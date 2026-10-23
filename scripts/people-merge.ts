// Merge duplicate people from a plan file, after a backup of the database.
//   npx tsx scripts/people-merge.ts plan.json           show what would change
//   npx tsx scripts/people-merge.ts plan.json --apply   back up the database, then merge
// plan.json: { "merges": [{ "label": "Alex", "keep": 1, "drop": [4998, 5000] }],
//              "moves":  [{ "label": "Work meetings with Jordan Lee", "from": 843, "to": 121, "refs": ["omi:…"] }] }
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import db, { getPersonById, mergePeople, movePersonRecords } from '../src/db.js';

const file = process.argv[2];
const apply = process.argv.includes('--apply');
if (!file) { console.error('usage: people-merge.ts plan.json [--apply]'); process.exit(1); }
const plan = JSON.parse(readFileSync(file, 'utf8')) as {
  merges?: Array<{ label: string; keep: number; drop: number[] }>;
  moves?: Array<{ label: string; from: number; to: number; refs: string[] }>;
};
const q = db as unknown as { prepare: (s: string) => { get: (...a: unknown[]) => unknown } };
const count = (id: number) => (q.prepare('SELECT count(*) AS n FROM interactions WHERE person_id = ?').get(id) as { n: number }).n;
const name = (id: number) => getPersonById(id)?.name ?? `#${id} (gone)`;

for (const m of plan.merges ?? []) {
  const found = m.drop.filter((id) => getPersonById(id));
  console.log(`${m.label}: keep ${name(m.keep)} (#${m.keep}, ${count(m.keep)} conversations), fold in ${found.length} records (${found.reduce((s, id) => s + count(id), 0)} conversations)`);
}
for (const m of plan.moves ?? []) console.log(`${m.label}: ${m.refs.length} conversations from ${name(m.from)} (#${m.from}) to ${name(m.to)} (#${m.to})`);

if (apply) {
  const backup = join(process.cwd(), 'backups', `assistant-before-people-merge-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.db`);
  await (db as unknown as { backup: (p: string) => Promise<unknown> }).backup(backup);
  console.log(`\nBacked up to ${backup}`);
  for (const m of plan.merges ?? []) console.log(`${m.label}:`, JSON.stringify(mergePeople(m.keep, m.drop)));
  for (const m of plan.moves ?? []) console.log(`${m.label}: moved ${movePersonRecords(m.from, m.to, m.refs)}`);
} else console.log('\nNothing changed. Add --apply to merge.');
process.exit(0);
