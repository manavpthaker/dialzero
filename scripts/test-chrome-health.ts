// Chrome health tests: everything stubbed (no Chrome, no texts, fixed clock).
//   npm run test:chrome-health
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-chrome-health-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
const ch = await import('../src/lib/chrome-health.js');

let now = 1_000_000;
let connected = true;
let version: () => Promise<string> = async () => '1.1.0';
const did: string[] = [];
let jobs: string[] = [];
const alerts: string[] = [];
function stub() {
  ch.setChromeHealthDeps({
    connected: () => connected,
    version: () => version(),
    reload: async () => { did.push('reload'); },
    openChrome: async () => { did.push('open'); },
    expectedVersion: () => '1.1.0',
    jobsWaiting: () => jobs,
    alert: async (t) => { alerts.push(t); },
    now: () => now,
  });
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log(`PASS  ${name}`); }
const MIN = 60_000;

try {
  await check('healthy: nothing to do', async () => {
    stub();
    assert.equal(await ch.chromeHealthTick(), 'ok');
    assert.deepEqual(did, []);
  });
  await check('older extension: reloads itself, once per 30 min', async () => {
    stub();
    version = async () => '1.0.0';
    assert.equal(await ch.chromeHealthTick(), 'reloaded');
    assert.equal(await ch.chromeHealthTick(), 'ok');
    assert.deepEqual(did, ['reload']);
    version = async () => '1.1.0';
  });
  await check('very old extension (no version action) counts as alive', async () => {
    stub();
    version = async () => { throw new Error('Unknown action: version'); };
    assert.equal(await ch.chromeHealthTick(), 'ok');
    version = async () => '1.1.0';
  });
  await check('down: waits, opens Chrome after 3 min, alerts once after 10 min only if a job waits', async () => {
    stub(); did.length = 0;
    connected = false;
    assert.equal(await ch.chromeHealthTick(), 'down');
    now += 3 * MIN;
    assert.equal(await ch.chromeHealthTick(), 'opened');
    now += 8 * MIN;
    assert.equal(await ch.chromeHealthTick(), 'down', 'no job waiting, so no text; Chrome was just reopened');
    jobs = ['Export Plaud transcripts, then cancel Plaud.'];
    now += 1 * MIN;
    assert.equal(await ch.chromeHealthTick(), 'alerted');
    assert.match(alerts[0], /paused: Export Plaud/);
    now += 1 * MIN;
    assert.notEqual(await ch.chromeHealthTick(), 'alerted', 'once a day');
    assert.equal(alerts.length, 1);
  });
  await check('a half-open socket (ping times out) counts as down', async () => {
    stub(); connected = true;
    version = async () => { throw new Error('Browser command timed out after 5000ms: version'); };
    assert.equal(await ch.chromeHealthTick(), 'down');
    assert.ok(ch.chromeDownForMs() >= 0);
  });
  console.log(`\nChrome health tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
