// The assistant as the receptionist for its own number: who gets put through, quiet
// hours, held messages, and the press-1 transfer steps. Nothing dials or texts.
//   npm run test:reception
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'dialzero-reception-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
for (const k of ['PHONE_PUBLIC_URL', 'TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_NUMBER', 'OPENAI_WEBHOOK_SECRET', 'OPENAI_PROJECT_ID']) process.env[k] = '';
process.env.RECEPTION_QUIET = '19-8';
const db = await import('../src/db.js');
const rc = await import('../src/reception.js');
const phone = await import('../src/phone.js');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS  ${name}`); }
const sent: Array<{ text: string; urgent: boolean; hold: boolean }> = [];
rc.setReceptionDeliver(async (text, _s, urgent, hold) => { sent.push({ text, urgent, hold }); });

db.upsertPerson({ name: 'Jordan Lee', phones: ['312-555-0300'] });
db.upsertPerson({ name: 'Sam Rivera', phones: ['312-555-0310'] });
const day = new Date('2026-10-06T15:00:00Z');   // 11am in the test timezone
const night = new Date('2026-10-07T00:30:00Z'); // 8:30pm

await check('quiet hours are 7pm to 8am local', () => {
  assert.equal(rc.inCallQuietHours(day), false);
  assert.equal(rc.inCallQuietHours(night), true);
  assert.equal(rc.inCallQuietHours(new Date('2026-10-06T11:30:00Z')), true);  // 7:30am
  assert.equal(rc.inCallQuietHours(new Date('2026-10-06T12:05:00Z')), false); // 8:05am
});

await check('contacts get put through by day; strangers leave a message', () => {
  const jordan = rc.lookupCaller('+13125550300', 'TN-Validation-Passed-A');
  assert.equal(jordan.name, 'Jordan Lee');
  assert.equal(rc.connectDecision(jordan, day).ok, true);
  const stranger = rc.lookupCaller('+12125550000', '');
  assert.equal(stranger.known, false);
  assert.equal(rc.connectDecision(stranger, day).ok, false);
});

await check('at night only always-ring people get through', () => {
  const jordan = rc.lookupCaller('+13125550300', '');
  assert.equal(rc.connectDecision(jordan, night).ok, false);
  const r = rc.updateAlwaysRing(['Sam'], []);
  assert.deepEqual(r.added, ['Sam Rivera']);
  const sam = rc.lookupCaller('3125550310', '');
  assert.equal(sam.alwaysRing, true);
  assert.equal(rc.connectDecision(sam, night).ok, true);
});

await check('modes: through lets strangers ring by day, messages stops everyone but always-ring', () => {
  const stranger = rc.lookupCaller('+12125550000', '');
  rc.setReceptionMode('through', null);
  assert.equal(rc.connectDecision(stranger, day).ok, true);
  rc.setReceptionMode('messages', Date.now() + 3600_000);
  assert.equal(rc.connectDecision(rc.lookupCaller('+13125550300', ''), day).ok, false);
  assert.equal(rc.connectDecision(rc.lookupCaller('3125550310', ''), day).ok, true);
  rc.setReceptionMode('through', Date.now() - 1000); // expired → back to normal
  assert.equal(rc.getReceptionMode().mode, 'normal');
});

await check('a forged caller ID never rings the owner', () => {
  const fake = rc.lookupCaller('+13125550300', 'TN-Validation-Failed-B');
  assert.equal(rc.connectDecision(fake, day).ok, false);
});

await check('messages: a stranger\'s "urgent" waits; a contact\'s urgent goes now', async () => {
  const stranger = rc.lookupCaller('+12125550000', '');
  await rc.deliverMessage(stranger, { callerName: 'Pat', callback: '', reason: 'about the car', urgent: true });
  assert.equal(sent.at(-1)!.urgent, false);
  assert.match(sent.at(-1)!.text, /Pat \(212-555-0000\) called: about the car/);
  const jordan = rc.lookupCaller('+13125550300', '');
  await rc.deliverMessage(jordan, { callerName: 'Jordan', callback: '3125550300', reason: 'Saturday plans', urgent: true });
  assert.equal(sent.at(-1)!.urgent, true);
  assert.equal(sent.at(-1)!.hold, false);
  assert.equal(db.callNotesFor({ phone: '3125550300' }).length, 1);
});

await check('press-1 transfer: whisper asks, 1 bridges, no answer comes back to the assistant', () => {
  const jordan = rc.lookupCaller('+13125550300', '');
  phone.stageTransferForTest('tok1', 'Jordan Lee', 'Saturday plans', jordan);
  const whisper = phone.receptionStep('whisper', 'tok1', new URLSearchParams());
  assert.match(whisper, /<Gather numDigits="1"/);
  assert.match(whisper, /Jordan Lee, about Saturday plans\. Press 1 to take it\./);
  assert.equal(phone.receptionStep('accept', 'tok1', new URLSearchParams({ Digits: '1' })), '<?xml version="1.0" encoding="UTF-8"?><Response/>');
  assert.match(phone.receptionStep('after', 'tok1', new URLSearchParams({ DialCallStatus: 'completed' })), /<Hangup\/>/);
  phone.stageTransferForTest('tok2', 'Jordan Lee', 'Saturday plans', jordan);
  assert.match(phone.receptionStep('accept', 'tok2', new URLSearchParams({ Digits: '' })), /<Hangup\/>/);
  const back = phone.receptionStep('after', 'tok2', new URLSearchParams({ DialCallStatus: 'completed', CallSid: 'CAx' }));
  assert.match(back, /<Sip>sip:.*X-Assistant-Nonce=/, 'the owner did not press 1: the caller goes back to the assistant for a message');
  assert.match(phone.receptionStep('after', 'nope', new URLSearchParams()), /<Hangup\/>/);
});

console.log(`\nReception tests passed: ${passed} checks.`);
rmSync(tempRoot, { recursive: true, force: true });
process.exit(0);
