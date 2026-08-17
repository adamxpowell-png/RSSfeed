import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, query } from './database.js';
import { startScheduler, triggerDigestNow, triggerAlertsNow, sendSelectionNow } from './scheduler.js';
import { fetchFeeds, getUnreadArticles, backfillDedupeKeys } from './feedFetcher.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Backstop: never let a single stray async error take the whole reader down.
// Handlers still use try/catch; this only stops an unforeseen unhandled
// rejection / exception from terminating the process (Node 22 exits by default).
process.on('unhandledRejection', (err) => {
  console.error('Unhandled promise rejection (kept alive):', err);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (kept alive):', err);
});

// READER_PASSWORD accepted as fallback so the existing Railway variable keeps working
const APP_PASSWORD = process.env.APP_PASSWORD || process.env.READER_PASSWORD || '';
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// SESSION_SECRET must be set independently in production and must NEVER derive
// from the password. The signed cookie value is attacker-predictable (an expiry
// timestamp), so a password-derived secret would turn any captured cookie into
// an offline password-cracking oracle. In production an unset secret is a fatal
// misconfiguration (fail closed). In development we mint an ephemeral random
// secret so local runs work without config — cookies simply reset per process.
const RAW_SESSION_SECRET = process.env.SESSION_SECRET || '';
const SESSION_SECRET = RAW_SESSION_SECRET ||
  (IS_PRODUCTION ? '' : crypto.randomBytes(32).toString('hex'));

// Auth is live only when BOTH a password and a signing secret are configured.
// Otherwise every /api route and the login endpoint fail closed (503) in every
// environment — there is no unauthenticated mode.
const AUTH_CONFIGURED = Boolean(APP_PASSWORD) && Boolean(SESSION_SECRET);

if (!APP_PASSWORD) {
  console.warn('WARNING: APP_PASSWORD is not set - authentication is not configured; the API will return 503 until it is set.');
}
if (IS_PRODUCTION && !RAW_SESSION_SECRET) {
  console.warn('WARNING: SESSION_SECRET is not set - authentication is not configured; the API will return 503. Set a long random SESSION_SECRET in the environment.');
}

// Railway runs behind a proxy; needed for correct client IPs in rate limiting
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
    },
  },
}));
// No CORS: the frontend is served from the same origin as the API, so no
// cross-origin access is needed. Emitting Access-Control-Allow-Origin: * on an
// authenticated, per-client instance would be a needless data-exposure risk.
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser(SESSION_SECRET));

// Rate limiting
const globalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300, standardHeaders: true, legacyHeaders: false });
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });
const expensiveLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: true, legacyHeaders: false });
// Per-feed pull / email-selection are lighter and used interactively, so they get
// a more generous ceiling than the full-fetch / full-digest jobs.
const selectionLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 40, standardHeaders: true, legacyHeaders: false });
app.use(globalLimiter);

// --- Auth ---

function timingSafeMatch(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Fail closed in every environment: without a configured password AND secret,
// there is no API access.
function requireAuth(req, res, next) {
  if (!AUTH_CONFIGURED) {
    return res.status(503).json({ error: 'Service unavailable: authentication is not configured' });
  }
  // The signed cookie carries its own expiry (ms epoch). Reject if missing,
  // malformed, or past expiry — checked server-side, so a captured cookie stops
  // working after 30 days even if the browser keeps sending it. The signature
  // (SESSION_SECRET) is what prevents a client forging the timestamp.
  const raw = req.signedCookies && req.signedCookies.auth;
  const expiresAt = Number(raw);
  if (raw && Number.isFinite(expiresAt) && expiresAt > Date.now()) return next();
  return res.status(401).json({ error: 'Authentication required' });
}

const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

app.post('/api/login', loginLimiter, (req, res) => {
  if (!AUTH_CONFIGURED) {
    return res.status(503).json({ error: 'Service unavailable: authentication is not configured' });
  }
  const { password } = req.body || {};
  if (typeof password !== 'string' || !timingSafeMatch(password, APP_PASSWORD)) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  res.cookie('auth', String(Date.now() + SESSION_MAX_AGE_MS), {
    signed: true,
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
    maxAge: SESSION_MAX_AGE_MS,
  });
  res.json({ success: true });
});

// Logout: clear the session cookie. Reachable without auth so it always works.
app.post('/api/logout', (req, res) => {
  res.clearCookie('auth', {
    httpOnly: true,
    secure: IS_PRODUCTION,
    sameSite: 'lax',
  });
  res.json({ success: true });
});

// Public: instance branding for the frontend
app.get('/api/config', (req, res) => {
  res.json({
    appName: process.env.APP_NAME || 'CSG RSS Intelligence Feed',
    accentColor: process.env.APP_COLOR || '#000648',
    authRequired: AUTH_CONFIGURED,
  });
});

// All other /api routes require auth
app.use('/api', requireAuth);

// --- Validation helpers ---

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^169\.254\./,
  /^\[?::1\]?$/,
  /^0\.0\.0\.0$/,
  /\.internal$/i,
  /\.local$/i,
];

