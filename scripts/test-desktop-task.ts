// A desktop task keeps its go and gets enough steps,
// an out-of-steps reply can't promise work, "X done" texts close tasks, and calls
// see the recent texts. Isolated DB, fake model, no screenshots, clicks or network.
//   npm run test:desktop-task
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-desktop-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.ACTIONS_ENABLED = 'true';
process.env.OPENAI_API_KEY = '';
process.env.THREADS_ENABLED = 'false';

const cu = await import('../src/tools/computer-use.js');
const { getOwner } = await import('../src/config.js');
const { runAgent } = await import('../src/agent.js');
const guard = await import('../src/task-done-guard.js');
const { recentTextsForCall } = await import('../src/phone.js');

const owner = getOwner();
const tool = cu.computerUseTools[0];
const ownerCtx = { groupKey: 'admin', userId: owner.id, currentMessage: 'finish it' };
const plan = 'Open the registration form attachment in Pages, fill it, save a copy';
const realNow = Date.now;
const at = (ms: number) => { Date.now = () => realNow() + ms; };

let failures = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`ok   ${name}`); } catch (err) { failures++; console.error(`FAIL ${name}\n  ${err instanceof Error ? err.message : err}`); }
  finally { Date.now = realNow; }
}

await test('start_task while the window is open does not ask again', async () => {
  cu.approveComputerUseTask('admin', 190, plan);
  const out = String(await tool.handler({ action: 'start_task', plan }, ownerCtx));
  assert.match(out, /Already approved/);
  assert.doesNotMatch(out, /Go\?/);
});

await test('the owner\'s go still stands after the window lapses', async () => {
  cu.approveComputerUseTask('admin', 190, plan);
  at(6 * 60_000);
  assert.equal(cu.desktopTaskActive('admin'), false);
  const out = String(await tool.handler({ action: 'start_task', plan: 'Finish the registration form' }, ownerCtx));
  assert.match(out, /still stands/);
  assert.match(out, /registration form attachment in Pages/);
  assert.equal(cu.desktopTaskActive('admin'), true);
});

await test('a scheduled run cannot reuse the owner\'s go', async () => {
  cu.approveComputerUseTask('admin', 190, plan);
  at(6 * 60_000);
  const out = String(await tool.handler({ action: 'start_task', plan }, { ...ownerCtx, systemAuthored: true }));
  assert.match(out, /\nGo\?\n/);
});

await test('after 30 minutes or end_task it asks again', async () => {
  cu.approveComputerUseTask('admin', 190, plan);
  at(31 * 60_000);
  assert.match(String(await tool.handler({ action: 'start_task', plan }, ownerCtx)), /\nGo\?\n/);
  Date.now = realNow;
  cu.approveComputerUseTask('admin', 191, plan);
  await tool.handler({ action: 'end_task' }, ownerCtx);
  at(6 * 60_000);
  assert.match(String(await tool.handler({ action: 'start_task', plan }, ownerCtx)), /\nGo\?\n/);
});

type Req = { tools?: unknown[]; input: unknown[] };
const call = (i: number, args: Record<string, unknown>) => ({
  output: [{ type: 'function_call', call_id: `c${i}`, name: 'computer_use', arguments: JSON.stringify(args) }],
});
const text = (t: string) => ({ output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: t }] }] });
const admin = { key: 'admin', name: 'Admin', tools: ['computer-use'], contextPath: 'context/admin' };
const user = { id: owner.id, name: owner.name, phone: '', role: 'admin' as const, tone: 'direct' as const, allowedGroups: ['admin'] };

async function runFake(maxToolCalls: number, args: Record<string, unknown>) {
  const reqs: Req[] = [];
  const reply = await runAgent(admin, user, 'go', undefined, undefined, undefined, undefined, undefined, undefined, {
    createResponse: (async (opts: Req) => {
      reqs.push({ tools: opts.tools, input: [...opts.input] });
      return reqs.length <= maxToolCalls && opts.tools?.length ? call(reqs.length, args) : text('Form filled and saved.');
    }) as never,
  });
  return { reply, reqs };
}

await test('an approved desktop task gets more than 12 steps', async () => {
  cu.clearComputerUseTask('admin');
  cu.approveComputerUseTask('admin', 192, plan);
  const { reply, reqs } = await runFake(20, { action: 'start_task', plan });
  assert.equal(reply, 'Form filled and saved.');
  assert.equal(reqs.length, 21, 'all 20 steps ran, then the reply');
  assert.ok(reqs[20].tools?.length, 'tools were still there after step 12');
});

await test('out of steps: tools go away and the note forbids promising work', async () => {
  cu.clearComputerUseTask('admin');
  const { reqs } = await runFake(99, { action: 'bogus' });
  assert.equal(reqs.length, 12);
  assert.equal(reqs[11].tools, undefined);
  assert.match(JSON.stringify(reqs[11].input), /nothing keeps running after you reply/);
});

await test('done-guard only reads finished-sounding texts and real task ids', () => {
  assert.deepEqual(guard.parseDoneIds('{"done":[866, 868, 9999]}', new Set([866, 867, 868])), [866, 868]);
  assert.deepEqual(guard.parseDoneIds('nope', new Set([1])), []);
  const now = Date.parse('2026-10-15T19:00:00Z');
  const base = { assignee: 'owner', created_at: '2026-10-15 13:05:38' };
  const picked = guard.candidateTasks([
    { ...base, id: 1, due_date: '2026-10-15T19:00:00-04:00' },
    { ...base, id: 2, due_date: '2026-08-01' },
    { ...base, id: 3, due_date: null },
    { ...base, id: 4, due_date: null, assignee: 'partner' },
  ] as never, now).map((t) => t.id);
  assert.deepEqual(picked, [1, 3]);
});

await test('done-guard skips when no done words or a task tool already ran', async () => {
  assert.deepEqual(await guard.closeTasksOwnerSaidAreDone('I should put the chicken in now no?', '', new Set()), []);
  assert.deepEqual(await guard.closeTasksOwnerSaidAreDone('laundry done', '', new Set(['complete_task'])), []);
});

await test('owner calls see the last few hours of texts', () => {
  const now = Date.parse('2026-10-15T23:10:00Z');
  const out = recentTextsForCall([
    { role: 'user', content: 'Old thing', created_at: '2026-10-15 12:00:00' },
    { role: 'user', content: 'Let’s play three clue mystery with Kai', created_at: '2026-10-15 23:05:54' },
    { role: 'assistant', content: 'Right. I give Kai three short clues.', created_at: '2026-10-15 23:06:59' },
  ], 'Alex', 'Assistant', now);
  assert.doesNotMatch(out, /Old thing/);
  assert.match(out, /^Alex: Let’s play three clue mystery/);
  assert.match(out, /\nAssistant: Right\. I give Kai three short clues\./);
});

rmSync(tempRoot, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} failed`); process.exit(1); }
console.log('\nall passed');
process.exit(0);
