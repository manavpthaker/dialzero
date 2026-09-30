/**
 * Portability gate: keeps the code free of one person's timezone and identity.
 *
 * 1. The fallback timezone string may appear only where the timezone is decided
 *    (src/config.ts, src/lib/time.ts). Everything else calls getTimezone().
 *    Test fixtures (scripts/test-*.ts) may pin it; package.json sets
 *    ASSISTANT_TIMEZONE for them.
 * 2. No denylisted string (names, places, numbers, private projects) appears in
 *    any tracked file. The denylist is private and lives outside the repo:
 *    DIALZERO_DENYLIST, default ../.dialzero-private/denylist.txt. When it is
 *    missing this part is skipped with a note.
 *
 * Exit 1 on any hit.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FALLBACK_TIMEZONE } from '../src/config.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TZ_ALLOWED = new Set(['src/config.ts', 'src/lib/time.ts']);
const DEFAULT_DENYLIST = join(ROOT, '..', '.dialzero-private', 'denylist.txt');

function git(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, stdout: r.stdout || '' };
}

let failed = false;

// ── 1. Hardcoded timezone ────────────────────────────────────────────────────
const tzHits = git(['grep', '-nIF', FALLBACK_TIMEZONE, '--', 'src', 'scripts']).stdout
  .split('\n')
  .filter(Boolean)
  .filter((line) => {
    const file = line.split(':', 1)[0];
    return !TZ_ALLOWED.has(file) && !/^scripts\/test-[^/]+\.ts$/.test(file);
  });
if (tzHits.length) {
  failed = true;
  console.error(`✗ ${tzHits.length} hardcoded ${FALLBACK_TIMEZONE} outside src/config.ts / src/lib/time.ts (use getTimezone()):`);
  for (const hit of tzHits) console.error(`  ${hit}`);
} else {
  console.log('✓ no hardcoded timezone in src/ or scripts/');
}

// ── 2. Denylist ─────────────────────────────────────────────────────────────
const denylistPath = process.env.DIALZERO_DENYLIST?.trim() || DEFAULT_DENYLIST;
if (!existsSync(denylistPath)) {
  console.log(`- denylist not found at ${denylistPath}; skipping identifier check (set DIALZERO_DENYLIST)`);
} else {
  const patterns = readFileSync(denylistPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (!patterns.length) {
    console.log('- denylist is empty; skipping identifier check');
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'check-portable-'));
    const patternFile = join(dir, 'patterns.txt');
    writeFileSync(patternFile, patterns.join('\n') + '\n');
    try {
      const contentHits = git(['grep', '-niIF', '-f', patternFile]).stdout.split('\n').filter(Boolean);
      const lowered = patterns.map((p) => p.toLowerCase());
      const nameHits = git(['ls-files']).stdout.split('\n')
        .filter((file) => file && lowered.some((p) => file.toLowerCase().includes(p)));
      if (contentHits.length || nameHits.length) {
        failed = true;
        // Print locations only, never the matched text: the denylist is private.
        console.error(`✗ ${contentHits.length + nameHits.length} denylisted identifier hit(s):`);
        for (const hit of contentHits) console.error(`  ${hit.split(':').slice(0, 2).join(':')}`);
        for (const file of nameHits) console.error(`  ${file} (file name)`);
      } else {
        console.log(`✓ no denylisted identifiers in tracked files (${patterns.length} patterns)`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

process.exit(failed ? 1 : 0);
