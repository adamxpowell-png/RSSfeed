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
