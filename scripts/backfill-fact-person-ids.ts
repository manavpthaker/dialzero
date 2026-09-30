import 'dotenv/config';
import db from '../src/db.js';

/**
 * One-shot backfill: walk active facts where person_id IS NULL and try to
 * resolve the subject string to a row in `people` via strict case-insensitive
 * exact-name match. Sets person_id where unambiguous (exactly one match).
 *
 * Idempotent — safe to re-run. Facts whose subject doesn't resolve to a
 * person stay unlinked; that's expected for company/project/topic subjects.
 *
 * Usage: tsx scripts/backfill-fact-person-ids.ts
 */

interface CandidateFact {
  id: number;
  subject: string;
}

interface CandidatePerson {
  id: number;
}

const unlinked = db
  .prepare(
    `SELECT id, subject FROM facts
     WHERE person_id IS NULL
       AND active = 1
       AND (valid_until IS NULL OR valid_until > datetime('now'))`
  )
  .all() as CandidateFact[];

console.log(`[backfill] scanning ${unlinked.length} unlinked active facts`);

const findExact = db.prepare('SELECT id FROM people WHERE name = ? COLLATE NOCASE');
const link = db.prepare('UPDATE facts SET person_id = ? WHERE id = ?');

let linked = 0;
let ambiguous = 0;
let nomatch = 0;

for (const fact of unlinked) {
  const hits = findExact.all(fact.subject) as CandidatePerson[];
  if (hits.length === 0) {
    nomatch += 1;
    continue;
  }
  if (hits.length > 1) {
    ambiguous += 1;
    console.log(`  ? fact #${fact.id} subject="${fact.subject}" matches ${hits.length} people — leaving unlinked`);
    continue;
  }
  link.run(hits[0].id, fact.id);
  linked += 1;
}

console.log(`\n[backfill] done: ${linked} linked, ${ambiguous} ambiguous (left unlinked), ${nomatch} non-person subjects`);
