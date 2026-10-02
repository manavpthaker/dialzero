// Web task tests (do_online): isolated DB; the browser runner, notifier, and
// Chrome connection are stubbed. Nothing opens a browser or texts.
//   npm run test:web-task
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-web-task-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.ACTIONS_ENABLED = 'true';

const db = await import('../src/db.js');
const wb = await import('../src/web-booking.js');
const wt = await import('../src/web-task.js');
wt.setWebTaskCodeLookup(async () => null); // never touch real email/texts in tests
wt.setWebTaskEmailLookup(async () => null);
wt.setWebTaskPageUrlReader(async () => null);
const { toolRegistry } = await import('../src/tools/index.js');
const { looksLikeWebTask } = await import('../src/tools/computer-use.js');
const { getOwner } = await import('../src/config.js');

const doOnline = toolRegistry['web-booking'].find((t) => t.definition.name === 'do_online')!;
const confirm = toolRegistry.actions.find((t) => t.definition.name === 'confirm_action')!;
assert.ok(doOnline && confirm, 'do_online is registered under actions');

const told: Array<{ text: string; subject: string }> = [];
let connected = true;
let browserReply = '';
let lastPrompt = '';
wb.setBookingDeps({
  isConnected: () => connected,
  runBrowser: async (prompt) => { lastPrompt = prompt; return browserReply; },
  notify: async (text, subject) => { told.push({ text, subject }); },
  withLock: async (_label, fn) => fn(),
  timeoutMs: 2000,
});

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const OWNER = getOwner().id;
const request = 'Let’s cancel Plaud - but I want to export all of my transcripts and conversations.';
const ctx = { groupKey: 'admin', userId: OWNER, currentMessage: request };
const base = { task: 'export all recordings as audio, then cancel the PLAUD subscription', site: 'https://web.plaud.ai' };
const doneJson = JSON.stringify({ status: 'done', summary: 'Exported 42 recordings. PLAUD cancelled; access ends Oct 29.', confirmation: 'email sent', url: 'https://web.plaud.ai/settings' });

