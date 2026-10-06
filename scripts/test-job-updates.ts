// Progress updates on jobs the owner started: milestones always go, in-between progress
// waits 45 min, same text never twice, raw API errors never reach them.
//   npm run test:job-updates
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-job-updates-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
const ju = await import('../src/lib/job-updates.js');
const { getTimezone } = await import('../src/config.js');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS  ${name}`); }
const sent: Array<{ subject: string; text: string }> = [];
ju.setJobUpdateSender(async (subject, text) => { sent.push({ subject, text }); });

const creditError = `Browser error: OpenAI 429: {
  "error": {
    "message": "You have no credits remaining. Add credits to continue using the API at https://platform.openai.com/settings/organization/billing/.",
    "type": "insufficient_quota", "param": null, "code": "credit_balance_exhausted"
  }
}`;

await check('the credit error is recognized as assistant-side and never pasted', () => {
  assert.ok(ju.isInfraError(creditError));
  assert.ok(!ju.isInfraError('The form needs a phone number'));
  const t = ju.cleanUpdate(`repairs.example.com keeps hitting the same wall: ${creditError} Want me to email their support instead?`);
  assert.ok(!t.includes('{') && !t.includes('insufficient_quota'), t);
});

await check('first progress goes, the next within 45 min waits, a milestone still goes', async () => {
  assert.equal(await ju.updateOwner('errand:1', 'Called A: no answer. Trying again today 2:00pm.'), true);
  assert.equal(await ju.updateOwner('errand:1', 'Called A again: no answer.'), false);
  assert.equal(await ju.updateOwner('errand:1', 'A: no answer twice. Trying B next, now.', { milestone: true }), true);
  assert.equal(sent.length, 2);
});

await check('the same text twice is sent once, even as a milestone', async () => {
  assert.equal(await ju.updateOwner('errand:1', 'A: no answer twice. Trying B next, now.', { milestone: true }), false);
});

await check('a job quiet for 3h is due a check-in; one just updated is not', () => {
  assert.equal(ju.dueForCheckIn('errand:1', Date.now() - 5 * 3600_000), false);
  const quiet = ju.dueForCheckIn('errand:2', Date.now() - 5 * 3600_000);
  const h = Number(new Date().toLocaleString('en-US', { timeZone: getTimezone(), hour: 'numeric', hour12: false }));
  assert.equal(quiet, !(h >= 21 || h < 7)); // never in quiet hours
});

await check("times read in the owner's zone", () => {
  assert.match(ju.fmtWhen(new Date()), /^today \d{1,2}:\d\d(am|pm)$/);
  assert.match(ju.fmtWhen(new Date(Date.now() + 86400_000)), /^tomorrow /);
});

console.log(`\n${passed} passed`);
rmSync(tempRoot, { recursive: true, force: true });
process.exit(0);
