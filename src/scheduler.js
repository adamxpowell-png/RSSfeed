import schedule from 'node-schedule';
import { fetchFeeds } from './feedFetcher.js';
import { sendDailyDigest } from './emailService.js';
import { getUnreadArticles, markArticlesAsRead } from './feedFetcher.js';

export function startScheduler() {
  // Run every day at 8 AM
  schedule.scheduleJob('0 8 * * *', async () => {
    console.log('Running scheduled daily digest job...');
    try {
      await fetchFeeds();
      const articles = await getUnreadArticles();
      await sendDailyDigest(articles);
      await markArticlesAsRead();
    } catch (err) {
      console.error('Scheduler error:', err);
    }
  });

  console.log('Scheduler started - digest scheduled for 8 AM daily');
}

// Manual trigger for testing
export async function triggerDigestNow() {
  try {
    await fetchFeeds();
    const articles = await getUnreadArticles();
    await sendDailyDigest(articles);
    await markArticlesAsRead();
    return { success: true, articleCount: articles.length };
  } catch (err) {
    return { success: false, error: err.message };
  }
}
