import { Resend } from 'resend';

// Lazy, memoised Resend client. Constructing Resend with no API key THROWS, so
// building it at import time would crash the whole process at boot if the key
// were ever unset. Instead we build it on first send and surface a missing key
// as a normal { ok:false } send failure (retried next run), consistent with how
// every other send rejection is handled. Also lets the test suite import this
// module without a key configured.
let _resend = null;
function getResend() {
  if (!process.env.RESEND_API_KEY) return null;
  if (!_resend) _resend = new Resend(process.env.RESEND_API_KEY);
  return _resend;
}

const APP_NAME = process.env.APP_NAME || 'CSG RSS Intelligence Feed';

// Escape untrusted feed content before embedding in email HTML
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only allow http(s) URLs as link targets
function safeUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return value;
  } catch {}
  return '#';
}

// Sends one digest. opts.to is the recipient; opts.label is the client name,
// shown in the subject and heading so each client's email stands alone. Both
// fall back to the legacy single-recipient behaviour when omitted.
// Returns { ok, error? }. IMPORTANT: the Resend SDK does NOT throw on a rejected
// send (unverified domain, bad key, etc.) — it resolves with an { error } field.
// We must inspect that, or a refusal looks like success and the caller marks the
// articles read and loses them. ok:false means "do not mark these read".
export async function sendDailyDigest(articles, opts = {}) {
  if (articles.length === 0) {
    console.log('No unread articles to send');
    return { ok: true, sent: 0 };
  }

  const to = opts.to || process.env.EMAIL_TO;
  if (!to) {
    console.warn('Digest skipped: no recipient configured');
    return { ok: false, error: 'no recipient configured' };
  }
  const heading = opts.label ? `${APP_NAME} — ${opts.label}` : APP_NAME;

  const resend = getResend();
  if (!resend) {
    console.error('Digest not sent: RESEND_API_KEY is not configured');
    return { ok: false, error: 'RESEND_API_KEY is not configured' };
  }

  const grouped = groupByCategory(articles);
  const html = generateEmailHTML(grouped, heading);

  try {
    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
      to,
      subject: `${heading} - ${articles.length} new articles`,
      html,
    });
    if (error) {
      const msg = error.message || JSON.stringify(error);
      console.error(`Resend rejected digest to ${to} (${opts.label || 'all'}): ${msg}`);
      return { ok: false, error: msg };
    }
    console.log(`Email sent to ${to} with ${articles.length} articles (${opts.label || 'all'}) id=${data && data.id}`);
    return { ok: true, sent: articles.length, id: data && data.id };
  } catch (err) {
    console.error('Error sending email:', err);
    return { ok: false, error: err.message };
  }
}

// Sends one priority alert covering the stories that tripped a rule for a single
// client in this scan. Deliberately distinct from the daily digest: red banner,
// the triggering term(s) called out per story, "why you're seeing this" footer.
// Same { ok, error? } contract as the digest — ok:false means "do not record
// these as alerted", so a rejected send is retried on the next scan.
export async function sendPriorityAlert(articles, opts = {}) {
  if (!articles || articles.length === 0) return { ok: true, sent: 0 };

  const to = opts.to || process.env.EMAIL_TO;
  if (!to) {
    console.warn('Priority alert skipped: no recipient configured');
    return { ok: false, error: 'no recipient configured' };
  }
  const label = opts.label || 'Monitoring';

  const resend = getResend();
  if (!resend) {
    console.error('Priority alert not sent: RESEND_API_KEY is not configured');
    return { ok: false, error: 'RESEND_API_KEY is not configured' };
  }

  const subject = `⚠ Priority alert — ${label}: ${articles.length} flagged`;
  const html = generateAlertHTML(articles, label);

  try {
    const { data, error } = await resend.emails.send({
      from: process.env.EMAIL_FROM || 'onboarding@resend.dev',
      to,
      subject,
      html,
    });
    if (error) {
      const msg = error.message || JSON.stringify(error);
      console.error(`Resend rejected alert to ${to} (${label}): ${msg}`);
      return { ok: false, error: msg };
    }
    console.log(`Priority alert sent to ${to} with ${articles.length} stories (${label}) id=${data && data.id}`);
    return { ok: true, sent: articles.length, id: data && data.id };
  } catch (err) {
    console.error('Error sending priority alert:', err);
    return { ok: false, error: err.message };
  }
}

