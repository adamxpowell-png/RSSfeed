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

  const reset = async () => {
    await db.query('DROP TABLE IF EXISTS article_feed_hits, articles, feeds, categories, clients CASCADE');
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
