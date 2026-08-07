import schedule from 'node-schedule';
import { fetchFeeds } from './feedFetcher.js';
import { sendDailyDigest } from './emailService.js';
import { getUnreadArticles, markArticlesAsRead } from './feedFetcher.js';
import { query } from './database.js';

// Runs the digest once per client: each client gets its own email covering only
// its unread articles, sent to its own recipient. Falls back to a single
// combined digest if no clients exist yet (fresh DB before migration).
export async function runDigests() {
  await fetchFeeds();

  const clients = (await query('SELECT id, name, email FROM clients ORDER BY name')).rows;

  if (!clients.length) {
    const articles = await getUnreadArticles();
    await sendDailyDigest(articles);
    await markArticlesAsRead(articles.map((a) => a.id));
    return { success: true, articleCount: articles.length, clients: 0 };
  }

  let total = 0;
  const perClient = [];
  for (const client of clients) {
    const to = client.email || process.env.EMAIL_TO;
    const articles = await getUnreadArticles(client.id);
    if (!articles.length) {
      perClient.push({ client: client.name, sent: 0 });
      continue;
    }
    if (!to) {
      console.warn(`Digest for ${client.name}: ${articles.length} unread but no recipient — left unread`);
      perClient.push({ client: client.name, sent: 0, skipped: 'no recipient' });
      continue;
    }
    await sendDailyDigest(articles, { to, label: client.name });
    // Mark read only after a successful send, and only this client's articles.
    await markArticlesAsRead(articles.map((a) => a.id));
    total += articles.length;
    perClient.push({ client: client.name, sent: articles.length });
  }
  return { success: true, articleCount: total, clients: clients.length, perClient };
}

export function startScheduler() {
  // Fetch feeds every 30 minutes (direct function call — works behind auth).
  // Overlap with the digest job or manual fetches is handled inside fetchFeeds.
  schedule.scheduleJob('*/30 * * * *', async () => {
    console.log('Running scheduled feed fetch...');
    try {
      await fetchFeeds();
    } catch (err) {
      console.error('Scheduled fetch error:', err);
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
