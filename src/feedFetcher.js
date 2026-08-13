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

export async function fetchFeeds() {
  if (fetchInProgress) {
    console.log('Feed fetch already in progress, skipping');
    return;
  }
  fetchInProgress = true;
  try {
    return await doFetchFeeds();
  } finally {
    fetchInProgress = false;
  }
}

async function doFetchFeeds() {
  const result = await query('SELECT id, url, title FROM feeds');
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

      await query('UPDATE feeds SET last_fetched = NOW() WHERE id = $1', [feed.id]);
      console.log(`Fetched: ${feed.title}`);
    } catch (err) {
      stats.failed += 1;
      console.error(`Error fetching ${feed.url}:`, err.message);
    }
  }

  console.log(
    `Fetch complete: ${stats.inserted} new, ${stats.deduped} de-duplicated, ${stats.failed} feed errors`
  );
  return stats;
}

// Stores one item, collapsing it onto an existing article when the same story
// has already arrived through another feed. Returns 'inserted' or 'deduped'.
async function storeArticle(feed, item) {
  const url = item.link || '';
  const title = item.title || 'Untitled';
  const published = item.pubDate ? new Date(item.pubDate) : new Date();
  const description = item.contentSnippet || item.description || '';
  const { urlKey, titleKey } = dedupeKeys({ url, title });

  const existing = await query(
    `SELECT id FROM articles
      WHERE published_at > NOW() - ($1 || ' days')::interval
        AND (
          (url_key IS NOT NULL AND url_key = $2)
          OR (title_key IS NOT NULL AND title_key = $3)
        )
      ORDER BY id ASC
      LIMIT 1`,
    [String(DEDUPE_WINDOW_DAYS), urlKey, titleKey]
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
      AND c.in_digest IS NOT FALSE
    ORDER BY c.name, a.published_at DESC
  `, params);
  return result.rows;
}

// Marks only the given articles read, so articles fetched while a digest is
// being sent stay unread for the next digest instead of being silently skipped.
export async function markArticlesAsRead(articleIds) {
  if (!articleIds.length) return;
  await query('UPDATE articles SET read = TRUE WHERE id = ANY($1)', [articleIds]);
}