// Blocks non-http(s) protocols and obvious private/internal hosts.
// Full DNS-rebinding protection is out of scope; the API requires auth.
function validateFeedUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 1024) {
    return { valid: false, reason: 'URL must be between 1 and 1024 characters' };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Only http and https URLs are allowed' };
  }
  if (PRIVATE_HOST_PATTERNS.some((p) => p.test(parsed.hostname))) {
    return { valid: false, reason: 'URL host is not allowed' };
  }
  return { valid: true };
}

function handleDbError(res, err, uniqueMessage) {
  if (err.code === '23505' && uniqueMessage) {
    return res.status(400).json({ error: uniqueMessage });
  }
  console.error('Database error:', err);
  return res.status(500).json({ error: 'Something went wrong' });
}

// Deep-link endpoint for adding feeds from external sites
app.get('/add', (req, res) => {
  const feedUrl = req.query.url;
  if (feedUrl) {
    const check = validateFeedUrl(feedUrl);
    if (!check.valid) {
      return res.status(400).send('Invalid feed URL');
    }
  }
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use(express.static('public'));

// Initialize
(async () => {
  try {
    await initDatabase();
    await backfillDedupeKeys();
    startScheduler();
  } catch (err) {
    console.error('Startup error - database unavailable:', err.message);
  }
})();

// API Routes

// Resolves the SYOS client id, used as the default when a request omits one so
// the pre-client single-workspace behaviour keeps working.
async function defaultClientId() {
  const r = await query("SELECT id FROM clients WHERE name = 'SYOS'");
  return r.rows[0] ? r.rows[0].id : null;
}

// True only for a plain integer within Postgres int4 range. Guards against
// all-digit values that pass /^\d+$/ but overflow int4 — feeding one straight
// to pg throws, and if that throw is awaited outside a try/catch it becomes an
// unhandled rejection that takes the process down.
function isPgInt(raw) {
  return /^\d+$/.test(String(raw)) && Number(raw) <= 2147483647;
}

// Parses a request-supplied list of feed ids. Returns an array of ints, or null
// if the payload isn't an array of valid pg ints (so the handler can 400 rather
// than feed garbage to a query). Caps the list length as a cheap abuse guard.
function parseFeedIds(raw) {
  if (!Array.isArray(raw) || raw.length > 1000) return null;
  const ids = [];
  for (const v of raw) {
    if (!isPgInt(v)) return null;
    ids.push(Number(v));
  }
  return ids;
}

// Returns a valid client id for a request-supplied value: the default when
// absent, or null when the value is invalid or names no existing client
// (so the handler can 400 rather than write an orphan row or crash).
async function resolveClientId(raw) {
  if (raw === undefined || raw === null || raw === '') return await defaultClientId();
  if (!isPgInt(raw)) return null;
  const r = await query('SELECT id FROM clients WHERE id = $1', [raw]);
  return r.rows[0] ? r.rows[0].id : null;
}

// Clients
app.get('/api/clients', async (req, res) => {
  try {
    const result = await query(`
      SELECT cl.id, cl.name, cl.email,
        (SELECT COUNT(*)::int FROM articles a
           JOIN feeds f ON a.feed_id = f.id
          WHERE f.client_id = cl.id AND a.read = FALSE) AS unread_count
      FROM clients cl ORDER BY cl.name
    `);
    res.json(result.rows);
  } catch (err) {
    handleDbError(res, err);
  }
});

app.post('/api/clients', async (req, res) => {
  const { name, email } = req.body || {};
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 255) {
    return res.status(400).json({ error: 'Client name must be between 1 and 255 characters' });
  }
  if (email != null && (typeof email !== 'string' || email.length > 320)) {
    return res.status(400).json({ error: 'Email must be 320 characters or fewer' });
  }
  try {
    const result = await query(
      'INSERT INTO clients (name, email) VALUES ($1, $2) RETURNING *',
      [name.trim(), email ? email.trim() : null]
    );
    res.json(result.rows[0]);
  } catch (err) {
    handleDbError(res, err, 'Client already exists');
  }
});

app.patch('/api/clients/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid client id' });
  const { email } = req.body || {};
  if (email != null && (typeof email !== 'string' || email.length > 320)) {
    return res.status(400).json({ error: 'Email must be 320 characters or fewer' });
  }
  try {
    const result = await query(
      'UPDATE clients SET email = $1 WHERE id = $2 RETURNING *',
      [email ? email.trim() : null, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json(result.rows[0]);
  } catch (err) {
    handleDbError(res, err);
  }
});

