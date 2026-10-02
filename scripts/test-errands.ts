// Errand runner tests: isolated DB, phone deliberately unconfigured (nothing can
// dial), owner notifications captured instead of texted.
//   npm run test:errands
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-errands-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
// Empty (not unset) so a later dotenv load can't fill them in.
for (const k of ['PHONE_PUBLIC_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER', 'OPENAI_WEBHOOK_SECRET', 'OPENAI_PROJECT_ID']) process.env[k] = '';
process.env.USER_OWNER = '9085552100';
process.env.ERRAND_RETRY_GAP_MIN = '120';

const db = await import('../src/db.js');
const phone = await import('../src/phone.js');
const errands = await import('../src/errands.js');

assert.equal(phone.isPhoneConfigured(), false, 'phone must be unconfigured in tests');

const told: Array<{ id: number; kind: string; text: string }> = [];
errands.setErrandNotifier(async (row, kind, text) => { told.push({ id: row.id, kind, text }); });

// Calendar writes are captured, never sent to Google.
const booked: Array<Record<string, unknown>> = [];
let calendarFails = false;
errands.setErrandCalendar(async (b) => {
  if (calendarFails) throw new Error('Google said no');
  booked.push({ ...b });
  return { eventId: `evt${booked.length}`, htmlLink: `https://calendar.test/evt${booked.length}` };
});

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const base = {
  goal: 'Book an oil change for the 2019 Honda Civic',
  targets: [{ name: 'Quick Lube Springfield', phone: '(732) 555-2142' }, { name: 'Oil Stop Riverside', phone: '908-555-2199' }],
  share: 'Name: Alex Rivera; cell 908-555-2100; car: 2019 Honda Civic',
  window: 'Wed or Thu after 3pm',
};

function activate(payload: Record<string, unknown>): number {
  const prepared = errands.prepareErrand(payload);
  if ('error' in prepared) throw new Error(prepared.error);
  return db.createErrand({ action_id: null, goal: String(prepared.payload.goal), deadline: null, envelope_json: JSON.stringify(prepared.payload) });
}

