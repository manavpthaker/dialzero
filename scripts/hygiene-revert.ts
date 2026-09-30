import 'dotenv/config';
import { revertHygieneRun } from '../src/db.js';

/**
 * Reverse a hygiene run by its run_id. Reads hygiene_log rows for the given
 * run, restores each affected fact's columns from `before_json`, and runs in
 * a single transaction.
 *
 * Refuses runs older than 14 days (see `revertHygieneRun` in db.ts) — those
 * may overlap with newer legitimate changes and need manual recovery.
 *
 * Usage: tsx scripts/hygiene-revert.ts <run_id>
 */

const runId = process.argv[2];
if (!runId) {
  console.error('Usage: tsx scripts/hygiene-revert.ts <run_id>');
  process.exit(1);
}

try {
  const result = revertHygieneRun(runId);
  console.log(`[hygiene-revert] ${runId}: reverted ${result.reverted}, skipped ${result.skipped}`);
} catch (err) {
  console.error('[hygiene-revert] failed:', err instanceof Error ? err.message : err);
  process.exit(1);
}
