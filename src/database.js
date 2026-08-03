import pg from 'pg';

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

export async function initDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS feeds (
        id SERIAL PRIMARY KEY,
        url VARCHAR(1024) NOT NULL UNIQUE,
        title VARCHAR(255),
        category_id INTEGER REFERENCES categories(id),
        last_fetched TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS articles (
        id SERIAL PRIMARY KEY,
        feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        url VARCHAR(1024) NOT NULL,
        description TEXT,
        published_at TIMESTAMP,
        read BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(feed_id, url)
      );

      CREATE INDEX IF NOT EXISTS idx_articles_feed_id ON articles(feed_id);
      CREATE INDEX IF NOT EXISTS idx_articles_read ON articles(read);
      CREATE INDEX IF NOT EXISTS idx_articles_published_at ON articles(published_at DESC);

      -- De-duplication. url_key is the hash of the canonical destination URL,
      -- title_key the hash of the normalised headline; a match on either means
      -- the same story arrived through more than one keyword feed.
      ALTER TABLE articles ADD COLUMN IF NOT EXISTS url_key VARCHAR(64);
      ALTER TABLE articles ADD COLUMN IF NOT EXISTS title_key VARCHAR(64);

      CREATE INDEX IF NOT EXISTS idx_articles_url_key
        ON articles(url_key, published_at DESC) WHERE url_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_articles_title_key
        ON articles(title_key, published_at DESC) WHERE title_key IS NOT NULL;

      -- Which feeds surfaced a given story. The story is stored once; every
      -- feed that carried it gets a row here, so "seen in 6 feeds" survives
      -- de-duplication and becomes a salience signal rather than noise.
      CREATE TABLE IF NOT EXISTS article_feed_hits (
        article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
        seen_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (article_id, feed_id)
      );

      CREATE INDEX IF NOT EXISTS idx_afh_article ON article_feed_hits(article_id);
    `);
    console.log('Database initialized');
  } finally {
    client.release();
  }
}

export async function query(text, params) {
  return pool.query(text, params);
}

export async function getPool() {
  return pool;
}
