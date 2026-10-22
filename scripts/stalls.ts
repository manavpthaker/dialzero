// npm run stalls → the bot's recent freezes (src/lib/stall-watch.ts), newest last.
import { getMemory } from '../src/db.js';
const raw = getMemory('system', 'stalls');
const list = raw ? JSON.parse(raw) as Array<{ at: string; ms: number; duringCall: boolean; before: string[] }> : [];
if (!list.length) console.log('No freezes logged since the bot started.');
for (const s of list) {
  console.log(`${s.at}  ${(s.ms / 1000).toFixed(1)}s${s.duringCall ? '  DURING A CALL' : ''}`);
  for (const b of s.before) console.log(`    ${b}`);
}
process.exit(0);
