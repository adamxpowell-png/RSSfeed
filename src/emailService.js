import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

export async function sendDailyDigest(articles) {
  if (articles.length === 0) {
    console.log('No unread articles to send');
    return;
  }

  const grouped = groupByCategory(articles);
  const html = generateEmailHTML(grouped);

  try {
    await resend.emails.send({
      from: process.env.EMAIL_FROM || 'noreply@resend.dev',
      to: process.env.EMAIL_TO,
      subject: `Daily Feed Digest - ${articles.length} new articles`,
      html,
    });
    console.log(`Email sent with ${articles.length} articles`);
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

function generateEmailHTML(grouped) {
  let html = `
    <html>
      <body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
        <h1 style="color: #2c3e50;">Daily Feed Digest</h1>
        <p style="color: #7f8c8d; font-size: 14px;">
          ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
        </p>
  `;

  for (const [category, articles] of Object.entries(grouped)) {
    html += `<h2 style="color: #34495e; border-bottom: 2px solid #3498db; padding-bottom: 10px;">${category}</h2>`;

    for (const article of articles) {
      html += `
        <div style="margin: 20px 0; padding: 15px; background: #f8f9fa; border-left: 4px solid #3498db;">
          <h3 style="margin: 0 0 10px 0; color: #2c3e50;">
            <a href="${article.url}" style="color: #3498db; text-decoration: none;">
              ${article.title}
            </a>
          </h3>
          <p style="margin: 10px 0; color: #7f8c8d; font-size: 12px;">
            From: <strong>${article.feed_title}</strong>
          </p>
          <p style="margin: 10px 0; color: #555; font-size: 14px;">
            ${article.description?.substring(0, 200) || 'No description'}...
          </p>
          <a href="${article.url}" style="color: #3498db; font-size: 12px; text-decoration: none;">
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
