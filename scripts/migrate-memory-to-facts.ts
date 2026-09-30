import 'dotenv/config';
import db, { saveFact, factsAbout } from '../src/db.js';

/**
 * One-time migration: convert structured key/value rows in `memory` into
 * atomic rows in `facts`.
 *
 * Routes through `saveFact` so per-type supersession applies — if a preference
 * value has changed since the last run, the new row correctly supersedes the
 * old. Skips writes when an identical active fact already exists.
 *
 * Idempotent — safe to re-run.
 *
 * Conversions:
 *   `*_preference`                → fact_type='preference', subject from key prefix
 *   `current_priorities`          → fact_type='decision'
 *   `weekly_schedule_proposal`    → fact_type='decision' with valid_until = next Sunday
 *   `checkpoint_*` / `latest_context` / operational keys → left in memory
 *
 * Usage: tsx scripts/migrate-memory-to-facts.ts
 */

interface MemoryRow {
  group_id: string;
  key: string;
  value: string;
  updated_at: string;
}

function nextSundayIso(): string {
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 1=Mon, ...
  const daysUntilSunday = day === 0 ? 7 : 7 - day;
  const target = new Date(now);
  target.setUTCDate(now.getUTCDate() + daysUntilSunday);
  target.setUTCHours(0, 0, 0, 0);
  return target.toISOString();
}

function alreadyExists(subject: string, predicate: string, object: string): boolean {
  const existing = factsAbout(subject, 100);
  const pNorm = predicate.toLowerCase();
  return existing.some((f) => f.predicate === pNorm && f.object === object);
}

function maybeSave(args: {
  subject: string;
  predicate: string;
  object: string;
  fact_type: string;
  group_id?: string;
  valid_until?: string;
  source: string;
}): { wrote: boolean; reason?: string } {
  if (alreadyExists(args.subject, args.predicate, args.object)) {
    return { wrote: false, reason: 'identical fact already active' };
  }
  saveFact(args);
  return { wrote: true };
}

function migrateRow(row: MemoryRow): { converted: boolean; wrote?: boolean; reason?: string } {
  const { key, value, group_id } = row;

  // Family memory is a closed namespace. Never promote it into the global
  // facts table, even if this function is reused outside the query below.
  if (group_id === 'family') {
    return { converted: false, reason: 'Family memory remains isolated' };
  }

  if (key.endsWith('_preference')) {
    const stripped = key.replace(/_preference$/, '');
    const parts = stripped.split('_').filter(Boolean);
    if (parts.length === 0) {
      return { converted: false, reason: 'malformed preference key' };
    }
    const subject = parts[0];
    const topic = parts.slice(1).join('_');
    const predicate = topic ? `prefers_${topic}` : 'prefers';
    const { wrote, reason } = maybeSave({
      subject,
      predicate,
      object: value,
      fact_type: 'preference',
      group_id: group_id || undefined,
      source: 'manual',
    });
    return { converted: true, wrote, reason };
  }

  if (key === 'current_priorities') {
    const { wrote, reason } = maybeSave({
      subject: 'owner',
      predicate: 'priorities',
      object: value,
      fact_type: 'decision',
      group_id: group_id || undefined,
      source: 'manual',
    });
    return { converted: true, wrote, reason };
  }

  if (key === 'weekly_schedule_proposal') {
    const { wrote, reason } = maybeSave({
      subject: 'owner',
      predicate: 'weekly_schedule',
      object: value,
      fact_type: 'decision',
      group_id: group_id || undefined,
      source: 'manual',
      valid_until: nextSundayIso(),
    });
    return { converted: true, wrote, reason };
  }

  return { converted: false, reason: 'no conversion rule (operational/checkpoint key)' };
}

function main() {
  const rows = db
    .prepare('SELECT group_id, key, value, updated_at FROM memory WHERE group_id <> ? ORDER BY updated_at ASC')
    .all('family') as MemoryRow[];

  console.log(`[migrate] scanning ${rows.length} memory rows`);

  let wrote = 0;
  let skipped = 0;
  let untouched = 0;
  const reasons: Record<string, number> = {};

  for (const row of rows) {
    const result = migrateRow(row);
    if (!result.converted) {
      untouched += 1;
      continue;
    }
    if (result.wrote) {
      wrote += 1;
      console.log(`  ✓ ${row.group_id}/${row.key} → fact`);
    } else {
      skipped += 1;
      const reason = result.reason ?? 'skipped';
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
  }

  console.log(`\n[migrate] done: ${wrote} written, ${skipped} skipped (already migrated), ${untouched} left in memory`);
  if (Object.keys(reasons).length > 0) {
    for (const [r, n] of Object.entries(reasons)) {
      console.log(`           ${n}× ${r}`);
    }
  }
}

main();