try {
  await check('proposal summary lists targets, share, cap, and transcript default', () => {
    const p = errands.prepareErrand(base);
    assert.ok(!('error' in p));
    if ('error' in p) return;
    assert.match(p.summary, /Calls: Quick Lube Springfield 732-555-2142 \(backup: Oil Stop Riverside\), up to 4x/);
    assert.match(p.summary, /Shares: Name: Alex Rivera/);
    assert.match(p.summary, /No transcript \("keep transcript" to record\)/);
    assert.ok(p.summary.split('\n').length <= 5, 'summary stays short');
  });

  await check('rejects missing targets, bad numbers, emergency numbers, own number, too many targets', () => {
    const err = (p: Record<string, unknown>) => { const r = errands.prepareErrand(p); return 'error' in r ? r.error : ''; };
    assert.match(err({ ...base, targets: [] }), /needs "targets"/);
    assert.match(err({ ...base, targets: [{ name: 'X', phone: '12345' }] }), /not a US number/);
    assert.match(err({ ...base, targets: [{ name: '911', phone: '911' }] }), /not a US number/);
    assert.match(err({ ...base, targets: [{ name: 'Premium', phone: '1-900-555-0100' }] }), /not a US number/);
    assert.match(err({ ...base, targets: [{ name: 'Me', phone: '908 555 2100' }] }), /your own number/);
    assert.match(err({ ...base, targets: [1, 2, 3, 4].map((i) => ({ name: `S${i}`, phone: `732555210${i}` })) }), /at most 3/);
    assert.match(err({ ...base, deadline: '2020-01-01' }), /in the past/);
    assert.match(err({ ...base, goal: '' }), /needs "goal"/);
  });

  await check('made-up 555-01xx numbers are refused', () => {
    const r = errands.prepareErrand({ ...base, targets: [{ name: 'Springfield DPW', phone: '908-555-0111' }] });
    assert.ok('error' in r && /made-up/.test(r.error));
    assert.equal(phone.isFictionalNumber('+19085550111'), true);
    assert.equal(phone.isFictionalNumber('+12125552368'), false);
  });

  await check('call_now only skips the gate for the owner\'s own words asking for a call', async () => {
    const { ownerAskedForCall } = await import('../src/tools/errands.js');
    const msg = 'Call springfield waste management they haven\'t picked up our grass clippings, leave a message with my address';
    const ctx = { groupKey: 'admin', userId: 'owner', currentMessage: msg };
    assert.equal(ownerAskedForCall('Call springfield waste management', ctx), true);
    assert.equal(ownerAskedForCall('call Springfield Waste Management!', ctx), true, 'case and punctuation insensitive');
    assert.equal(ownerAskedForCall('Call the mayor', ctx), false, 'words he did not say');
    assert.equal(ownerAskedForCall('grass clippings in two weeks', { ...ctx, currentMessage: 'grass clippings in two weeks' }), false, 'no call words');
    assert.equal(ownerAskedForCall('Call springfield waste management', { ...ctx, userId: 'partner' }), false, 'only the owner');
  });

  await check('a known personal contact needs personal_ok', () => {
    db.upsertPerson({ name: 'Priya Test', phones: ['732-555-2177'] });
    const blocked = errands.prepareErrand({ ...base, targets: [{ name: 'Priya', phone: '732-555-2177' }] });
    assert.ok('error' in blocked && /personal contact/.test(blocked.error));
    const ok = errands.prepareErrand({ ...base, targets: [{ name: 'Priya', phone: '732-555-2177' }], personal_ok: true });
    assert.ok(!('error' in ok));
  });

  await check('max_calls is capped at 8 and duplicate numbers collapse', () => {
    const p = errands.prepareErrand({ ...base, max_calls: 50, targets: [base.targets[0], base.targets[0]] });
    assert.ok(!('error' in p));
    if ('error' in p) return;
    assert.equal(p.payload.max_calls, 8);
    assert.equal((p.payload.targets as unknown[]).length, 1);
  });

  await check('calling hours: Mon-Sat 9-18 ET, never Sunday', () => {
    assert.equal(errands.inCallingHours(new Date('2026-09-30T14:00:00Z')), true);   // Wed 10:00 ET
    assert.equal(errands.inCallingHours(new Date('2026-09-30T23:30:00Z')), false);  // Wed 19:30 ET
    assert.equal(errands.inCallingHours(new Date('2026-10-04T15:00:00Z')), false);  // Sun 11:00 ET
    const next = errands.nextCallingTime(new Date('2026-10-04T15:00:00Z'));         // Sun → Mon 9:00 ET
    assert.equal(next.toISOString(), '2026-10-05T13:00:00.000Z');
  });

  await check('done result finishes the errand and tells the owner once', async () => {
    const id = activate(base);
    await errands.applyCallResult(id, { status: 'done', outcome: 'Booked Thu 4pm under Alex Rivera.', followUp: '', transcriptTail: '' });
    assert.equal(db.getErrand(id)!.status, 'done');
    const t = told.filter((x) => x.id === id);
    assert.equal(t.length, 1);
    assert.equal(t[0].kind, 'done');
    assert.match(t[0].text, /Booked Thu 4pm/);
  });

  await check('no answer twice on the first place moves to the backup; no owner text', async () => {
    const id = activate(base);
    const dial = (idx: number) => db.addErrandEvent(id, 'dialing', `[t${idx}] test, action #0`);
    dial(0);
    await errands.applyCallResult(id, { status: 'retry_later', outcome: 'No answer.', followUp: '', transcriptTail: '' });
    assert.equal(db.getErrand(id)!.target_idx, 0, 'one miss stays on the first place');
    dial(0);
    await errands.applyCallResult(id, { status: 'voicemail', outcome: 'Left a message.', followUp: '', transcriptTail: '' });
    const row = db.getErrand(id)!;
    assert.equal(row.target_idx, 1, 'two misses move to the backup');
    assert.equal(row.status, 'active');
    assert.equal(told.filter((x) => x.id === id).length, 0);
  });

  await check('a "failed" result moves on immediately', async () => {
    const id = activate(base);
    db.addErrandEvent(id, 'dialing', '[t0] test, action #0');
    await errands.applyCallResult(id, { status: 'failed', outcome: 'They don\'t do oil changes.', followUp: '', transcriptTail: '' });
    assert.equal(db.getErrand(id)!.target_idx, 1);
  });

  await check('blocked waits on the owner as a decision; a note resumes it', async () => {
    const id = activate(base);
    await errands.applyCallResult(id, { status: 'blocked', outcome: 'They quoted $89.', followUp: 'OK to book at $89?', transcriptTail: '' });
    assert.equal(db.getErrand(id)!.status, 'waiting');
    assert.equal(told.filter((x) => x.id === id)[0].kind, 'blocked');
    const reply = errands.addErrandNote(id, '$89 is fine');
    assert.match(reply, /back on/);
    const row = db.getErrand(id)!;
    assert.equal(row.status, 'active');
    assert.ok((JSON.parse(row.envelope_json) as { notes: string[] }).notes.includes('$89 is fine'));
  });

  await check('running out of approved numbers blocks and asks', async () => {
    const id = activate(base);
    db.updateErrand(id, { target_idx: 2, next_check_at: null });
    await errands.processErrand(id);
    assert.equal(db.getErrand(id)!.status, 'waiting');
    assert.match(told.filter((x) => x.id === id)[0].text, /Give me another number, want me to email them, or drop it\?/);
  });

  await check('a stuck call is explained in plain words: the menu path, not "used all 2 calls"', async () => {
    const id = activate(base);
    db.addErrandEvent(id, 'call_result', 'Springfield Public Works: retry_later — Connected, but no one engaged (likely a phone menu, hold music, or silence). Menu: Pressed 1 (scheduling or services); Pressed 9 (deliver message and exit the system)');
    db.addErrandEvent(id, 'call_result', 'Springfield Public Works: retry_later — Connected, but no one engaged (likely a phone menu, hold music, or silence). Menu: Pressed 9 (deliver message and exit the system)');
    const said = errands.whatHappened(id);
    assert.match(said, /couldn't reach a person in 2 calls/);
    assert.match(said, /I pressed 9 \(deliver message and exit the system\)/);
    assert.doesNotMatch(said, /retry_later|Menu:/);
  });

  await check('hitting the call cap blocks; more_calls restarts', async () => {
    const id = activate({ ...base, max_calls: 2 });
    db.updateErrand(id, { calls_made: 2 });
    await errands.processErrand(id);
    assert.equal(db.getErrand(id)!.status, 'waiting');
    errands.extendErrand(id, 2, true);
    const row = db.getErrand(id)!;
    assert.equal(row.status, 'active');
    assert.equal(row.target_idx, 0);
    assert.equal((JSON.parse(row.envelope_json) as { max_calls: number }).max_calls, 4);
  });

  await check('a call that cannot be placed is logged and retried later, not texted', async () => {
    const id = activate(base);
    const realNow = Date.now;
    // Pin "now" inside calling hours so the runner tries to dial.
    Date.now = () => new Date('2026-09-30T14:00:00Z').getTime();
    const RealDate = Date;
    // inCallingHours() defaults to new Date(); give it the pinned instant.
    (globalThis as { Date: DateConstructor }).Date = class extends RealDate {
      constructor(...a: ConstructorParameters<DateConstructor>) { super(...(a.length ? a : [Date.now()]) as unknown as []); }
      static now() { return new RealDate('2026-09-30T14:00:00Z').getTime(); }
    } as DateConstructor;
    try {
      await errands.processErrand(id);
    } finally {
      (globalThis as { Date: DateConstructor }).Date = RealDate;
      Date.now = realNow;
    }
    const row = db.getErrand(id)!;
    assert.equal(row.calls_made, 1);
    assert.equal(row.call_state, null);
    const events = db.getErrandEvents(id).map((e) => e.type);
    assert.ok(events.includes('dialing') && events.includes('call_result'));
    assert.equal(told.filter((x) => x.id === id).length, 0);
  });

  await check('an owner-asked call reports a left voicemail as done, as a reply', async () => {
    const p = errands.prepareErrand({ ...base, targets: [base.targets[0]], max_calls: 2 });
    if ('error' in p) throw new Error(p.error);
    const id = db.createErrand({ action_id: null, goal: 'x', deadline: null, envelope_json: JSON.stringify({ ...p.payload, reply_mode: true }) });
    db.addErrandEvent(id, 'dialing', '[t0] test, action #0');
    await errands.applyCallResult(id, { status: 'voicemail', outcome: 'Left a message with the address and callback.', followUp: '', transcriptTail: '' });
    assert.equal(db.getErrand(id)!.status, 'done');
    assert.equal(told.filter((x) => x.id === id)[0].kind, 'done');
  });

  await check('an owner-asked call that drops mid-message reports what the bot said', async () => {
    const p = errands.prepareErrand({ ...base, targets: [base.targets[0]], max_calls: 2 });
    if ('error' in p) throw new Error(p.error);
    const id = db.createErrand({ action_id: null, goal: 'x', deadline: null, envelope_json: JSON.stringify({ ...p.payload, reply_mode: true }) });
    db.addErrandEvent(id, 'dialing', '[t0] test, action #0');
    await errands.applyCallResult(id, {
      status: 'retry_later', outcome: 'The call ended without a recorded outcome.', followUp: '', transcriptTail: '',
      botSaid: 'Hi, this is Robin, Alex Rivera\'s assistant, calling about grass clippings at 12 Oak St.', endedWithoutOutcome: true,
      menuLog: ['Pressed 3 (sanitation)'],
    });
    assert.equal(db.getErrand(id)!.status, 'waiting');
    const t = told.filter((x) => x.id === id)[0];
    assert.match(t.text, /I said: "Hi, this is Robin/);
    const ev = db.getErrandEvents(id).find((e) => e.type === 'call_result')!;
    assert.match(ev.detail!, /Menu: Pressed 3 \(sanitation\)/);
    assert.match(errands.addErrandNote(id, 'try again'), /back on/);
  });

  await check('restart recovery: finds an unanswered message and clears its half-saved row', () => {
    const at = new Date(Date.now() - 60_000).toISOString();
    db.saveMessage('admin', 'alex', 'user', 'call springfield public works');
    assert.equal(db.hasAssistantReplySince(at), false, 'no reply yet');
    assert.equal(db.dropUnansweredUserRowsSince(at), 1);
    db.saveMessage('admin', 'alex', 'user', 'call springfield public works');
    db.saveMessage('admin', 'assistant', 'assistant', 'Calling now.');
    assert.equal(db.hasAssistantReplySince(at), true, 'answered');
    const later = new Date(Date.now() + 10_000);
    db.saveMessage('family', 'assistant', 'assistant', 'Added milk.', later.toISOString());
    assert.equal(db.hasAssistantReplySince(new Date(later.getTime() - 2000).toISOString()), false, 'Family replies do not count');
  });

  await check('cancel stops it for good', () => {
    const id = activate(base);
    assert.match(errands.cancelErrand(id), /cancelled/);
    assert.equal(db.getErrand(id)!.status, 'cancelled');
    assert.match(errands.cancelErrand(id), /already cancelled/);
  });

  await check('a booking lands on the calendar with the right fields', async () => {
    const id = activate(base);
    db.addErrandEvent(id, 'dialing', '[t0] test, action #0');
    const before = booked.length;
    await errands.applyCallResult(id, {
      status: 'done', outcome: 'Booked Thu 4pm under Alex Rivera.', followUp: '', transcriptTail: '',
      booking: { title: 'Oil change', start: '2026-10-01T16:00:00-04:00', location: '1100 Main St, Springfield NJ', confirmation: 'JL-4471' },
    });
    assert.equal(booked.length, before + 1);
    const b = booked[booked.length - 1];
    assert.equal(b.title, 'Oil change — Quick Lube Springfield');
    assert.equal(b.date, '2026-10-01');
    assert.equal(b.startTime, '16:00');
    assert.equal(b.endTime, '17:00', 'defaults to an hour');
    assert.equal(b.location, '1100 Main St, Springfield NJ');
    assert.match(String(b.description), /Confirmation: JL-4471/);
    assert.match(String(b.description), new RegExp(`\\(errand #${id}\\)`));
    assert.equal(b.sourceRef, `errand:${id}`);
    assert.equal(db.getErrand(id)!.status, 'done');
    const ev = db.getErrandEvents(id).find((e) => e.type === 'booked');
    assert.ok(ev && /evt\d+/.test(ev.detail!) && /calendar\.test/.test(ev.detail!));
    const t = told.filter((x) => x.id === id);
    assert.equal(t.length, 1);
    assert.match(t[0].text, /Added to your calendar/);
  });

  await check('a booking with an end time keeps it', async () => {
    const id = activate(base);
    db.addErrandEvent(id, 'dialing', '[t0] test, action #0');
    await errands.applyCallResult(id, {
      status: 'done', outcome: 'Booked.', followUp: '', transcriptTail: '',
      booking: { title: 'Oil change at Quick Lube Springfield', start: '2026-10-01T15:30:00-04:00', end: '2026-10-01T16:15:00-04:00' },
    });
    const b = booked[booked.length - 1];
    assert.equal(b.title, 'Oil change at Quick Lube Springfield', 'no duplicate place name');
    assert.equal(b.startTime, '15:30');
    assert.equal(b.endTime, '16:15');
  });

  await check('a calendar failure still finishes the errand and says so', async () => {
    const id = activate(base);
    db.addErrandEvent(id, 'dialing', '[t0] test, action #0');
    calendarFails = true;
    try {
      await errands.applyCallResult(id, {
        status: 'done', outcome: 'Booked Thu 4pm.', followUp: '', transcriptTail: '',
        booking: { title: 'Oil change', start: '2026-10-01T16:00:00-04:00' },
      });
    } finally {
      calendarFails = false;
    }
    assert.equal(db.getErrand(id)!.status, 'done');
    assert.match(told.filter((x) => x.id === id)[0].text, /Couldn't add it to your calendar/);
    assert.ok(db.getErrandEvents(id).some((e) => e.type === 'calendar_error'));
  });

  await check('an unreadable booking time is reported, not guessed', async () => {
    const id = activate(base);
    db.addErrandEvent(id, 'dialing', '[t0] test, action #0');
    const before = booked.length;
    await errands.applyCallResult(id, {
      status: 'done', outcome: 'Booked for Thursday.', followUp: '', transcriptTail: '',
      booking: { title: 'Oil change', start: 'Thursday afternoon' },
    });
    assert.equal(booked.length, before);
    assert.equal(db.getErrand(id)!.status, 'done');
    assert.match(told.filter((x) => x.id === id)[0].text, /Couldn't add it to your calendar/);
  });

  await check('end_call booking args are parsed; empty ones dropped', () => {
    assert.equal(phone.parseBooking(undefined), undefined);
    assert.equal(phone.parseBooking({}), undefined);
    assert.equal(phone.parseBooking('x'), undefined);
    assert.deepEqual(phone.parseBooking({ title: ' Dinner ', start: '2026-10-02T19:00:00-04:00', confirmation: '' }),
      { title: 'Dinner', start: '2026-10-02T19:00:00-04:00' });
  });

  await check('callback lookup: open and recently finished errands match; old and unknown numbers do not', () => {
    // Fresh numbers so earlier tests' errands don't interfere.
    const t = (n: string) => ({ ...base, targets: [{ name: `Shop ${n}`, phone: `732-555-3${n}` }] });
    const active = activate(t('301'));
    const waiting = activate(t('302'));
    db.updateErrand(waiting, { status: 'waiting' });
    const done = activate(t('303'));
    db.updateErrand(done, { status: 'done', finished_at: new Date(Date.now() - 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) });
    const old = activate(t('304'));
    db.updateErrand(old, { status: 'done', finished_at: new Date(Date.now() - 5 * 24 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) });
    const cancelled = activate(t('305'));
    db.updateErrand(cancelled, { status: 'cancelled', finished_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });

    assert.equal(errands.findErrandForCallback('+17325553301')?.row.id, active);
    assert.equal(errands.findErrandForCallback('(732) 555-3302')?.row.id, waiting);
    assert.equal(errands.findErrandForCallback('7325553303')?.row.id, done);
    assert.equal(errands.findErrandForCallback('7325553303')?.target.name, 'Shop 303');
    assert.equal(errands.findErrandForCallback('7325553304'), null, 'finished too long ago');
    assert.equal(errands.findErrandForCallback('7325553305'), null, 'cancelled');
    assert.equal(errands.findErrandForCallback('9175550000'), null, 'unknown number');
    assert.equal(errands.findErrandForCallback(''), null);
  });

  await check('callback lookup prefers an open errand over a finished one for the same number', () => {
    const t = { ...base, targets: [{ name: 'Shop 310', phone: '732-555-3310' }] };
    const finished = activate(t);
    db.updateErrand(finished, { status: 'failed', finished_at: new Date().toISOString().replace('T', ' ').slice(0, 19) });
    const open = activate(t);
    db.updateErrand(open, { status: 'waiting' });
    assert.equal(errands.findErrandForCallback('7325553310')?.row.id, open);
  });

  await check('a "done" callback finishes a waiting errand, books it, and tells the owner as a reply', async () => {
    const id = activate({ ...base, targets: [{ name: 'Shop 320', phone: '732-555-3320' }] });
    db.updateErrand(id, { status: 'waiting' });
    const before = booked.length;
    await errands.applyCallbackResult(id, 'Shop 320', {
      status: 'done', outcome: 'They can take the car Thu at 4pm; booked.', followUp: '', transcriptTail: '',
      booking: { title: 'Oil change', start: '2026-10-01T16:00:00-04:00' },
    });
    assert.equal(db.getErrand(id)!.status, 'done');
    assert.equal(booked.length, before + 1);
    const t = told.filter((x) => x.id === id);
    assert.equal(t.length, 1);
    assert.equal(t[0].kind, 'callback');
    assert.match(t[0].text, /^📞 Shop 320 called back: They can take the car Thu at 4pm; booked\. Added to your calendar\./);
    assert.ok(db.getErrandEvents(id).some((e) => e.type === 'callback'));
  });

  await check('a callback during a live call only logs and notifies', async () => {
    const id = activate({ ...base, targets: [{ name: 'Shop 330', phone: '732-555-3330' }] });
    db.updateErrand(id, { call_state: 'connected' });
    await errands.applyCallbackResult(id, 'Shop 330', { status: 'done', outcome: 'Booked.', followUp: '', transcriptTail: '' });
    const row = db.getErrand(id)!;
    assert.equal(row.status, 'active');
    assert.equal(row.call_state, 'connected');
    assert.equal(told.filter((x) => x.id === id)[0].kind, 'callback');
    assert.ok(db.getErrandEvents(id).some((e) => e.type === 'callback'));
  });

  await check('a non-done callback leaves the errand as it was', async () => {
    const id = activate({ ...base, targets: [{ name: 'Shop 340', phone: '732-555-3340' }] });
    db.updateErrand(id, { status: 'waiting' });
    await errands.applyCallbackResult(id, 'Shop 340', { status: 'blocked', outcome: 'They quoted $95.', followUp: 'OK at $95?', transcriptTail: '' });
    assert.equal(db.getErrand(id)!.status, 'waiting');
    assert.match(told.filter((x) => x.id === id)[0].text, /Your move: OK at \$95\?/);
  });

  console.log(`\nErrand tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
