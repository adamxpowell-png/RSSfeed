import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, query } from './database.js';
import { startScheduler, triggerDigestNow } from './scheduler.js';
import { fetchFeeds, getUnreadArticles } from './feedFetcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Deep-link endpoint for adding feeds from external sites
app.get('/add', (req, res) => {
  const feedUrl = req.query.url;
  const feedTitle = req.query.title || '';

  // Validate URL format (basic check)
  if (feedUrl) {
    try {
      new URL(feedUrl);
    } catch (err) {
      return res.status(400).send('Invalid URL format');
    }
  }

  // Serve index.html - frontend will detect query params and handle pre-filling
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use(express.static('public'));

// Initialize
(async () => {
  await initDatabase();
  startScheduler();
})();

// API Routes

// Categories
app.post('/api/categories', async (req, res) => {
  const { name } = req.body;
  try {
    const result = await query('INSERT INTO categories (name) VALUES ($1) RETURNING *', [name]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/categories', async (req, res) => {
  const result = await query('SELECT * FROM categories ORDER BY name');
  res.json(result.rows);
});

// Feeds
app.post('/api/feeds', async (req, res) => {
  const { url, title, categoryId } = req.body;
  try {
    const result = await query(
      'INSERT INTO feeds (url, title, category_id) VALUES ($1, $2, $3) RETURNING *',
      [url, title || url, categoryId || null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/feeds', async (req, res) => {
  const result = await query(`
    SELECT f.*, c.name as category
    FROM feeds f
    LEFT JOIN categories c ON f.category_id = c.id
    ORDER BY c.name, f.title
  `);
  res.json(result.rows);
});

app.delete('/api/feeds/:id', async (req, res) => {
  await query('DELETE FROM feeds WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Articles
app.get('/api/articles', async (req, res) => {
  const result = await query(`
    SELECT
      a.id, a.title, a.url, a.description, a.published_at, a.read,
      f.id as feed_id, f.title as feed_title,
      c.name as category
    FROM articles a
    JOIN feeds f ON a.feed_id = f.id
    LEFT JOIN categories c ON f.category_id = c.id
    ORDER BY c.name, a.published_at DESC
    LIMIT 200
  `);
  res.json(result.rows);
});

app.patch('/api/articles/:id/read', async (req, res) => {
  await query('UPDATE articles SET read = TRUE WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

app.patch('/api/articles/mark-all-read', async (req, res) => {
  await query('UPDATE articles SET read = TRUE WHERE read = FALSE');
  res.json({ success: true });
});

// Manual trigger for digest
app.post('/api/trigger-digest', async (req, res) => {
  const result = await triggerDigestNow();
  res.json(result);
});

// Fetch feeds manually
app.post('/api/fetch-feeds', async (req, res) => {
  try {
    await fetchFeeds();
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
