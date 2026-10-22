// What the text tracker would open from the owner's recent threads, without writing anything.
//   npm run texts:loops -- [days, default 3]
import 'dotenv/config';
import { initUsers } from '../src/user-resolver.js';
import { textLoopsPass } from '../src/text-loops.js';

initUsers();
const days = Number(process.argv[2] ?? 3);
const r = await textLoopsPass({ dryRun: true, sinceDays: days });
const label: Record<string, string> = { owe_reply: 'You owe a reply', i_promised: 'You promised', waiting_on_them: 'Waiting on them', plan: 'Plan' };
for (const kind of Object.keys(label)) {
  const xs = r.proposed.filter((p) => p.loop.kind === kind);
  if (!xs.length) continue;
  console.log(`\n${label[kind]}`);
  for (const p of xs) console.log(`  - ${p.loop.summary}${p.loop.due ? ` (by ${p.loop.due})` : ''}  [${p.chat}, ${Math.round((p.loop.confidence ?? 1) * 100)}%]`);
}
console.log(`\nRead ${r.chats} threads from the last ${days} days. Dry run: nothing was written.`);
process.exit(0);
