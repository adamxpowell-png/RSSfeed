import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, query, getPool } from '../src/database.js';

// Seeds keyword-monitoring categories and feeds from feeds/seed.json.
// Idempotent and additive: it never deletes or rewrites an existing feed, so it
// is safe to re-run after editing the register. Decommissioning old feeds is a
// deliberate manual act, done in the UI.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const registry = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'feeds', 'seed.json'), 'utf8')
);

// Google News regional editions. The edition decides which outlets are indexed:
// a UK-scoped NLNG query quietly misses most Nigerian press, which is the whole
// point of running the Nigerian edition alongside it.
const EDITIONS = {
  GB: { hl: 'en-GB', gl: 'GB', ceid: 'GB:en' },
  US: { hl: 'en-US', gl: 'US', ceid: 'US:en' },
  NG: { hl: 'en-NG', gl: 'NG', ceid: 'NG:en' },
};

function buildUrl(feed) {
  const q = encodeURIComponent(feed.q);

  switch (feed.engine) {
    case 'gnews': {
      const edition = EDITIONS[feed.edition || 'GB'];
      if (!edition) throw new Error(`Unknown edition: ${feed.edition}`);
      return `https://news.google.com/rss/search?q=${q}&hl=${edition.hl}&gl=${edition.gl}&ceid=${encodeURIComponent(edition.ceid)}`;
    }
    case 'bing':
      return `https://www.bing.com/news/search?q=${q}&format=RSS`;
    case 'reddit':
      return `https://www.reddit.com/search.rss?q=${q}&sort=new`;
    case 'url':
      return feed.url;
    default:
      throw new Error(`Unknown engine: ${feed.engine}`);
  }
}

async function ensureCategory(name) {
  const existing = await query('SELECT id FROM categories WHERE name = $1', [name]);
  if (existing.rows.length) return existing.rows[0].id;
  const created = await query(
    'INSERT INTO categories (name) VALUES ($1) RETURNING id',
    [name]
  );
  console.log(`  + category: ${name}`);
  return created.rows[0].id;
}

async function ensureFeed(categoryId, title, url) {
  const result = await query(
    `INSERT INTO feeds (url, title, category_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (url) DO NOTHING
     RETURNING id`,
    [url, title, categoryId]
  );
  console.log(`  ${result.rows.length ? '+' : '='} ${title}`);
  return result.rows.length ? 'added' : 'existing';
}

async function main() {
  await initDatabase();

  const categories = [...registry.categories];

  // The Talkwalker alert URL is a bearer token in disguise — anyone holding it
  // can read the alert stream — so it is supplied by env var, never committed.
  if (process.env.TALKWALKER_ALERTS_RSS) {
    categories.push({
      name: 'Talkwalker',
      feeds: [
        {
          title: 'Talkwalker - all alerts',
          engine: 'url',
          url: process.env.TALKWALKER_ALERTS_RSS,
        },
      ],
    });
  } else {
    console.log('TALKWALKER_ALERTS_RSS not set - skipping Talkwalker feed\n');
  }

  let added = 0;
  let existing = 0;

  for (const category of categories) {
    console.log(category.name);
    const categoryId = await ensureCategory(category.name);
    for (const feed of category.feeds) {
      const outcome = await ensureFeed(categoryId, feed.title, buildUrl(feed));
      if (outcome === 'added') added += 1;
      else existing += 1;
    }
    console.log('');
  }

  console.log(`Seed complete: ${added} added, ${existing} already present`);
  const pool = await getPool();
  await pool.end();
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
