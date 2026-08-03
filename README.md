# RSS Feed Reader

A simple, self-hosted RSS feed monitoring tool with daily email digests via Resend.

## Features

- Subscribe to multiple RSS feeds organized by categories
- Automatic daily email digests of unread articles
- Simple web interface to manage feeds and read articles
- Mark articles as read
- Self-hosted on Railway

## Setup

### Local Development

1. **Clone and install:**
   ```bash
   npm install
   ```

2. **Create `.env` file:**
   ```bash
   cp .env.example .env
   ```

3. **Fill in your environment variables:**
   - `DATABASE_URL`: PostgreSQL connection string
   - `RESEND_API_KEY`: Your Resend API key from [resend.com](https://resend.com)
   - `EMAIL_FROM`: Sender email (e.g., noreply@yourdomain.com)
   - `EMAIL_TO`: Your email address for digests
   - `PORT`: Server port (default: 3000)
   - `APP_PASSWORD`: Access password (required in production - without it the app runs unauthenticated)
   - `SESSION_SECRET`: Random string used to sign login cookies
   - `APP_NAME`: Instance name shown in the UI and digest emails (optional)
   - `APP_COLOR`: Accent colour hex for the UI (optional)
   - `APP_URL`: Public URL of this instance, used in digest email footer

4. **Run locally:**
   ```bash
   npm run dev
   ```

5. **Open:** `http://localhost:3000`

### Railway Deployment

1. **Push to GitHub:**
   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git remote add origin https://github.com/YOUR_USERNAME/rss-feed-reader.git
   git push -u origin main
   ```

2. **Connect to Railway:**
   - Go to [railway.app](https://railway.app)
   - Click "New Project"
   - Select "Deploy from GitHub"
   - Connect your repo
   - Railway will auto-detect Node.js

3. **Add services:**
   - Click "+ Add Service"
   - Select "PostgreSQL"
   - Railway auto-creates `DATABASE_URL` env var

4. **Set environment variables** in Railway dashboard:
   - `RESEND_API_KEY`: Your Resend API key
   - `EMAIL_FROM`: Your from address
   - `EMAIL_TO`: Your email for digests
   - `NODE_ENV`: production

5. **Deploy:** Railway auto-deploys on push to main

## Usage

### Web Interface
- **Add Feed**: Click "+ Add Feed" button, paste RSS URL, select category
- **Manage Categories**: Click "+ Add Category" to organize feeds
- **Fetch Feeds**: Click "Fetch Now" to manually update feeds
- **Read Articles**: Articles appear in feed, click title to read
- **Daily Digest**: Automatically sent at 8 AM UTC (configure in `src/scheduler.js`)
- **Send Now**: Click "Send Digest" to manually trigger email

### Deep-Link API Endpoint

Add feeds from external websites and applications using the `/add` endpoint:

```
GET /add?url=<feed-url>&title=<optional-title>
```

**Example:**
```
https://yourdomain.com/add?url=https://example.com/feed.xml
https://yourdomain.com/add?url=https://news.ycombinator.com/rss&title=Hacker%20News
```

The endpoint serves the main page with the feed URL pre-filled in the form and the add feed modal automatically opened.

### Browser Extension

Install the "Add to RSS Reader" browser extension for one-click feed subscription:

1. **Load the extension:**
   - Chrome: `chrome://extensions` → Enable "Developer mode" → "Load unpacked" → Select `browser-extension` folder
   - Firefox: `about:debugging` → "Load Temporary Add-on" → Select `browser-extension/manifest.json`

2. **Configure your reader URL:**
   - Click extension icon → Settings → Enter your reader URL (defaults to production instance)

3. **Add feeds:**
   - Visit any website with RSS feeds
   - Click extension icon to see detected feeds
   - Click "+ Add" next to any feed or paste a custom URL
   - Your reader opens with the feed pre-filled

See `browser-extension/README.md` for detailed documentation.

### API Endpoints

- `GET /add` - Deep-link endpoint for adding feeds from external sites
- `POST /api/feeds` - Add feed
- `GET /api/feeds` - List feeds
- `DELETE /api/feeds/:id` - Remove feed
- `POST /api/categories` - Add category
- `GET /api/categories` - List categories
- `GET /api/articles` - List articles
- `PATCH /api/articles/:id/read` - Mark article read
- `POST /api/fetch-feeds` - Manually fetch all feeds
- `POST /api/trigger-digest` - Manually send digest email

## Security

- **Authentication**: Set `APP_PASSWORD` to require sign-in (`READER_PASSWORD` is accepted as a fallback for existing deployments). Login sets a signed, HttpOnly cookie valid for 30 days. In production the API returns 503 if no password is configured (fail-closed); in development it runs open.
- **Rate limiting**: 300 requests/15 min globally, 10 login attempts/15 min, 5 digest/fetch triggers per hour.
- **Feed URL validation**: Only http/https feeds are accepted; private and internal hosts (localhost, 10.x, 192.168.x, 169.254.x, etc.) are rejected to prevent SSRF.
- **XSS protection**: All feed content is HTML-escaped in the web UI and digest emails; only http/https article links are rendered.
- **Headers**: `helmet` sets standard security headers including a CSP.

## Running Multiple Client Instances

Each client gets a fully isolated instance (own database, password, branding, digest recipient) deployed from this same repo:

1. In Railway, create a **new service** from the same GitHub repo
2. Add a **new PostgreSQL** service for it
3. Set environment variables on the new service:
   - `DATABASE_URL` = `${{Postgres-2.DATABASE_URL}}` (reference the new Postgres service)
   - `APP_PASSWORD` = unique password for this client
   - `SESSION_SECRET` = unique random string
   - `APP_NAME` = client's brand name (shown in UI and digest emails)
   - `APP_COLOR` = client's accent colour (optional)
   - `EMAIL_TO` = client's digest recipient
   - `EMAIL_FROM`, `RESEND_API_KEY` = shared or per-client
   - `APP_URL` = the new service's public domain
   - `NODE_ENV` = production
4. Generate a public domain for the new service
5. Pushing to `main` deploys **all** instances - one codebase, isolated data

## Customization

### Change digest time
Edit `src/scheduler.js` line 6:
```javascript
schedule.scheduleJob('0 8 * * *', async () => { // Change "8" to desired hour
```

### Change article limit
Edit `src/server.js` in `/api/articles` route:
```javascript
LIMIT 200 // Change to desired number
```

## Notes

- Articles older than those fetched are kept in database
- Daily digest marks all articles as read automatically
- Requires valid PostgreSQL database and Resend account
