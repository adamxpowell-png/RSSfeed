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

      -- A client is a monitoring workspace (e.g. SYOS, NLNG). Categories are
      -- topics WITHIN a client, and every feed belongs to exactly one client.
      -- Each client has its own digest recipient, so the daily email is split
      -- one-per-client instead of one combined dump.
      CREATE TABLE IF NOT EXISTS clients (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        email VARCHAR(320),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE categories ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);
      ALTER TABLE feeds ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);

      -- Whether a topic's articles are included in the emailed digest. Kept as a
      -- convenience/default; the digest query is driven by the per-FEED flag
      -- below so individual feeds can be cherry-picked in or out.
      ALTER TABLE categories ADD COLUMN IF NOT EXISTS in_digest BOOLEAN DEFAULT TRUE;

      -- Per-feed digest control (source of truth for the emailed digest). The
      -- reader always shows the feed; in_digest=false means "browse only, never
      -- email". The topic pill is a bulk setter over these. Default true.
      ALTER TABLE feeds ADD COLUMN IF NOT EXISTS in_digest BOOLEAN DEFAULT TRUE;

      -- Feed health: last_error is the most recent fetch failure (NULL = healthy),
      -- error_count the consecutive-failure streak (reset to 0 on any good fetch).
      -- Surfaces silently-broken sources so they don't create invisible gaps.
      ALTER TABLE feeds ADD COLUMN IF NOT EXISTS last_error TEXT;
      ALTER TABLE feeds ADD COLUMN IF NOT EXISTS error_count INTEGER DEFAULT 0;
      CREATE INDEX IF NOT EXISTS idx_feeds_client ON feeds(client_id);
      CREATE INDEX IF NOT EXISTS idx_categories_client ON categories(client_id);

      -- Topic names are now unique per client (SYOS/Defence and NLNG/Defence can
      -- coexist), not globally. Drop the old global-unique on categories.name.
      ALTER TABLE categories DROP CONSTRAINT IF EXISTS categories_name_key;
      CREATE UNIQUE INDEX IF NOT EXISTS categories_client_name_key ON categories(client_id, name);

      -- Instant priority alerts. A rule is a high-stakes phrase watched for a
      -- single client (e.g. "administration"/"takeover" for Project Odyssey,
      -- "grounding"/"incident" for SYOS). When a newly-fetched article's title or
      -- description contains an enabled rule's term, that client gets an immediate
      -- email — separate from, and ahead of, the 8 AM digest. Matching is a plain
      -- case-insensitive substring, so terms are phrases, not Boolean queries.
      CREATE TABLE IF NOT EXISTS alert_rules (
        id SERIAL PRIMARY KEY,
        client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
        term VARCHAR(255) NOT NULL,
        enabled BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (client_id, term)
      );
      CREATE INDEX IF NOT EXISTS idx_alert_rules_client ON alert_rules(client_id) WHERE enabled;

      -- Alert ledger: one row per article that has already been considered for a
      -- priority alert, so the same story never alerts twice. matched_terms is the
      -- terms that fired (NULL = a baseline/suppressed row: the article predates
      -- the alert feature or its rules and must not retroactively alert).
      CREATE TABLE IF NOT EXISTS article_alerts (
        article_id INTEGER PRIMARY KEY REFERENCES articles(id) ON DELETE CASCADE,
        client_id INTEGER REFERENCES clients(id) ON DELETE SET NULL,
        matched_terms TEXT,
        alerted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Baseline-suppress every article that already exists the first time this
    // migration runs: mark them all "considered" (matched_terms NULL) so that
    // enabling the alert feature — or adding a rule — never blasts a client with
    // an alert for old, already-seen coverage. Only articles fetched AFTER this
    // point become alert candidates. Idempotent via ON CONFLICT: rows added by a
    // real alert are never overwritten because we never touch existing keys.
    await client.query(
      `INSERT INTO article_alerts (article_id, matched_terms)
         SELECT id, NULL FROM articles
       ON CONFLICT (article_id) DO NOTHING`
    );

    // Seed clients + backfill existing rows to SYOS. Idempotent: ON CONFLICT on
    // the client names, and the backfills only touch rows whose client_id is
    // still NULL, so re-running on every boot is a no-op after the first time.
    const defaultEmail = process.env.EMAIL_TO || null;
    await client.query(
      `INSERT INTO clients (name, email) VALUES ('SYOS', $1), ('NLNG', $1), ('Project Odyssey', $1)
       ON CONFLICT (name) DO NOTHING`,
      [defaultEmail]
    );
    await client.query(
      `UPDATE categories SET client_id = (SELECT id FROM clients WHERE name = 'SYOS')
        WHERE client_id IS NULL`
    );
    await client.query(
      `UPDATE feeds SET client_id = COALESCE(
           (SELECT c.client_id FROM categories c WHERE c.id = feeds.category_id),
           (SELECT id FROM clients WHERE name = 'SYOS'))
        WHERE client_id IS NULL`
    );

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
