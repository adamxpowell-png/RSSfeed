import Parser from 'rss-parser';
import { query } from './database.js';
import { dedupeKeys } from './dedupe.js';

const parser = new Parser();

// How far back to look for an existing copy of a story. Long enough to catch
// slow-moving trade coverage and alert lag; short enough that a genuinely
// recurring headline ("Weekly defence roundup") is not suppressed forever.
const DEDUPE_WINDOW_DAYS = 21;

// Single guard shared by every caller (both cron jobs and both manual endpoints),
// so overlapping runs — e.g. the 30-min fetch and the 8 AM digest — never race.
let fetchInProgress = false;

// feedIds: optional array of feed ids to fetch just those (per-feed "pull").
// Omitted/empty → fetch every feed (the scheduled behaviour).
export async function fetchFeeds(feedIds = null) {
  if (fetchInProgress) {
    console.log('Feed fetch already in progress, skipping');
    return;
  }
  fetchInProgress = true;
  try {
    return await doFetchFeeds(feedIds);
  } finally {
    fetchInProgress = false;
  }
}

async function doFetchFeeds(feedIds = null) {
  const hasFilter = Array.isArray(feedIds) && feedIds.length > 0;
  const result = await query(
    hasFilter
      ? 'SELECT id, url, title, client_id FROM feeds WHERE id = ANY($1)'
      : 'SELECT id, url, title, client_id FROM feeds',
    hasFilter ? [feedIds] : []
  );
  const feeds = result.rows;
  const stats = { inserted: 0, deduped: 0, failed: 0 };

  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);

      for (const item of parsed.items || []) {
        const outcome = await storeArticle(feed, item);
        if (outcome === 'inserted') stats.inserted += 1;
        else if (outcome === 'deduped') stats.deduped += 1;
      }

      await query(
        'UPDATE feeds SET last_fetched = NOW(), last_error = NULL, error_count = 0 WHERE id = $1',
        [feed.id]
      );
      console.log(`Fetched: ${feed.title}`);
    } catch (err) {
      stats.failed += 1;
      console.error(`Error fetching ${feed.url}:`, err.message);
      // Record the failure so a silently-broken feed becomes visible in the UI.
      await query(
        'UPDATE feeds SET last_error = $2, error_count = error_count + 1 WHERE id = $1',
        [feed.id, String(err.message || 'fetch failed').slice(0, 500)]
      );
    }
  }

  console.log(
    `Fetch complete: ${stats.inserted} new, ${stats.deduped} de-duplicated, ${stats.failed} feed errors`
  );
  return stats;
}

// Stores one item, collapsing it onto an existing article when the same story
// has already arrived through another feed OF THE SAME CLIENT. Returns
// 'inserted' or 'deduped'. Exported for the regression suite.
export async function storeArticle(feed, item) {
  const url = item.link || '';
  const title = item.title || 'Untitled';
  const published = item.pubDate ? new Date(item.pubDate) : new Date();
  const description = item.contentSnippet || item.description || '';
  const { urlKey, titleKey } = dedupeKeys({ url, title });

  // De-dup is scoped to the incoming feed's CLIENT. A story shared across
  // clients is stored once per client, so each client's digest and read-state
  // stay independent — one client sending a shared story can't mark it read for
  // (and thereby hide it from) another client that also monitors it.
  const existing = await query(
    `SELECT a.id FROM articles a
       JOIN feeds f ON a.feed_id = f.id
      WHERE f.client_id IS NOT DISTINCT FROM $4
        AND a.published_at > NOW() - ($1 || ' days')::interval
        AND (
          (a.url_key IS NOT NULL AND a.url_key = $2)
          OR (a.title_key IS NOT NULL AND a.title_key = $3)
        )
      ORDER BY a.id ASC
      LIMIT 1`,
    [String(DEDUPE_WINDOW_DAYS), urlKey, titleKey, feed.client_id ?? null]
  );

  if (existing.rows.length) {
    await recordHit(existing.rows[0].id, feed.id);
    return 'deduped';
  }

  const inserted = await query(
    `INSERT INTO articles (feed_id, title, url, description, published_at, url_key, title_key)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (feed_id, url) DO UPDATE
       SET url_key = COALESCE(articles.url_key, EXCLUDED.url_key),
           title_key = COALESCE(articles.title_key, EXCLUDED.title_key)
     RETURNING id`,
    [feed.id, title, url, description, published, urlKey, titleKey]
  );

  if (inserted.rows.length) await recordHit(inserted.rows[0].id, feed.id);
  return 'inserted';
}

