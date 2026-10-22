// Stall watch: a frozen thread is logged with what ran just before it.
//   npm run test:stall-watch
import assert from 'node:assert/strict';
const { startStallWatch, noteForTest } = await import('../src/lib/stall-watch.js');

const saved: unknown[][] = [];
const lines: string[] = [];
const origWarn = console.warn;
const stop = startStallWatch({ thresholdMs: 300, callLive: () => true, save: (s) => saved.push([...s]) });
const wrapped = console.warn;
console.warn = (...a: unknown[]) => { lines.push(a.join(' ')); };
noteForTest('[omi-sync] reading 4 new conversations');
// Freeze the thread for ~800ms.
const until = Date.now() + 800; while (Date.now() < until) { /* busy */ }
await new Promise((r) => setTimeout(r, 400));
console.warn = wrapped;
stop();
console.warn = origWarn;
const stall = lines.find((l) => l.startsWith('[stall]'));
assert.ok(stall, 'a freeze is logged');
assert.match(stall!, /froze 0\.\ds|froze 1\.\ds/);
assert.match(stall!, /DURING A CALL/);
assert.match(stall!, /\[omi-sync\] reading 4 new conversations/);
assert.equal(saved.length >= 1, true, 'kept for npm run stalls');
console.log('PASS  a freeze is logged with what ran just before it\n\nStall watch tests passed: 1 check.');
process.exit(0);