// Categories (topics within a client)
app.post('/api/categories', async (req, res) => {
  const { name, clientId } = req.body;
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 255) {
    return res.status(400).json({ error: 'Category name must be between 1 and 255 characters' });
  }
  const resolvedClient = await resolveClientId(clientId);
  if (!resolvedClient) return res.status(400).json({ error: 'Valid clientId is required' });
  try {
    const result = await query(
      'INSERT INTO categories (name, client_id) VALUES ($1, $2) RETURNING *',
      [name.trim(), resolvedClient]
    );
    res.json(result.rows[0]);
  } catch (err) {
    handleDbError(res, err, 'Category already exists for this client');
  }
});

app.get('/api/categories', async (req, res) => {
  const { clientId } = req.query;
  const params = [];
  let where = '';
  if (clientId !== undefined) {
    if (!/^\d+$/.test(clientId)) return res.status(400).json({ error: 'clientId must be numeric' });
    params.push(clientId);
    where = 'WHERE client_id = $1';
  }
  try {
    const result = await query(`SELECT * FROM categories ${where} ORDER BY name`, params);
    res.json(result.rows);
  } catch (err) {
    handleDbError(res, err);
  }
});

// Topic toggle = bulk setter: set the topic's flag AND every feed under it, so
// one click moves a whole topic in/out while per-feed flags remain the truth.
app.patch('/api/categories/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid category id' });
  const { in_digest } = req.body || {};
  if (typeof in_digest !== 'boolean') {
    return res.status(400).json({ error: 'in_digest must be true or false' });
  }
  try {
    const result = await query(
      'UPDATE categories SET in_digest = $1 WHERE id = $2 RETURNING *',
      [in_digest, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Category not found' });
    await query('UPDATE feeds SET in_digest = $1 WHERE category_id = $2', [in_digest, req.params.id]);
    res.json(result.rows[0]);
  } catch (err) {
    handleDbError(res, err);
  }
});

// Feeds
app.post('/api/feeds', async (req, res) => {
  const { url, title, categoryId, clientId } = req.body;
  const check = validateFeedUrl(url);
  if (!check.valid) {
    return res.status(400).json({ error: check.reason });
  }
  if (title && (typeof title !== 'string' || title.length > 255)) {
    return res.status(400).json({ error: 'Title must be 255 characters or fewer' });
  }
  const resolvedClient = await resolveClientId(clientId);
  if (!resolvedClient) return res.status(400).json({ error: 'Valid clientId is required' });
  // Validate categoryId if given: numeric, in range, and belonging to this
  // client (so a feed can't be filed under another client's topic).
  let resolvedCategory = null;
  if (categoryId !== undefined && categoryId !== null && categoryId !== '') {
    if (!isPgInt(categoryId)) return res.status(400).json({ error: 'categoryId must be numeric' });
    const cat = await query('SELECT id FROM categories WHERE id = $1 AND client_id = $2', [categoryId, resolvedClient]);
    if (!cat.rows.length) return res.status(400).json({ error: 'categoryId must belong to the selected client' });
    resolvedCategory = cat.rows[0].id;
  }
  try {
    const result = await query(
      'INSERT INTO feeds (url, title, category_id, client_id) VALUES ($1, $2, $3, $4) RETURNING *',
      [url, title || url, resolvedCategory, resolvedClient]
    );
    res.json(result.rows[0]);
  } catch (err) {
    handleDbError(res, err, 'Feed already exists');
  }
});