function generateAlertHTML(articles, label) {
  let html = `
    <html>
      <body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
        <div style="background: #c0392b; color: #fff; padding: 14px 18px; border-radius: 4px 4px 0 0;">
          <h1 style="margin: 0; font-size: 18px;">⚠ Priority Alert — ${escapeHtml(label)}</h1>
          <p style="margin: 4px 0 0 0; font-size: 13px; opacity: 0.9;">
            ${articles.length} ${articles.length === 1 ? 'story matches' : 'stories match'} a watch term ·
            ${new Date().toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
  `;

  for (const article of articles) {
    const terms = Array.isArray(article.matched_terms) ? article.matched_terms : [];
    const chips = terms
      .map((t) => `<span style="display:inline-block; background:#fdecea; color:#c0392b; border:1px solid #f5c6cb; border-radius:3px; padding:1px 7px; font-size:11px; font-weight:bold; margin:0 4px 4px 0;">${escapeHtml(t)}</span>`)
      .join('');
    html += `
      <div style="margin: 0; padding: 16px 18px; border-left: 4px solid #c0392b; border-bottom: 1px solid #eee; background: #fff;">
        <div style="margin-bottom: 8px;">${chips}</div>
        <h3 style="margin: 0 0 8px 0; color: #2c3e50; font-size: 16px;">
          <a href="${escapeHtml(safeUrl(article.url))}" style="color: #c0392b; text-decoration: none;">${escapeHtml(article.title)}</a>
        </h3>
        <p style="margin: 6px 0; color: #7f8c8d; font-size: 12px;">From: <strong>${escapeHtml(article.feed_title || 'Unknown feed')}</strong></p>
        <p style="margin: 6px 0; color: #555; font-size: 14px;">${escapeHtml((article.description || '').substring(0, 220) || 'No description')}...</p>
        <a href="${escapeHtml(safeUrl(article.url))}" style="color: #c0392b; font-size: 12px; text-decoration: none;">Read more →</a>
      </div>
    `;
  }

  html += `
        <p style="color: #95a5a6; font-size: 11px; padding: 14px 18px;">
          You're seeing this because a story matched a priority watch term for ${escapeHtml(label)}.
          This is a real-time alert, separate from your daily digest.
          Manage watch terms at
          <a href="${process.env.APP_URL || 'http://localhost:3000'}" style="color: #c0392b;">the reader</a>.
        </p>
      </body>
    </html>
  `;
  return html;
}

function groupByCategory(articles) {
  return articles.reduce((acc, article) => {
    const cat = article.category || 'Uncategorized';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(article);
    return acc;
  }, {});
}

function generateEmailHTML(grouped, heading = APP_NAME) {
  let html = `
    <html>
      <body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #2c3e50;">${escapeHtml(heading)}</h1>
        <p style="color: #7f8c8d; font-size: 14px;">
          ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
  `;

  for (const [category, articles] of Object.entries(grouped)) {
    html += `<h2 style="color: #34495e; border-bottom: 2px solid #3498db; padding-bottom: 10px;">${escapeHtml(category)}</h2>`;

    for (const article of articles) {
      html += `
        <div style="margin: 20px 0; padding: 15px; background: #f8f9fa; border-left: 4px solid #3498db;">
          <h3 style="margin: 0 0 10px 0; color: #2c3e50;">
            <a href="${escapeHtml(safeUrl(article.url))}" style="color: #3498db; text-decoration: none;">
              ${escapeHtml(article.title)}
            </a>
          </h3>
          <p style="margin: 10px 0; color: #7f8c8d; font-size: 12px;">
            From: <strong>${escapeHtml(article.feed_title)}</strong>
          </p>
          <p style="margin: 10px 0; color: #555; font-size: 14px;">
            ${escapeHtml(article.description?.substring(0, 200) || 'No description')}...
          </p>
          <a href="${escapeHtml(safeUrl(article.url))}" style="color: #3498db; font-size: 12px; text-decoration: none;">
            Read more →
          </a>
        </div>
      `;
    }
  }

  html += `
        <hr style="border: none; border-top: 1px solid #ecf0f1; margin: 30px 0;">
        <p style="color: #95a5a6; font-size: 12px; text-align: center;">
          Manage your feeds at: <a href="${process.env.APP_URL || 'http://localhost:3000'}" style="color: #3498db;">Feed Reader</a>
        </p>
      </body>
    </html>
  `;

  return html;
}
