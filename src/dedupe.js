import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Article de-duplication.
//
// The reader aggregates many keyword feeds (Google Alerts, Google News, Bing
// News, Talkwalker) that deliberately overlap: one story about SYOS can arrive
// via ten different SKU alerts. The old UNIQUE(feed_id, url) constraint only
// stopped a feed repeating itself, so overlap showed up as ten near-identical
// cards.
//
// Two keys are derived per item:
//   urlKey   - hash of the canonical destination URL, after unwrapping
//              redirectors and stripping tracking params. Catches the same
//              article arriving through different alert wrappers.
//   titleKey - hash of the normalised headline. Catches wire copy syndicated
//              across outlets, where the URLs genuinely differ.
//
// A match on EITHER key inside the dedupe window means "same story".
// ---------------------------------------------------------------------------

// Params that never change which article you are looking at.
const TRACKING_PARAMS = [
  /^utm_/i, /^pk_/i, /^mc_/i, /^at_/i,
  /^fbclid$/i, /^gclid$/i, /^dclid$/i, /^msclkid$/i, /^igshid$/i, /^twclid$/i,
  /^ito$/i, /^ocid$/i, /^cmpid$/i, /^cmp$/i, /^smid$/i, /^partner$/i,
  /^ref$/i, /^ref_src$/i, /^referrer$/i, /^source$/i, /^src$/i, /^s$/i,
  /^oc$/i, /^hl$/i, /^gl$/i, /^ceid$/i, /^rct$/i, /^sa$/i, /^ct$/i, /^cd$/i,
  /^usg$/i, /^ved$/i, /^ei$/i, /^aid$/i, /^tid$/i, /^sid$/i, /^mid$/i,
  /^guccounter$/i, /^guce_referrer/i, /^outputtype$/i, /^amp$/i,
];

// Query params used by wrappers to carry the real destination.
const REDIRECT_PARAMS = ['url', 'u', 'q', 'target', 'link', 'dest', 'redirect'];

const MAX_UNWRAP_DEPTH = 5;

function isHttpUrl(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value);
}

// Google News RSS links are opaque (/rss/articles/CBMi...). Older-format items
// embed the source URL as readable bytes inside the base64 payload; newer
// protobuf items do not. Best effort — null when the URL is not recoverable.
export function decodeGoogleNewsLink(rawUrl) {
  try {
    const { hostname, pathname } = new URL(rawUrl);
    if (!/(^|\.)news\.google\.com$/i.test(hostname)) return null;
    const segment = pathname.split('/').filter(Boolean).pop();
    if (!segment || segment.length < 16) return null;
    const decoded = Buffer.from(
      segment.replace(/-/g, '+').replace(/_/g, '/'),
      'base64'
    ).toString('latin1');
    const match = decoded.match(/https?:\/\/[^\s"'\\\x00-\x1f]+/);
    return match ? match[0] : null;
  } catch {
    return null;
  }
}

// Follow wrapper links (Google Alerts google.com/url?url=,
// Bing news/apiclick.aspx?url=, Talkwalker and friends) to the real article.
function unwrap(rawUrl, depth = 0) {
  if (depth >= MAX_UNWRAP_DEPTH) return rawUrl;

  const gnews = decodeGoogleNewsLink(rawUrl);
  if (gnews && gnews !== rawUrl) return unwrap(gnews, depth + 1);

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  for (const param of REDIRECT_PARAMS) {
    const value = parsed.searchParams.get(param);
    if (isHttpUrl(value) && value !== rawUrl) return unwrap(value, depth + 1);
  }

  return rawUrl;
}

// Reduce a URL to the thing that identifies the article, and nothing else.
export function canonicalUrl(rawUrl) {
  if (!isHttpUrl(rawUrl)) return null;

  let parsed;
  try {
    parsed = new URL(unwrap(rawUrl));
  } catch {
    return null;
  }

  // A link we could not unwrap past the aggregator is not a stable identity.
  if (/(^|\.)news\.google\.com$/i.test(parsed.hostname)) return null;

  parsed.protocol = 'https:';
  parsed.hash = '';
  parsed.hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (parsed.port === '80' || parsed.port === '443') parsed.port = '';

  for (const key of [...parsed.searchParams.keys()]) {
    if (TRACKING_PARAMS.some((pattern) => pattern.test(key))) {
      parsed.searchParams.delete(key);
    }
  }
  parsed.searchParams.sort();

  // Collapse AMP variants onto the canonical article.
  parsed.pathname = parsed.pathname
    .replace(/\/amp\/?$/i, '')
    .replace(/\.amp$/i, '')
    .replace(/\/+$/, '');
  if (parsed.pathname === '') parsed.pathname = '/';

  const search = parsed.searchParams.toString();
  return `${parsed.hostname}${parsed.pathname}${search ? `?${search}` : ''}`;
}

// Strip a headline back to its words, so the same story titled slightly
// differently by two outlets still collides.
export function normaliseTitle(rawTitle) {
  if (typeof rawTitle !== 'string') return '';

  return rawTitle
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/gi, ' ')
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    // Trailing publication credit: "Headline - Reuters", "Headline | Sky News"
    .replace(/\s+[-|–—·]\s+[^-|–—·]{1,40}$/u, '')
    // Content-farm year stamps: "Headline (2026)"
    .replace(/\s*\((?:19|20)\d{2}\)\s*$/u, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .slice(0, 120)
    .trim();
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

// Titles shorter than this are too generic to merge on safely
// ("Weekly roundup", "Newsletter"), so they fall back to URL identity only.
const MIN_TITLE_KEY_LENGTH = 25;

export function dedupeKeys({ url, title }) {
  const canonical = canonicalUrl(url);
  const normalised = normaliseTitle(title);

  return {
    urlKey: canonical ? sha1(canonical) : null,
    titleKey: normalised.length >= MIN_TITLE_KEY_LENGTH ? sha1(normalised) : null,
  };
}
