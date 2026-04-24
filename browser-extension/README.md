# Add to RSS Reader - Browser Extension

A convenient browser extension that allows you to add RSS feeds to your RSS Reader with a single click. Detects feeds on any webpage and provides a quick interface to subscribe.

## Features

- **Automatic Feed Detection**: Detects RSS feeds on webpages via `<link rel="alternate">` tags and common feed URL patterns
- **One-Click Subscribe**: Add detected feeds or custom feed URLs with a single click
- **Deep-Link Integration**: Opens your RSS Reader with pre-filled form when you click "Add Feed"
- **Configurable Reader URL**: Set your custom RSS Reader instance URL (defaults to production)
- **Quick Settings**: Easy-to-access settings panel to configure your reader URL
- **Visual Feedback**: Loading states and success/error messages for all actions

## Installation

### From Source (Development)

1. Clone or download this repository
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable "Developer mode" (toggle in top-right corner)
4. Click "Load unpacked"
5. Select the `browser-extension` folder
6. The extension will appear in your Chrome toolbar

### Firefox (Compatible)

1. Open Firefox and navigate to `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select the `manifest.json` file from the `browser-extension` folder
4. The extension will appear in your Firefox toolbar

## Usage

### First Time Setup

1. Click the extension icon in your browser toolbar
2. Click the ⚙️ Settings button
3. Enter your RSS Reader URL (example: `https://rssfeed-production-8f03.up.railway.app`)
4. Click "Save Settings"

### Adding Feeds

#### From Detected Feeds
1. Visit a website with RSS feeds
2. Click the extension icon
3. You'll see a list of feeds detected on the page
4. Click the "+ Add" button next to any feed
5. Your RSS Reader will open with the feed pre-filled and ready to add

#### From Custom URL
1. Click the extension icon
2. Paste your RSS feed URL in the "Add a custom feed URL" field
3. Click "Add Feed"
4. Your RSS Reader will open with the URL pre-filled

### Keyboard Shortcut
- Press **Enter** in the custom URL field to quickly add a feed

## File Structure

```
browser-extension/
├── manifest.json          # Extension metadata and permissions
├── popup.html             # Extension popup UI
├── popup.js               # Popup logic and feed management
├── content.js             # Feed detection script (runs on all pages)
├── background.js          # Service worker for background tasks
├── styles.css             # Popup styling
├── icons/
│   ├── icon-16.svg       # Toolbar icon (16x16)
│   ├── icon-48.svg       # Settings icon (48x48)
│   └── icon-128.svg      # Chrome Web Store icon (128x128)
└── README.md             # This file
```

## How It Works

1. **Content Script** (`content.js`): 
   - Runs on every webpage
   - Detects RSS feeds by looking for `<link rel="alternate">` tags
   - Also searches for common feed patterns in URLs and link text
   - Stores detected feeds in browser session storage

2. **Popup** (`popup.html`/`popup.js`):
   - Shows detected feeds from the current page
   - Provides input field for custom feed URLs
   - Manages user settings (reader URL)
   - Validates URLs before adding
   - Opens the reader with the deep-link API

3. **Deep-Link API** (in main application):
   - Endpoint: `GET /add?url=<feed-url>&title=<optional-title>`
   - Pre-fills the feed form with the URL
   - Auto-opens the add feed modal
   - User can then edit title and category before adding

4. **Service Worker** (`background.js`):
   - Handles message passing between scripts
   - Manages tab operations

## Settings

The extension stores one setting in `chrome.storage.sync`:
- **readerUrl**: The URL of your RSS Reader instance (defaults to `https://rssfeed-production-8f03.up.railway.app`)

This setting syncs across devices if you're logged into Chrome.

## Permissions Explained

- **`activeTab`**: Required to detect feeds on the current webpage
- **`scripting`**: Required to inject content script for feed detection
- **`storage`**: Required to store your reader URL preference
- **`<all_urls>`**: Required to run on all websites and detect feeds

## Detected Feed Patterns

The extension detects feeds using:
- HTML link tags: `<link rel="alternate" type="application/rss+xml">`
- Common URL patterns: `/feed`, `/rss`, `atom.xml`, etc.
- Link text indicators: Pages with "RSS", "Feed", "Subscribe" text

## Troubleshooting

### No feeds detected on a page
- Not all websites expose their RSS feeds
- Some sites may have feeds at alternative URLs (check the site's help/about page)
- You can always paste the feed URL directly in the custom URL field

### Settings not saving
- Make sure you've granted the extension storage permissions
- Try clicking "Save Settings" again
- Clear your browser cache if issues persist

### Extension not appearing
- Check that the extension is enabled in `chrome://extensions/`
- Try reloading the extension using the refresh button
- For Firefox, make sure you reload the temporary add-on

## Future Enhancements

- Keyboard shortcut support for quick feed detection
- Context menu option to add feeds
- Support for alternative feed formats (JSON Feed, etc.)
- Extension options page with more customization
- Integration with your reader's API for direct subscription (without opening tabs)

## Support

For issues or feature requests related to the extension, please check the main repository's issues page.
