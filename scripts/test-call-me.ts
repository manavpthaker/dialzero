// "Call me" tests: fake Twilio (fetch stubbed), isolated DB. Nothing dials.
//   npm run test:call-me
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-callme-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
Object.assign(process.env, {
  PHONE_PUBLIC_URL: 'https://example.test', TWILIO_ACCOUNT_SID: 'AC_test', TWILIO_AUTH_TOKEN: 'tok', TWILIO_NUMBER: '+15550100000',
  OPENAI_WEBHOOK_SECRET: 'whsec_dGVzdA==', OPENAI_PROJECT_ID: 'proj_test', OPENAI_API_KEY: 'sk-test', PHONE_OWNER_NUMBERS: '5550100001', PHONE_RING_DAILY_CAP: '1', PHONE_CALL_ME_DAILY_CAP: '2',
});
const dials: URLSearchParams[] = [];
globalThis.fetch = (async (url: string, init?: { body?: unknown }) => {
  if (String(url).includes('api.twilio.com') && String(url).endsWith('/Calls.json')) {
    dials.push(new URLSearchParams(String(init?.body ?? '')));
    return new Response(JSON.stringify({ sid: `CA${dials.length}` }), { status: 201 });
  }
  return new Response('{}', { status: 404 });
}) as typeof fetch;

const phone = await import('../src/phone.js');
const { isQuietHours } = await import('../src/lib/time-et.js');
const { toolRegistry } = await import('../src/tools/index.js');
const { getOwner } = await import('../src/config.js');
const callMe = toolRegistry.actions.find((t) => t.definition.name === 'call_me')!;

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) { await fn(); passed++; console.log(`PASS  ${name}`); }
try {
  await check('the owner\'s own "call me" rings any hour, with voicemail detection', async () => {
    const out = String(await callMe.handler({ reason: 'prep the demo call' }, { groupKey: 'admin', userId: getOwner().id }));
    assert.match(out, /Calling the owner now/);
    assert.equal(dials.length, 1);
    assert.equal(dials[0].get('MachineDetection'), 'Enable');
  });

  await check('the assistant calling on its own keeps quiet hours and its own cap', async () => {
    const before = dials.length;
    const first = await phone.callOwner('a time-critical heads-up');
    assert.equal(first, !isQuietHours(), 'rings only outside quiet hours');
    assert.equal(await phone.callOwner('another one'), false, 'cap of 1 used, or quiet hours');
    assert.equal(dials.length, before + (first ? 1 : 0));
  });

  await check('a scheduled run cannot use "call me" to get past quiet hours', async () => {
    const before = dials.length;
    const out = String(await callMe.handler({}, { groupKey: 'admin', userId: getOwner().id, systemAuthored: true }));
    if (isQuietHours()) { assert.match(out, /quiet hours/); assert.equal(dials.length, before); }
  });

  await check('"call me" has a runaway limit', async () => {
    await callMe.handler({}, { groupKey: 'admin', userId: getOwner().id });
    const out = String(await callMe.handler({}, { groupKey: 'admin', userId: getOwner().id }));
    assert.match(out, /daily "call me" limit/);
  });
  console.log(`\nCall-me tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
process.exit(0);
