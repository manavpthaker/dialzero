// Follow-up tests (watches + email threads): isolated DB; the checker agent,
// email sender, notifier and clock are stubbed. Nothing sends or texts.
//   npm run test:followups
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-followups-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.ACTIONS_ENABLED = 'true';

const db = await import('../src/db.js');
const fu = await import('../src/followups.js');
const wb = await import('../src/web-booking.js');
const wt = await import('../src/web-task.js');
wt.setWebTaskCodeLookup(async () => null); // never touch real email/texts in tests
wt.setWebTaskEmailLookup(async () => null);
wt.setWebTaskPageUrlReader(async () => null);
const jobs = await import('../src/jobs.js');
const { toolRegistry } = await import('../src/tools/index.js');
const { getOwner } = await import('../src/config.js');

const HOUR = 3_600_000;
let now = Date.parse('2026-10-05T14:00:00Z'); // a Monday
let checks: string[] = [];
const prompts: string[] = [];
const sent: Array<{ to: string; subject: string; body: string }> = [];
const told: Array<{ text: string; kind: string }> = [];
const ambient: string[] = [];
fu.setFollowupDeps({
  runCheck: async (p) => { prompts.push(p); return checks.shift() ?? '{"status":"not_yet","summary":""}'; },
  sendEmail: async (e) => { sent.push(e); },
  notify: async (text, _s, kind) => { told.push({ text, kind }); },
  ambient: (line) => { ambient.push(line); },
  now: () => now,
});

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS  ${name}`); }
const OWNER = getOwner().id;
const tool = (n: string) => toolRegistry.actions.find((t) => t.definition.name === n)!;

try {
  await check('business days skip weekends', () => {
    const fri = Date.parse('2026-10-02T15:00:00Z');
    assert.equal(fu.businessDaysBetween(fri, fri + 3 * 24 * HOUR), 1, 'Fri → Mon = 1');
    assert.equal(fu.businessDaysBetween(fri, fri + 5 * 24 * HOUR), 3);
  });

  await check('watch: not yet → checks again later; ok → closes quietly into the check-in', async () => {
    const id = fu.openWatch('Make sure the plaud.ai cancellation is confirmed by email.', 'A confirmation email from plaud.ai', { firstCheckInHours: 1, untilDays: 3 });
    assert.equal(await fu.followupTick(), 0, 'not due yet');
    now += HOUR;
    checks = ['{"status":"not_yet","summary":"nothing yet"}'];
    assert.equal(await fu.followupTick(), 1);
    assert.equal(db.getJob(id)!.status, 'watching');
    now += 12 * HOUR;
    checks = ['{"status":"ok","summary":"Plaud confirmed the cancellation by email."}'];
    await fu.followupTick();
    assert.equal(db.getJob(id)!.status, 'done');
    assert.deepEqual(ambient, ['✅ Plaud confirmed the cancellation by email.']);
    assert.equal(told.length, 0, 'good news never interrupts');
    assert.match(prompts[0], /Read only/);
  });

  await check('watch: a problem texts them a decision; running out of time does too', async () => {
    const a = fu.openWatch('Make sure Comcast refunds the $40.', 'A $40 refund from Comcast', { firstCheckInHours: 0, untilDays: 1 });
    checks = ['{"status":"problem","summary":"Comcast charged you $40 again on Oct 5."}'];
    await fu.followupTick();
    assert.equal(db.getJob(a)!.status, 'failed');
    assert.deepEqual(told.at(-1), { text: '⚠️ Comcast charged you $40 again on Oct 5.', kind: 'decision' });
    const b = fu.openWatch('Make sure X emails back.', 'A reply from X', { firstCheckInHours: 0, untilDays: 1 });
    now += 25 * HOUR;
    checks = ['{"status":"not_yet","summary":""}'];
    await fu.followupTick();
    assert.equal(db.getJob(b)!.status, 'failed');
    assert.match(told.at(-1)!.text, /Still nothing on: A reply from X/);
  });

  await check('email errand: sends now when they asked, then answers their question within what they allowed', async () => {
    sent.length = 0;
    const out = String(await tool('email_errand').handler({
      owner_request: 'email plaud support to cancel', goal: 'cancel my Plaud subscription', to: 'support@plaud.ai',
      subject: 'Cancel my subscription', body: 'Hi, please cancel my subscription. Thanks, Alex', share: 'account email m@example.com',
    }, { groupKey: 'admin', userId: OWNER, currentMessage: 'email plaud support to cancel' }));
    assert.match(out, /Sent, and watching/);
    assert.equal(sent.length, 1);
    const job = db.listOpenJobRows().find((j) => j.kind === 'email_thread')!;
    assert.match(jobs.describeOpenItems(), /Cancel my Plaud subscription \(emailed support@plaud\.ai\)/);
    now += 2 * HOUR;
    checks = ['{"status":"reply","summary":"They asked which account.","reply_body":"It is m@example.com."}'];
    await fu.followupTick();
    assert.deepEqual(sent.at(-1), { to: 'support@plaud.ai', subject: 'Re: Cancel my subscription', body: 'It is m@example.com.' });
    assert.match(prompts.at(-1)!, /DETAILS THEY ALLOWED SHARING: account email m@example.com/);
    now += 2 * HOUR;
    checks = ['{"status":"done","summary":"Plaud cancelled it; no more charges."}'];
    await fu.followupTick();
    assert.equal(db.getJob(job.id)!.status, 'done');
    assert.deepEqual(told.at(-1), { text: '✅ Plaud cancelled it; no more charges.', kind: 'reply' });
  });

  await check('email errand: silence → one follow-up after 3 business days → then offers a call, waiting on them', async () => {
    sent.length = 0;
    const id = await fu.startEmailThread({ goal: 'get my deposit back', to: 'office@landlord.com', subject: 'Deposit', body: 'Hi, about my deposit.', share: '' });
    now += 2 * HOUR;
    checks = ['{"status":"none","followup_body":"Just following up."}'];
    await fu.followupTick();
    assert.equal(sent.length, 1, 'too early for a follow-up');
    now += 6 * 24 * HOUR; // 3+ business days, whatever weekday it started
    checks = ['{"status":"none","followup_body":"Just following up on my email below."}'];
    await fu.followupTick();
    assert.equal(sent.length, 2);
    assert.match(db.getJob(id)!.progress!, /sent a follow-up/);
    now += 5 * 24 * HOUR;
    checks = ['{"status":"none","followup_body":"x"}'];
    await fu.followupTick();
    assert.equal(sent.length, 2, 'only one follow-up');
    assert.equal(db.getJob(id)!.status, 'waiting_on_you');
    assert.match(told.at(-1)!.text, /Want me to call them instead\?/);
  });

  await check('email errand from their own idea is a proposal ("Go?"), never sent first', async () => {
    sent.length = 0;
    const out = String(await tool('email_errand').handler({ goal: 'ask for a refund', to: 'help@x.com', subject: 'Refund', body: 'Hi' }, { groupKey: 'admin', userId: OWNER, currentMessage: 'hmm' }));
    assert.match(out, /Go\?/);
    assert.equal(sent.length, 0);
  });

  await check('after a website cancellation: watches for the confirmation email and for a new charge', async () => {
    wb.setBookingDeps({
      isConnected: () => true,
      runBrowser: async () => '{"status":"done","summary":"Plaud cancelled; access ends Oct 29.","next_charge":"2026-10-29"}',
      notify: async () => {},
      withLock: async (_l, fn) => fn(),
      timeoutMs: 2000,
    });
    const before = db.listOpenJobRows().filter((j) => j.kind === 'watch').length;
    const { done } = wt.startWebTask({ task: 'cancel the PLAUD subscription', site: 'https://web.plaud.ai' } as never, 'Cancel Plaud.', 'admin');
    await done;
    const watches = db.listOpenJobRows().filter((j) => j.kind === 'watch');
    assert.equal(watches.length - before, 2);
    assert.ok(watches.some((w) => /cancellation is confirmed by email/.test(w.title)));
    const charge = watches.find((w) => /doesn't charge again after 2026-10-29/.test(w.title))!;
    assert.ok(Date.parse(charge.next_check_at!) > Date.parse('2026-10-30T00:00:00Z'), 'checks after the billing date');
  });

  console.log(`\nFollow-up tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
