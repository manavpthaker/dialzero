// The owner as the safety net: questions from a live call, the owner's answer (text or
// hook), ringing them in, and the take-over hooks. Isolated DB, phone unconfigured, no network.
//   npm run test:safety-net
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-safety-net-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
for (const k of ['PHONE_PUBLIC_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER', 'OPENAI_WEBHOOK_SECRET', 'OPENAI_PROJECT_ID']) process.env[k] = '';

const net = await import('../src/call-safety-net.js');
const phone = await import('../src/phone.js');
const db = await import('../src/db.js');
const errands = await import('../src/errands.js');
const { setDoneChecker } = await import('../src/lib/verify.js');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS  ${name}`); }

try {
  await check("a question from a call is answered by the owner's next text, or the hook", async () => {
    const events: string[] = [];
    net.setCallsChanged((e) => events.push(`${e.type}:${e.key}`));
    const p = net.openAsk('errand:1', 'Example Siding', 'Thursday 4pm or Friday 10am?', 5_000);
    assert.equal(net.canAsk('errand:1'), true);
    assert.equal(net.pendingAsk('errand:1'), 'Thursday 4pm or Friday 10am?');
    assert.deepEqual(net.takeAskAnswer('Friday 10'), { who: 'Example Siding' });
    assert.equal(await p, 'Friday 10');
    assert.equal(net.canAsk('errand:1'), false);
    assert.equal(net.takeAskAnswer('unrelated text'), null, 'no open question: the text goes to the assistant as usual');
    const q = net.openAsk('errand:2', 'Dentist', 'OK to share your insurance?', 5_000);
    assert.equal(net.answerCallAsk('errand:2', 'No'), true);
    assert.equal(await q, 'No');
    assert.deepEqual(events, ['ask:errand:1', 'answered:errand:1', 'ask:errand:2', 'answered:errand:2']);
    net.setCallsChanged(null);
  });

  await check('no answer in time: the call goes on without the owner', async () => {
    assert.equal(await net.openAsk('errand:3', 'Roofer', 'Price OK?', 50), null);
    assert.equal(net.canAsk('errand:3'), false);
  });

  await check('take over reaches the live call; an ended call says so', async () => {
    let rung = 0;
    net.registerLiveCall('errand:4', 'Example Pro', async () => { rung++; return 'Ringing the owner now.'; });
    assert.equal(net.canTakeOver('errand:4'), true);
    assert.equal(await net.takeOverCall('errand:4'), 'Ringing the owner now.');
    assert.equal(rung, 1);
    const pending = net.openAsk('errand:4', 'Example Pro', 'q', 5_000);
    net.unregisterLiveCall('errand:4');
    assert.equal(await pending, null, 'a call that ends drops its question');
    assert.equal(net.canTakeOver('errand:4'), false);
    assert.equal(await net.takeOverCall('errand:4'), 'That call is over.');
  });

  await check('the call tools exist only where the owner can be reached (an errand on the conference)', () => {
    const base = { kind: 'errand' as const, actionId: 1, to: '+12025550142', name: 'Example Auto', personId: null, goal: 'Book an oil change', context: '', keepTranscript: false };
    const withNet = phone.errandSessionConfig({ ...base, errandId: 9, conf: { token: 't', name: 'n' } });
    const names = (withNet.tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(names.includes('check_with_owner') && names.includes('bring_in_owner'));
    assert.match(withNet.instructions, /call check_with_owner/);
    const without = phone.errandSessionConfig(base);
    assert.ok(!(without.tools as Array<{ name: string }>).some((t) => t.name === 'check_with_owner'));
    assert.match(without.instructions, /call them back/);
  });

  await check('a call the owner took over is done without the transcript checker', async () => {
    setDoneChecker(async () => ({ ok: false, why: 'no confirmation in the transcript' }));
    errands.setErrandNotifier(async () => {});
    const p = errands.prepareErrand({ goal: 'Book an inspection', targets: [{ name: 'Example Pro', phone: '202-555-2765' }] });
    if ('error' in p) throw new Error(p.error);
    const id = db.createErrand({ action_id: null, goal: 'x', deadline: null, envelope_json: JSON.stringify(p.payload) });
    db.addErrandEvent(id, 'dialing', '[t0] Example Pro (202-555-2765), action #0');
    await errands.applyCallResult(id, { status: 'done', outcome: 'Handed the call to the owner', followUp: '', transcriptTail: '', handedToOwner: true });
    assert.equal(db.getErrand(id)!.status, 'done');
    setDoneChecker(null);
  });

  console.log(`\nSafety net tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
process.exit(0);
