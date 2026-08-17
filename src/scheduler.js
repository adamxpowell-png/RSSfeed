import schedule from 'node-schedule';
import { fetchFeeds } from './feedFetcher.js';
import { sendDailyDigest } from './emailService.js';
import { getUnreadArticles, markArticlesAsRead, getUnreadForSelection } from './feedFetcher.js';
import { runAlertScan } from './alertService.js';
import { query } from './database.js';

// Runs the digest once per client: each client gets its own email covering only
// its unread articles, sent to its own recipient. Falls back to a single
// combined digest if no clients exist yet (fresh DB before migration).
export async function runDigests() {
  await fetchFeeds();

  const clients = (await query('SELECT id, name, email FROM clients ORDER BY name')).rows;

  if (!clients.length) {
    const articles = await getUnreadArticles();
    const r = await sendDailyDigest(articles);
    if (r.ok && articles.length) await markArticlesAsRead(articles.map((a) => a.id));
    return { success: true, articleCount: r.ok ? articles.length : 0, clients: 0, error: r.error };
  }

  let total = 0;
  const perClient = [];
  const errors = [];
  for (const client of clients) {
    const to = client.email || process.env.EMAIL_TO;
    const articles = await getUnreadArticles(client.id);
    if (!articles.length) {
      perClient.push({ client: client.name, sent: 0 });
      continue;
    }
    if (!to) {
      console.warn(`Digest for ${client.name}: ${articles.length} unread but no recipient — left unread`);
      perClient.push({ client: client.name, sent: 0, error: 'no recipient' });
      errors.push(`${client.name}: no recipient`);
      continue;
    }
    const r = await sendDailyDigest(articles, { to, label: client.name });
    if (r.ok) {
      // Mark read ONLY after a confirmed send — a rejected send leaves the
      // articles unread so they are retried in the next digest, not lost.
      await markArticlesAsRead(articles.map((a) => a.id));
      total += articles.length;
      perClient.push({ client: client.name, sent: articles.length });
    } else {
      perClient.push({ client: client.name, sent: 0, error: r.error });
      errors.push(`${client.name}: ${r.error}`);
    }
  }
  return { success: errors.length === 0, articleCount: total, clients: clients.length, perClient, errors };
}

export function startScheduler() {
  // Fetch feeds every 30 minutes (direct function call — works behind auth),
  // then immediately scan the freshly-fetched articles for priority watch terms.
  // This 30-min cadence is the "instant" resolution of priority alerts. Overlap
  // with the digest job or manual fetches is handled inside fetchFeeds/runAlertScan.
  schedule.scheduleJob('*/30 * * * *', async () => {
    console.log('Running scheduled feed fetch...');
    try {
      await fetchFeeds();
    } catch (err) {
      console.error('Scheduled fetch error:', err);
    }
    try {
      const alertResult = await runAlertScan();
      if (alertResult.alerted) console.log('Priority alerts sent:', JSON.stringify(alertResult));
    } catch (err) {
      console.error('Alert scan error:', err);
    }
  });

  // Run every day at 8 AM — one digest per client.
  schedule.scheduleJob('0 8 * * *', async () => {
    console.log('Running scheduled daily digest job...');
    try {
      const result = await runDigests();
      console.log(`Digest run complete:`, JSON.stringify(result));
    } catch (err) {
      console.error('Scheduler error:', err);
    }
  });

  console.log('Scheduler started - feed fetch every 30 min, per-client digest at 8 AM daily');
}

// Manual trigger (used by POST /api/trigger-digest)
export async function triggerDigestNow() {
  try {
    return await runDigests();
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Manual trigger (used by POST /api/trigger-alerts). Fetches first so a scan on
// demand sees the newest articles, then scans for priority watch terms.
export async function triggerAlertsNow() {
  try {
    await fetchFeeds();
    return await runAlertScan();
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// On-demand email of the unread articles surfaced by a chosen set of feeds
// (the sidebar "Email selected" action). Grouped per client so each client's
// picks go to its own recipient, in the same format as the daily digest. Marks
// those articles read ONLY on a confirmed send, so a rejected send is retried and
// nothing is silently lost — same contract as runDigests().
export async function sendSelectionNow(feedIds) {
  try {
    const articles = await getUnreadForSelection(feedIds);
    if (!articles.length) return { success: true, articleCount: 0, clients: 0, perClient: [] };

    const byClient = new Map();
    for (const a of articles) {
      const key = a.client_id ?? 'none';
      if (!byClient.has(key)) {
        byClient.set(key, { name: a.client_name || 'Unassigned', recipient: a.recipient, articles: [] });
      }
      byClient.get(key).articles.push(a);
    }

    let total = 0;
    const perClient = [];
    const errors = [];
    for (const [, g] of byClient) {
      if (!g.recipient) {
        perClient.push({ client: g.name, sent: 0, error: 'no recipient' });
        errors.push(`${g.name}: no recipient`);
        continue;
      }
      const r = await sendDailyDigest(g.articles, { to: g.recipient, label: g.name });
      if (r.ok) {
        await markArticlesAsRead(g.articles.map((a) => a.id));
        total += g.articles.length;
        perClient.push({ client: g.name, sent: g.articles.length });
      } else {
        perClient.push({ client: g.name, sent: 0, error: r.error });
        errors.push(`${g.name}: ${r.error}`);
      }
    }
    return { success: errors.length === 0, articleCount: total, clients: byClient.size, perClient, errors };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
