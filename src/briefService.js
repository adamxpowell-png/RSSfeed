import { query } from './database.js';

// Export-to-brief: a client's coverage over a date range, grouped by topic, as a
// CSG-branded document. One renderer produces either a print-ready HTML page
// (Save-as-PDF in the browser) or a Word-openable .doc (HTML the MS Office way,
// so there is NO new dependency and the file is still fully editable in Word).

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return value;
  } catch {}
  return '#';
}

// YYYY-MM-DD only. Returns null for anything else so the caller can 400 rather
// than pass junk to pg.
export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
}

function prettyDate(d) {
  return new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

// Coverage for one client whose stories were published in [from, to] inclusive.
// `to` is treated as the whole end day (we compare against the next day, exclusive).
// Ignores read-state and in_digest — a briefing is a historical coverage summary,
// not the unread queue. De-dup already collapsed repeats per client, so each story
// appears once, with a "seen in N sources" salience count.
export async function getCoverage(clientId, from, to) {
  const client = (await query('SELECT id, name FROM clients WHERE id = $1', [clientId])).rows[0];
  if (!client) return null;

  const { rows } = await query(
    `SELECT a.id, a.title, a.url, a.description, a.published_at,
            f.title AS feed_title, c.name AS category,
            (SELECT COUNT(*)::int FROM article_feed_hits h WHERE h.article_id = a.id) AS hit_count,
            (SELECT string_agg(DISTINCT f2.title, ', ')
               FROM article_feed_hits h JOIN feeds f2 ON f2.id = h.feed_id
              WHERE h.article_id = a.id) AS seen_in
       FROM articles a
       JOIN feeds f ON a.feed_id = f.id
       LEFT JOIN categories c ON f.category_id = c.id
      WHERE f.client_id = $1
        AND a.published_at >= $2::date
        AND a.published_at < ($3::date + INTERVAL '1 day')
      ORDER BY c.name NULLS LAST, a.published_at DESC`,
    [clientId, from, to]
  );
  return { client, from, to, articles: rows };
}

function groupByCategory(articles) {
  const groups = [];
  const index = new Map();
  for (const a of articles) {
    const key = a.category || 'Uncategorised';
    if (!index.has(key)) {
      index.set(key, { name: key, items: [] });
      groups.push(index.get(key));
    }
    index.get(key).items.push(a);
  }
  return groups;
}

// forWord=true wraps the body in the minimal MS-Office HTML envelope so Word
// opens it as an editable document; otherwise it's a normal print-ready web page.
export function renderBrief({ client, from, to, articles }, { forWord = false } = {}) {
  const groups = groupByCategory(articles);
  const accent = '#000648';
  const generated = new Date().toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const styles = `
    body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; max-width: 800px; margin: 0 auto; padding: 32px; line-height: 1.5; }
    .masthead { border-bottom: 3px solid ${accent}; padding-bottom: 14px; margin-bottom: 8px; }
    .masthead .kicker { color: ${accent}; font-size: 12px; letter-spacing: 0.14em; text-transform: uppercase; font-family: Arial, sans-serif; }
    h1 { color: ${accent}; font-size: 26px; margin: 6px 0 2px; }
    .range { color: #555; font-size: 14px; }
    .meta { color: #888; font-size: 12px; font-family: Arial, sans-serif; margin-top: 4px; }
    .summary { background: #F4EFF9; border-left: 4px solid ${accent}; padding: 10px 14px; margin: 18px 0; font-size: 13px; font-family: Arial, sans-serif; color: #333; }
    h2 { color: ${accent}; font-size: 17px; border-bottom: 1px solid #ddd; padding-bottom: 6px; margin: 26px 0 8px; }
    h2 .topic-count { color: #999; font-size: 12px; font-weight: normal; font-family: Arial, sans-serif; }
    .story { margin: 0 0 16px; padding-bottom: 12px; border-bottom: 1px solid #eee; }
    .story h3 { font-size: 15px; margin: 0 0 4px; }
    .story h3 a { color: #1a1a1a; text-decoration: none; }
    .story .src { color: #666; font-size: 12px; font-family: Arial, sans-serif; margin: 2px 0; }
    .story .salience { color: ${accent}; font-weight: bold; }
    .story p { font-size: 13px; color: #333; margin: 6px 0 0; }
    .empty { color: #888; font-style: italic; margin: 24px 0; }
    .footer { margin-top: 32px; border-top: 1px solid #ddd; padding-top: 10px; color: #999; font-size: 11px; font-family: Arial, sans-serif; }
    .printbar { position: sticky; top: 0; background: #fff; padding: 10px 0; margin-bottom: 10px; font-family: Arial, sans-serif; }
    .printbar button { background: ${accent}; color: #fff; border: none; border-radius: 4px; padding: 8px 16px; font-size: 13px; cursor: pointer; }
    @media print { .printbar { display: none; } body { padding: 0; } }
  `;

  const printbar = forWord ? '' :
    `<div class="printbar"><button onclick="window.print()">Print / Save as PDF</button></div>`;

  let body = `
    ${printbar}
    <div class="masthead">
      <div class="kicker">CSG RSS Intelligence — Coverage Briefing</div>
      <h1>${escapeHtml(client.name)}</h1>
      <div class="range">${prettyDate(from)} – ${prettyDate(to)}</div>
      <div class="meta">Generated ${escapeHtml(generated)} · ${articles.length} ${articles.length === 1 ? 'story' : 'stories'} across ${groups.length} ${groups.length === 1 ? 'topic' : 'topics'}</div>
    </div>
  `;

  if (!articles.length) {
    body += `<p class="empty">No coverage recorded for ${escapeHtml(client.name)} in this period.</p>`;
  } else {
    for (const g of groups) {
      body += `<h2>${escapeHtml(g.name)} <span class="topic-count">${g.items.length}</span></h2>`;
      for (const a of g.items) {
        const salience = a.hit_count > 1
          ? ` · <span class="salience" title="${escapeHtml(a.seen_in || '')}">seen in ${a.hit_count} sources</span>`
          : '';
        const desc = (a.description || '').replace(/\s+/g, ' ').trim().slice(0, 280);
        body += `
          <div class="story">
            <h3><a href="${escapeHtml(safeUrl(a.url))}">${escapeHtml(a.title)}</a></h3>
            <div class="src">${escapeHtml(a.feed_title || 'Unknown source')} · ${prettyDate(a.published_at)}${salience}</div>
            ${desc ? `<p>${escapeHtml(desc)}${a.description && a.description.length > 280 ? '…' : ''}</p>` : ''}
          </div>`;
      }
    }
  }

  body += `<div class="footer">Chapel Street Group · Prepared from monitored coverage. Links go to the original source.</div>`;

  // MS-Office HTML envelope makes Word treat the file as a document it can edit.
  const wordHead = forWord
    ? `<xml><o:OfficeDocumentSettings xmlns:o="urn:schemas-microsoft-com:office:office"><o:AllowPNG/></o:OfficeDocumentSettings></xml>`
    : '';

  return `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(client.name)} — Coverage Briefing</title>
  ${wordHead}
  <style>${styles}</style>
</head>
<body>${body}</body>
</html>`;
}

// A filesystem-safe filename for the Word download.
export function briefFilename(clientName, from, to) {
  const slug = String(clientName || 'client').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return `${slug}-briefing-${from}_to_${to}.doc`;
}
