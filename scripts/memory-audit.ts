import 'dotenv/config';
import { runMemoryAudit, formatAuditReport } from '../src/memory-audit.js';

/**
 * Run the semantic memory audit (Odysseus Experiment 1) once, from the CLI.
 * Normally it rides the Monday hygiene cron (src/hygiene.ts); this entry exists
 * for testing and manual passes.
 *
 * Usage: tsx scripts/memory-audit.ts [--dry] [--force]
 *   --dry    print the LLM's proposals, write nothing (no mutations, no
 *            fingerprint update)
 *   --force  bypass the fingerprint gate (still honors MEMORY_AUDIT_ENABLED)
 *
 * Revert an applied run: tsx scripts/hygiene-revert.ts <run_id>
 */

const dryRun = process.argv.includes('--dry') || process.argv.includes('--test');
const force = process.argv.includes('--force');

runMemoryAudit({ dryRun, force, log: (m) => console.log(`[memory-audit] ${m}`) })
  .then((report) => {
    console.log(formatAuditReport(report));
    process.exit(0);
  })
  .catch((err) => {
    console.error('[memory-audit] failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
