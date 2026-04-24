import Parser from 'rss-parser';
import { query } from './database.js';

const parser = new Parser();

export async function fetchFeeds() {
  const result = await query('SELECT id, url, title FROM feeds');
  const feeds = result.rows;

  for (const feed of feeds) {
    try {
      const parsed = await parser.parseURL(feed.url);

      for (const item of parsed.items || []) {
        const published = item.pubDate ? new Date(item.pubDate) : new Date();

        await query(
          `INSERT INTO articles (feed_id, title, url, description, published_at)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [
            feed.id,
            item.title || 'Untitled',
            item.link || '',
            item.contentSnippet || item.description || '',
            published,
          ]
        );
      }

      await query('UPDATE feeds SET last_fetched = NOW() WHERE id = $1', [feed.id]);
      console.log(`Fetched: ${feed.title}`);
    } catch (err) {
      console.error(`Error fetching ${feed.url}:`, err.message);
    }
  }
}

export async function getUnreadArticles() {
  const result = await query(`
    SELECT
      a.id, a.title, a.url, a.description, a.published_at,
      f.id as feed_id, f.title as feed_title,
      c.name as category
    FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    LEFT JOIN categories c ON f.category_id = c.id
    WHERE a.read = FALSE
    ORDER BY c.name, a.published_at DESC
  `);
  return result.rows;
}

export async function markArticlesAsRead() {
  await query('UPDATE articles SET read = TRUE WHERE read = FALSE');
}
