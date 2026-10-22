// Call stages and phone menus (call stages): what's on the line, when the assistant may
// speak, Twilio's machine verdict, and the menu ladder. Real lines from the practice
// line and from real calls. Isolated DB, no model, no network.
//   npm run test:call-states
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-call-states-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
for (const k of ['PHONE_PUBLIC_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER', 'OPENAI_WEBHOOK_SECRET', 'OPENAI_PROJECT_ID']) process.env[k] = '';

const { classifyLine, CallStage, isGoodbye, sendMessageKey } = await import('../src/lib/call-stage.js');
const nav = await import('../src/menu-nav.js');
const phone = await import('../src/phone.js');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

try {
  await check('lines: menus, hold, voicemail, closed and people are told apart', () => {
    const cases: Array<[string, string | null]> = [
      ['Thank you for calling A B C Roofing. For sales, press 1. For billing, press 2. To speak with the operator, press 0.', 'menu'],
      ['For trash and recycling, press 3.', 'menu'],
      ['If this is correct, say yes.', 'menu'],
      ['Please enter your account number followed by the pound sign.', 'menu'],
      ['Thanks for calling ABC Roofing. All of our team members are with other customers. Please hold.', 'hold'],
      ['Your call is important to us. Please stay on the line.', 'hold'],
      ["Hi, you've reached A B C Roofing. We can't come to the phone right now. Please leave your name, number, and a brief message after the tone.", 'voicemail'],
      ['Thank you for calling Example Dental Arts. We are currently not in the office. Please leave your name, your phone number, and a brief message.', 'voicemail'],
      ['Thank you for calling. We are currently closed. Our hours are Tuesday through Sunday, 5 to 9:30.', 'recording'],
      ['Thanks for calling ABC Roofing, this is Dana speaking. How can I help you today?', 'person'],
      ['Operator, this is Sam. How can I help?', 'person'],
      ['Thanks for holding, this is Dana. How can I help you?', 'person'],
      ['Hello?', 'person'],
      ['Example Fence, how can I direct your call?', null],
      ['', null],
    ];
    for (const [line, want] of cases) assert.equal(classifyLine(line), want, line);
  });

  await check('stage: a menu, then the operator; the assistant may only speak to the person', () => {
    const st = new CallStage(() => 0);
    assert.equal(st.mayTalk, true, 'nothing heard yet: a person until shown otherwise');
    st.line('Thank you for calling A B C Roofing. For sales, press 1. To speak with the operator, press 0.');
    assert.equal(st.stage, 'menu');
    assert.equal(st.mayTalk, false);
    st.line('Billing department.');
    assert.equal(st.stage, 'menu', 'undecided words keep the menu');
    st.line('Operator, this is Sam. How can I help?');
    assert.equal(st.stage, 'person');
    assert.equal(st.mayTalk, true);
    assert.equal(st.path(), 'greeting → menu 0:00 → person 0:00');
  });

  await check('stage: hold is waited out, music and recordings included; a person back ends it', () => {
    const st = new CallStage(() => 0);
    st.line('Thanks for calling ABC Roofing. All of our team members are with other customers. Please hold.');
    assert.equal(st.stage, 'hold');
    st.line('♪ la la ♪');
    st.line('Your call is important to us.');
    assert.equal(st.stage, 'hold');
    assert.equal(st.mayTalk, false);
    st.line('Thanks for holding, this is Dana. How can I help you?');
    assert.equal(st.stage, 'person');
    const st2 = new CallStage(() => 0);
    st2.line('One second, please hold.');
    st2.line('Okay, so what day works for you?');
    assert.equal(st2.stage, 'person', 'a person who put us on hold, back with a question');
  });

  await check('stage: voicemail waits for the beep or the greeting going quiet', () => {
    const st = new CallStage(() => 0);
    st.line("Hi, you've reached A B C Roofing. Please leave a message after the tone.");
    assert.equal(st.stage, 'voicemail');
    assert.equal(st.mayTalk, false, 'not over the greeting');
    st.greetingOver();
    assert.equal(st.mayTalk, true);
    const amd = new CallStage(() => 0);
    amd.line('Please leave a message after the tone.');
    amd.amd('machine_end_beep');
    assert.equal(amd.beep, true);
  });

  await check("Twilio's machine verdict: decided by the words when it comes first", () => {
    // The voicemail scene: no turn ever closed, so no words, and the mailbox hung up.
    const quiet = new CallStage(() => 0);
    quiet.amd('machine_end_beep');
    assert.equal(quiet.stage, 'greeting');
    assert.equal(quiet.machineSuspected, true);
    quiet.machineConfirmed();
    assert.equal(quiet.stage, 'voicemail');
    assert.equal(quiet.mayTalk, true, 'past the beep');
    // A long, cheerful real greeting mistaken for a machine: the words win.
    const dana = new CallStage(() => 0);
    dana.amd('machine_end_other');
    dana.line('Thanks for calling ABC Roofing, this is Dana speaking. How can I help you today?');
    assert.equal(dana.stage, 'person');
    dana.machineConfirmed();
    assert.equal(dana.stage, 'person', 'nothing left to confirm');
    // Machine verdicts on a menu or a person already on the line are ignored.
    const menu = new CallStage(() => 0);
    menu.line('For sales, press 1.');
    menu.amd('machine_end_other');
    assert.equal(menu.stage, 'menu');
    const human = new CallStage(() => 0);
    human.amd('human');
    assert.equal(human.stage, 'person');
  });

  await check('menu: one key per step, no repeat within 3s, and the ladder when it loops', async () => {
    let t = 0;
    const picks: string[] = [];
    nav.setMenuChooser(async (i) => { picks.push(i.menu); return { action: 'press', digits: '3', reason: 'sanitation' }; });
    const m = new nav.MenuNav('Report missed yard-waste pickup', () => t);
    assert.deepEqual(await m.decide(), { action: 'wait', reason: 'nothing new heard' });
    m.heard('Welcome to the City of Springfield. For trash and recycling, press 3. For water, press 4.');
    assert.deepEqual(await m.decide(), { action: 'press', digits: '3', reason: 'sanitation' });
    m.heard('For trash pickup schedules, press 1. To report a missed pickup, press 2.');
    t = 1_000;
    assert.equal((await m.decide()).action, 'wait', 'the same keys again within 3s are blocked');
    // The first menu comes back: ladder.
    m.heard('Welcome to the City of Springfield. For trash and recycling, press 3. For water, press 4.');
    t = 10_000;
    assert.deepEqual(await m.decide(), { action: 'press', digits: '0', reason: 'same menu again: operator' });
    m.heard('Welcome to the City of Springfield. For trash and recycling, press 3. For water, press 4.');
    assert.deepEqual(await m.decide(), { action: 'say', words: 'representative', reason: 'same menu again: asked for a person' });
    m.heard('Welcome to the City of Springfield. For trash and recycling, press 3. For water, press 4.');
    assert.equal((await m.decide()).action, 'stuck');
    assert.deepEqual(m.pressed, ['3', '0']);
    nav.setMenuChooser(null);
  });

  await check('menu: the model\'s answer is checked, and a broken model just waits', async () => {
    assert.deepEqual(nav.parseChoice('{"action":"press","digits":"1#","reason":"sales"}'), { action: 'press', digits: '1#', reason: 'sales' });
    assert.equal(nav.parseChoice('{"action":"press","digits":"one"}').action, 'wait', 'no real keys');
    assert.equal(nav.parseChoice('{"action":"dance"}').action, 'wait');
    assert.equal(nav.parseChoice('nonsense').action, 'wait');
    nav.setMenuChooser(async () => { throw new Error('model down'); });
    const m = new nav.MenuNav('x');
    m.heard('For sales, press 1.');
    assert.equal((await m.decide()).action, 'wait');
    nav.setMenuChooser(null);
    assert.equal(nav.sameMenu('For sales press 1, for billing press 2', 'for billing, press 2. For sales, press 1.'), true);
    assert.equal(nav.sameMenu('For sales press 1', 'Operator, this is Sam, how can I help'), false);
  });

  await check('goodbyes: theirs ends the call; a greeting\'s "thanks for calling" does not', () => {
    assert.equal(isGoodbye("Perfect, you're all set. Thanks for calling. Bye now."), true);
    assert.equal(isGoodbye('Okay, have a good one.'), true);
    assert.equal(isGoodbye('Alright, take care.'), true);
    assert.equal(isGoodbye('Thanks for calling ABC Roofing, this is Dana speaking. How can I help you today?'), false);
    assert.equal(isGoodbye("You're all set for Thursday at 4. Anything else?"), false);
  });

  await check('A real-call menu: "Thank you." is not the menu again; "press 1 to send" is found', () => {
    assert.equal(nav.sameMenu('Thank you for calling Example Siding. For a new project or free estimate, press 1. For an existing job, press 2.', 'Thank you.'), false);
    assert.equal(sendMessageKey('To send your message, press 1. To listen back to your message, press 2.'), '1');
    assert.equal(sendMessageKey('To erase and re-record your message, press 3.'), null);
    assert.equal(sendMessageKey('To deliver this message, press pound.'), '#');
  });

  await check('voicemail message: who, why, and the callback number twice', () => {
    process.env.PHONE_CALLBACK_NUMBER = '+12025550123';
    const rule = phone.voicemailRule();
    assert.match(rule, /greeting is over: the beep has sounded/);
    assert.match(rule, /said twice, slowly.*2 0 2, 5 5 5, 0 1 2 3/s);
    assert.match(rule, /end_call with status "voicemail"/);
    assert.match(rule, /emergency line/);
    delete process.env.PHONE_CALLBACK_NUMBER;
  });

  console.log(`\nCall stage tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
process.exit(0);
