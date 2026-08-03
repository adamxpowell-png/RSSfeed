import 'dotenv/config';
import { initDatabase, query, getPool } from '../src/database.js';
import { backfillDedupeKeys } from '../src/feedFetcher.js';

// One-off cleanup for articles stored before de-duplication existed.
//
// Going forward the fetcher collapses duplicates on insert, but history still
// holds one row per feed per story. This merges each duplicate group onto its
// oldest row, preserving which feeds carried it in article_feed_hits, and
// treating the merged story as read only if every copy was read.
//
// Dry run by default. Pass --apply to write.

const APPLY = process.argv.includes('--apply');

async function collapse() {
  await initDatabase();
  await backfillDedupeKeys();

  // Group by whichever key is present, preferring url_key: two rows are the
  // same story if they share a canonical URL or a normalised headline.
  const groups = await query(`
    SELECT COALESCE('u:' || url_key, 't:' || title_key) AS key,
           array_agg(id ORDER BY id) AS ids
      FROM articles
     WHERE (url_key IS NOT NULL OR (title_key IS NOT NULL AND title_key <> 'unkeyed'))
     GROUP BY 1
    HAVING COUNT(*) > 1
  `);

  const totalRedundant = groups.rows.reduce((n, g) => n + g.ids.length - 1, 0);
  console.log(
    `${groups.rows.length} duplicate groups covering ${totalRedundant} redundant rows`
  );

  if (!APPLY) {
    for (const group of groups.rows.slice(0, 15)) {
      const sample = await query('SELECT title FROM articles WHERE id = $1', [group.ids[0]]);
      console.log(`  x${group.ids.length}  ${sample.rows[0]?.title?.slice(0, 80)}`);
    }
    if (groups.rows.length > 15) console.log(`  ... and ${groups.rows.length - 15} more`);
    console.log('\nDry run. Re-run with --apply to merge.');
    return;
  }

  for (const group of groups.rows) {
    const [keepId, ...dropIds] = group.ids;

    // Preserve attribution: every feed that carried a dropped copy is recorded
    // against the surviving article before the copy goes.
    await query(
      `INSERT INTO article_feed_hits (article_id, feed_id)
       SELECT $1, feed_id FROM articles WHERE id = ANY($2)
       ON CONFLICT DO NOTHING`,
      [keepId, dropIds]
    );

    // Only stays read if you had actually read every copy.
    await query(
      `UPDATE articles SET read = FALSE
        WHERE id = $1 AND EXISTS (
          SELECT 1 FROM articles WHERE id = ANY($2) AND read = FALSE
        )`,
      [keepId, dropIds]
    );

    await query('DELETE FROM articles WHERE id = ANY($1)', [dropIds]);
  }

  console.log(`Merged ${totalRedundant} redundant rows into ${groups.rows.length} stories`);
}

collapse()
  .catch((err) => {
    console.error('Collapse failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    const pool = await getPool();
    await pool.end();
  });
