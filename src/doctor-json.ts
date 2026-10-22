// Runs the health check in its own process and prints it as JSON. The watchdog calls
// this so the doctor's blocking commands (git, curl, 1Password…) never freeze the bot:
// run in-process every 10 minutes they froze it 1.5–3s (stall watch, 2026-10-21).
import 'dotenv/config';
import { runHealthCheck } from './doctor.js';

process.stdout.write(JSON.stringify(runHealthCheck()));
process.exit(0);
