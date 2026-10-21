// Practice line tests (call review step 2): the six scenes' TwiML, who the line
// answers, the grader, and a full scene run with the call stubbed out.
// Isolated DB, phone unconfigured, no network.
//   npm run test:practice-line
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-practice-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
for (const k of ['PHONE_PUBLIC_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'OPENAI_WEBHOOK_SECRET', 'OPENAI_PROJECT_ID', 'PRACTICE_LINE_NUMBER']) process.env[k] = '';
process.env.TWILIO_NUMBER = '+17325550142';

const pl = await import('../src/practice-line.js');
const log = await import('../src/call-log.js');
const { CallTimeline } = await import('../src/lib/call-timing.js');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const BASE = 'https://mini.example/twilio/voice';
const P = (o: Record<string, string> = {}) => new URLSearchParams(o);
const step = (scene: import('../src/practice-line.js').Scene, s = '', o: Record<string, string> = {}) => pl.sceneStep(scene, s, P(o), BASE);

/** A call_log row as the real call path would write it. */
function row(over: Partial<import('../src/call-log.js').CallLogRow>): import('../src/call-log.js').CallLogRow {
  return {
    id: 1, call_id: 'rtc', errand_id: 1, target: 'ABC Roofing (practice)', phone: '+17325550142', practice: 1,
    duration_s: 40, end_reason: 'bot_end_call', bot_status: 'done', answered_by: 'person', verdict: 'goal_met', goal_met: 1,
    summary: null, learned: null, next_step: null, replies: 3, median_reply_ms: 900, max_reply_ms: 1400, talk_overs: 0, echoes: 0,
    first_words_ms: 2500, menu: null, transcript: '', conference_sid: null, twilio_sid: null, created_at: '', ...over,
  };
}
const GOOD_TAIL = [
  "[0:09] Bot: Hi Dana, this is Assistant, Alex Rivera's assistant. I'm calling to book a roof inspection for Thursday or Friday.",
  '[0:14] Them: Sure, I can help with that. We have Thursday at 4, or Friday at 10. Which works better?',
  "[0:17] Bot: Thursday at 4 works.",
  '[0:20] Them: Okay. And what name should I put that under?',
  '[0:22] Bot: Alex Rivera.',
  "[0:25] Them: Perfect, you're all set. Thanks for calling, bye now.",
];

try {
  await check('scenes: each opens the way a business would', () => {
    assert.match(step('hello').twiml, /<Say[^>]*>Hello\?<\/Say><Gather input="speech"/);
    assert.match(step('greeting').twiml, /this is Dana speaking\. How can I help you today\?<\/Say><Gather/);
    assert.match(step('menu').twiml, /<Gather input="dtmf" numDigits="1"[^>]*><Say[^>]*>Thank you for calling A B C Roofing\. For sales, press 1/);
    const hold = step('hold');
    assert.match(hold.twiml, /Please hold\.<\/Say><Play loop="0">/);
    assert.equal(hold.redirect?.ms, pl.HOLD_MS);
    assert.match(hold.redirect!.step, /scene=hold&p=back$/);
    assert.match(step('hold', 'back').twiml, /Thanks for holding, this is Dana/);
    assert.match(step('voicemail').twiml, /after the tone\.<\/Say><Record playBeep="true"/);
    assert.match(step('hangup').twiml, /Hello\?<\/Say><Pause length="4"\/><Hangup\/>/);
    assert.match(step('greeting').twiml, /action="https:\/\/mini\.example\/twilio\/voice\?step=practice&amp;scene=greeting&amp;p=turn&amp;n=0"/, 'URLs are XML-escaped');
  });

  await check('menu: 0 reaches the operator, anything else is a dead end, silence repeats once', () => {
    assert.match(step('menu', 'choice', { Digits: '0' }).twiml, /Operator, this is Sam/);
    assert.match(step('menu', 'choice', { Digits: '2' }).twiml, /department is closed.*<Hangup\/>/);
    assert.match(step('menu', 'choice').twiml, /<Redirect method="POST">.*tries=1<\/Redirect>/);
    assert.match(step('menu', 'choice', { tries: '1' }).twiml, /Goodbye\.<\/Say><Hangup\/>/);
  });

  await check('the person answers each of the assistant\'s turns from the script, then says goodbye', () => {
    assert.match(step('hello', 'turn', { n: '0', SpeechResult: 'Hi, this is Assistant calling for Alex.' }).twiml, new RegExp(`${pl.DIALOG[0].slice(0, 30)}.*n=1`));
    assert.match(step('hello', 'turn', { n: '1', SpeechResult: 'Thursday at 4.' }).twiml, /what name.*n=2/);
    assert.match(step('hello', 'turn', { n: '2', SpeechResult: 'Alex Rivera.' }).twiml, /you're all set.*<\/Say><Pause length="6"\/><Hangup\/>/, 'stays on the line for the goodbye');
    assert.match(step('hello').twiml, /speechTimeout="1"/, 'answers a second after the assistant stops, like a person');
    assert.match(step('hello', 'turn', { n: '1' }).twiml, /Are you still there\?.*again=1/);
    assert.match(step('hello', 'turn', { n: '1', again: '1' }).twiml, /can't hear you.*<Hangup\/>/);
  });

  await check('the line answers only the assistant, and only while a scene is armed', () => {
    const call = P({ To: '+17325550142', From: '+17325550142' });
    assert.equal(pl.isPracticeCall(call), false, 'not armed');
    pl.armScene('menu');
    assert.equal(pl.isPracticeCall(call), true);
    assert.equal(pl.isPracticeCall(P({ To: '+17325550142', From: '+12025550188' })), false, 'someone else calling the assistant\'s number');
    pl.disarm();
    assert.equal(pl.armedScene(), null);
    pl.armScene('hello', -1);
    assert.equal(pl.armedScene(), null, 'an expired arm is off');
  });

  await check('grader: a well-behaved call passes each conversation scene', () => {
    const greet = row({ transcript: ['[0:05] Them: Thanks for calling A B C Roofing, this is Dana speaking. How can I help you today?', ...GOOD_TAIL].join('\n') });
    assert.deepEqual(pl.gradeScene('greeting', greet).problems, []);
    assert.equal(pl.gradeScene('hello', row({ transcript: ['[0:02] Them: Hello?', ...GOOD_TAIL].join('\n') })).pass, true);
    const menu = row({ menu: 'Pressed 0 (operator)', transcript: ['[0:08] Them: Thank you for calling A B C Roofing. For sales, press 1. For billing, press 2. To speak with the operator, press 0.', '[0:09] Them: Operator, this is Sam. How can I help?', ...GOOD_TAIL].join('\n') });
    assert.equal(pl.gradeScene('menu', menu).pass, true);
    const hold = row({ transcript: ['[0:04] Them: Please hold.', '[0:08] Them: (music)', '[0:30] Them: Thanks for holding, this is Dana. How can I help you?', ...GOOD_TAIL.map((l) => l.replace(/^\[0:(\d\d)\]/, (_m, s) => `[0:${String(Number(s) + 25)}]`))].join('\n') });
    assert.deepEqual(pl.gradeScene('hold', hold).problems, []);
  });

  await check('grader: catches talk-over, a doubled intro, a missed key and a wrong result', () => {
    const over = pl.gradeScene('greeting', row({ transcript: ["[0:03] Bot: Hi, this is Assistant, Alex's assistant.", '[0:06] Them: Thanks for calling A B C Roofing, this is Dana speaking. How can I help you today?', ...GOOD_TAIL].join('\n') }));
    assert.equal(over.pass, false);
    assert.ok(over.problems.some((p) => /spoke before/.test(p)));
    assert.ok(over.problems.some((p) => /introduced itself 2 times/.test(p)));
    const menu = pl.gradeScene('menu', row({ menu: 'Pressed 1 (sales)', bot_status: 'retry_later', transcript: '[0:08] Them: Thank you for calling. For sales, press 1.' }));
    assert.ok(menu.problems.some((p) => /didn't press 0/.test(p)));
    assert.ok(menu.problems.some((p) => /never got to/.test(p)));
    assert.ok(menu.problems.some((p) => /not done/.test(p)));
    assert.deepEqual(pl.gradeScene('hello', null).problems, ['no call was logged (the call never started, or never ended)']);
  });

  await check('grader: voicemail waits for the tone; a hang-up must be noticed', () => {
    const vm = row({ bot_status: 'voicemail', transcript: [
      "[0:07] Them: Hi, you've reached A B C Roofing. We can't come to the phone right now. Please leave your name, number, and a brief message after the tone.",
      "[0:15] Bot: Hi, this is Assistant calling for Alex Rivera about a roof inspection. Please call them back at 202-555-0100. Thanks.",
    ].join('\n') });
    assert.equal(pl.gradeScene('voicemail', vm).pass, true);
    const early = pl.gradeScene('voicemail', row({ ...vm, transcript: `[0:03] Bot: Hi, this is Assistant.\n${vm.transcript}` }));
    assert.ok(early.problems.some((p) => /spoke before/.test(p)));
    assert.equal(pl.gradeScene('hangup', row({ end_reason: 'they_hung_up', bot_status: null, transcript: '[0:01] Them: Hello?\n[0:04] Bot: Hi, this is Assistant' })).pass, true);
    const missed = pl.gradeScene('hangup', row({ end_reason: 'line_dropped', bot_status: 'done' }));
    assert.equal(missed.problems.length, 2);
  });

  await check('a scene run: arms the line, dials a silent practice errand, grades it, keeps the result', async () => {
    let armedDuring: string | null = null;
    const g = await pl.runScene('greeting', {
      wait: async (errandId) => {
        armedDuring = pl.armedScene();
        // What the real call path writes when the call ends.
        log.recordCall({
          callId: 'rtc_p', errandId, target: 'ABC Roofing (practice)', phone: '+17325550142', practice: true,
          durationS: 30, endReason: 'bot_end_call', botStatus: 'done', review: null, timing: new CallTimeline().stats(), echoes: 0,
          menuLog: [], keep: false,
          transcript: ['[0:05] Them: Thanks for calling A B C Roofing, this is Dana speaking. How can I help you today?', ...GOOD_TAIL].join('\n'),
        });
      },
    });
    assert.equal(armedDuring, 'greeting');
    assert.equal(pl.armedScene(), null, 'disarmed after');
    assert.equal(g.pass, true, g.problems.join('; '));
    const db = await import('../src/db.js');
    const errand = db.listErrands({ limit: 5 }).find((e) => e.goal.startsWith('PRACTICE'));
    assert.ok(errand, 'the practice errand exists');
    assert.equal(errand!.status, 'done', "closed once graded, so it never sits in the owner's open jobs");
    assert.equal(errand!.outcome, 'Practice greeting: pass');
    const env = JSON.parse(errand!.envelope_json);
    assert.equal(env.silent, true, 'never texts the owner');
    assert.equal(env.targets[0].phone, '+17325550142', "falls back to the assistant's own number");
    assert.equal(pl.recentResults(5)[0].scene, 'greeting');
  });

  await check("practice and test errands never reach the owner's open jobs (check-ins, the app)", async () => {
    const db = await import('../src/db.js');
    const jobs = await import('../src/jobs.js');
    const silent = db.createErrand({ action_id: null, goal: 'CANARY practice call', deadline: null, envelope_json: JSON.stringify({ goal: 'x', targets: [], silent: true }) });
    db.updateErrand(silent, { status: 'waiting', outcome: 'Not confirmed' });
    const real = db.createErrand({ action_id: null, goal: 'Book an oil change', deadline: null, envelope_json: JSON.stringify({ goal: 'x', targets: [{ name: 'Example Auto', phone: '+17325552142' }] }) });
    const keys = jobs.openItems().map((i) => i.key);
    assert.ok(keys.includes(`errand:${real}`));
    assert.ok(!keys.includes(`errand:${silent}`));
    assert.equal(jobs.isSilentErrand({ envelope_json: 'not json' }), false);
  });

  await check('run requests: queued by the script, taken once by the bot', () => {
    pl.requestRun(['menu', 'hold']);
    assert.deepEqual(pl.takeRunRequest(), ['menu', 'hold']);
    assert.deepEqual(pl.takeRunRequest(), []);
    assert.equal(pl.sceneForDay(0), 'hello');
    assert.equal(pl.sceneForDay(8), 'menu');
  });

  console.log(`\nPractice line tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
process.exit(0);
