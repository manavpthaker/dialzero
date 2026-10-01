// Job tracker tests: isolated DB; browser runner, page host, notifier and
// Chrome connection stubbed. Nothing opens a browser or texts.
//   npm run test:jobs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-jobs-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.ACTIONS_ENABLED = 'true';
process.env.WEB_TASK_RETRY_GAP_MS = '10';

const db = await import('../src/db.js');
const wb = await import('../src/web-booking.js');
const wt = await import('../src/web-task.js');
const jobs = await import('../src/jobs.js');
const { toolRegistry } = await import('../src/tools/index.js');
const { getOwner } = await import('../src/config.js');

const tool = (key: string, name: string) => toolRegistry[key].find((t) => t.definition.name === name)!;
const whats = tool('actions', 'whats_going_on');
const stop = tool('actions', 'stop_job');
const answer = tool('actions', 'answer_job');
const enterCode = tool('booking-browser', 'enter_owner_code');

const told: string[] = [];
let replies: string[] = [];
let onRun: ((prompt: string) => Promise<void>) | null = null;
const prompts: string[] = [];
wb.setBookingDeps({
  isConnected: () => true,
  runBrowser: async (prompt) => { prompts.push(prompt); if (onRun) await onRun(prompt); return replies.shift() ?? '{"status":"failed","summary":"no reply queued"}'; },
  notify: async (text) => { told.push(text); },
  withLock: async (_label, fn) => fn(),
  timeoutMs: 2000,
});
let pageHost = 'web.plaud.ai';
wt.setWebTaskHostReader(async () => pageHost);

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS  ${name}`); }

const OWNER = getOwner().id;
const ctx = { groupKey: 'admin', userId: OWNER, currentMessage: 'x' };
const base = { task: 'export all transcripts, then cancel the PLAUD subscription', site: 'https://web.plaud.ai' };
const wait = (ms = 60) => new Promise((r) => setTimeout(r, ms));

try {
  await check('extractCode: digits with spaces/dashes, or a short token', () => {
    assert.equal(jobs.extractCode('its 482 913'), '482913');
    assert.equal(jobs.extractCode('code: 4829-13 thanks'), '482913');
    assert.equal(jobs.extractCode('X7K2P9'), 'X7K2P9');
    assert.equal(jobs.extractCode('logged in'), null);
  });

  let actionId = 0;
  await check('a website job pauses for a code instead of failing, and asks them once', async () => {
    replies = ['{"status":"needs_owner","need":"code","ask":"Plaud sent you a code. What is it?","summary":"At the code screen."}'];
    const { id, done } = wt.startWebTask(base as never, 'Export Plaud transcripts, then cancel Plaud.', 'admin');
    actionId = id;
    const r = await done;
    assert.equal(r.status, 'needs_owner');
    assert.equal(db.getAction(id)!.status, 'executing', 'still running, not failed');
    const job = db.getJobByRef(`action:${id}`)!;
    assert.equal(job.status, 'waiting_on_you');
    assert.equal(job.waiting_for, 'code');
    assert.equal(job.code_host, 'web.plaud.ai');
    assert.equal(told.at(-1), 'Plaud sent you a code. What is it?');
    assert.equal(wt.resumeWebTasks(), 0, 'restart-resume leaves a waiting job alone');
  });

  await check('whats_going_on: plain words, waiting on them first, no ids', async () => {
    db.insertJob({ title: 'Watch for the Plaud confirmation email.', kind: 'watch', status: 'watching' });
    const out = String(await whats.handler({}, ctx));
    assert.match(out, /^Waiting on you\n- Export Plaud transcripts, then cancel Plaud\. Waiting on you: Plaud sent you a code/);
    assert.match(out, /Keeping an eye on\n- Watch for the Plaud confirmation email/);
    assert.doesNotMatch(out, /#|action|job:/);
  });

  await check('their reply "482913" resumes the job; the code is typed by the tool, never put in the prompt', async () => {
    const typed: string[] = [];
    replies = ['{"status":"done","summary":"Exported 238 transcripts. Plaud cancelled; access ends Oct 29."}'];
    onRun = async (prompt) => {
      assert.doesNotMatch(prompt, /482913/, 'code never reaches the model');
      assert.match(prompt, /THE OWNER SENT THE CODE/);
      // The sub-agent calls enter_owner_code mid-run:
      const { browserTools } = await import('../src/tools/browser.js');
      const orig = browserTools[0].handler;
      browserTools[0].handler = async (input) => {
        if (input.action === 'get_current_url') return JSON.stringify({ url: `https://${pageHost}/verify` });
        if (input.action === 'fill_input') { typed.push(String(input.value)); return '{"filled":true}'; }
        return orig(input);
      };
      try {
        assert.match(String(await enterCode.handler({ selector: '#code' }, ctx)), /Entered the code/);
        assert.match(String(await enterCode.handler({ selector: '#code' }, ctx)), /No code from the owner/, 'single use');
      } finally {
        browserTools[0].handler = orig;
      }
    };
    const msg = String(await answer.handler({ answer: 'its 482913' }, ctx));
    assert.match(msg, /entering it now/);
    await wait(400);
    onRun = null;
    assert.deepEqual(typed, ['482913']);
    assert.equal(db.getAction(actionId)!.status, 'done');
    assert.equal(db.getJobByRef(`action:${actionId}`)!.status, 'done');
    assert.match(told.at(-1)!, /^✅ Exported 238/);
  });

  await check('a code is only typed on the site that asked for it', async () => {
    replies = ['{"status":"needs_owner","need":"code","ask":"Code?","summary":"code"}'];
    pageHost = 'web.plaud.ai';
    const { id, done } = wt.startWebTask(base as never, 'Log in to Plaud.', 'admin');
    await done;
    const job = db.getJobByRef(`action:${id}`)!;
    db.patchJob(job.id, { answer: '111222', answered_at: new Date().toISOString(), status: 'working' });
    pageHost = 'evil.example.com';
    replies = ['{"status":"failed","summary":"x"}'];
    let refusal = '';
    onRun = async () => {
      const { browserTools } = await import('../src/tools/browser.js');
      const orig = browserTools[0].handler;
      browserTools[0].handler = async (input) => input.action === 'get_current_url' ? JSON.stringify({ url: 'https://evil.example.com/x' }) : orig(input);
      try { refusal = String(await enterCode.handler({ selector: '#code' }, ctx)); } finally { browserTools[0].handler = orig; }
    };
    void wt.runWebTask(id, base as never);
    await wait(100);
    onRun = null;
    assert.match(refusal, /Refused: the code was for web\.plaud\.ai/);
    await stop.handler({ which: 'log in plaud' }, ctx);
    pageHost = 'web.plaud.ai';
  });

  await check('stop mid-run: closes the browser window, ends quietly, no "couldn\'t finish" text', async () => {
    replies = [];
    let windowOpenDuringStop: boolean | null = null;
    onRun = async () => {
      await wait(50);
      const out = String(await stop.handler({ which: 'cancel netflix' }, ctx));
      assert.match(out, /Stopped: Cancel Netflix/);
      windowOpenDuringStop = wb.bookingWindowOpen();
    };
    const before = told.length;
    const { id, done } = wt.startWebTask({ task: 'cancel Netflix', site: 'netflix.com' } as never, 'Cancel Netflix.', 'admin');
    await done;
    onRun = null;
    assert.equal(windowOpenDuringStop, false, 'browser tools refuse from the moment they say stop');
    assert.equal(db.getAction(id)!.status, 'cancelled');
    assert.equal(db.getJobByRef(`action:${id}`)!.status, 'stopped');
    assert.equal(told.length, before, 'no extra text after stopping');
  });

  await check('answer_job / stop_job: only the owner, and ask which when unclear', async () => {
    assert.match(String(await answer.handler({ answer: '123456' }, { ...ctx, userId: 'someone-else' })), /Only the owner/);
    const a = db.insertJob({ title: 'Cancel Hulu.', kind: 'web_task', status: 'waiting_on_you' });
    const b = db.insertJob({ title: 'Cancel Peacock.', kind: 'web_task', status: 'waiting_on_you' });
    assert.match(String(await answer.handler({ answer: 'done' }, ctx)), /Ask which.*Cancel (Hulu|Peacock) or Cancel (Hulu|Peacock)/);
    assert.match(String(await stop.handler({ which: 'peacock' }, ctx)), /Stopped: Cancel Peacock/);
    assert.equal(db.getJob(b)!.status, 'stopped');
    assert.equal(db.getJob(a)!.status, 'waiting_on_you');
  });

  await check('how they like things done reaches the website job prompt', async () => {
    db.saveFact({ subject: 'how-i-like-things', predicate: 'exports', object: 'transcripts, not audio', fact_type: 'preference', source: 'test' } as never);
    db.saveFact({ subject: 'how-i-like-things', predicate: 'cancellations', object: 'always turn down offers to stay', fact_type: 'preference', source: 'test' } as never);
    const { preferencesFor } = await import('../src/lib/preferences.js');
    const prefs = preferencesFor('export recordings then cancel plaud');
    assert.match(prefs, /exports: transcripts, not audio/);
    assert.match(prefs, /cancellations: always turn down offers to stay/);
    assert.match(wt.webTaskPrompt(base as never), /HOW THEY LIKE THINGS DONE[\s\S]*transcripts, not audio/);
  });

  console.log(`\nJob tracker tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
