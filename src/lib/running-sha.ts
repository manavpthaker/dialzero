// Which commit the running bot was started on. Written at boot to .running-sha
// (gitignored). scripts/sync-repos.sh compares it with HEAD and rebuilds +
// restarts when they differ, so a commit made on the mini itself deploys too
// (a pull that brings nothing new used to leave the bot on stale code).

import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const REPO_ROOT = process.cwd();
const FILE = join(REPO_ROOT, '.running-sha');

export function currentHeadSha(): string | null {
  try {
    return execFileSync('/usr/bin/git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function recordRunningSha(): void {
  const sha = currentHeadSha();
  if (!sha) return;
  try { writeFileSync(FILE, `${sha}\n`); } catch (err) { console.warn('[running-sha] could not write:', err); }
}

export function readRunningSha(): string | null {
  try { return readFileSync(FILE, 'utf8').trim() || null; } catch { return null; }
}
