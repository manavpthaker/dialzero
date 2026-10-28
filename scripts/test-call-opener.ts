// The opener and the first exchange: what the assistant says first, when it answers,
// what it leaves unanswered, and the morning check closing its own errand.
// Isolated DB, no model, no network.
//   npm run test:call-opener
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-call-opener-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
for (const k of ['PHONE_PUBLIC_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER', 'OPENAI_WEBHOOK_SECRET', 'OPENAI_PROJECT_ID']) process.env[k] = '';
process.env.USER_OWNER = '2025552100';
delete process.env.PHONE_OPENER_AI;
delete process.env.PHONE_RECORD_CALLS;

const opener = await import('../src/lib/call-opener.js');
const { ReplyGate, endsTurn, isPresenceCheck } = await import('../src/lib/reply-gate.js');
const { classifyLine, CallStage } = await import('../src/lib/call-stage.js');
const phone = await import('../src/phone.js');
const db = await import('../src/db.js');
const errands = await import('../src/errands.js');
const canary = await import('../src/canary.js');

const told: string[] = [];
errands.setErrandNotifier(async (_row, _kind, text) => { told.push(text); });

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

try {
  await check('the first question: short and plain, or nothing (the prompt rule takes over)', () => {
    assert.equal(opener.cleanAsk('Do you have wooden garden gates ready for pickup?'), 'Do you have wooden garden gates ready for pickup?');
    assert.equal(opener.cleanAsk('"how soon could you come look at a roof leak?"'), 'How soon could you come look at a roof leak?');
    assert.equal(opener.cleanAsk('Question: What time do you close today?\nextra'), 'What time do you close today?');
    // 22 words of measurements.
    assert.equal(opener.cleanAsk('Do you have a ready-to-pick-up painted wood arched slatted garden gate that matches approximately 39 inches wide by 46 inches tall?'), null);
    assert.equal(opener.cleanAsk('Hi, this is Sam. Do you sell gates?'), null, 'no intro of its own');
    assert.equal(opener.cleanAsk("I'm calling about a roof leak, can you help?"), null);
    assert.equal(opener.cleanAsk('Do you sell gates? And fences?'), null, 'one question');
    assert.equal(opener.cleanAsk('We need a roof inspection.'), null, 'must be a question');
    assert.equal(opener.cleanAsk(''), null);
  });

  await check('who it is: six words, no "AI, on a recorded line" up front in New Jersey', () => {
    assert.equal(opener.openerLine('Sam', 'Alex Rivera', 'Do you sell wooden garden gates?'), "Hi, this is Sam, Alex Rivera's assistant. Do you sell wooden garden gates?");
    assert.equal(opener.whoLine('Sam', 'Alex Rivera', { ai: true, notice: true }), "Hi, this is Sam, Alex Rivera's AI assistant, on a recorded line.");
    // New Jersey, New York and DC let one party record; elsewhere the notice stays.
    assert.equal(opener.needsRecordingNotice('+18625550100', true), false, 'NJ');
    assert.equal(opener.needsRecordingNotice('+17325550100', true), false, 'NJ too');
    assert.equal(opener.needsRecordingNotice('+12125551234', true), false, 'NYC');
    assert.equal(opener.needsRecordingNotice('+14155551234', true), true, 'California needs everyone to consent');
    assert.equal(opener.needsRecordingNotice('+12155551234', true), true, 'Pennsylvania too');
    assert.equal(opener.needsRecordingNotice('+13034997111', true), true, 'unknown → notice');
    assert.equal(opener.needsRecordingNotice('+14155551234', false), false, 'nothing recorded, nothing to say');
  });

  await check('openerFor: written before the dial; none for the listen-only time line or when the model fails', async () => {
    opener.setAskWriter(async () => 'Do you have wooden garden gates ready for pickup?');
    const line = await phone.openerFor('Ask whether they have a ready-to-pick-up painted wood arched slatted garden gate ~39x46', '+17325550100');
    assert.match(line ?? '', /^Hi, this is \w+, .+'s assistant\. Do you have wooden garden gates ready for pickup\?$/);
    process.env.PHONE_RECORD_CALLS = 'true';
    assert.match(await phone.openerFor('x', '+14155551234') ?? '', /'s assistant, on a recorded line\. Do you/);
    assert.doesNotMatch(await phone.openerFor('x', '+18625550100') ?? '', /recorded/);
    delete process.env.PHONE_RECORD_CALLS;
    assert.equal(await phone.openerFor('CANARY practice call: hear the current time', '+13034997111'), undefined);
    opener.setAskWriter(async () => 'Could you please tell me whether you have a painted wood arched slatted gate 39 by 46 inches?');
    assert.equal(await phone.openerFor('x', '+17325550100'), undefined, 'too long: fall back to the prompt rule');
    opener.setAskWriter(async () => { throw new Error('model down'); });
    assert.equal(await phone.openerFor('x', '+17325550100'), undefined);
    opener.setAskWriter(null);
    assert.equal(await phone.openerFor('x', '+17325550100'), undefined, 'isolated tests never call a model');
  });

  await check('session: the written opener word for word; AI said plainly when asked; no keypad when the code works menus', () => {
    const line = "Hi, this is Sam, Alex Rivera's assistant. Do you have wooden garden gates ready for pickup?";
    const base = { kind: 'errand' as const, actionId: 1, to: '+17325550100', name: 'Example Fence', personId: null, goal: 'Ask about a garden gate', context: '', keepTranscript: false, errandId: 9 };
    const plain = phone.errandSessionConfig({ ...base, opener: line });
    assert.match(plain.instructions, /exactly this, word for word, and nothing more: "Hi, this is Sam, Alex Rivera's assistant\. Do you have wooden/);
    assert.match(plain.instructions, /who is calling, or whether you are a real person, a robot, an AI or a recording, say plainly, right away: "I'm an AI assistant\./);
    assert.match(plain.instructions, /Never claim to be .+ or a human/);
    assert.match(plain.instructions, /rather not talk to an AI.*don't argue.*status "blocked"/s);
    assert.match(plain.instructions, /TAKE A NO.*wholesale only.*Don't rephrase the question or push/s);
    assert.match(plain.instructions, /transfer you or put you through.*give them your short opener again/s);
    assert.doesNotMatch(plain.instructions, /call is recorded/, 'nothing recorded, nothing to answer');
    assert.ok(plain.tools.some((t) => t.name === 'press_keys'), 'the old one-session path still has its keypad');
    phone.stageConferenceForTest('tok1');
    const staged = phone.errandSessionConfig({ ...base, opener: line, conf: { token: 'tok1', name: 'bot-tok1' } });
    assert.ok(!staged.tools.some((t) => t.name === 'press_keys'), 'it once pressed a key while a person transferred the call');
    assert.match(staged.instructions, /Phone menus, hold music and recordings are handled for you/);
    assert.doesNotMatch(staged.instructions, /call press_keys/);
    process.env.PHONE_RECORD_CALLS = 'true';
    assert.match(phone.errandSessionConfig(base).instructions, /whether the call is recorded, say "Yes, so I get the details right\."/);
    delete process.env.PHONE_RECORD_CALLS;
    const callback = phone.errandSessionConfig({ ...base, callback: true });
    assert.doesNotMatch(callback.instructions, /word for word/, 'callbacks answer the phone their own way');
  });

  await check('a person passing the call on is hold; the next person gets the opener', () => {
    assert.equal(classifyLine('Let me transfer you over to the correct department one second.'), 'hold');
    assert.equal(classifyLine("I'll put you through to Mike."), 'hold');
    assert.equal(classifyLine('Let me connect you with our sales team.'), 'hold');
    assert.equal(classifyLine('I can put you down for Thursday at 4.'), null, 'a booking, not a transfer');
    assert.equal(classifyLine('Can I put you on hold for a sec?'), null, 'a question: it answers it');
    const st = new CallStage(() => 0);
    st.line('Example Fence, how can I direct your call?');
    st.line('Let me transfer you over to the correct department one second.');
    assert.equal(st.stage, 'hold');
    assert.equal(st.mayTalk, false);
    st.line('Hello, can we help you?');
    assert.equal(st.stage, 'person');
  });

  await check('their turn hands the line back: questions, hellos and names are answered without the beat', () => {
    for (const t of ['Hello?', 'Example Fence, how can I direct your call?', 'Thanks for calling ABC Roofing, this is Dana speaking. How can I help you today?', 'ABC Roofing, this is Dana.', 'Yeah?', 'Hello, can we help you?'])
      assert.equal(endsTurn(t), true, t);
    for (const t of ['Sure, I can help with that.', 'Oh, no.', 'We have Thursday at 4', ''])
      assert.equal(endsTurn(t), false, t);
  });

  await check('"Hello?" over the assistant is covered by its reply; answers are not', () => {
    for (const t of ['Hello?', 'Hello? Hello?', 'Hello, can we help you?', 'Hi, how can I help you?', 'Hello? Are you still there?', 'Mhm.', 'Uh-huh'])
      assert.equal(isPresenceCheck(t), true, t);
    for (const t of ['Yes.', 'Yeah, we do.', 'Okay.', 'Sure.', 'No.', 'Wholesale.', 'Sorry?', 'What size?', 'Is it just material you\'re interested in?', ''])
      assert.equal(isPresenceCheck(t), false, t);
  });

  await check('reply gate: "now" skips the rest of the beat; a zero beat answers at once', () => {
    let fired = 0;
    const pending: Array<() => void> = [];
    const timers = { set: (fn: () => void) => { pending.push(fn); return pending.length as unknown as ReturnType<typeof setTimeout>; }, clear: () => { pending.length = 0; } };
    const gate = new ReplyGate(() => { fired++; }, 700, timers);
    gate.now();
    assert.equal(fired, 0, 'nothing waiting, nothing fired');
    gate.turnEnded();
    assert.equal(gate.waiting, true);
    gate.now();
    assert.equal(fired, 1);
    assert.equal(gate.waiting, false);
    gate.turnEnded(0);
    assert.equal(fired, 2);
  });

  await check('morning check: its errand is closed whatever happened; old ones left waiting are closed at start', () => {
    const silent = (goal: string) => db.createErrand({ action_id: null, goal, deadline: null, envelope_json: JSON.stringify({ goal, targets: [{ name: 'NIST time line', phone: '+13034997111' }], max_calls: 1, silent: true }) });
    const waiting = silent('CANARY practice call: hear the current time from the recorded time announcement.');
    db.updateErrand(waiting, { status: 'waiting', outcome: 'Not confirmed: the recording only says "minutes".' });
    const onCall = silent('CANARY practice call: hear the current time from the recorded time announcement.');
    db.updateErrand(onCall, { call_state: 'connected' });
    const real = db.createErrand({ action_id: null, goal: 'Ask about a gate', deadline: null, envelope_json: JSON.stringify({ goal: 'x', targets: [] }) });
    db.updateErrand(real, { status: 'waiting', outcome: 'Tried every approved number.' });
    assert.equal(canary.closeStaleChecks(), 0, 'nothing under an hour old is touched');
    assert.equal(canary.closeStaleChecks(Date.now() + 2 * 3600_000), 1);
    assert.equal(db.getErrand(waiting)!.status, 'failed');
    assert.match(db.getErrand(waiting)!.outcome ?? '', /it had stopped at: Not confirmed/);
    assert.equal(db.getErrand(onCall)!.status, 'active', 'a live call is left alone');
    assert.equal(db.getErrand(real)!.status, 'waiting', 'real errands are left alone');
    const today = silent('CANARY practice call: hear the current time from the recorded time announcement.');
    db.updateErrand(today, { status: 'waiting', outcome: 'Used all 1 calls without finishing.' });
    canary.closeCheck(today, { ok: false, detail: "The call didn't go through." });
    assert.equal(db.getErrand(today)!.status, 'failed');
    assert.match(db.getErrand(today)!.outcome ?? '', /^Morning check: fail/);
  });

  await check("a failed leg to the voice service isn't a call: not counted, retried, told once", async () => {
    const mk = (silent: boolean) => {
      const id = db.createErrand({ action_id: null, goal: 'Ask the wait time', deadline: null, envelope_json: JSON.stringify({ goal: 'Ask the wait time', targets: [{ name: 'Example Diner', phone: '+12025550142' }], max_calls: 2, reply_mode: true, silent, notes: [], share: '', window: '', keep_transcript: false }) });
      db.updateErrand(id, { calls_made: 1, call_state: 'dialing', call_started_at: new Date(Date.now() - 6 * 60_000).toISOString().replace('T', ' ').slice(0, 19) });
      db.addErrandEvent(id, 'dialing', '[t0] Example Diner (202-555-0142), action #1');
      db.addErrandEvent(id, 'twilio', `CA${id}`);
      return id;
    };
    const pig = mk(false);
    // Twilio's leg to OpenAI's SIP address failed.
    await errands.sweepStuckCalls(async () => ({ status: 'failed', duration: 0, to: 'sip:proj_x@sip.api.openai.com;transport=tls' }));
    const row = db.getErrand(pig)!;
    assert.equal(row.status, 'active');
    assert.equal(row.calls_made, 0, 'not counted');
    assert.equal(row.call_state, null);
    assert.ok(db.getErrandEvents(pig, 10).some((e) => e.type === 'phone_down' && /voice service/.test(e.detail ?? '')));
    assert.ok(!db.getErrandEvents(pig, 10).some((e) => e.type === 'call_result'), "no \"didn't go through\" call result");
    assert.ok(Number(db.getMemory('errands', 'voice_down_until')) > Date.now(), 'other dials wait too');
    db.setMemory('errands', 'voice_down_until', '');
    // The business's own number failing is still a failed call.
    const other = mk(true);
    db.updateErrand(pig, { status: 'cancelled' });
    await errands.sweepStuckCalls(async () => ({ status: 'failed', duration: 0, to: '+12025550142' }));
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(db.getErrandEvents(other, 10).some((e) => e.type === 'call_result' && /didn't go through/.test(e.detail ?? '')));
  });

  console.log(`\nCall opener tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
process.exit(0);
