// Detect all RSS feed links on the page
function detectFeeds() {
  const feeds = [];

  // Look for link rel="alternate" type="application/rss+xml"
  const links = document.querySelectorAll('link[rel*="alternate"][type*="rss"], link[rel*="alternate"][type*="feed"]');

  links.forEach(link => {
    const url = link.href;
    const title = link.title || document.title;

    if (url && isValidFeedUrl(url)) {
      feeds.push({ url, title });
    }
  });

  // Also check for common RSS feed patterns in links
  const allLinks = document.querySelectorAll('a');
  allLinks.forEach(link => {
    const href = link.href || '';
    const text = link.textContent.toLowerCase();

    // Look for common feed indicators in URL or link text
    if ((href.includes('/feed') || href.includes('/rss') || href.includes('atom.xml') ||
         text.includes('rss') || text.includes('feed') || text.includes('subscribe')) &&
        (href.endsWith('.xml') || href.includes('feed') || href.includes('rss'))) {

      // Make sure it's not already in our list
      if (!feeds.some(f => f.url === href) && isValidFeedUrl(href)) {
        feeds.push({ url: href, title: link.textContent.trim() || document.title });
      }
    }
  });

  return feeds;
}

// Validate that a URL looks like a feed
function isValidFeedUrl(url) {
  if (!url || typeof url !== 'string') return false;

  try {
    new URL(url);
  } catch {
    return false;
  }

  // Check for common feed patterns
  const lowerUrl = url.toLowerCase();
  return lowerUrl.includes('feed') || lowerUrl.includes('rss') ||
         lowerUrl.includes('atom') || lowerUrl.endsWith('.xml');
}

// Store detected feeds in browser storage
function storeDetectedFeeds(feeds) {
  chrome.storage.session.set({ detectedFeeds: feeds });
}

// Handle messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getDetectedFeeds') {
    const feeds = detectFeeds();
    storeDetectedFeeds(feeds);
    sendResponse({ feeds });
  }
});

// Detect feeds on page load and store them
const feeds = detectFeeds();
storeDetectedFeeds(feeds);

// Also listen for dynamic content changes (optional, for SPAs)
const observer = new MutationObserver((mutations) => {
  const updatedFeeds = detectFeeds();
  storeDetectedFeeds(updatedFeeds);
});

observer.observe(document.head, { childList: true, subtree: true });
