import { mkdirSync, appendFileSync } from 'fs';
import { dirname } from 'path';
import { localChatComplete, localLlmEnabled, localLlmModel } from './local-llm.js';
import { openAIText } from './openai.js';
import { withLlmContext } from './llm-context.js';
import { setMemory, getMemory } from '../db.js';
import { parseBoolEnv, parseNumEnv } from './env.js';
import { assertWithinBudget } from './token-budget.js';
import { currentLlmContext } from './llm-context.js';

// Shared scaffolding for the launchd KeepAlive daemons (meeting / imessage /
// inbox-signal). Each previously duplicated the timestamped logger, the
// first-JSON extractor, the low-cost OpenAI index-prefilter protocol, and the
// tick-on-interval main loop. This centralizes those.

/** Slice out the first balanced-ish JSON object/array between `open` and `close`. */
export function extractFirstJson(text: string, open: '{' | '[', close: '}' | ']'): string | null {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

/**
 * Parse a model reply that should be a JSON array of integers. Tolerates stray
 * prose with brackets (e.g. "[link]") by matching the first all-numeric array.
 */
export function parseIndexArray(text: string): number[] {
  const m = text.match(/\[[\d,\s]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((n): n is number => typeof n === 'number');
  } catch {
    return [];
  }
}

export type Logger = (msg: string) => void;

// Provider telemetry (the Odysseus PRD's unmet "catch silent fallback storms"
// requirement): one JSON blob in the memory table so the doctor can see
// local-vs-fallback without tailing per-daemon logs. The three daemons are
// separate processes, so read-modify-write can race — but ticks are minutes
// apart and this is a health signal, not an audit ledger; last-writer-wins.
// Circuit breaker knobs. The breaker is deliberately GLOBAL rather than
// per-caller: "is Ollama up" is a property of the one server, not of whoever
// asked. If it is down for the current-context loop it is down for the imessage
// daemon too, and every caller should stop paying the timeout to rediscover
// that. Failures are attributed in the stats blob so the doctor can still say
// which caller saw it first.
const BREAKER_THRESHOLD = parseNumEnv('LOCAL_LLM_BREAKER_THRESHOLD', 3);
const BREAKER_BASE_COOLDOWN_MIN = parseNumEnv('LOCAL_LLM_BREAKER_COOLDOWN_MIN', 15);
const BREAKER_MAX_COOLDOWN_MIN = 60;

interface LocalLlmStats {
  local_count?: number;
  fallback_count?: number;
  last_local_at?: string;
  last_local_caller?: string;
  last_fallback_at?: string;
  last_fallback_caller?: string;
  last_fallback_reason?: string;
  consecutive_failures?: number;
  breaker_open_until?: string;
  breaker_opened_at?: string;
  breaker_trips?: number;
  breaker_cooldown_min?: number;
}

function readStats(): LocalLlmStats {
  try {
    return JSON.parse(getMemory('system', 'local_llm_stats') || '{}') as LocalLlmStats;
  } catch {
    return {};
  }
}

/**
 * Is the local model currently short-circuited?
 *
 * `half_open` means the cooldown has elapsed and the next caller should make one
 * probing attempt: success closes the breaker, failure re-opens it with a longer
 * cooldown.
 */
export function localBreakerState(): { open: boolean; halfOpen: boolean; until?: string; trips: number } {
  const stats = readStats();
  const trips = stats.breaker_trips || 0;
  const until = stats.breaker_open_until;
  if (!until) return { open: false, halfOpen: false, trips };
  const expired = Date.parse(until) <= Date.now();
  return { open: !expired, halfOpen: expired, until, trips };
}

function recordLlmOutcome(outcome: 'local' | 'fallback', caller: string, detail?: string): void {
  try {
    const stats = readStats();
    const now = new Date().toISOString();
    if (outcome === 'local') {
      stats.local_count = (stats.local_count || 0) + 1;
      stats.last_local_at = now;
      stats.last_local_caller = caller;
      // A success closes the breaker and resets the escalation, so a transient
      // blip does not leave a long cooldown behind it.
      stats.consecutive_failures = 0;
      delete stats.breaker_open_until;
      delete stats.breaker_opened_at;
      stats.breaker_cooldown_min = BREAKER_BASE_COOLDOWN_MIN;
    } else {
      stats.fallback_count = (stats.fallback_count || 0) + 1;
      stats.last_fallback_at = now;
      stats.last_fallback_caller = caller;
      stats.last_fallback_reason = (detail || 'unknown').slice(0, 200);
      stats.consecutive_failures = (stats.consecutive_failures || 0) + 1;
      if (stats.consecutive_failures >= BREAKER_THRESHOLD) {
        // Re-opening after a failed half-open probe doubles the wait, so a
        // genuinely dead server is retried on a decaying schedule instead of
        // every cooldown forever.
        const previous = stats.breaker_cooldown_min || BREAKER_BASE_COOLDOWN_MIN;
        const cooldown = stats.breaker_opened_at
          ? Math.min(BREAKER_MAX_COOLDOWN_MIN, previous * 2)
          : BREAKER_BASE_COOLDOWN_MIN;
        stats.breaker_cooldown_min = cooldown;
        stats.breaker_opened_at = now;
        stats.breaker_open_until = new Date(Date.now() + cooldown * 60_000).toISOString();
        stats.breaker_trips = (stats.breaker_trips || 0) + 1;
      }
    }
    setMemory('system', 'local_llm_stats', JSON.stringify(stats));
  } catch {
    /* telemetry must never break extraction */
  }
}

/**
 * The daemons' structured-extraction completion (Odysseus Phase A). When a local
 * model is configured (LOCAL_LLM_BASE_URL + LOCAL_LLM_MODEL) it runs there first
 * — these calls are timer-driven, so local latency costs nobody a chat reply —
 * and falls back to OpenAI (`openaiModel`) on any local failure: timeout, HTTP
 * error, empty output. Returns raw text; callers keep their extractFirstJson +
 * JSON.parse pipeline, which also guards a local model that emits valid-but-
 * wrong-shape JSON (unknown keys are ignored by the writeback loops).
 * Outcomes land in memory key `local_llm_stats` for the doctor's local-llm check.
 */
export async function extractionComplete(opts: {
  prompt: string;
  maxTokens: number;
  openaiModel: string;
  log: Logger;
  caller?: string;
  /**
   * 'local' makes a local-model failure THROW instead of falling back to the
   * paid provider. Mandatory for bulk/backfill callers: an unattended pass over
   * 100k+ rows must never silently switch providers partway through, which is
   * how a free overnight job becomes an invoice. Default 'auto' preserves the
   * existing behavior for the three live daemons.
   */
  provider?: 'auto' | 'local';
  /** Per-call local timeout override (the env default is 120s). */
  localTimeoutMs?: number;
  /** False for index prefilters, whose contract is a bare JSON array. */
  json?: boolean;
}): Promise<string> {
  const { prompt, maxTokens, openaiModel, log, caller = 'unknown', provider = 'auto', localTimeoutMs, json = true } = opts;

  if (provider === 'local' && !localLlmEnabled()) {
    throw new Error('extractionComplete: provider "local" requested but LOCAL_LLM_BASE_URL / LOCAL_LLM_MODEL are not configured');
  }

  // True once we know the local model is not going to serve this call, so the
  // paid fallback below can be held to the tighter fallback ceiling.
  let localUnavailable = false;

  const breaker = localBreakerState();
  if (localLlmEnabled() && breaker.open) {
    localUnavailable = true;
    // Skipping the attempt entirely is the immediate win, independent of cost:
    // a dead Ollama otherwise burns the full LOCAL_LLM_TIMEOUT_MS (120s by
    // default) on EVERY tick before falling back, which is a permanent stall
    // that stays invisible because the fallback succeeds.
    log(`extract: local breaker open until ${breaker.until} (${breaker.trips} trip(s)) — skipping local attempt`);
    if (provider === 'local') {
      throw new Error(`extractionComplete: local model unavailable (breaker open until ${breaker.until}) and provider is "local", so no paid fallback was made`);
    }
  } else if (localLlmEnabled()) {
    const started = Date.now();
    try {
      const text = await localChatComplete({ prompt, maxTokens, json, timeoutMs: localTimeoutMs });
      if (breaker.halfOpen) log('extract: local breaker probe succeeded — closing');
      log(`extract: local model ${localLlmModel()} ok in ${Date.now() - started}ms`);
      recordLlmOutcome('local', caller);
      return text;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      localUnavailable = true;
      recordLlmOutcome('fallback', caller, reason);
      if (provider === 'local') {
        log(`extract: local model failed after ${Date.now() - started}ms (${reason}) — NOT falling back (provider: local)`);
        throw err;
      }
      log(`extract: local model failed after ${Date.now() - started}ms (${reason}) — falling back to ${openaiModel}`);
    }
  }

  // Everything below here spends money. When the local model was supposed to
  // serve this and could not, the work is now billing a paid provider nobody
  // budgeted for, so the ambient lane gets its tighter fallback ceiling.
  // Awaited: an un-awaited rejection here used to crash the whole process.
  await assertWithinBudget(currentLlmContext().lane, { localDown: localUnavailable });
  return openAIText({ model: openaiModel, prompt, maxOutputTokens: maxTokens, reasoningEffort: 'low' });
}

/** Create a timestamped file logger (also echoes to stdout in test mode). Ensures the log dir exists. */
export function makeLogger(logPath: string, testMode: boolean): Logger {
  try {
    mkdirSync(dirname(logPath), { recursive: true });
  } catch {
    /* dir creation best-effort */
  }
  return (msg: string) => {
    const line = `[${new Date().toISOString()}] ${msg}\n`;
    try {
      appendFileSync(logPath, line);
    } catch {
      /* logging must never throw */
    }
    if (testMode) process.stdout.write(line);
  };
}

// Odysseus Experiment 3 remainder: route the pre-filters to the local model too.
// Default OFF — classification accuracy vs. the low-cost OpenAI model is unproven (the PRD's open
// question), and a filter that wrongly drops items fails silently downstream.
// Flip LOCAL_LLM_PREFILTER=true once local_llm_stats shows extraction holding.
const PREFILTER_LOCAL = parseBoolEnv('LOCAL_LLM_PREFILTER', false);

/**
 * Run a low-cost OpenAI pre-filter that returns the subset of `items` worth the primary
 * downstream call. `criteria` is the full instruction text (what to keep / drop);
 * the shared JSON-array protocol and the numbered list are appended here.
 * With LOCAL_LLM_PREFILTER=true (and LOCAL_LLM_* configured) the local model is
 * tried first, falling back to the configured OpenAI router model on any failure — same discipline and same
 * `local_llm_stats` telemetry as extractionComplete.
 */
export async function haikuPrefilter<T>(opts: {
  items: T[];
  render: (item: T, idx: number) => string;
  criteria: string;
  model: string;
  log: Logger;
  maxTokens?: number;
  caller?: string;
  /** local = require Ollama and never make a paid fallback call. */
  provider?: 'auto' | 'local';
}): Promise<T[]> {
  const { items, render, criteria, model, log, maxTokens = 300, caller = 'prefilter', provider = 'auto' } = opts;
  if (!items.length) return [];

  const list = items.map((it, i) => render(it, i)).join('\n');
  const prompt = `${criteria}

Reply with ONLY a JSON array of integers, e.g. [0,3,4]. If none qualify, reply [].

${list}`;

  // Strict local-only callers go through extractionComplete rather than the
  // legacy prefilter shortcut below so they inherit the shared circuit breaker
  // and can never fall through to a paid provider.
  if (provider === 'local') {
    const text = await extractionComplete({
      prompt,
      maxTokens,
      openaiModel: model,
      log,
      caller,
      provider: 'local',
      json: false,
    });
    const picked = new Set(parseIndexArray(text));
    return items.filter((_, i) => picked.has(i));
  }

  if (PREFILTER_LOCAL && localLlmEnabled()) {
    const started = Date.now();
    try {
      // json:false — the reply is a bare array and parseIndexArray tolerates
      // stray prose; Ollama's format:'json' nudges models toward objects.
      const text = await localChatComplete({ prompt, maxTokens, json: false });
      log(`prefilter: local model ${localLlmModel()} ok in ${Date.now() - started}ms`);
      recordLlmOutcome('local', caller);
      const picked = new Set(parseIndexArray(text));
      return items.filter((_, i) => picked.has(i));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log(`prefilter: local model failed after ${Date.now() - started}ms (${reason}) — falling back to ${model}`);
      recordLlmOutcome('fallback', caller, reason);
    }
  }

  try {
    const text = await openAIText({ model, prompt, maxOutputTokens: maxTokens, reasoningEffort: 'none' });
    const picked = new Set(parseIndexArray(text));
    return items.filter((_, i) => picked.has(i));
  } catch (err) {
    log(`prefilter failed: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

/**
 * Standard single-tick daemon loop. In test mode runs one tick and returns;
 * otherwise kicks off immediately then repeats every `intervalMs`. Each tick's
 * errors are caught and logged (never crash the loop). Wrap the call in
 * `.catch()` at the entry point for fatal handling.
 */
export async function runDaemon(opts: {
  name: string;
  intervalMs: number;
  testMode: boolean;
  tick: () => Promise<void>;
  log: Logger;
}): Promise<void> {
  const { name, intervalMs, testMode, tick, log } = opts;
  log(`${name} starting${testMode ? ' (TEST MODE)' : ''}`);

  // Attribute every model call a tick makes to the ambient lane. This MUST wrap
  // the tick invocation, not the setInterval registration below: AsyncLocalStorage
  // does not propagate into a timer callback scheduled outside its run().
  const attributed = () => withLlmContext(
    { caller: `daemon:${name}`, lane: 'ambient' },
    () => tick(),
  );

  if (testMode) {
    await attributed();
    log('test run complete; exiting');
    return; // test ticks never stamp — a dead daemon shouldn't look alive
  }

  // Liveness heartbeat: stamp <name>_last_tick after each successful tick so the
  // doctor (src/doctor.ts) can flag a daemon whose process has died — these run
  // as separate launchd KeepAlive processes the DB-reading checks can't see.
  const markTick = () => {
    try {
      setMemory('system', `${name}_last_tick`, new Date().toISOString());
    } catch {
      /* heartbeat stamp must never break the loop */
    }
  };

  setInterval(() => {
    attributed().then(markTick).catch((err) => log(`tick threw: ${err instanceof Error ? err.message : err}`));
  }, intervalMs);
  // Kick off immediately too.
  attributed().then(markTick).catch((err) => log(`initial tick threw: ${err instanceof Error ? err.message : err}`));
}