app.get('/api/feeds', async (req, res) => {
  try {
    const result = await query(`
      SELECT f.*, c.name as category, c.in_digest as category_in_digest, cl.name as client,
        (SELECT COUNT(*)::int FROM articles a WHERE a.feed_id = f.id AND a.read = FALSE) AS unread_count
      FROM feeds f
      LEFT JOIN categories c ON f.category_id = c.id
      LEFT JOIN clients cl ON f.client_id = cl.id
      ORDER BY cl.name, c.name, f.title
    `);
    res.json(result.rows);
  } catch (err) {
    handleDbError(res, err);
  }
});

// Per-feed digest toggle — the source of truth for the emailed digest.
app.patch('/api/feeds/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid feed id' });
  const { in_digest } = req.body || {};
  if (typeof in_digest !== 'boolean') {
    return res.status(400).json({ error: 'in_digest must be true or false' });
  }
  try {
    const result = await query(
      'UPDATE feeds SET in_digest = $1 WHERE id = $2 RETURNING *',
      [in_digest, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Feed not found' });
    res.json(result.rows[0]);
  } catch (err) {
    handleDbError(res, err);
  }
});

app.delete('/api/feeds/:id', async (req, res) => {
  try {
    await query('DELETE FROM feeds WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    handleDbError(res, err);
  }
});

// Alert rules (per-client priority watch terms)
app.get('/api/alert-rules', async (req, res) => {
  const { clientId } = req.query;
  const params = [];
  let where = '';
  if (clientId !== undefined) {
    if (!/^\d+$/.test(clientId)) return res.status(400).json({ error: 'clientId must be numeric' });
    params.push(clientId);
    where = 'WHERE r.client_id = $1';
  }
  try {
    const result = await query(
      `SELECT r.id, r.client_id, r.term, r.enabled, r.created_at, cl.name AS client
         FROM alert_rules r JOIN clients cl ON cl.id = r.client_id
         ${where} ORDER BY cl.name, r.term`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    handleDbError(res, err);
  }
});

app.post('/api/alert-rules', async (req, res) => {
  const { term, clientId } = req.body || {};
  if (typeof term !== 'string' || term.trim().length === 0 || term.length > 255) {
    return res.status(400).json({ error: 'Watch term must be between 1 and 255 characters' });
  }
  const resolvedClient = await resolveClientId(clientId);
  if (!resolvedClient) return res.status(400).json({ error: 'Valid clientId is required' });
  try {
    const result = await query(
      'INSERT INTO alert_rules (client_id, term) VALUES ($1, $2) RETURNING *',
      [resolvedClient, term.trim()]
    );
    res.json(result.rows[0]);
  } catch (err) {
    handleDbError(res, err, 'That watch term already exists for this client');
  }
});

app.patch('/api/alert-rules/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid rule id' });
  const { enabled } = req.body || {};
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled must be true or false' });
  }
  try {
    const result = await query(
      'UPDATE alert_rules SET enabled = $1 WHERE id = $2 RETURNING *',
      [enabled, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Rule not found' });
    res.json(result.rows[0]);
  } catch (err) {
    handleDbError(res, err);
  }
});

app.delete('/api/alert-rules/:id', async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid rule id' });
  try {
    await query('DELETE FROM alert_rules WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    handleDbError(res, err);
  }
});

// Manual trigger for a priority-alert scan (fetches, then scans new articles).
app.post('/api/trigger-alerts', expensiveLimiter, async (req, res) => {
  const result = await triggerAlertsNow();
  if (result.error && !result.perClient) console.error('Alert scan error:', result.error);
  res.json(result);
});

// Articles
// Builds SQL conditions from feedId/categoryId query params ("none" = no category).
// Returns null if a param is present but not numeric, so handlers can 400 instead
// of passing garbage to pg (an unhandled query rejection would kill the process).
function articleFilter(queryParams) {
  const { feedId, categoryId, clientId } = queryParams;
  const conditions = [];
  const params = [];
  if (clientId !== undefined) {
    if (!/^\d+$/.test(clientId)) return null;
    params.push(clientId);
    conditions.push(`f.client_id = $${params.length}`);
  }
  if (feedId !== undefined) {
    if (!/^\d+$/.test(feedId)) return null;
    params.push(feedId);
    conditions.push(`f.id = $${params.length}`);
  }
  if (categoryId !== undefined) {
    if (categoryId === 'none') {
      conditions.push('f.category_id IS NULL');
    } else if (/^\d+$/.test(categoryId)) {
      params.push(categoryId);
      conditions.push(`f.category_id = $${params.length}`);
    } else {
      return null;
    }
  }
  return { conditions, params };
}

