import { query } from './database.js';
import { sendPriorityAlert } from './emailService.js';

// Only alert on articles ingested within this window. Guards against a large
// backlog suddenly alerting if the scan was paused/broken for a long stretch, or
// if a feed backfills old items. For an INSTANT alert, only fresh coverage counts.
const ALERT_LOOKBACK_HOURS = 48;

// Serialise scans the same way feed fetches are serialised, so an automatic scan
// (after the 30-min fetch) and a manual trigger can't double-send the same story.
let scanInProgress = false;

// opts.send is the email sender (defaults to the real one). Injectable so the
// regression suite can exercise matching + ledger recording without sending mail.
export async function runAlertScan(opts = {}) {
  if (scanInProgress) {
    console.log('Alert scan already in progress, skipping');
    return { success: true, alerted: 0, clients: 0, perClient: [], skipped: true };
  }
  scanInProgress = true;
  try {
    return await doAlertScan(opts.send || sendPriorityAlert);
  } finally {
    scanInProgress = false;
  }
}

async function doAlertScan(send) {
  // Candidate articles: not yet considered for an alert, ingested recently, whose
  // owning feed's client has an ENABLED rule whose term appears (case-insensitive
  // substring) in the title or description. One row per (article, client) with the
  // set of terms that fired. The nested replace() escapes LIKE metacharacters
  // (\ % _) in each term so a term like "R&D_" is matched literally.
  const { rows } = await query(
    `SELECT a.id AS article_id, a.title, a.url, a.description, a.published_at,
            f.title AS feed_title,
            cl.id AS client_id, cl.name AS client_name,
            COALESCE(cl.email, $1) AS recipient,
            array_agg(DISTINCT r.term ORDER BY r.term) AS matched_terms
       FROM articles a
       JOIN feeds f    ON a.feed_id = f.id
       JOIN clients cl ON f.client_id = cl.id
       JOIN alert_rules r ON r.client_id = cl.id AND r.enabled = TRUE
      WHERE NOT EXISTS (SELECT 1 FROM article_alerts aa WHERE aa.article_id = a.id)
        AND a.created_at > NOW() - ($2 || ' hours')::interval
        AND (
              a.title ILIKE '%' || replace(replace(replace(r.term, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' ESCAPE '\\'
           OR COALESCE(a.description, '') ILIKE '%' || replace(replace(replace(r.term, '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%' ESCAPE '\\'
        )
      GROUP BY a.id, f.title, cl.id, cl.name, recipient
      ORDER BY cl.name, a.published_at DESC`,
    [process.env.EMAIL_TO || null, String(ALERT_LOOKBACK_HOURS)]
  );

  if (!rows.length) return { success: true, alerted: 0, clients: 0, perClient: [] };

  // Group flagged articles by client so each client gets ONE alert email per
  // scan, however many stories tripped a rule in that pass.
  const byClient = new Map();
  for (const r of rows) {
    if (!byClient.has(r.client_id)) {
      byClient.set(r.client_id, { name: r.client_name, recipient: r.recipient, articles: [] });
    }
    byClient.get(r.client_id).articles.push(r);
  }

  let alerted = 0;
  const perClient = [];
  const errors = [];
  for (const [clientId, group] of byClient) {
    if (!group.recipient) {
      // No recipient — leave these articles UNrecorded so they alert once a
      // recipient is configured, rather than being silently swallowed.
      perClient.push({ client: group.name, alerted: 0, error: 'no recipient' });
      errors.push(`${group.name}: no recipient`);
      continue;
    }
    const r = await send(group.articles, { to: group.recipient, label: group.name });
    if (r.ok) {
      // Record the ledger rows ONLY after a confirmed send, so a rejected alert
      // is retried next scan instead of being marked considered and lost.
      for (const art of group.articles) {
        await query(
          `INSERT INTO article_alerts (article_id, client_id, matched_terms)
             VALUES ($1, $2, $3) ON CONFLICT (article_id) DO NOTHING`,
          [art.article_id, clientId, art.matched_terms.join(', ')]
        );
      }
      alerted += group.articles.length;
      perClient.push({ client: group.name, alerted: group.articles.length });
    } else {
      perClient.push({ client: group.name, alerted: 0, error: r.error });
      errors.push(`${group.name}: ${r.error}`);
    }
  }

  console.log(`Alert scan complete: ${alerted} flagged across ${byClient.size} client(s)`);
  return { success: errors.length === 0, alerted, clients: byClient.size, perClient, errors };
}
