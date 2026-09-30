// Wake-up call tests: isolated DB, phone deliberately unconfigured, the dialer
// and the notifier stubbed, and the clock passed in explicitly.
//   npm run test:wakeup
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-wakeup-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
// Empty (not unset) so a later dotenv load can't fill them in.
for (const k of ['PHONE_PUBLIC_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER', 'OPENAI_WEBHOOK_SECRET', 'OPENAI_PROJECT_ID']) process.env[k] = '';
process.env.WAKEUP_MAX_ATTEMPTS = '3';
process.env.WAKEUP_RETRY_MIN = '5';

const db = await import('../src/db.js');
const phone = await import('../src/phone.js');
const wake = await import('../src/wakeup.js');

assert.equal(phone.isPhoneConfigured(), false, 'phone must be unconfigured in tests');

type Dialed = Parameters<Parameters<typeof wake.setWakeUpDeps>[0]['dial'] & {}>[0];
const dialed: Dialed[] = [];
const told: Array<{ id: number; text: string }> = [];
let dialError: Error | null = null;
wake.setWakeUpDeps({
  dial: async (w) => { dialed.push(w); if (dialError) throw dialError; },
  notify: async (row, text) => { told.push({ id: row.id, text }); },
  firstEvent: async () => 'Standup at 9:30 AM',
});

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const at = (iso: string) => new Date(iso);
const idOf = (msg: string) => Number(msg.match(/#(\d+)/)?.[1]);
const row = (id: number) => db.getWakeUpCall(id)!;
const min = 60_000;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

try {
  await check('ET instants are DST-correct', () => {
    assert.equal(wake.etInstant('2026-10-30', '06:45').toISOString(), '2026-10-30T10:45:00.000Z', 'EDT');
    assert.equal(wake.etInstant('2026-11-02', '06:45').toISOString(), '2026-11-02T11:45:00.000Z', 'EST after fall back');
    assert.equal(wake.etInstant('2027-03-12', '06:45').toISOString(), '2027-03-12T11:45:00.000Z', 'EST before spring forward');
    assert.equal(wake.etInstant('2027-03-15', '06:45').toISOString(), '2027-03-15T10:45:00.000Z', 'EDT after spring forward');
  });

  await check('parses times and days', () => {
    assert.equal(wake.parseTime('6:45'), '06:45');
    assert.equal(wake.parseTime('6:45am'), '06:45');
    assert.equal(wake.parseTime('12:15 am'), '00:15');
    assert.equal(wake.parseTime('6:30 pm'), '18:30');
    assert.equal(wake.parseTime('25:00'), null);
    assert.equal(wake.parseDays(['fri', 'Monday']), 'mon,fri');
    assert.equal(wake.parseDays('weekdays'), 'mon,tue,wed,thu,fri');
    assert.equal(wake.parseDays(['daily']), 'sun,mon,tue,wed,thu,fri,sat');
    assert.equal(wake.parseDays(['someday']), null);
  });

  await check('only real spoken answers count toward awake', () => {
    for (const t of ['yeah', 'Yeah, I\'m up.', 'ok ok', 'mhm', 'hello?', 'I\'m awake']) assert.equal(phone.isRealWakeAnswer(t), false, t);
    for (const t of ['Coffee.', 'Going to the gym', 'I slept badly', 'standup at nine']) assert.equal(phone.isRealWakeAnswer(t), true, t);
  });

  await check('one-off: fires at its time once, and is done after he is awake', async () => {
    const now = at('2026-10-05T10:00:00Z'); // Mon 06:00 ET
    const msg = wake.setWakeUpCall({ time: '06:45', note: 'gym at 7' }, now);
    const id = idOf(msg);
    assert.match(msg, /6:45 AM/);
    assert.equal(row(id).date, '2026-10-05', 'no date = the next time that clock time comes around');
    dialed.length = 0;
    await wake.tick(at('2026-10-05T10:44:30Z'));
    assert.equal(dialed.length, 0, 'not before its time');
    await wake.tick(at('2026-10-05T10:45:10Z'));
    assert.equal(dialed.length, 1);
    assert.deepEqual({ ...dialed[0] }, { id, attempt: 1, timeLabel: '6:45 AM', note: 'gym at 7', firstEvent: 'Standup at 9:30 AM' });
    await wake.tick(at('2026-10-05T10:45:40Z'));
    assert.equal(dialed.length, 1, 'no second dial while the first is ringing');
    wake.wakeCallHooks.onConnected(id, 1);
    assert.equal(row(id).call_state, 'connected');
    await wake.recordAttempt(id, 1, 'awake', at('2026-10-05T10:48:00Z'));
    assert.equal(row(id).status, 'done');
    assert.match(row(id).last_result ?? '', /awake/);
    await wake.tick(at('2026-10-05T10:50:00Z'));
    assert.equal(dialed.length, 1);
    assert.equal(told.length, 0, 'success sends no text');
  });

  await check('one-off in the past is refused', () => {
    assert.match(wake.setWakeUpCall({ time: '06:45', date: '2026-10-05' }, at('2026-10-05T11:00:00Z')), /already passed/);
    assert.match(wake.setWakeUpCall({ time: 'soon' }), /needs a time/);
  });

  await check('weekday recurrence: skips the weekend, fires once per morning, not again the same day', async () => {
    const sat = at('2026-10-03T12:00:00Z');
    const id = idOf(wake.setWakeUpCall({ time: '06:30', days: ['weekdays'] }, sat));
    assert.equal(wake.nextOccurrence(row(id), sat)?.toISOString(), '2026-10-05T10:30:00.000Z');
    assert.equal(wake.dueDate(row(id), at('2026-10-04T10:31:00Z')), null, 'Sunday');
    dialed.length = 0;
    await wake.tick(at('2026-10-04T10:31:00Z'));
    assert.equal(dialed.length, 0);
    await wake.tick(at('2026-10-05T10:30:05Z'));
    assert.equal(dialed.length, 1, 'Monday');
    await wake.recordAttempt(id, 1, 'awake', at('2026-10-05T10:33:00Z'));
    assert.equal(row(id).status, 'active', 'recurring stays active');
    assert.equal(row(id).last_done_date, '2026-10-05');
    await wake.tick(at('2026-10-05T10:40:00Z'));
    assert.equal(dialed.length, 1, 'not re-fired the same morning');
    await wake.tick(at('2026-10-06T10:30:05Z'));
    assert.equal(dialed.length, 2, 'Tuesday');
    await wake.recordAttempt(id, 1, 'awake', at('2026-10-06T10:33:00Z'));
    wake.cancelWakeUpCall(id);
  });

  await check('a recurring call set after today\'s time waits for the next day', async () => {
    const id = idOf(wake.setWakeUpCall({ time: '06:30', days: ['daily'] }, at('2026-10-07T11:00:00Z')));
    dialed.length = 0;
    await wake.tick(at('2026-10-07T11:00:30Z'));
    assert.equal(dialed.length, 0);
    assert.equal(wake.nextOccurrence(row(id), at('2026-10-07T11:00:30Z'))?.toISOString(), '2026-10-08T10:30:00.000Z');
    wake.cancelWakeUpCall(id);
  });

  await check('retries 5 min after a failed attempt, gives up after 3 with one text', async () => {
    const t0 = at('2026-10-09T10:45:00Z'); // Fri 06:45 ET (quiet hours: ignored)
    const id = idOf(wake.setWakeUpCall({ time: '06:45', date: '2026-10-09' }, at('2026-10-09T10:00:00Z')));
    dialed.length = 0;
    told.length = 0;
    await wake.tick(t0);
    assert.equal(dialed.length, 1);

    // He hung up without really talking.
    await wake.recordAttempt(id, 1, 'hung up without confirming (1 real answers)', plus(t0, 2 * min));
    assert.equal(row(id).call_state, null);
    await wake.tick(plus(t0, 6 * min));
    assert.equal(dialed.length, 1, 'waits the full 5 minutes');
    await wake.tick(plus(t0, 7 * min + 1000));
    assert.equal(dialed.length, 2);
    assert.equal(dialed[1].attempt, 2);

    // A late result for attempt 1 is ignored.
    await wake.recordAttempt(id, 1, 'awake', plus(t0, 7 * min + 2000));
    assert.equal(row(id).status, 'active');

    // Nobody picks up: the watchdog calls it after 2 minutes.
    await wake.tick(plus(t0, 8 * min));
    assert.equal(row(id).call_state, 'calling', 'still ringing');
    await wake.tick(plus(t0, 9 * min + 2000));
    assert.equal(row(id).call_state, null);
    assert.match(row(id).last_result ?? '', /no answer/);

    // Third attempt: the dial itself fails. That is the last try.
    dialError = new Error('Twilio 503');
    await wake.tick(plus(t0, 14 * min + 3000));
    dialError = null;
    assert.equal(dialed.length, 3);
    assert.equal(told.length, 1);
    assert.equal(told[0].id, id);
    assert.match(told[0].text, /Couldn't wake you — 3 calls unanswered/);
    assert.equal(row(id).status, 'done');
    assert.match(row(id).last_result ?? '', /gave up/);
    await wake.tick(plus(t0, 30 * min));
    assert.equal(dialed.length, 3, 'no more calls');
    assert.equal(told.length, 1, 'one text only');
  });

  await check('cancel works, including mid-morning', async () => {
    const id = idOf(wake.setWakeUpCall({ time: '07:00', date: '2026-10-12' }, at('2026-10-12T10:00:00Z')));
    dialed.length = 0;
    await wake.tick(at('2026-10-12T11:00:05Z'));
    assert.equal(dialed.length, 1);
    assert.match(wake.cancelWakeUpCall(id), /cancelled/);
    assert.equal(row(id).status, 'cancelled');
    await wake.recordAttempt(id, 1, 'no answer', at('2026-10-12T11:03:00Z'));
    await wake.tick(at('2026-10-12T11:10:00Z'));
    assert.equal(dialed.length, 1);
    assert.match(wake.cancelWakeUpCall(id), /already cancelled/);
    assert.match(wake.cancelWakeUpCall(9999), /not found/);
  });

  await check('a one-off missed while the bot was down is marked missed, not fired late', async () => {
    const id = idOf(wake.setWakeUpCall({ time: '06:00', date: '2026-10-13' }, at('2026-10-12T20:00:00Z')));
    dialed.length = 0;
    await wake.tick(at('2026-10-13T13:00:00Z')); // 09:00 ET
    assert.equal(dialed.length, 0);
    assert.equal(row(id).status, 'missed');
  });

  await check('list shows active calls with the next time', () => {
    const now = at('2026-10-14T12:00:00Z');
    const id = idOf(wake.setWakeUpCall({ time: '06:30', days: ['mon', 'wed'], note: 'flight' }, now));
    const out = wake.listWakeUps(now);
    assert.match(out, new RegExp(`#${id} 6:30 AM mon, wed \\("flight"\\) · next 6:30 AM Mon, Oct 19`));
    assert.doesNotMatch(out, /cancelled|missed/);
  });

  console.log(`\nWake-up call tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
