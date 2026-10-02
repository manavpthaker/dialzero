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
wt.setWebTaskCodeLookup(async () => null); // never touch real email/texts in tests
wt.setWebTaskEmailLookup(async () => null);
wt.setWebTaskPageUrlReader(async () => null);
const jobs = await import('../src/jobs.js');
const { toolRegistry } = await import('../src/tools/index.js');
const { getOwner } = await import('../src/config.js');

const tool = (key: string, name: string) => (toolRegistry[key].find((t) => t.definition.name === name) ?? Object.values(toolRegistry).flat().find((t) => t.definition.name === name))!;
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

  await check('asking again about a job already running or waiting does not start a second one', async () => {
    const doOnline = tool('actions', 'do_online');
    const id = db.insertJob({ title: 'Cancel the Hulu subscription.', kind: 'web_task', status: 'working' });
    const ctx2 = { groupKey: 'admin', userId: OWNER, currentMessage: 'cancel hulu anyway' };
    const before = db.listOpenJobRows().length;
    const out = String(await doOnline.handler({ owner_request: 'cancel hulu anyway', task: 'cancel the Hulu subscription', site: 'https://www.hulu.com' }, ctx2));
    assert.match(out, /Already working on that/);
    assert.equal(db.listOpenJobRows().length, before);
    db.patchJob(id, { status: 'waiting_on_you', waiting_for: 'decision', ask: 'Hulu offers 50% off. Take it?' });
    const out2 = String(await doOnline.handler({ owner_request: 'cancel hulu anyway', task: 'cancel the Hulu subscription', site: 'https://www.hulu.com' }, ctx2));
    assert.match(out2, /Back on it/);
    assert.equal(db.getJob(id)!.answer, 'cancel hulu anyway');
  });

  await check('a code the site emailed them is fetched and typed without asking them', async () => {
    const cf = await import('../src/lib/code-finder.js');
    const linkedin = `Search results\n────────────────────────────\n\n  ID: 190575\n  Subject: Here's your verification code 415836\n  From: LinkedIn <security-noreply@linkedin.com>\n  Date: 2099-01-01 10:00\n\n  [Enter the 6-digit code below](https://x.com/a)\n  # ** [415836](https://x.com/b)**\n`;
    assert.deepEqual(cf.parseSparkResults(linkedin).map((m) => m.id), ['190575']);
    assert.equal(cf.codeFromText("Here's your verification code 415836", ''), '415836');
    assert.equal(cf.codeFromText('Your PLAUD sign-in code', 'Use this code: 482913 to sign in. © 2026 Plaud'), '482913');
    assert.equal(cf.codeFromText('Order shipped', 'Arrives 2026-10-03'), null);
    // An airline's wording: the code sits inside link text, after "is".
    assert.equal(cf.codeFromText("Here's your verification code", 'Example Air - Example Miles [Your Example Air verification code is 593104. This code will expire in 5 minutes.](https://notification.example.com/x)'), '593104');
    assert.equal(cf.codeFromText('Sign in', 'Your one-time code for Acme is: 4821-07'), '482107');
    assert.equal(cf.codeFromText('Sign in to Shopify', 'Your login code is K7Q2ZP'), 'K7Q2ZP');
    assert.equal(cf.codeFromText('Code of conduct update', 'We updated our code of conduct in 2026.'), null, 'a year is not a code');
    cf.setCodeFinderDeps({ searchEmail: async () => linkedin.replace(/LinkedIn/g, 'Plaud'), ownerHandles: () => [] });
    assert.equal((await cf.findEmailCode(['plaud'], Date.parse('2099-01-01T09:58')))?.code, '415836');
    assert.equal(await cf.findEmailCode(['netflix'], Date.parse('2099-01-01T09:58')), null, 'another company\'s code is ignored');
    assert.equal(await cf.findEmailCode(['plaud'], Date.parse('2099-01-01T11:00')), null, 'an old code is ignored');

    wt.setWebTaskCodeLookup(async (brands) => (brands.includes('plaud') ? { code: '777111', source: 'email' } : null));
    const typed: string[] = [];
    const before = told.length;
    replies = [
      '{"status":"needs_owner","need":"code","ask":"Plaud sent you a code. What is it?","summary":"code screen"}',
      '{"status":"done","summary":"Signed in and cancelled."}',
    ];
    onRun = async (prompt) => {
      if (!/THE OWNER SENT THE CODE/.test(prompt)) return;
      assert.doesNotMatch(prompt, /777111/);
      const { browserTools } = await import('../src/tools/browser.js');
      const orig = browserTools[0].handler;
      browserTools[0].handler = async (input) => {
        if (input.action === 'get_current_url') return JSON.stringify({ url: `https://${pageHost}/login` });
        if (input.action === 'fill_input') { typed.push(String(input.value)); return '{"filled":true}'; }
        return orig(input);
      };
      try { await enterCode.handler({ selector: '#otp' }, ctx); } finally { browserTools[0].handler = orig; }
    };
    const { id, done } = wt.startWebTask(base as never, 'Cancel Plaud.', 'admin');
    const r = await done;
    onRun = null;
    wt.setWebTaskCodeLookup(async () => null);
    assert.equal(r.status, 'done');
    assert.deepEqual(typed, ['777111']);
    assert.equal(told.length - before, 1, 'only the final result was texted, no "what is the code?"');
    assert.equal(db.getAction(id)!.status, 'done');
  });

  await check('an emailed sign-in link (Stripe-style) is found, opened in the job tab, and kept out of the prompt', async () => {
    const cf = await import('../src/lib/code-finder.js');
    const stripe = `Results\n────────────────────────────\n\n  ID: 9\n  Subject: Sign in to Plaud's billing portal\n  From: Plaud <receipts+abc@stripe.com>\n  To: Alex <m@example.com>\n  Date: 2099-01-01 10:00\n\n  [Unsubscribe](https://stripe.com/unsub)\n  [Sign in](https://billing.stripe.com/p/session/login_SECRET123)\n`;
    assert.equal(cf.signInLinkFrom(cf.parseSparkResults(stripe)[0].body, ['plaud'])?.host, 'billing.stripe.com');
    assert.equal(cf.signInLinkFrom('[Sign in](https://evil.example.com/login)', ['plaud']), null, 'unknown hosts are ignored');
    cf.setCodeFinderDeps({ searchEmail: async () => stripe, ownerHandles: () => [] });
    assert.equal((await cf.findEmailLink(['plaud'], Date.parse('2099-01-01T09:59')))?.link, 'https://billing.stripe.com/p/session/login_SECRET123');
    assert.equal(await cf.findAccountEmail(['plaud']), 'm@example.com', 'the address Plaud emails them at');

    wt.setWebTaskCodeLookup(async () => ({ link: 'https://billing.stripe.com/p/session/login_SECRET123' }));
    const opened: string[] = [];
    replies = [
      '{"status":"needs_owner","need":"link","ask":"Stripe emailed you a link.","summary":"link sent"}',
      '{"status":"done","summary":"Cancelled in the Stripe portal."}',
    ];
    const before = told.length;
    onRun = async (prompt) => {
      if (!/THE SIGN-IN LINK ARRIVED/.test(prompt)) return;
      assert.doesNotMatch(prompt, /SECRET123/);
      const { browserTools } = await import('../src/tools/browser.js');
      const orig = browserTools[0].handler;
      browserTools[0].handler = async (input) => {
        if (input.action === 'navigate') { opened.push(String(input.url)); return 'Title: Billing\nURL: https://billing.stripe.com/p/session/xyz\n\nManage subscription'; }
        return orig(input);
      };
      try {
        const out = String(await tool('booking-browser', 'open_sign_in_link').handler({}, ctx));
        assert.doesNotMatch(out, /SECRET|billing\.stripe\.com\/p/, 'token never reaches the model');
        assert.match(String(await tool('booking-browser', 'open_sign_in_link').handler({}, ctx)), /No sign-in link/, 'single use');
      } finally { browserTools[0].handler = orig; }
    };
    const { done } = wt.startWebTask({ task: 'cancel Plaud', site: 'https://web.plaud.ai' } as never, 'Cancel Plaud.', 'admin');
    assert.equal((await done).status, 'done');
    onRun = null;
    wt.setWebTaskCodeLookup(async () => null);
    assert.deepEqual(opened, ['https://billing.stripe.com/p/session/login_SECRET123']);
    assert.equal(told.length - before, 1, 'no "click the link" text to them');
  });

  await check('two jobs queued for the browser: each run sees itself as the active job', async () => {
    let chain: Promise<unknown> = Promise.resolve();
    const seen: Array<number | null> = [];
    const ids: number[] = [];
    wb.setBookingDeps({
      isConnected: () => true,
      runBrowser: async () => { await wait(30); seen.push(wt.activeWebTaskRun()?.actionId ?? null); return '{"status":"done","summary":"ok"}'; },
      notify: async () => {},
      // A real FIFO lock, like lib/browser-lock.
      withLock: async (_l, fn) => { const run = chain.then(fn); chain = run.catch(() => {}); return run; },
      timeoutMs: 2000,
    });
    const a = wt.startWebTask({ task: 'read A', site: 'https://a.example.com' } as never, 'A.', 'admin');
    const b = wt.startWebTask({ task: 'read B', site: 'https://b.example.com' } as never, 'B.', 'admin');
    ids.push(a.id, b.id);
    await Promise.all([a.done, b.done]);
    assert.deepEqual(seen, ids, 'each run saw its own job, never null or the other');
    assert.equal(wt.activeWebTaskRun(), null);
  });

  console.log(`\nJob tracker tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
