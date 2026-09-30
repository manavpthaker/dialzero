/**
 * Pure tests for the LLM token budget and the local-model circuit breaker.
 *
 * No network, no API key, no model: rows are written straight into an isolated
 * llm_usage table via ASSISTANT_DB_PATH, matching the harness style of
 * scripts/test-relationship-tracker.ts.
 *
 *   npm run test:token-budget
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-token-budget-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'budget-test.db');

// Round numbers so the assertions below read as intent, not arithmetic.
process.env.LLM_DAILY_CAP_USD = '10';
process.env.LLM_WEEKLY_CAP_USD = '50';
process.env.LLM_AMBIENT_DAILY_CAP_USD = '4';
process.env.LLM_FALLBACK_DAILY_CAP_USD = '1';
process.env.LLM_BUDGET_ENFORCED = 'true';
// Breaker constants are read at module load, so they must be set before import.
process.env.LOCAL_LLM_BREAKER_THRESHOLD = '3';
process.env.LOCAL_LLM_BREAKER_COOLDOWN_MIN = '15';
process.env.LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434';
process.env.LOCAL_LLM_MODEL = 'test-model';

const failures: string[] = [];
async function test(name: string, body: () => Promise<void> | void): Promise<void> {
  try {
    await body();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
}

const USD = 1_000_000;

/** Mutable state for the stand-in Ollama, so a test can flip it up or down. */
const localOk = { status: 500 };

