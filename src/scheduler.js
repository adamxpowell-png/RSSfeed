import schedule from 'node-schedule';
import { fetchFeeds } from './feedFetcher.js';
import { sendDailyDigest } from './emailService.js';
import { getUnreadArticles, markArticlesAsRead } from './feedFetcher.js';

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

  // Run every day at 8 AM
  schedule.scheduleJob('0 8 * * *', async () => {
    console.log('Running scheduled daily digest job...');
    try {
      await fetchFeeds();
      const articles = await getUnreadArticles();
      await sendDailyDigest(articles);
      await markArticlesAsRead(articles.map(a => a.id));
    } catch (err) {
      console.error('Scheduler error:', err);
    }
  });

  console.log('Scheduler started - feed fetch every 30 min, digest at 8 AM daily');
}

// Manual trigger for testing
export async function triggerDigestNow() {
  try {
    await fetchFeeds();
    const articles = await getUnreadArticles();
    await sendDailyDigest(articles);
    await markArticlesAsRead(articles.map(a => a.id));
    return { success: true, articleCount: articles.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
