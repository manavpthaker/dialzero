/**
 * Pure tests for the OpenAI adapter's retry/backoff/metering behavior.
 *
 * No network and no API key: a local http server stands in for the provider via
 * OPENAI_BASE_URL, so this is safe to run anywhere and costs nothing. Isolated
 * database via ASSISTANT_DB_PATH, matching scripts/test-relationship-tracker.ts.
 *
 *   npm run test:openai-adapter
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-openai-adapter-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'adapter-test.db');
process.env.OPENAI_API_KEY = 'test-key-not-real';
process.env.OPENAI_MAX_ATTEMPTS = '4';
// Keep the whole-call budget short so a hung case fails the suite fast.
process.env.OPENAI_TIMEOUT_MS = '8000';

interface Route {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

let queue: Route[] = [];
let hits = 0;
let server: Server;
let baseUrl = '';

function usageBody(inTok = 10, outTok = 4): string {
  return JSON.stringify({
    output_text: 'ok',
    usage: {
      input_tokens: inTok,
      output_tokens: outTok,
      input_tokens_details: { cached_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 2 },
    },
  });
}

async function start(): Promise<void> {
  server = createServer((req, res) => {
    hits += 1;
    const route = queue.shift() ?? { status: 200, body: usageBody() };
    res.writeHead(route.status, { 'content-type': 'application/json', ...(route.headers ?? {}) });
    res.end(route.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  baseUrl = `http://127.0.0.1:${addr.port}`;
  process.env.OPENAI_BASE_URL = baseUrl;
}

const failures: string[] = [];
async function test(name: string, body: () => Promise<void>): Promise<void> {
  queue = [];
  hits = 0;
  try {
    await body();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? err.message : String(err));
  }
}

async function main(): Promise<void> {
  await start();

  // Imported AFTER the env is set: the adapter reads OPENAI_BASE_URL and the
  // attempt cap at module load.
  const { createOpenAIResponse } = await import('../src/lib/openai.js');
  const db = (await import('../src/db.js')).default;
  const rows = () => db.prepare(
    'SELECT model, ok, error_kind, attempt, input_tokens, cached_input_tokens, output_tokens, reasoning_tokens FROM llm_usage ORDER BY id',
  ).all() as Array<Record<string, unknown>>;
  const clear = () => db.prepare('DELETE FROM llm_usage').run();
  // The meter's first write resolves a dynamic import; give it a beat so the
  // assertions below see rows rather than a race.
  const settle = () => new Promise((r) => setTimeout(r, 250));

  await test('success path records one row with parsed token counts', async () => {
    clear();
    queue = [{ status: 200, body: usageBody(10, 4) }];
    const res = await createOpenAIResponse({ model: 'test-model', input: 'hi' });
    assert.equal(res.output_text, 'ok');
    assert.equal(hits, 1, 'should not retry a success');
    await settle();
    const r = rows();
    assert.equal(r.length, 1);
    assert.equal(r[0].ok, 1);
    assert.equal(r[0].input_tokens, 10);
    assert.equal(r[0].cached_input_tokens, 3, 'cached tokens must be read from input_tokens_details');
    assert.equal(r[0].output_tokens, 4);
    assert.equal(r[0].reasoning_tokens, 2, 'reasoning tokens must be read from output_tokens_details');
  });

  await test('429 is retried and succeeds, with one metered row per attempt', async () => {
    clear();
    queue = [
      { status: 429, body: '{"error":"slow down"}', headers: { 'retry-after': '0' } },
      { status: 429, body: '{"error":"slow down"}', headers: { 'retry-after': '0' } },
      { status: 200, body: usageBody() },
    ];
    const res = await createOpenAIResponse({ model: 'test-model', input: 'hi' });
    assert.equal(res.output_text, 'ok');
    assert.equal(hits, 3, 'should have retried twice then succeeded');
    await settle();
    const r = rows();
    assert.equal(r.length, 3, 'each attempt is metered');
    assert.equal(r[0].error_kind, '429');
    assert.equal(r[0].attempt, 1);
    assert.equal(r[1].attempt, 2);
    assert.equal(r[2].ok, 1, 'final attempt succeeded');
    assert.equal(r[2].attempt, 3);
  });

  await test('5xx is retried', async () => {
    clear();
    queue = [
      { status: 503, body: 'gateway', headers: { 'retry-after': '0' } },
      { status: 200, body: usageBody() },
    ];
    await createOpenAIResponse({ model: 'test-model', input: 'hi' });
    assert.equal(hits, 2);
    await settle();
    assert.equal(rows()[0].error_kind, '5xx');
  });

  await test('4xx is NOT retried — a malformed request fails identically every time', async () => {
    clear();
    queue = [{ status: 400, body: '{"error":{"message":"bad input"}}' }];
    await assert.rejects(
      () => createOpenAIResponse({ model: 'test-model', input: 'hi' }),
      /OpenAI 400/,
    );
    assert.equal(hits, 1, 'a 400 must not be retried');
    await settle();
    const r = rows();
    assert.equal(r.length, 1);
    assert.equal(r[0].ok, 0);
    assert.equal(r[0].error_kind, '4xx');
  });

  await test('retries are bounded by OPENAI_MAX_ATTEMPTS', async () => {
    clear();
    queue = Array.from({ length: 10 }, () => ({
      status: 429, body: 'nope', headers: { 'retry-after': '0' },
    }));
    await assert.rejects(() => createOpenAIResponse({ model: 'test-model', input: 'hi' }), /OpenAI 429/);
    assert.equal(hits, 4, 'exactly OPENAI_MAX_ATTEMPTS attempts');
    await settle();
    assert.equal(rows().length, 4);
  });

  await test('a caller-supplied abort signal is terminal, not retried', async () => {
    clear();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(() => createOpenAIResponse({ model: 'test-model', input: 'hi', signal: ac.signal }));
    assert.equal(hits, 0, 'an already-aborted call must not reach the network');
  });

  await test('non-JSON body on a 200 fails fast and is metered', async () => {
    clear();
    queue = [{ status: 200, body: '<html>gateway</html>' }];
    await assert.rejects(
      () => createOpenAIResponse({ model: 'test-model', input: 'hi' }),
      /non-JSON/,
    );
    assert.equal(hits, 1);
    await settle();
    assert.equal(rows()[0].error_kind, 'non-json');
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }

  if (failures.length) {
    console.error(`\n${failures.length} OpenAI adapter check(s) failed.`);
    process.exit(1);
  }
  console.log('\nOpenAI adapter tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