async function main(): Promise<void> {
  // A stand-in for Ollama, started BEFORE lib/local-llm.ts is imported because
  // that module captures LOCAL_LLM_BASE_URL at load. Lets the breaker be driven
  // through real failures instead of hand-written stats.
  const { createServer } = await import('node:http');
  const server = createServer((_req, res) => {
    if (localOk.status !== 200) {
      res.writeHead(localOk.status, { 'content-type': 'text/plain' });
      res.end('local model exploded');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ message: { content: '{"ok":true}' }, prompt_eval_count: 5, eval_count: 2 }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no server address');
  process.env.LOCAL_LLM_BASE_URL = `http://127.0.0.1:${addr.port}`;
  process.env.LOCAL_LLM_TIMEOUT_MS = '3000';

  const db = (await import('../src/db.js')).default;
  const { recordLlmUsageRow, getDailyLlmSpendMicros, setMemory, getMemory } = await import('../src/db.js');
  const { checkTokenBudget, assertWithinBudget, isLlmBudgetError, budgetStopResponse } = await import('../src/lib/token-budget.js');
  const { localBreakerState } = await import('../src/lib/daemon.js');

  const clear = () => db.prepare('DELETE FROM llm_usage').run();

  await test('system-authored budget stops stay silent instead of becoming heartbeat alerts', () => {
    const message = 'Background LLM budget spent: $4.43 of $4.00 today.';
    assert.equal(budgetStopResponse(true, '', message), '');
    assert.equal(budgetStopResponse(true, 'partial model text', message), '');
    assert.match(budgetStopResponse(false, '', message), /I had to stop before finishing/);
    assert.match(budgetStopResponse(false, 'partial model text', message), /Stopped early/);
  });
  /** Book `usd` of spend against a lane, as the meter would. */
  const spend = (lane: string, usd: number) => recordLlmUsageRow({
    caller: 'test', lane, provider: 'openai', model: 'test-model',
    cost_micros: Math.round(usd * USD),
  });

  await test('interactive is never refused, even far over every cap', async () => {
    clear();
    spend('ambient', 500); // 50x the daily cap
    assert.equal(getDailyLlmSpendMicros(), 500 * USD);
    const check = await checkTokenBudget('interactive');
    assert.equal(check.ok, true, 'a reply a human is waiting on must never be refused');
    await assertWithinBudget('interactive'); // must not throw
  });

  await test('ambient is refused at its own sub-cap while the global cap still has room', async () => {
    clear();
    spend('ambient', 5); // over the $4 ambient cap, under the $10 daily cap
    const check = await checkTokenBudget('ambient');
    assert.equal(check.ok, false);
    if (check.ok) throw new Error('unreachable');
    assert.equal(check.reason, 'ambient');
    await assert.rejects(() => assertWithinBudget('ambient'), (err: unknown) => {
      assert.ok(isLlmBudgetError(err), 'should throw LlmBudgetError');
      return true;
    });
  });

  await test('batch survives the ambient sub-cap — a runaway loop cannot eat the morning brief', async () => {
    clear();
    spend('ambient', 5); // ambient is over its cap...
    const check = await checkTokenBudget('batch');
    assert.equal(check.ok, true, 'batch must not be refused by the ambient sub-cap');
  });

  await test('batch IS refused once the whole daily budget is gone', async () => {
    clear();
    spend('ambient', 11); // over the $10 daily cap
    const check = await checkTokenBudget('batch');
    assert.equal(check.ok, false);
    if (check.ok) throw new Error('unreachable');
    assert.equal(check.reason, 'daily');
  });

  await test('weekly cap is enforced independently of the daily cap', async () => {
    clear();
    // Isolate the weekly rule by lifting the daily one out of the way. Spend has
    // to land inside the current ET week, and startOfWeekET() is a calendar
    // boundary — backdating days would fall out of the window on most weekdays
    // and silently test nothing.
    process.env.LLM_DAILY_CAP_USD = '1000';
    try {
      spend('batch', 60); // under the $1000 daily cap, over the $50 weekly cap
      const check = await checkTokenBudget('batch');
      assert.equal(check.ok, false, '$60 in one week should exceed the $50 weekly cap');
      if (check.ok) throw new Error('unreachable');
      assert.equal(check.reason, 'weekly');
    } finally {
      process.env.LLM_DAILY_CAP_USD = '10';
    }
  });

  await test('localDown swaps the ambient cap for the tighter fallback cap', async () => {
    clear();
    spend('ambient', 2); // under the $4 ambient cap, over the $1 fallback cap
    assert.equal((await checkTokenBudget('ambient')).ok, true, 'fine while the local model is up');
    const down = await checkTokenBudget('ambient', { localDown: true });
    assert.equal(down.ok, false, 'the same spend must be refused when work is silently billing a paid provider');
    if (down.ok) throw new Error('unreachable');
    assert.equal(down.reason, 'fallback');
    assert.match(down.message, /local model is down/i);
  });

  await test('LLM_BUDGET_ENFORCED=false observes without refusing', async () => {
    clear();
    spend('ambient', 99);
    process.env.LLM_BUDGET_ENFORCED = 'false';
    try {
      await assertWithinBudget('ambient'); // must not throw
      const stamp = getMemory('system', 'llm_budget_breached_at');
      assert.ok(stamp, 'a breach must still be recorded in observe mode');
    } finally {
      process.env.LLM_BUDGET_ENFORCED = 'true';
    }
  });

  // ── circuit breaker ───────────────────────────────────────────────────────

  const setStats = (s: Record<string, unknown>) => setMemory('system', 'local_llm_stats', JSON.stringify(s));

  await test('breaker is closed by default', () => {
    setStats({});
    const s = localBreakerState();
    assert.equal(s.open, false);
    assert.equal(s.halfOpen, false);
  });

  await test('breaker opens once the cooldown is in the future, and reports its deadline', () => {
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    setStats({ breaker_open_until: until, breaker_trips: 1 });
    const s = localBreakerState();
    assert.equal(s.open, true);
    assert.equal(s.halfOpen, false);
    assert.equal(s.until, until);
    assert.equal(s.trips, 1);
  });

  await test('breaker goes half-open once the cooldown elapses, so the next call probes', () => {
    setStats({ breaker_open_until: new Date(Date.now() - 60_000).toISOString(), breaker_trips: 2 });
    const s = localBreakerState();
    assert.equal(s.open, false, 'an elapsed cooldown must not keep blocking');
    assert.equal(s.halfOpen, true, 'the next call should make one probing attempt');
  });

  await test('an open breaker + provider:"local" throws instead of silently spending', async () => {
    setStats({ breaker_open_until: new Date(Date.now() + 10 * 60_000).toISOString() });
    const { extractionComplete } = await import('../src/lib/daemon.js');
    await assert.rejects(
      () => extractionComplete({
        prompt: 'x', maxTokens: 10, openaiModel: 'should-never-be-called',
        log: () => {}, provider: 'local', caller: 'test',
      }),
      /no paid fallback was made/,
      'a bulk caller must never be silently switched to a paid provider',
    );
  });

  await test('repeated local failures trip the breaker after exactly THRESHOLD attempts', async () => {
    setStats({});
    const { extractionComplete } = await import('../src/lib/daemon.js');
    // The fake local server always 500s, so every attempt is a local failure.
    // provider:'local' keeps this from falling through to a paid provider.
    for (let i = 1; i <= 3; i++) {
      await assert.rejects(() => extractionComplete({
        prompt: 'x', maxTokens: 10, openaiModel: 'should-never-be-called',
        log: () => {}, provider: 'local', caller: 'test',
      }));
      const s = localBreakerState();
      const stats = JSON.parse(getMemory('system', 'local_llm_stats') || '{}') as { consecutive_failures?: number };
      assert.equal(stats.consecutive_failures, i, `failure ${i} should be counted`);
      assert.equal(s.open, i >= 3, `breaker should open on failure 3, not before (was ${i})`);
    }
    assert.equal(localBreakerState().trips, 1);
  });

  await test('a local success closes the breaker and resets the escalation', async () => {
    // Simulate the half-open probe succeeding by driving the same write path a
    // success takes: consecutive_failures cleared, cooldown deadline dropped.
    setStats({
      consecutive_failures: 3,
      breaker_open_until: new Date(Date.now() + 60_000).toISOString(),
      breaker_opened_at: new Date().toISOString(),
      breaker_trips: 1,
      breaker_cooldown_min: 30,
    });
    assert.equal(localBreakerState().open, true, 'precondition: breaker is open');

    localOk.status = 200; // fake server now answers correctly
    const { extractionComplete } = await import('../src/lib/daemon.js');
    // Still open, so this call is skipped rather than probing — that is the
    // point of the breaker. Move the deadline into the past to force half-open.
    setStats({
      consecutive_failures: 3,
      breaker_open_until: new Date(Date.now() - 1000).toISOString(),
      breaker_opened_at: new Date().toISOString(),
      breaker_trips: 1,
      breaker_cooldown_min: 30,
    });
    assert.equal(localBreakerState().halfOpen, true, 'precondition: breaker is half-open');

    const out = await extractionComplete({
      prompt: 'x', maxTokens: 10, openaiModel: 'should-never-be-called',
      log: () => {}, provider: 'local', caller: 'test',
    });
    assert.match(out, /ok/, 'the probe should return the local model output');
    const s = localBreakerState();
    assert.equal(s.open, false, 'a successful probe must close the breaker');
    assert.equal(s.halfOpen, false, 'and clear the deadline entirely, not just let it lapse');
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }

  if (failures.length) {
    console.error(`\n${failures.length} token budget check(s) failed.`);
    process.exit(1);
  }
  console.log('\nToken budget + circuit breaker tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
