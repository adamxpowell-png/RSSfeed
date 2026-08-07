import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

const APP_NAME = process.env.APP_NAME || 'Daily Feed Digest';

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
export async function sendDailyDigest(articles, opts = {}) {
  if (articles.length === 0) {
    console.log('No unread articles to send');
    return;
  }

  const to = opts.to || process.env.EMAIL_TO;
  if (!to) {
    console.warn('Digest skipped: no recipient configured');
    return;
  }
  const heading = opts.label ? `${APP_NAME} — ${opts.label}` : APP_NAME;

  const grouped = groupByCategory(articles);
  const html = generateEmailHTML(grouped, heading);

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'noreply@resend.dev',
      to,
      subject: `${heading} - ${articles.length} new articles`,
      html,
    });
    console.log(`Email sent to ${to} with ${articles.length} articles (${opts.label || 'all'})`);
  } catch (err) {
    console.error('Error sending email:', err);
  }
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