app.get('/api/articles', async (req, res) => {
  const filter = articleFilter(req.query);
  if (!filter) {
    return res.status(400).json({ error: 'clientId, feedId and categoryId must be numeric' });
  }
  const where = filter.conditions.length ? `WHERE ${filter.conditions.join(' AND ')}` : '';
  try {
    const result = await query(`
      SELECT
        a.id, a.title, a.url, a.description, a.published_at, a.read,
        f.id as feed_id, f.title as feed_title, f.client_id,
        c.name as category, cl.name as client,
        (SELECT COUNT(*)::int FROM article_feed_hits h WHERE h.article_id = a.id) AS hit_count,
        (SELECT string_agg(f2.title, ', ' ORDER BY f2.title)
           FROM article_feed_hits h
           JOIN feeds f2 ON f2.id = h.feed_id
          WHERE h.article_id = a.id) AS seen_in
      FROM articles a
      JOIN feeds f ON a.feed_id = f.id
      LEFT JOIN categories c ON f.category_id = c.id
      LEFT JOIN clients cl ON f.client_id = cl.id
      ${where}
      ORDER BY a.published_at DESC
      LIMIT 200
    `, filter.params);
    res.json(result.rows);
  } catch (err) {
    handleDbError(res, err);
  }
});

app.patch('/api/articles/mark-all-read', async (req, res) => {
  const filter = articleFilter(req.query);
  if (!filter) {
    return res.status(400).json({ error: 'clientId, feedId and categoryId must be numeric' });
  }
  const scope = filter.conditions.length ? `AND ${filter.conditions.join(' AND ')}` : '';
  try {
    await query(`
      UPDATE articles a SET read = TRUE
      FROM feeds f
      WHERE a.feed_id = f.id AND a.read = FALSE ${scope}
    `, filter.params);
    res.json({ success: true });
  } catch (err) {
    handleDbError(res, err);
  }
});

app.patch('/api/articles/:id/read', async (req, res) => {
  try {
    await query('UPDATE articles SET read = TRUE WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    handleDbError(res, err);
  }
});

// Manual trigger for digest
app.post('/api/trigger-digest', expensiveLimiter, async (req, res) => {
  const result = await triggerDigestNow();
  // Always return the detail (per-client sends + any errors) so the UI can show
  // the real reason a digest didn't arrive instead of a false success.
  if (result.error && !result.perClient) console.error('Digest error:', result.error);
  res.json(result);
});

// Fetch feeds manually. With no body → fetch all (the "Fetch Now" button). With
// { feedIds: [...] } → pull only those feeds (the sidebar "Pull selected" action).
app.post('/api/fetch-feeds', selectionLimiter, async (req, res) => {
  let feedIds = null;
  if (req.body && req.body.feedIds !== undefined) {
    feedIds = parseFeedIds(req.body.feedIds);
    if (!feedIds) return res.status(400).json({ error: 'feedIds must be an array of numeric feed ids' });
  }
  try {
    const stats = await fetchFeeds(feedIds && feedIds.length ? feedIds : null);
    res.json({ success: true, feeds: feedIds ? feedIds.length : 'all', ...(stats || {}) });
  } catch (err) {
    console.error('Fetch feeds error:', err);
    res.status(500).json({ error: 'Feed fetch failed - check server logs' });
  }
});

// Email just the unread articles surfaced by a chosen set of feeds, grouped per
// client. The sidebar "Email selected" action.
app.post('/api/send-selection', selectionLimiter, async (req, res) => {
  const feedIds = parseFeedIds(req.body && req.body.feedIds);
  if (!feedIds || feedIds.length === 0) {
    return res.status(400).json({ error: 'Select at least one feed to email' });
  }
  const result = await sendSelectionNow(feedIds);
  if (result.error && !result.perClient) console.error('Send-selection error:', result.error);
  res.json(result);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
