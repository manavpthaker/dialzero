import 'dotenv/config';
import { runHygiene } from '../src/hygiene.js';

/**
 * Dry-run the hygiene pass. Prints the JSON plan, makes no writes.
 *
 * Use this before flipping HYGIENE_ENABLED in production, and any time you
 * change a threshold (HYGIENE_CONFIDENCE_THRESHOLD, HYGIENE_MIN_SURFACE_BEFORE_EXPIRE,
 * etc.) to confirm the new bar doesn't surface false positives.
 *
 * Usage: tsx scripts/hygiene-dry-run.ts
 */

async function main(): Promise<void> {
  const report = await runHygiene({ dryRun: true });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
  console.error('[hygiene-dry-run] failed:', err);
  process.exit(1);
});
