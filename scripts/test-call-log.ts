// Call log tests (call review step 1): timing, the after-call review, how it folds
// into a call's result, the log itself, the scorecard's call numbers, and the
// practice call's "stayed quiet" check. Isolated DB, no model, no network.
//   npm run test:call-log
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-call-log-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
for (const k of ['PHONE_PUBLIC_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER', 'OPENAI_WEBHOOK_SECRET', 'OPENAI_PROJECT_ID']) process.env[k] = '';

const { CallTimeline } = await import('../src/lib/call-timing.js');
const log = await import('../src/call-log.js');
const db = await import('../src/db.js');
const { personSpoke, botWrappedUp, buildScorecard } = await import('../src/scorecard.js');
const { practiceSpeech } = await import('../src/canary.js');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const review = (over: Partial<import('../src/call-log.js').CallReview> = {}) => ({
  answeredBy: 'person' as const, goalMet: false, verdict: 'progress' as const,
  summary: 'They offered Friday at 10, 11 or 12; the assistant proposed 11, then the line ended.',
  learned: 'Example Roofing: Friday 10, 11 or 12 available.', nextStep: 'Confirm Friday at 11 with Example Roofing.', ...over,
});
const dropped = { status: 'retry_later' as const, outcome: 'The call ended without a recorded outcome.', followUp: '', transcriptTail: '', endedWithoutOutcome: true };

