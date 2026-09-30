// `npm run setup`: the terminal version of "set me up" (see setup/GUIDE.md).
// Runs the interview if there's no profile yet, then the readiness check, and
// points at the guide for anything still missing.
import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = (script: string, args: string[] = []) =>
  spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, script), ...args], { stdio: 'inherit', cwd: ROOT });

if (!existsSync(join(ROOT, 'config', 'profile.json'))) {
  console.log('\nFirst, a short interview so your assistant knows you.\n');
  const r = tsx('scripts/onboard.ts');
  if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log('\nChecking what is ready and what is left:\n');
const check = tsx('scripts/doctor.ts', ['--setup']);
console.log(check.status === 0
  ? '\nAll set. Install the background service with: npm run install:service'
  : '\nFor each item marked ✗, follow the matching step in setup/GUIDE.md, then run npm run setup again.');
process.exit(check.status ?? 0);
