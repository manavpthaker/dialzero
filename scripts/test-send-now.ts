// send_now tests: isolated DB, real senders swapped for stubs so nothing is
// ever texted or emailed.
//   npm run test:send-now
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-send-now-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.ACTIONS_ENABLED = 'true';

const db = await import('../src/db.js');
// Load the registry first, as the app does; tools/errands.ts sits in an import
// cycle through phone.ts that only resolves in that order.
await import('../src/tools/index.js');
const { ownerAsked } = await import('../src/lib/owner-request.js');
const sendNow = await import('../src/tools/send-now.js');

const sent: Array<{ tool: string; payload: Record<string, unknown> }> = [];
sendNow.setSendNowSenders({
  imessage: async (a) => { sent.push({ tool: a.tool_name, payload: JSON.parse(a.payload_json) }); return { outcome: 'stub text', actual_cost_cents: 0 }; },
  email: async (a) => { sent.push({ tool: a.tool_name, payload: JSON.parse(a.payload_json) }); return { outcome: 'stub email', actual_cost_cents: 0 }; },
});

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const handler = sendNow.sendNowTools[0].handler;
const msg = "Tell Priya Test I'm running 10 late, sorry";
const ctx = { groupKey: 'admin', userId: 'owner', currentMessage: msg };

try {
  await check('ownerAsked: his words match, case and punctuation insensitive', () => {
    assert.equal(sendNow.ownerAskedToSend("Tell Priya Test I'm running 10 late", ctx), true);
    assert.equal(sendNow.ownerAskedToSend('tell priya test, I’m... running 10 LATE!', ctx), true);
  });

  await check('ownerAsked: words he did not say, other users, short quotes fail', () => {
    assert.equal(sendNow.ownerAskedToSend('Tell Priya the deal is off', ctx), false, 'not his words');
    assert.equal(sendNow.ownerAskedToSend("Tell Priya Test I'm running 10 late", { ...ctx, userId: 'partner' }), false, 'owner only');
    assert.equal(sendNow.ownerAskedToSend("Tell Priya Test I'm running 10 late", { ...ctx, userId: undefined }), false, 'no user');
    assert.equal(sendNow.ownerAskedToSend('ask her', { ...ctx, currentMessage: 'ask her' }), false, 'too short');
  });

  await check('ownerAsked: action words are required', () => {
    const m = "I'm running 10 late to dinner with Priya";
    assert.equal(sendNow.ownerAskedToSend("I'm running 10 late to dinner", { ...ctx, currentMessage: m }), false);
    assert.equal(ownerAsked("I'm running 10 late to dinner", { ...ctx, currentMessage: m }, /\blate\b/), true, 'helper takes the word list');
    for (const w of ['text Sam that Thursday works', 'email the landlord about the leak', 'reply to Sam saying yes', 'let Sam know Thursday works', 'ask Sam if Thursday works']) {
      assert.equal(sendNow.ownerAskedToSend(w, { ...ctx, currentMessage: w }), true, w);
    }
  });

  await check('ownerAsked: his messages from the last 30 min count, older ones do not', () => {
    db.saveMessage('admin', 'alex', 'user', 'text Sam that the plumber is coming Friday');
    db.saveMessage('admin', 'alex', 'user', 'email Dana the Q3 numbers', new Date(Date.now() - 45 * 60_000).toISOString());
    db.saveMessage('admin', 'assistant', 'assistant', 'text Sam that the deal is off');
    const later = { ...ctx, currentMessage: 'yes do it' };
    assert.equal(sendNow.ownerAskedToSend('text Sam that the plumber is coming Friday', later), true);
    assert.equal(sendNow.ownerAskedToSend('email Dana the Q3 numbers', later), false, 'older than 30 min');
    assert.equal(sendNow.ownerAskedToSend('text Sam that the deal is off', later), false, 'assistant turns do not count');
  });

  await check('call_now still uses the same check', async () => {
    const { ownerAskedForCall } = await import('../src/tools/errands.js');
    const m = 'Call the dentist and move my cleaning';
    assert.equal(ownerAskedForCall('call the dentist', { ...ctx, currentMessage: m }), true);
    assert.equal(ownerAskedForCall(msg, ctx), false, 'send words are not call words');
  });

  await check('refuses without his words; nothing sent, no action row', async () => {
    const out = await handler({ owner_request: 'Tell Priya the deal is off', channel: 'imessage', to: '732-555-2177', text: 'Deal is off' }, ctx);
    assert.match(String(out), /^Not sent: .*propose_action with send_imessage/);
    assert.equal(sent.length, 0);
    assert.equal(db.listRecentActions(5).length, 0);
  });

  await check('ambiguous name comes back as a question', async () => {
    db.upsertPerson({ name: 'Priya Test', phones: ['732-555-2177'] });
    db.upsertPerson({ name: 'Priya Other', phones: ['732-555-2188'] });
    const out = await handler({ owner_request: "Tell Priya Test I'm running 10 late", channel: 'imessage', person: 'Priya', text: 'Running 10 late, sorry!' }, ctx);
    assert.match(String(out), /Not sent: "Priya" matches 2 people.*Ask which one/);
    assert.equal(sent.length, 0);
  });

  await check('sends a text: short reply, audit row done, duplicate refused', async () => {
    const input = { owner_request: "Tell Priya Test I'm running 10 late", channel: 'imessage', person: 'Priya Test', text: 'Running 10 late, sorry!' };
    const out = String(await handler(input, ctx));
    assert.match(out, /^Sent to Priya Test: "Running 10 late, sorry!" \[action #\d+\]$/);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.to, '+17325552177');
    const id = Number(out.match(/#(\d+)\]$/)![1]);
    const row = db.getAction(id)!;
    assert.equal(row.status, 'done');
    assert.equal(row.tool_name, 'send_imessage');
    assert.equal(row.kind, 'message');
    assert.match(row.summary, /^Text Priya Test/);
    assert.ok(row.confirmed_at);
    assert.match(String(await handler(input, ctx)), /Already sent/);
    assert.equal(sent.length, 1, 'no second send');
  });

  await check('sends an email via the email preparer', async () => {
    const m = 'email the landlord at landlord@example.com about the leak under the sink';
    const out = String(await handler({ owner_request: 'email the landlord at landlord@example.com about the leak', channel: 'email', to: 'landlord@example.com', subject: 'Leak under the sink', body: 'Hi, the kitchen sink is leaking. Can someone come by?' }, { ...ctx, currentMessage: m }));
    assert.match(out, /^Emailed landlord@example\.com, subject "Leak under the sink"\. \[action #\d+\]$/);
    assert.equal(sent.at(-1)!.tool, 'send_email');
    assert.deepEqual(sent.at(-1)!.payload.to, ['landlord@example.com']);
  });

  await check('a failed send marks the row failed', async () => {
    sendNow.setSendNowSenders({
      imessage: async () => { throw new Error('Messages app not running'); },
      email: async () => { throw new Error('unused'); },
    });
    const out = String(await handler({ owner_request: msg, channel: 'imessage', to: '732-555-2199', text: 'On my way' }, ctx));
    assert.match(out, /Couldn't send to \+17325552199: Messages app not running/);
    const row = db.listRecentActions(10).find((a) => a.payload_json.includes('+17325552199'));
    assert.equal(row?.status, 'failed');
    assert.match(String(row?.error), /Messages app not running/);
  });

  console.log(`\n${passed} passed`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