try {
  await check('timeline: reply delays, talk-over, first words, timed lines', () => {
    let t = 0;
    const tl = new CallTimeline(() => t);
    t = 500; tl.pickedUp();
    t = 1_000; tl.theyStarted(); tl.line('Them', 'Thanks for calling ABC Roofing.');
    t = 2_000; tl.theyStopped();
    t = 3_400; tl.botStarted(); tl.line('Bot', 'Hi, this is Assistant.');
    t = 3_600; tl.theyStarted(); // over the assistant
    t = 4_000; tl.botStopped();
    t = 5_000; tl.theyStopped();
    t = 5_800; tl.botStarted();
    t = 6_000; tl.botStopped();
    const s = tl.stats();
    assert.deepEqual(s.replies, [1_400, 800]);
    assert.equal(s.medianReplyMs, 800);
    assert.equal(s.maxReplyMs, 1_400);
    assert.equal(s.talkOvers, 1);
    assert.equal(s.firstWordsMs, 2_900, 'from pickup, not from dialing');
    assert.equal(tl.text(), '[0:01] Them: Thanks for calling ABC Roofing.\n[0:03] Bot: Hi, this is Assistant.');
  });

  await check('timeline: speaking first is not a reply', () => {
    let t = 0;
    const tl = new CallTimeline(() => t);
    t = 3_000; tl.botStarted();
    assert.deepEqual(tl.stats().replies, []);
    assert.equal(tl.stats().medianReplyMs, null);
  });

  await check('review parsing: bad values fall back, goal_met needs the verdict', () => {
    const r = log.parseReview('ok: {"answered_by":"robot","verdict":"great","goal_met":true,"summary":"x","learned":"","next_step":""}')!;
    assert.equal(r.answeredBy, 'nobody');
    assert.equal(r.verdict, 'other');
    assert.equal(r.goalMet, false);
    assert.equal(log.parseReview('no json here'), null);
  });

  await check('review step: silence needs no model; failures and timeouts are just missing', async () => {
    const silent = await log.reviewCall({ goal: 'g', target: 't', transcript: '  ', menuLog: [], endReason: 'dead_air', botStatus: '', botOutcome: '' });
    assert.equal(silent?.verdict, 'no_answer');
    log.setCallReviewer(async () => { throw new Error('model down'); });
    assert.equal(await log.reviewCall({ goal: 'g', target: 't', transcript: '[0:01] Them: hi', menuLog: [], endReason: 'they_hung_up', botStatus: '', botOutcome: '' }), null);
    log.setCallReviewer(() => new Promise(() => {}));
    assert.equal(await log.reviewCall({ goal: 'g', target: 't', transcript: '[0:01] Them: hi', menuLog: [], endReason: 'they_hung_up', botStatus: '', botOutcome: '' }, 50), null);
    log.setCallReviewer(async () => review());
    assert.equal((await log.reviewCall({ goal: 'g', target: 't', transcript: '[0:01] Them: hi', menuLog: [], endReason: 'they_hung_up', botStatus: '', botOutcome: '' }))?.verdict, 'progress');
    log.setCallReviewer(null);
  });

  await check('a dropped call where a person gave something useful becomes a question, not a redial', () => {
    // A business offered Friday 10/11/12; it was logged as a generic retry and called twice more.
    const r = log.applyReview(dropped, review());
    assert.equal(r.status, 'blocked');
    assert.match(r.outcome, /line ended before I wrapped up\. They offered Friday/);
    assert.equal(r.followUp, 'Confirm Friday at 11 with Example Roofing.');
    assert.equal(r.notes?.said, 'Example Roofing: Friday 10, 11 or 12 available.');
    assert.equal(r.review?.verdict, 'progress');
  });

  await check('a call they ended after confirming is done (the checker still reads the transcript)', () => {
    const r = log.applyReview(dropped, review({ verdict: 'goal_met', goalMet: true, summary: 'Sam booked Thursday at 4 under Alex Rivera.' }));
    assert.equal(r.status, 'done');
    assert.equal(r.outcome, 'Sam booked Thursday at 4 under Alex Rivera.');
  });

  await check('a hang-up on the intro moves on to the next place instead of asking the owner', () => {
    const r = log.applyReview(dropped, review({ verdict: 'hung_up', summary: 'A person answered and hung up right after the intro.', learned: 'They only said "Hello?".', nextStep: 'Call again.' }));
    assert.equal(r.status, 'failed');
    assert.match(r.outcome, /hung up right after the intro/);
  });

  await check('a dropped call stuck in a menu stays a retry, with an honest outcome', () => {
    const r = log.applyReview(dropped, review({ answeredBy: 'menu', verdict: 'menu_stuck', summary: 'Only the phone menu answered; no person.', learned: '', nextStep: '' }));
    assert.equal(r.status, 'retry_later');
    assert.equal(r.outcome, 'Only the phone menu answered; no person.');
  });

  await check('a dropped call that left a voicemail counts as a voicemail', () => {
    const r = log.applyReview(dropped, review({ answeredBy: 'voicemail', verdict: 'voicemail_left', summary: 'Left a message after the beep.', learned: '', nextStep: '' }));
    assert.equal(r.status, 'voicemail');
  });

  await check("the assistant's own wrap-up stands; the review adds what it left out", () => {
    // A voicemail greeting gave an emergency line nobody noted.
    const mine = { status: 'voicemail' as const, outcome: 'Left a voicemail.', followUp: '', transcriptTail: '' };
    const r = log.applyReview(mine, review({ answeredBy: 'voicemail', verdict: 'voicemail_left', summary: 'Voicemail.', learned: 'Greeting: for emergencies call Dr. Lee at 202-555-3197.', nextStep: '' }));
    assert.equal(r.status, 'voicemail');
    assert.equal(r.outcome, 'Left a voicemail.');
    assert.match(r.followUp, /Dr\. Lee at 202-555-3197/);
    const done = log.applyReview({ ...mine, status: 'done', outcome: 'Booked Fri 11am.' }, review({ verdict: 'goal_met', goalMet: true }));
    assert.equal(done.followUp, '', 'a done call does not grow a to-do');
    assert.deepEqual(log.applyReview(mine, null), mine);
  });

  await check('call log: written, listed, practice kept apart, transcripts cleared after the window', () => {
    const timing = new CallTimeline().stats();
    const base = { callId: 'rtc_1', errandId: 7, target: 'Example Roofing', phone: '+17325552100', durationS: 41.26, endReason: 'they_hung_up' as const, botStatus: '' as const, timing, echoes: 0, menuLog: [], keep: false };
    const id = log.recordCall({ ...base, practice: false, review: review(), transcript: '[0:01] Them: Example Roofing, this is Jen.' });
    log.recordCall({ ...base, callId: 'rtc_2', errandId: 8, practice: true, review: null, transcript: '[0:02] Bot: The time is noon.' });
    const real = log.listCalls();
    assert.equal(real.length, 1);
    assert.equal(real[0].verdict, 'progress');
    assert.equal(real[0].duration_s, 41.3);
    assert.equal(log.listCalls({ includePractice: true }).length, 2);
    const raw = db.default as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
    raw.prepare(`UPDATE call_log SET created_at = datetime('now', '-40 days') WHERE id = ?`).run(id);
    assert.equal(log.pruneTranscripts(30), 1);
    assert.equal(log.listCalls({ days: 60 }).find((r) => r.id === id)?.transcript, null, 'numbers stay, words go');
  });

  await check('practice call: knows whether the assistant stayed quiet', () => {
    const timing = new CallTimeline().stats();
    const base = { phone: '+13034997111', target: 'NIST time line', durationS: 30, endReason: 'bot_end_call' as const, botStatus: 'done' as const, review: null, timing, echoes: 0, menuLog: [], keep: false, practice: true };
    log.recordCall({ ...base, callId: 'p1', errandId: 101, transcript: '[0:05] Them: At the tone, twelve hours...\n[0:09] Bot: Understood, I will stay quiet.' });
    log.recordCall({ ...base, callId: 'p2', errandId: 102, transcript: '[0:05] Them: At the tone, twelve hours...' });
    assert.equal(practiceSpeech(101), 'Understood, I will stay quiet.');
    assert.equal(practiceSpeech(102), '');
    assert.equal(practiceSpeech(999), null);
  });

  await check('scorecard: a person spoke, the assistant wrapped up, and the goal are separate', () => {
    const newDrop = 'Example Roofing: blocked — The line ended before I wrapped up.\nReview: progress; answered by person; ended: they hung up; reply 1.4s median, 2.0s max';
    const newMenu = 'Springfield: retry_later — Only the menu.\nReview: menu stuck; answered by menu; ended: dead air';
    const newDone = 'Example Auto: done — Booked.\nReview: goal met; answered by person; ended: bot end call';
    assert.equal(personSpoke(newDrop), true);
    assert.equal(botWrappedUp(newDrop), false);
    assert.equal(personSpoke(newMenu), false);
    assert.equal(botWrappedUp(newDone), true);
    // Rows from before the review: judged by their transcript lines.
    const old = 'Example Fence: retry_later — The call ended without a recorded outcome.\nBot said: Hi\nThem: One second.';
    assert.equal(personSpoke(old), true, 'a person said "One second" — that counts as reached');
    assert.equal(botWrappedUp(old), false);
    assert.equal(personSpoke('X: voicemail — Left a message.\nThem: Leave a message at the tone.'), false);
    const card = buildScorecard(7);
    assert.match(card.text, /Practice calls: Assistant stayed quiet on 1 of 2\./);
  });

  console.log(`\nCall log tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
process.exit(0);
