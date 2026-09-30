import 'dotenv/config';
import { runHealthCheck, formatHealthReport, runSetupCheck, formatSetupReport } from '../src/doctor.js';

/**
 * Health and setup checks. JSON shapes are documented at the top of src/doctor.ts.
 *
 *   npm run doctor                    liveness: are the loops firing (exit 1 on any warning)
 *   npm run doctor -- --setup         is this Mac ready to use (exit 1 on any failure)
 *   add --json for machine-readable output
 */

const args = new Set(process.argv.slice(2));
const json = args.has('--json');

if (args.has('--setup')) {
  const report = runSetupCheck();
  console.log(json ? JSON.stringify(report, null, 2) : formatSetupReport(report));
  process.exit(report.ready ? 0 : 1);
}

const report = runHealthCheck();
console.log(json
  ? JSON.stringify({ mode: 'health', healthy: report.healthy, checks: report.checks, stats: report.stats }, null, 2)
  : formatHealthReport(report));
process.exit(report.healthy ? 0 : 1);
