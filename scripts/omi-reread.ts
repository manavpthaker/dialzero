// Re-read Omi conversations the sync got wrong (empty reads, wrongly skipped, cut short) with
// the current rules. Prints what it would keep; writes nothing unless told to.
//   npm run omi:reread -- 37129c44 a046f25a ...                 dry run
//   npm run omi:reread -- --save review.json 37129c44 ...       dry run, saved for review
//   npm run omi:reread -- --apply-from review.json              write exactly what's in the file
//   npm run omi:reread -- --apply 37129c44 ...                  re-read and write in one go
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { applyReread, rereadConversations, type OmiExtract } from '../src/omi-sync.js';
import { similarOpenTask } from '../src/lib/task-dedupe.js';

const args = process.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const save = flag('--save');
const from = flag('--apply-from');
const apply = args.includes('--apply');
const ids = args.filter((a) => !a.startsWith('--'));

function show(id: string, title: string, when: string, p: OmiExtract, marks: boolean) {
  console.log(`\n${id.slice(0, 8)}  ${title}  (${when.slice(0, 16)})`);
  for (const t of p.todos ?? []) console.log(`  to-do: ${t.title}${t.due ? ` (due ${t.due})` : ''}${marks && similarOpenTask(t.title) ? '  [already on the list]' : ''}`);
  for (const c of p.commitments ?? []) console.log(`  promised${c.counterpart ? ` ${c.counterpart}` : ''}: ${c.text}`);
  for (const d of p.decisions ?? []) console.log(`  decided: ${d.text}`);
  if (p.people?.length) console.log(`  people: ${p.people.map((x) => x.name).join(', ')}`);
}

if (from) {
  const rows = JSON.parse(readFileSync(from, 'utf8')) as Parameters<typeof applyReread>[0];
  for (const r of applyReread(rows)) console.log(`${r.id.slice(0, 8)}  wrote ${JSON.stringify(r.wrote)}`);
  console.log('\nWritten.');
  process.exit(0);
}
if (!ids.length) { console.error('usage: npm run omi:reread -- [--save file | --apply] <conversation id or prefix>... | --apply-from file'); process.exit(2); }

const rows = await rereadConversations(ids, apply);
for (const r of rows) {
  if (r.note || !r.parsed) { console.log(`\n${r.id.slice(0, 8)}  ${r.title}\n  - ${r.note}`); continue; }
  show(r.id, r.title, r.when, r.parsed, !apply);
  if (r.wrote) console.log(`  wrote: ${JSON.stringify(r.wrote)}`);
}
if (save) {
  writeFileSync(save, JSON.stringify(rows.filter((r) => r.card && r.parsed).map((r) => ({ card: r.card, parsed: r.parsed, upTo: r.upTo })), null, 2));
  console.log(`\nSaved for review: ${save}`);
}
console.log(apply ? '\nWritten.' : '\nDry run: nothing was written.');
process.exit(0);
