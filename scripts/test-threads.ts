// Ongoing topics (src/threads.ts): created from a real subject, matched with no
// cue words, updated in place, closed when done, kept per chat. Model stubbed.
//   npm run test:threads
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-threads-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
const t = await import('../src/threads.js');

let reply = '';
const seen: string[] = [];
t.setThreadDeps({ complete: async (_sys, prompt) => { seen.push(prompt); return reply; } });

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) { await fn(); passed++; console.log(`PASS  ${name}`); }

try {
  let tripId = 0;
  await check('a real subject starts a topic; a one-off does not', async () => {
    reply = '{"updates":[{"id":null,"title":"February 2027 family trip","summary":"Leaning Lisbon for Feb 2027; Valencia and Mexico City as backups.","details":"Dates: Presidents Day week\\nLisbon: Bairro Alto hotels ~$220/night","open_questions":"Flights from ORD?"}]}';
    const ids = await t.updateThreads('admin', [{ role: 'user', content: 'Help plan a family vacation for February' }, { role: 'assistant', content: 'Lisbon is the pick…' }], []);
    assert.equal(ids.length, 1);
    tripId = ids[0];
    reply = '{"updates":[]}';
    assert.deepEqual(await t.updateThreads('admin', [{ role: 'user', content: "what's the weather" }, { role: 'assistant', content: 'Sunny' }], []), []);
    assert.equal(t.openThreads('admin').length, 1);
  });

  await check('"what about flights" matches the trip with no cue words, and the record goes in the prompt', async () => {
    reply = `{"ids":[${tripId}]}`;
    const picked = await t.pickThreads('admin', 'ok what about flights', [{ role: 'user', content: 'cancel the streaming thing' }, { role: 'assistant', content: 'Done.' }]);
    assert.deepEqual(picked.map((x) => x.id), [tripId]);
    assert.match(seen.at(-1)!, /February 2027 family trip — Leaning Lisbon/);
    const block = t.threadBlock(picked);
    assert.match(block, /they don't need to repeat any of this/);
    assert.match(block, /Lisbon: Bairro Alto hotels ~\$220\/night/);
    assert.match(block, /Open: Flights from ORD\?/);
  });

  await check('updates land on the same topic; finished topics close', async () => {
    const trip = t.getThread(tripId)!;
    reply = `{"updates":[{"id":${tripId},"title":"February 2027 family trip","summary":"Lisbon chosen; TAP nonstop ORD-LIS ~$780 pp.","details":"Flights: TAP TP202 ORD-LIS","open_questions":"Book hotel"}]}`;
    await t.updateThreads('admin', [{ role: 'user', content: 'ok what about flights' }, { role: 'assistant', content: 'TAP nonstop…' }], [trip]);
    assert.match(t.getThread(tripId)!.details, /TP202/);
    assert.equal(t.openThreads('admin').length, 1, 'no duplicate topic');
    reply = `{"updates":[{"id":${tripId},"title":"February 2027 family trip","summary":"All booked.","details":"","open_questions":"","close":true}]}`;
    await t.updateThreads('admin', [{ role: 'user', content: 'booked everything' }, { role: 'assistant', content: 'Nice.' }], [t.getThread(tripId)!]);
    assert.equal(t.openThreads('admin').length, 0);
  });

  await check('topics are per chat, and an unknown id is never written', async () => {
    reply = '{"updates":[{"id":null,"title":"Sam birthday party","summary":"Planning for April","details":"","open_questions":""}]}';
    await t.updateThreads('family', [{ role: 'user', content: 'lets plan Sam bday' }, { role: 'assistant', content: 'Sure' }], []);
    assert.equal(t.openThreads('family').length, 1);
    assert.equal(t.openThreads('admin').length, 0, "the Family chat's topics stay in the Family chat");
    reply = '{"updates":[{"id":9999,"title":"x","summary":"y"}]}';
    assert.deepEqual(await t.updateThreads('admin', [{ role: 'user', content: 'x' }], []), []);
    reply = '{"ids":[9999]}';
    assert.deepEqual(await t.pickThreads('family', 'hm', []), []);
  });

  console.log(`\nThread tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
