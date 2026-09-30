import 'dotenv/config';
import Database from 'better-sqlite3';
import { join } from 'path';
import { getTasksWithGoogleMapping } from '../src/db.js';
import { deleteGoogleTaskMirror } from '../src/sync/tasks-sync.js';

// One-shot wipe: clear the tasks table + pending actions rows, and remove the
// Google Tasks mirrors so the owner's phone matches. Leaves facts / people /
// interactions / imessage_log / done+failed+cancelled actions intact.
//
// Usage:
//   npx tsx scripts/wipe-tasks-actions.ts --dry   # preview counts, no writes
//   npx tsx scripts/wipe-tasks-actions.ts         # do it
//
// Idempotent — safe to re-run.

const DRY = process.argv.includes('--dry');

async function main() {
  const db = new Database(join(process.cwd(), 'assistant.db'));

  const totalTasks = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as Array<{ status: string; n: number }>;
  const pendingActions = (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status IN ('proposed','confirmed','executing')").get() as { n: number }).n;
  const totalActions = (db.prepare('SELECT COUNT(*) AS n FROM actions').get() as { n: number }).n;

  console.log(`[wipe] tasks total: ${totalTasks}`);
  for (const row of byStatus) console.log(`[wipe]   ${row.status}: ${row.n}`);
  console.log(`[wipe] actions total: ${totalActions} (pending to delete: ${pendingActions})`);

  const mirrored = getTasksWithGoogleMapping();
  console.log(`[wipe] tasks with Google mirror: ${mirrored.length}`);

  if (DRY) {
    console.log('[wipe] --dry: no writes. Exiting.');
    db.close();
    return;
  }

  // 1. Delete each Google Tasks mirror. deleteGoogleTaskMirror returns false on
  //    a real failure (quota/network — mirror still exists in Google); 404s
  //    count as success. Throttled: the unthrottled 2026-07-29 run hit Google's
  //    per-minute quota after ~0 deletes while reporting all 255 as deleted.
  let mirrorOk = 0;
  let mirrorErr = 0;
  for (const t of mirrored) {
    if (await deleteGoogleTaskMirror(t)) mirrorOk++;
    else {
      mirrorErr++;
      console.warn(`[wipe] Google mirror delete FAILED for task ${t.id} (${t.title}) — mirror left in Google`);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log(`[wipe] Google mirrors: ${mirrorOk} deleted, ${mirrorErr} errored${mirrorErr ? ' (re-run the script to retry — failed mappings are preserved)' : ''}.`);

  // Fail-stop: wiping the DB destroys the google_task_id mappings, so if any
  // mirror delete failed we must NOT proceed — that orphans mirrors in Google
  // with no record to retry from (recoverable only via a pre-wipe backup).
  if (mirrorErr > 0) {
    console.error(`[wipe] ${mirrorErr} mirror delete(s) failed — ABORTING before DB wipe so mappings survive. Re-run to retry.`);
    db.close();
    process.exit(1);
  }

  // 2. Wipe tasks + pending actions in one transaction.
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM tasks').run();
    db.prepare("DELETE FROM actions WHERE status IN ('proposed','confirmed','executing')").run();
  });
  tx();

  const remainingTasks = (db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n;
  const remainingPending = (db.prepare("SELECT COUNT(*) AS n FROM actions WHERE status IN ('proposed','confirmed','executing')").get() as { n: number }).n;
  console.log(`[wipe] done. tasks now: ${remainingTasks}, pending actions now: ${remainingPending}`);

  db.close();
}

main().catch((err) => {
  console.error('[wipe] fatal:', err);
  process.exit(1);
});
