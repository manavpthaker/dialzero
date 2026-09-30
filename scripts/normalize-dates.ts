import 'dotenv/config';
import db from '../src/db.js';
import { toSqliteDate } from '../src/lib/dates.js';

/**
 * One-time migration: rewrite existing `facts.valid_until`, `people.last_contact`,
 * and `interactions.occurred_at` from ISO `YYYY-MM-DDTHH:MM:SS.sssZ` form to
 * SQLite-native `YYYY-MM-DD HH:MM:SS` form.
 *
 * Why: writers like `nextSundayIso()` in `scheduler.ts` call `.toISOString()`,
 * but readers compare with `datetime('now')` which returns space-separated UTC.
 * String comparison at character 10 puts `T` (0x54) above ` ` (0x20), so an
 * ISO `valid_until` lexically sorts above any space-form upper bound and is
 * silently excluded from `BETWEEN` windows it should match.
 *
 * Idempotent: rows already in SQLite form pass through unchanged.
 *
 * Usage: tsx scripts/normalize-dates.ts
 */

const SQLITE_FORM = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

interface Target {
  table: string;
  column: string;
  // optional extra column to keep id in the log
  idColumn: string;
}

const TARGETS: Target[] = [
  { table: 'facts', column: 'valid_until', idColumn: 'id' },
  { table: 'people', column: 'last_contact', idColumn: 'id' },
  { table: 'interactions', column: 'occurred_at', idColumn: 'id' },
];

function rewriteColumn(t: Target): { rewritten: number; passed: number; skipped: number } {
  const rows = db
    .prepare(`SELECT ${t.idColumn} AS id, ${t.column} AS val FROM ${t.table} WHERE ${t.column} IS NOT NULL`)
    .all() as Array<{ id: number; val: string }>;

  let rewritten = 0;
  let passed = 0;
  let skipped = 0;

  const update = db.prepare(`UPDATE ${t.table} SET ${t.column} = ? WHERE ${t.idColumn} = ?`);

  for (const row of rows) {
    if (SQLITE_FORM.test(row.val)) {
      passed++;
      continue;
    }
    const normalized = toSqliteDate(row.val);
    if (!normalized) {
      console.warn(`[normalize-dates] ${t.table}.${t.column} id=${row.id}: could not parse "${row.val}" — leaving as-is`);
      skipped++;
      continue;
    }
    update.run(normalized, row.id);
    rewritten++;
  }

  return { rewritten, passed, skipped };
}

function main(): void {
  console.log('[normalize-dates] starting…');
  let totalRewritten = 0;
  for (const t of TARGETS) {
    const { rewritten, passed, skipped } = rewriteColumn(t);
    totalRewritten += rewritten;
    console.log(
      `[normalize-dates] ${t.table}.${t.column}: rewrote ${rewritten}, already-normalized ${passed}, unparseable ${skipped}`,
    );
  }
  console.log(`[normalize-dates] done. total rows rewritten: ${totalRewritten}`);
}

main();
