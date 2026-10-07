// The take-over page: token-gated page, noVNC files, the screen relay, and
// Done / Couldn't-do-it resuming or stopping the job. Uses a fake VNC server.
//   npm run test:takeover
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

const tempRoot = mkdtempSync(join(tmpdir(), 'dialzero-takeover-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.TAKEOVER_BASE_URL = 'https://my-mac.example.ts.net:8443';
process.env.TAKEOVER_PORT = '4913';
process.env.TAKEOVER_VNC_PORT = '4914';
const db = await import('../src/db.js');
const jobs = await import('../src/jobs.js');
const tk = await import('../src/lib/takeover.js');
const srv = await import('../src/takeover-server.js');
const { default: WebSocket } = await import('ws');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS  ${name}`); }

// A fake Screen Sharing server: says hello, echoes what it gets.
const fake = createServer((sock) => { sock.write('RFB 003.889\n'); sock.on('data', (d) => sock.write(d)); });
await new Promise<void>((r) => fake.listen(4914, '127.0.0.1', () => r()));
srv.startTakeoverServer();
await new Promise((r) => setTimeout(r, 200));
const base = 'http://127.0.0.1:4913';

let resumed = 0;
jobs.registerJobKind('web_task', { resume: () => { resumed++; } });
const jobId = jobs.openJob('web_task', 'Cancel Streamly.', 'action:1');
jobs.waitOnOwner(jobId, 'login', 'Streamly needs you to log in.');

await check('the ask carries a one-time page link instead of the VNC fallback', () => {
  const line = tk.takeoverLine('streamly.example.com', { id: jobId, label: 'Log in to Streamly' });
  assert.match(line, /https:\/\/my-mac\.example\.ts\.net:8443\/t\/[A-Za-z0-9_-]{24}/);
  assert.match(line, /Tap Done there/);
});

const url = tk.createTakeover(jobId, 'Log in to Streamly', 'streamly.example.com');
const token = url.split('/t/')[1];

await check('page needs a real token; noVNC files are served, nothing else', async () => {
  assert.equal((await fetch(`${base}/t/nottherighttokenatall123`)).status, 404);
  const page = await fetch(`${base}/t/${token}`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Log in to Streamly/);
  assert.match(html, /Chrome is on streamly\.example\.com/);
  assert.equal((await fetch(`${base}/novnc/core/rfb.js`)).status, 200);
  assert.equal((await fetch(`${base}/novnc/../package.json`)).status, 404);
  assert.equal((await fetch(`${base}/novnc/core/../../../.env`)).status, 404);
});

await check('the screen relay passes bytes both ways, only with a token', async () => {
  const bad = new WebSocket(`ws://127.0.0.1:4913/ws/nottherighttokenatall123`);
  await new Promise<void>((r) => { bad.on('error', () => r()); bad.on('close', () => r()); });
  const ws = new WebSocket(`ws://127.0.0.1:4913/ws/${token}`);
  const got: string[] = [];
  await new Promise<void>((r) => ws.on('open', () => r()));
  ws.on('message', (d) => got.push(String(d)));
  ws.send(Buffer.from('ping'));
  await new Promise((r) => setTimeout(r, 200));
  assert.match(got.join(''), /^RFB 003\.889\n.*ping/s);
  ws.close();
});

await check('Done resumes the job and the link stops working', async () => {
  assert.equal((await fetch(`${base}/t/${token}/done`, { method: 'POST' })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(resumed, 1);
  assert.match(db.getJob(jobId)!.answer ?? '', /the owner finished that step/);
  assert.equal((await fetch(`${base}/t/${token}`)).status, 404);
});

await check("Couldn't do it stops the job", async () => {
  jobs.waitOnOwner(jobId, 'login', 'again');
  const t2 = tk.createTakeover(jobId, 'x', null).split('/t/')[1];
  assert.equal((await fetch(`${base}/t/${t2}/failed`, { method: 'POST' })).status, 200);
  assert.equal(db.getJob(jobId)!.status, 'stopped');
});

console.log(`\nTake-over tests passed: ${passed} checks.`);
fake.close();
rmSync(tempRoot, { recursive: true, force: true });
process.exit(0);
