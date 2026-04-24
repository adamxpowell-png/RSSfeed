// Service Worker for handling background tasks and messaging

// Initialize extension on first install
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // Open welcome/settings page on first install
    chrome.tabs.create({
      url: chrome.runtime.getURL('popup.html')
    });
  }
});

// Listen for messages from content scripts and popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'openReader') {
    // Open the reader URL in a new tab
    chrome.tabs.create({ url: request.url });
    sendResponse({ success: true });
  }
});

// Handle extension icon click - it will show the popup.html automatically
// via the manifest "action" configuration
