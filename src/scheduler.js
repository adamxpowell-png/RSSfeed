import schedule from 'node-schedule';
import { fetchFeeds } from './feedFetcher.js';
import { sendDailyDigest } from './emailService.js';
import { getUnreadArticles, markArticlesAsRead } from './feedFetcher.js';

let fetchRunning = false;

export function startScheduler() {
  // Fetch feeds every 30 minutes (direct function call — works behind auth)
  schedule.scheduleJob('*/30 * * * *', async () => {
    if (fetchRunning) {
      console.log('Feed fetch already running, skipping this run');
      return;
    }
    fetchRunning = true;
    console.log('Running scheduled feed fetch...');
    try {
      await fetchFeeds();
    } catch (err) {
      console.error('Scheduled fetch error:', err);
    } finally {
      fetchRunning = false;
    }
  });

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

  console.log('Scheduler started - feed fetch every 30 min, digest at 8 AM daily');
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