async function recordHit(articleId, feedId) {
  await query(
    `INSERT INTO article_feed_hits (article_id, feed_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [articleId, feedId]
  );
}

// One-off migration for rows that predate de-duplication: fills in the keys and
// seeds article_feed_hits from each article's own feed. Cheap and idempotent —
// it exits immediately once every row has been processed.
export async function backfillDedupeKeys(batchSize = 500) {
  let processed = 0;

  for (;;) {
    const batch = await query(
      `SELECT id, feed_id, url, title FROM articles
        WHERE url_key IS NULL AND title_key IS NULL
        ORDER BY id LIMIT $1`,
      [batchSize]
    );
    if (!batch.rows.length) break;

    for (const row of batch.rows) {
      const { urlKey, titleKey } = dedupeKeys({ url: row.url, title: row.title });
      // Sentinel: an article with no usable key still needs marking as done,
      // otherwise the batch loop reselects it forever.
      await query('UPDATE articles SET url_key = $1, title_key = $2 WHERE id = $3', [
        urlKey,
        titleKey ?? (urlKey ? null : 'unkeyed'),
        row.id,
      ]);
      await recordHit(row.id, row.feed_id);
      processed += 1;
    }
  }

  if (processed) console.log(`Backfilled dedupe keys for ${processed} articles`);
  return processed;
}

// Unread articles, optionally scoped to a single client. No clientId → all
// unread (legacy behaviour). Used per-client to build one digest per client.
export async function getUnreadArticles(clientId = null) {
  const params = [];
  let clientWhere = '';
  if (clientId != null) {
    params.push(clientId);
    clientWhere = ` AND f.client_id = $${params.length}`;
  }
  const result = await query(`
    SELECT
      a.id, a.title, a.url, a.description, a.published_at,
      f.id as feed_id, f.title as feed_title, f.client_id,
      c.name as category,
      (SELECT COUNT(*)::int FROM article_feed_hits h WHERE h.article_id = a.id) AS hit_count
    FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    LEFT JOIN categories c ON f.category_id = c.id
    WHERE a.read = FALSE${clientWhere}
      -- In the digest if ANY feed that carried the story is in_digest — not just
      -- the single owning feed. Stops a story deduped onto a context feed from
      -- being dropped when an in-digest mention feed also matched it.
      AND EXISTS (
        SELECT 1 FROM article_feed_hits h
        JOIN feeds hf ON hf.id = h.feed_id
        WHERE h.article_id = a.id AND hf.in_digest IS NOT FALSE
      )
    ORDER BY c.name, a.published_at DESC
  `, params);
  return result.rows;
}

// Unread articles surfaced by a specific SET of feeds, for the on-demand
// "email selected feeds" action. Uses article_feed_hits so a story counts if ANY
// selected feed carried it (even when it was de-duplicated onto a different
// feed's row), and — unlike the daily digest — ignores in_digest: the user picked
// these feeds explicitly, so everything they surfaced is included.
export async function getUnreadForSelection(feedIds) {
  if (!Array.isArray(feedIds) || feedIds.length === 0) return [];
  const result = await query(`
    SELECT
      a.id, a.title, a.url, a.description, a.published_at,
      f.id as feed_id, f.title as feed_title, f.client_id,
      c.name as category, cl.name as client_name,
      COALESCE(cl.email, $2) as recipient
    FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    LEFT JOIN categories c ON f.category_id = c.id
    LEFT JOIN clients cl ON cl.id = f.client_id
    WHERE a.read = FALSE
      AND EXISTS (
        SELECT 1 FROM article_feed_hits h
        WHERE h.article_id = a.id AND h.feed_id = ANY($1)
      )
    ORDER BY cl.name, c.name, a.published_at DESC
  `, [feedIds, process.env.EMAIL_TO || null]);
  return result.rows;
}

// Marks only the given articles read, so articles fetched while a digest is
// being sent stay unread for the next digest instead of being silently skipped.
export async function markArticlesAsRead(articleIds) {
  if (!articleIds.length) return;
  await query('UPDATE articles SET read = TRUE WHERE id = ANY($1)', [articleIds]);
}
