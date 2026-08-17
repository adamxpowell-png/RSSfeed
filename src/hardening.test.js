// Regression suite for the multi-client / digest changes. Integration tests that
// touch a real Postgres — they run ONLY when RSS_TEST_DATABASE_URL is set, and
// they DROP/recreate tables, so that variable must point at a throwaway test
// database, never production. Without it, every test is skipped (npm test stays
// green on machines with no test DB).
import test from 'node:test';
import assert from 'node:assert/strict';

const TEST_DB = process.env.RSS_TEST_DATABASE_URL;

if (!TEST_DB) {
  test('integration suite skipped (set RSS_TEST_DATABASE_URL to a throwaway DB to run)', () => {});
} else {
  process.env.DATABASE_URL = TEST_DB;
  process.env.NODE_ENV = 'development';
  process.env.EMAIL_TO = 'test@example.com';

  const db = await import('./database.js');
  const ff = await import('./feedFetcher.js');
  const al = await import('./alertService.js');
  const sch = await import('./scheduler.js');
  const brief = await import('./briefService.js');

  // Fake email sender: records what would have been sent, always "ok" so the
  // ledger records, so alert tests never touch Resend.
  const makeSender = () => {
    const sent = [];
    const send = async (articles, opts) => { sent.push({ articles, opts }); return { ok: true, sent: articles.length }; };
    return { send, sent };
  };
  const addRule = async (client, term, enabled = true) =>
    (await db.query('INSERT INTO alert_rules (client_id, term, enabled) VALUES ($1,$2,$3) RETURNING id', [client, term, enabled])).rows[0].id;

  const reset = async () => {
    await db.query('DROP TABLE IF EXISTS article_alerts, alert_rules, article_feed_hits, articles, feeds, categories, clients CASCADE');
    await db.initDatabase();
  };
  const clientId = async (name) => (await db.query('SELECT id FROM clients WHERE name=$1', [name])).rows[0].id;
  const addCat = async (name, client, inDigest = true) =>
    (await db.query('INSERT INTO categories (name,client_id,in_digest) VALUES ($1,$2,$3) RETURNING id', [name, client, inDigest])).rows[0].id;
  const addFeed = async (url, client, cat, inDigest = true) =>
    (await db.query('INSERT INTO feeds (url,title,category_id,client_id,in_digest) VALUES ($1,$1,$2,$3,$4) RETURNING id,client_id', [url, cat, client, inDigest])).rows[0];

  test('migration is idempotent — re-running initDatabase does not duplicate clients', async () => {
    await reset();
    await db.initDatabase();
    const n = (await db.query("SELECT COUNT(*)::int n FROM clients")).rows[0].n;
    assert.equal(n, 3, 'SYOS, NLNG, Project Odyssey seeded exactly once');
  });

  test('per-client dedup: a story shared across clients is kept separately for each', async () => {
    await reset();
    const syos = await clientId('SYOS'), nlng = await clientId('NLNG');
    const cs = await addCat('t', syos), cn = await addCat('t', nlng);
    const fa = await addFeed('http://a', syos, cs);
    const fb = await addFeed('http://b', nlng, cn);
    const story = { link: 'http://wire/1', title: 'Shared wire story' };
    await ff.storeArticle(fa, story); // owned by SYOS
    await ff.storeArticle(fb, story); // same story, different client -> separate row
    const s = await ff.getUnreadArticles(syos);
    const n = await ff.getUnreadArticles(nlng);
    assert.equal(s.length, 1, 'SYOS keeps its copy');
    assert.equal(n.length, 1, 'NLNG keeps its own copy (not collapsed onto SYOS)');
    // Marking SYOS read must not hide NLNG's copy.
    await ff.markArticlesAsRead(s.map((a) => a.id));
    assert.equal((await ff.getUnreadArticles(syos)).length, 0);
    assert.equal((await ff.getUnreadArticles(nlng)).length, 1, 'NLNG still has its story after SYOS sent');
  });

  test('within a client, dedup collapses the same story across that client\'s feeds', async () => {
    await reset();
    const syos = await clientId('SYOS');
    const c = await addCat('t', syos);
    const f1 = await addFeed('http://f1', syos, c);
    const f2 = await addFeed('http://f2', syos, c);
    const story = { link: 'http://wire/2', title: 'One SYOS story' };
    await ff.storeArticle(f1, story);
    await ff.storeArticle(f2, story); // same client -> collapses onto one row, records a hit
    const rows = (await db.query('SELECT COUNT(*)::int n FROM articles')).rows[0].n;
    assert.equal(rows, 1, 'one article row for the client');
    assert.equal((await ff.getUnreadArticles(syos)).length, 1);
  });

  test('digest inclusion is by ANY carrying feed, not just the owning feed', async () => {
    await reset();
    const syos = await clientId('SYOS');
    const ctx = await addCat('context', syos, false);
    const men = await addCat('mentions', syos, true);
    const fContext = await addFeed('http://ctx', syos, ctx, false); // reader-only
    const fMention = await addFeed('http://men', syos, men, true);  // emailed
    const story = { link: 'http://wire/3', title: 'SYOS mention also in trade press' };
    await ff.storeArticle(fContext, story); // deduped onto the CONTEXT feed (owner in_digest=false)
    await ff.storeArticle(fMention, story); // mention feed also carried it -> hit
    const digest = await ff.getUnreadArticles(syos);
    assert.equal(digest.length, 1, 'story is in the digest because a mention feed carried it, despite the context owner');
    // If no carrying feed is in_digest, it drops out.
    await db.query('UPDATE feeds SET in_digest = FALSE');
    assert.equal((await ff.getUnreadArticles(syos)).length, 0, 'excluded once every carrying feed is reader-only');
  });

  test('feed health: a failing fetch is recorded on the feed', async () => {
    await reset();
    const syos = await clientId('SYOS');
    const c = await addCat('t', syos);
    const bad = await addFeed('http://127.0.0.1:1/nope', syos, c); // refused connection
    await ff.fetchFeeds();
    const row = (await db.query('SELECT last_error, error_count FROM feeds WHERE id=$1', [bad.id])).rows[0];
    assert.ok(row.last_error, 'the fetch failure is recorded');
    assert.equal(row.error_count, 1, 'consecutive-failure count incremented');
  });

  test('priority alert: a matching new article fires once, case-insensitively, then never again', async () => {
    await reset();
    const syos = await clientId('SYOS');
    const c = await addCat('t', syos);
    const f = await addFeed('http://a', syos, c);
    await addRule(syos, 'takeover');
    await ff.storeArticle(f, { link: 'http://x/1', title: 'Board confirms TAKEOVER talks' });

    const s1 = makeSender();
    const r1 = await al.runAlertScan({ send: s1.send });
    assert.equal(r1.alerted, 1, 'the matching story alerts');
    assert.equal(s1.sent.length, 1, 'one client email');
    assert.deepEqual(s1.sent[0].articles[0].matched_terms, ['takeover'], 'the firing term is reported');

    const led = (await db.query('SELECT matched_terms FROM article_alerts')).rows;
    assert.equal(led.length, 1);
    assert.equal(led[0].matched_terms, 'takeover', 'ledger records what fired');

    const s2 = makeSender();
    const r2 = await al.runAlertScan({ send: s2.send });
    assert.equal(r2.alerted, 0, 'the same story does not alert twice');
    assert.equal(s2.sent.length, 0);
  });

  test('priority alert: a term only fires for the client that owns the rule', async () => {
    await reset();
    const syos = await clientId('SYOS'), nlng = await clientId('NLNG');
    const cs = await addCat('t', syos), cn = await addCat('t', nlng);
    const fs = await addFeed('http://s', syos, cs);
    const fn = await addFeed('http://n', nlng, cn);
    await addRule(syos, 'grounding'); // only SYOS watches it
    await ff.storeArticle(fn, { link: 'http://x/n', title: 'Fleet grounding reported' }); // NLNG feed
    await ff.storeArticle(fs, { link: 'http://x/s', title: 'Fleet grounding reported' }); // SYOS feed

    const s = makeSender();
    const r = await al.runAlertScan({ send: s.send });
    assert.equal(r.alerted, 1, 'only the SYOS copy alerts');
    assert.equal(s.sent[0].opts.label, 'SYOS');
  });

  test('priority alert: a disabled rule does not fire', async () => {
    await reset();
    const syos = await clientId('SYOS');
    const c = await addCat('t', syos);
    const f = await addFeed('http://a', syos, c);
    await addRule(syos, 'bid', false); // disabled
    await ff.storeArticle(f, { link: 'http://x/1', title: 'Takeover bid launched' });
    const s = makeSender();
    const r = await al.runAlertScan({ send: s.send });
    assert.equal(r.alerted, 0, 'disabled term is inert');
  });

  test('priority alert: articles that predate the feature are baseline-suppressed (no blast)', async () => {
    await reset();
    const syos = await clientId('SYOS');
    const c = await addCat('t', syos);
    const f = await addFeed('http://a', syos, c);
    // Story arrives BEFORE the alert feature/rules exist...
    await ff.storeArticle(f, { link: 'http://x/old', title: 'Historic takeover completed' });
    // ...then the alert migration runs again (as on the deploy that ships alerts).
    await db.initDatabase();
    await addRule(syos, 'takeover');
    const s = makeSender();
    const r = await al.runAlertScan({ send: s.send });
    assert.equal(r.alerted, 0, 'pre-existing coverage never retroactively alerts');
  });

  test('email-selection: returns unread from chosen feeds only, incl. stories they carried via dedup', async () => {
    await reset();
    const syos = await clientId('SYOS');
    const c = await addCat('t', syos);
    const fPick = await addFeed('http://pick', syos, c);
    const fOther = await addFeed('http://other', syos, c);
    // A story that arrives on the OTHER feed first, then also on the picked feed
    // (deduped onto other's row but carried by pick) must still be included.
    const shared = { link: 'http://wire/s', title: 'Shared story' };
    await ff.storeArticle(fOther, shared);
    await ff.storeArticle(fPick, shared);
    // A story only on the other (unpicked) feed must be excluded.
    await ff.storeArticle(fOther, { link: 'http://wire/o', title: 'Other-only story' });
    // A story only on the picked feed must be included.
    await ff.storeArticle(fPick, { link: 'http://wire/p', title: 'Pick-only story' });

    const rows = await ff.getUnreadForSelection([fPick.id]);
    const titles = rows.map((r) => r.title).sort();
    assert.deepEqual(titles, ['Pick-only story', 'Shared story'], 'includes carried + own, excludes other-only');
  });

  test('email-selection is non-destructive: a successful send leaves the stories unread', async () => {
    await reset();
    const syos = await clientId('SYOS');
    const c = await addCat('t', syos);
    const f = await addFeed('http://a', syos, c);
    await ff.storeArticle(f, { link: 'http://x/1', title: 'Story one' });
    await ff.storeArticle(f, { link: 'http://x/2', title: 'Story two' });

    const sent = [];
    const send = async (articles, opts) => { sent.push({ articles, opts }); return { ok: true, sent: articles.length }; };
    const r = await sch.sendSelectionNow([f.id], { send });
    assert.equal(r.articleCount, 2, 'both stories emailed');
    assert.equal(sent.length, 1, 'one client email');
    // The whole point: they must still be unread afterwards.
    assert.equal((await ff.getUnreadForSelection([f.id])).length, 2, 'stories remain unread after emailing');
  });

  test('brief coverage: filters by date range (inclusive end day) and scopes to the client', async () => {
    await reset();
    const syos = await clientId('SYOS'), nlng = await clientId('NLNG');
    const cs = await addCat('t', syos), cn = await addCat('t', nlng);
    const fs = await addFeed('http://s', syos, cs);
    const fn = await addFeed('http://n', nlng, cn);
    await ff.storeArticle(fs, { link: 'http://x/in1', title: 'In range early', pubDate: '2026-01-05T09:00:00Z' });
    await ff.storeArticle(fs, { link: 'http://x/in2', title: 'In range end-day late', pubDate: '2026-01-10T23:30:00Z' });
    await ff.storeArticle(fs, { link: 'http://x/before', title: 'Before range', pubDate: '2026-01-01T09:00:00Z' });
    await ff.storeArticle(fs, { link: 'http://x/after', title: 'After range', pubDate: '2026-01-20T09:00:00Z' });
    await ff.storeArticle(fn, { link: 'http://x/other', title: 'Other client in range', pubDate: '2026-01-06T09:00:00Z' });

    const cov = await brief.getCoverage(syos, '2026-01-05', '2026-01-10');
    const titles = cov.articles.map((a) => a.title).sort();
    assert.deepEqual(titles, ['In range early', 'In range end-day late'],
      'only SYOS stories within [from, to] inclusive of the end day');
  });

  test('brief coverage: a story shared across the client\'s feeds appears once, with a salience count', async () => {
    await reset();
    const syos = await clientId('SYOS');
    const c = await addCat('t', syos);
    const f1 = await addFeed('http://f1', syos, c);
    const f2 = await addFeed('http://f2', syos, c);
    // Dedup is anchored to NOW (21-day window), so use recent dates for this one.
    const iso = (d) => d.toISOString().slice(0, 10);
    const today = new Date();
    const yesterday = new Date(today.getTime() - 24 * 3600 * 1000);
    const weekAgo = new Date(today.getTime() - 7 * 24 * 3600 * 1000);
    const story = { link: 'http://wire/z', title: 'Shared story', pubDate: yesterday.toISOString() };
    await ff.storeArticle(f1, story);
    await ff.storeArticle(f2, story); // dedup → one row, two hits
    const cov = await brief.getCoverage(syos, iso(weekAgo), iso(today));
    assert.equal(cov.articles.length, 1, 'appears once in the brief');
    assert.equal(cov.articles[0].hit_count, 2, 'seen-in count reflects both carrying feeds');
  });

  test('brief render: produces a Word-openable doc and a print page, escaping titles', async () => {
    await reset();
    const syos = await clientId('SYOS');
    const c = await addCat('Defence', syos);
    const f = await addFeed('http://s', syos, c);
    await ff.storeArticle(f, { link: 'http://x/1', title: 'Deal <b>&</b> "talks"', pubDate: '2026-03-03T09:00:00Z' });
    const cov = await brief.getCoverage(syos, '2026-03-01', '2026-03-05');
    const web = brief.renderBrief(cov, { forWord: false });
    const doc = brief.renderBrief(cov, { forWord: true });
    assert.ok(web.includes('window.print()'), 'web page has a print control');
    assert.ok(!doc.includes('window.print()'), 'word doc has no print control');
    assert.ok(doc.includes('urn:schemas-microsoft-com:office:word'), 'word doc carries the office namespace');
    assert.ok(web.includes('Deal &lt;b&gt;&amp;&lt;/b&gt; &quot;talks&quot;'), 'title is HTML-escaped');
    assert.ok(brief.briefFilename('Project Odyssey', '2026-03-01', '2026-03-05').endsWith('.doc'));
  });

  test('per-feed digest control: a single feed can be excluded / cherry-picked', async () => {
    await reset();
    const syos = await clientId('SYOS');
    const c = await addCat('t', syos, false); // whole topic reader-only
    const fA = await addFeed('http://A', syos, c, false);
    const fB = await addFeed('http://B', syos, c, true); // cherry-picked into the digest
    await ff.storeArticle(fA, { link: 'http://x/a', title: 'A' });
    await ff.storeArticle(fB, { link: 'http://x/b', title: 'B' });
    const digest = (await ff.getUnreadArticles(syos)).map((a) => a.feed_title).sort();
    assert.deepEqual(digest, ['http://B'], 'only the cherry-picked feed emails, from an otherwise reader-only topic');
  });
}
