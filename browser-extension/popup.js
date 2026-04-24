// Default RSS Reader URL
const DEFAULT_READER_URL = 'https://rssfeed-production-8f03.up.railway.app';

// Load detected feeds and display them
async function loadDetectedFeeds() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  chrome.tabs.sendMessage(tab.id, { action: 'getDetectedFeeds' }, (response) => {
    if (response && response.feeds && response.feeds.length > 0) {
      displayDetectedFeeds(response.feeds);
    }
  });
}

// Display detected feeds in the popup
function displayDetectedFeeds(feeds) {
  const feedsList = document.getElementById('feedsList');
  const detectedSection = document.getElementById('detectedFeeds');

  if (feeds.length === 0) {
    detectedSection.style.display = 'none';
    return;
  }

  detectedSection.style.display = 'block';
  feedsList.innerHTML = feeds.map(feed => `
    <div class="feed-item">
      <div class="feed-info">
        <div class="feed-title">${feed.title || 'Unnamed Feed'}</div>
        <div class="feed-url">${feed.url}</div>
      </div>
      <button onclick="addFeed('${feed.url}', '${(feed.title || '').replace(/'/g, "\\'")}')" title="Add this feed">+ Add</button>
    </div>
  `).join('');
}

// Get the reader URL from storage
async function getReaderUrl() {
  return new Promise((resolve) => {
    chrome.storage.sync.get('readerUrl', (result) => {
      resolve(result.readerUrl || DEFAULT_READER_URL);
    });
  });
}

// Add a feed to the reader
async function addFeed(url, title = '') {
  const readerUrl = await getReaderUrl();

  // Validate URL
  try {
    new URL(url);
  } catch (err) {
    showStatus('Invalid feed URL', 'error');
    return;
  }

  // Show loading state
  showStatus('Adding feed...', 'loading');

  // Construct the deep-link URL
  const addUrl = new URL('/add', readerUrl);
  addUrl.searchParams.set('url', url);
  if (title) {
    addUrl.searchParams.set('title', title);
  }

  // Open the reader with the pre-filled form in a new tab
  chrome.tabs.create({ url: addUrl.toString() });

  // Show success message
  showStatus('Feed added! Check your reader.', 'success');

  // Clear the input after a brief delay
  setTimeout(() => {
    document.getElementById('customUrl').value = '';
    setTimeout(() => {
      showStatus('', 'success');
    }, 2000);
  }, 1500);
}

// Display status message
function showStatus(message, type = '') {
  const statusEl = document.getElementById('status');
  statusEl.textContent = message;
  statusEl.className = `status-message ${type}`;
  statusEl.style.display = message ? 'block' : 'none';
}

// Add feed button click handler
document.getElementById('addButton').addEventListener('click', () => {
  const url = document.getElementById('customUrl').value.trim();
  if (!url) {
    showStatus('Please enter a feed URL', 'error');
    return;
  }
  addFeed(url);
});

// Settings button handler
document.getElementById('settingsButton').addEventListener('click', () => {
  document.getElementById('main').style.display = 'none';
  document.getElementById('settings').style.display = 'block';

  // Load current URL
  getReaderUrl().then(url => {
    document.getElementById('readerUrl').value = url;
  });
});

// Back button handler
document.getElementById('backButton').addEventListener('click', () => {
  document.getElementById('settings').style.display = 'none';
  document.getElementById('main').style.display = 'block';
});

// Save settings handler
document.getElementById('saveSettings').addEventListener('click', () => {
  const url = document.getElementById('readerUrl').value.trim();

  if (!url) {
    showStatus('Please enter a URL', 'error');
    return;
  }

  // Validate URL
  try {
    new URL(url);
  } catch (err) {
    showStatus('Invalid URL format', 'error');
    return;
  }

  // Save to storage
  chrome.storage.sync.set({ readerUrl: url }, () => {
    showStatus('Settings saved!', 'success');
    setTimeout(() => {
      document.getElementById('settings').style.display = 'none';
      document.getElementById('main').style.display = 'block';
      showStatus('', 'success');
    }, 1500);
  });
});

// Allow Enter key to submit custom URL
document.getElementById('customUrl').addEventListener('keypress', (e) => {
  if (e.key === 'Enter') {
    document.getElementById('addButton').click();
  }
});

// Load detected feeds when popup opens
document.addEventListener('DOMContentLoaded', loadDetectedFeeds);