try {
  await check('prepare: needs task + site; refuses card/password details', () => {
    assert.ok('error' in wt.prepareWebTask({ site: 'x' }));
    assert.ok('error' in wt.prepareWebTask({ task: 'cancel' }));
    assert.ok('error' in wt.prepareWebTask({ ...base, share: 'password hunter2' }));
    assert.ok('error' in wt.prepareWebTask({ ...base, notes: '4111 1111 1111 1111' }));
    const ok = wt.prepareWebTask(base);
    assert.ok('summary' in ok);
    assert.equal(ok.summary, 'Export all recordings as audio, then cancel the PLAUD subscription.');
  });

  await check('result parsing: done, blocked, junk', () => {
    assert.equal(wt.parseWebTaskResult(doneJson).status, 'done');
    assert.equal(wt.parseWebTaskResult('{"status":"blocked","summary":"PLAUD wants you to log in."}').status, 'blocked');
    assert.equal(wt.parseWebTaskResult('I cancelled it!').status, 'failed');
  });

  await check('owner asked: runs now in Chrome, no go, texts the result', async () => {
    browserReply = doneJson;
    const out = String(await doOnline.handler({ ...base, owner_request: 'cancel Plaud' }, ctx));
    assert.match(out, /Started \[action #(\d+)\]/);
    const id = Number(out.match(/#(\d+)/)![1]);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(db.getAction(id)!.status, 'done');
    assert.match(lastPrompt, /decline every offer to stay/);
    assert.match(lastPrompt, /STOP before any later step that can't be undone/);
    assert.match(told.at(-1)!.text, /^✅ Exported 42/);
  });

  await check('its own idea: staged for go, then runs on go', async () => {
    browserReply = '{"status":"blocked","summary":"Cancel is phone-only."}';
    const out = String(await doOnline.handler(base, ctx));
    assert.match(out, /Go\?/);
    assert.doesNotMatch(out.split('(For you only')[0], /#|action/i, 'no action numbers in what they see');
    const id = Number(out.match(/action id (\d+)/)![1]);
    assert.equal(db.getAction(id)!.status, 'proposed');
    await confirm.handler({ id }, ctx);
    await wt.lastWebTaskRun();
    assert.equal(db.getAction(id)!.status, 'failed');
    assert.match(told.at(-1)!.text, /^Stuck on .*phone-only/);
  });

  await check('long job: keeps going run after run, texts only the end', async () => {
    const replies = [
      '{"status":"in_progress","summary":"Exported 20 of 42."}',
      '{"status":"in_progress","summary":"Exported 40 of 42."}',
      doneJson,
    ];
    const prompts: string[] = [];
    wb.setBookingDeps({
      isConnected: () => true,
      runBrowser: async (prompt) => { prompts.push(prompt); return replies.shift()!; },
      notify: async (text, subject) => { told.push({ text, subject }); },
      withLock: async (_label, fn) => fn(),
      timeoutMs: 2000,
    });
    const before = told.length;
    const { id, done } = wt.startWebTask(base as never, 'x', 'admin');
    const r = await done;
    assert.equal(r.status, 'done');
    assert.equal(prompts.length, 3);
    assert.match(prompts[2], /Exported 40 of 42/, 'later runs see earlier progress');
    assert.equal(told.length - before, 1, 'one text, at the end');
    assert.equal(db.getAction(id)!.status, 'done');
    wb.setBookingDeps({
      isConnected: () => connected,
      runBrowser: async (prompt) => { lastPrompt = prompt; return browserReply; },
      notify: async (text, subject) => { told.push({ text, subject }); },
      withLock: async (_label, fn) => fn(),
      timeoutMs: 2000,
    });
  });

  await check('"stuck" only when it needs them; otherwise it tries another way', async () => {
    assert.ok(wt.needsOwner('PLAUD wants you to log in again.'));
    assert.ok(wt.needsOwner('Cancelling is phone-only: call support.'));
    assert.ok(wt.needsOwner('It asks for a card to continue.'));
    assert.ok(!wt.needsOwner("The browser controls can't reliably open individual transcript rows."));
    assert.ok(!wt.needsOwner('No bulk export button found.'));
    const replies = [
      '{"status":"blocked","summary":"No verified bulk transcript export was available."}',
      doneJson,
    ];
    const prompts: string[] = [];
    wb.setBookingDeps({
      isConnected: () => true,
      runBrowser: async (prompt) => { prompts.push(prompt); return replies.shift()!; },
      notify: async (text, subject) => { told.push({ text, subject }); },
      withLock: async (_label, fn) => fn(),
      timeoutMs: 2000,
    });
    process.env.WEB_TASK_RETRY_GAP_MS = '10';
    const { done } = wt.startWebTask(base as never, 'x', 'admin');
    assert.equal((await done).status, 'done');
    assert.equal(prompts.length, 2, 'a fake "blocked" became a retry');
    assert.match(prompts[1], /didn't work\): No verified bulk/);
    assert.match(prompts[1], /try a different way/);
    assert.match(prompts[0], /snapshot/);
    wb.setBookingDeps({
      isConnected: () => connected,
      runBrowser: async (prompt) => { lastPrompt = prompt; return browserReply; },
      notify: async (text, subject) => { told.push({ text, subject }); },
      withLock: async (_label, fn) => fn(),
      timeoutMs: 2000,
    });
  });

  await check('restart: a running job is picked back up', async () => {
    const id = db.proposeAction({ kind: 'web_task', tool_name: 'web_task', summary: 'x', payload_json: JSON.stringify(base), estimated_cost_cents: null, reversible: false, category: 'web_task', created_by_group: 'admin' });
    db.confirmAction(id);
    db.markActionExecuting(id);
    browserReply = doneJson;
    assert.equal(wt.resumeWebTasks(), 1);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(db.getAction(id)!.status, 'done');
  });

  await check('the same wall three runs in a row: stops and asks them instead of grinding', async () => {
    const wall = (n: number) => `{"status":"failed","summary":"Plaud's web UI only exposes share links (try ${n}), not transcript export; nothing exported."}`;
    const replies = [wall(1), wall(2), wall(3), doneJson];
    let runs = 0;
    wb.setBookingDeps({
      isConnected: () => true,
      runBrowser: async () => { runs++; return replies.shift()!; },
      notify: async (text, subject) => { told.push({ text, subject }); },
      withLock: async (_l, fn) => fn(),
      timeoutMs: 2000,
    });
    const { id, done } = wt.startWebTask(base as never, 'x', 'admin');
    const r = await done;
    assert.equal(runs, 3, 'stopped after the third identical failure');
    assert.equal(r.status, 'needs_owner');
    assert.equal(db.getAction(id)!.status, 'executing', 'paused, not failed');
    assert.match(told.at(-1)!.text, /keeps hitting the same wall.*email their support instead, or skip this part\?/);
    assert.ok(!wt.sameWall(['Run 1 (didn\'t work): login page empty', 'Run 2 (didn\'t work): export button greyed out', 'Run 3 (didn\'t work): wrong account selected']));
    wb.setBookingDeps({
      isConnected: () => connected,
      runBrowser: async (prompt) => { lastPrompt = prompt; return browserReply; },
      notify: async (text, subject) => { told.push({ text, subject }); },
      withLock: async (_l, fn) => fn(),
      timeoutMs: 2000,
    });
  });

  await check('uploads: only the listed files, from the owner folders; the desktop tool only during a job', async () => {
    const { checkUploadPaths } = await import('../src/tools/browser.js');
    const { writeFileSync, mkdirSync } = await import('node:fs');
    const dl = join(process.env.HOME!, 'Downloads');
    mkdirSync(dl, { recursive: true });
    const receipt = join(dl, '.bb-test-receipt.pdf');
    writeFileSync(receipt, 'x');
    try {
      assert.equal(checkUploadPaths([receipt]), null);
      assert.match(checkUploadPaths(['/etc/hosts'])!, /outside Downloads/);
      assert.match(checkUploadPaths([join(process.env.HOME!, '.ssh/id_rsa')])!, /not allowed/);
      assert.match(checkUploadPaths([join(dl, 'nope-404.pdf')])!, /doesn't exist/);
      await new Promise((r) => setTimeout(r, 50)); // late-bound check loads
      assert.ok('error' in wt.prepareWebTask({ ...base, files: ['/etc/hosts'] }));
      const ok = wt.prepareWebTask({ ...base, files: [receipt] });
      assert.ok('payload' in ok && (ok.payload as { files?: string[] }).files?.[0] === receipt);
      const bb = toolRegistry['booking-browser'];
      const browserAct = bb.find((t) => t.definition.name === 'browser_action')!;
      assert.match(String(await browserAct.handler({ action: 'set_files', paths: [receipt] }, { groupKey: 'booking' })), /Refused|window is closed/);
      const desktop = bb.find((t) => t.definition.name === 'desktop')!;
      assert.match(String(await desktop.handler({ action: 'screenshot' }, { groupKey: 'booking' })), /no website job is running/);
    } finally {
      const { rmSync: rm } = await import('node:fs');
      rm(receipt, { force: true });
    }
  });

  await check('1Password: vault logins matched by site, never shown, and off without a token', async () => {
    const opm = await import('../src/lib/onepassword.js');
    assert.equal(opm.siteOf('web.plaud.ai'), 'plaud.ai');
    assert.equal(opm.siteOf('login.example.co.uk'), 'example.co.uk');
    const saved = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    assert.equal(opm.onePasswordReady(), false);
    const fill = toolRegistry['booking-browser'].find((t) => t.definition.name === 'fill_login')!;
    assert.match(String(await fill.handler({ password_index: 3 }, { groupKey: 'booking' })), /no website job is running/);
    process.env.OP_SERVICE_ACCOUNT_TOKEN = 'ops_test';
    const calls: string[][] = [];
    opm.setOpRunnerForTests(async (args) => {
      calls.push(args);
      if (args[1] === 'list') return JSON.stringify([
        { id: 'a1', title: 'Plaud', urls: [{ href: 'https://web.plaud.ai/login' }] },
        { id: 'b2', title: 'Netflix', urls: [{ href: 'netflix.com' }] },
      ]);
      return '[]';
    });
    try {
      assert.deepEqual(await opm.findLoginFor('app.plaud.ai'), { id: 'a1', title: 'Plaud' });
      assert.match(JSON.stringify(await opm.findLoginFor('evil-plaud.ai.example.com')), /No login for example\.com/);
      assert.ok(calls.every((c) => c.includes('--vault') && c.includes('Assistant')), 'only the Assistant vault');
    } finally {
      opm.setOpRunnerForTests(null);
      if (saved === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN; else process.env.OP_SERVICE_ACCOUNT_TOKEN = saved;
    }
  });

  await check('Chrome down: refuses up front', async () => {
    connected = false;
    assert.match(String(await doOnline.handler({ ...base, owner_request: 'cancel Plaud' }, ctx)), /isn't connected/);
    connected = true;
  });

  await check('desktop task refuses a website plan; still takes desktop plans', () => {
    assert.ok(looksLikeWebTask('Export all available PLAUD recordings as audio, verify the exports complete, then open subscription settings and cancel the PLAUD plan.'));
    assert.ok(looksLikeWebTask('Go to https://web.plaud.ai and export'));
    assert.ok(!looksLikeWebTask('Open the password manager extension menu and pick the PLAUD login'));
    assert.ok(!looksLikeWebTask('Open Finder and move the exports to Documents'));
  });

  await check('browser guard: billing pages are clickable, card fields and pay buttons are not', () => {
    assert.equal(wb.paymentRefusal({ action: 'click', selector: 'a[href="/settings/billing"]' }), null);
    assert.equal(wb.paymentRefusal({ action: 'click', text: 'Cancel subscription' }), null);
    assert.ok(wb.paymentRefusal({ action: 'click', selector: '#card-number' }));
    assert.ok(wb.paymentRefusal({ action: 'click', text: 'Pay now' }));
    assert.ok(wb.paymentRefusal({ action: 'real_type', value: '4111 1111 1111 1111' }), 'real typing never enters a card number');
    assert.equal(wb.paymentRefusal({ action: 'real_type', value: 'Alex Rivera' }), null);
  });

  console.log(`\nWeb task tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
