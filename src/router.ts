// Classifies whether an incoming message should be handled synchronously or
// asynchronously.
//
// Default path: a single cheap OpenAI call returns the mode.
// Fallback path (timeout / API error / missing key): a regex ladder.
// Small in-memory cache so repeated identical messages within ~30s skip the LLM.
//
// (Earlier this also generated a per-message in-voice ack. That was removed —
// the LLM acks drifted out of context; index.ts now fires a fixed receipt ack.)

import { parseStrEnv, parseNumEnv } from './lib/env.js';
import { OPENAI_ROUTER_MODEL, openAIText, llmConfigured, llmProvider } from './lib/openai.js';
import { withLlmContext } from './lib/llm-context.js';

export type Mode = 'sync' | 'async';

const ASYNC_SIGNALS = [
  /https?:\/\/\S+/,                     // contains URL (likely needs scraping)
  /\banalyze\b.*\b(jd|job|posting)\b/i, // analyze a job description
  /\bresearch\b/i,                       // research tasks
  /\bspawn\b.*\bclaude\b/i,             // spawn claude code
  /\bbuild\b/i,                          // build something
  /\bcreate\b.*\b(report|analysis)\b/i, // create a report or analysis
  /\bscrape\b/i,                         // scraping
  /\bfull\b.*\banalysis\b/i,            // full analysis
];

/** Pure-regex classifier. Kept as a fallback when the LLM call fails. */
export function detectModeRegex(text: string): Mode {
  for (const pattern of ASYNC_SIGNALS) {
    if (pattern.test(text)) return 'async';
  }
  return 'sync';
}

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 64;
const cache = new Map<string, { mode: Mode; expires: number }>();

function cacheGet(key: string): Mode | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return hit.mode;
}

function cacheSet(key: string, mode: Mode): void {
  if (cache.size >= CACHE_MAX) {
    // Drop oldest insertion — Map iteration order is insertion order.
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { mode, expires: Date.now() + CACHE_TTL_MS });
}

const ROUTER_MODEL = parseStrEnv('OPENAI_ROUTER_MODEL', OPENAI_ROUTER_MODEL);
const HAIKU_TIMEOUT_MS = parseNumEnv('ASSISTANT_ROUTER_TIMEOUT_MS', llmProvider() === 'claude' ? 3000 : 1500);

const ROUTE_SYSTEM =
  'Classify one incoming iMessage to a personal AI agent. Reply with EXACTLY one ' +
  'word, no other text: "async" or "sync".\n' +
  '"async" = needs research, scraping, a multi-step build, job-description ' +
  'analysis, or contains a URL to read/analyze.\n' +
  'Otherwise "sync".';

async function classifyWithOpenAI(text: string): Promise<Mode> {
  const trimmed = text.trim().slice(0, 600);
  if (!trimmed) return 'sync';

  // AbortController so we can hard-cap latency. If the API misbehaves we'd
  // rather fall back to the regex classifier than make the user wait.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);

  try {
    // Attributed here rather than at the call site: detectMode's only caller is
    // the inbound-message handler, so this is always work a human is waiting on
    // (the `interactive` lane, which the token budget must never refuse). The
    // call site in index.ts is pinned verbatim by the Family access gate and
    // must not be reshaped to carry a wrapper.
    const raw = await withLlmContext({ caller: 'router', lane: 'interactive' }, () => openAIText({
      model: ROUTER_MODEL,
      system: ROUTE_SYSTEM,
      prompt: trimmed,
      // Responses API currently rejects values below 16, even for a one-word
      // classifier. Sixteen tokens is still effectively free and keeps the
      // sync/async fast path valid on current OpenAI models.
      maxOutputTokens: 16,
      reasoningEffort: 'none',
      signal: controller.signal,
    }));
    const lower = raw.trim().toLowerCase();
    if (lower.startsWith('async')) return 'async';
    if (lower.startsWith('sync')) return 'sync';
    return detectModeRegex(text);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Classify a message sync/async. Tries the low-cost OpenAI model first; on timeout, API error, or
 * missing key, falls back to the regex ladder. Cached for ~30s.
 */
export async function detectMode(text: string): Promise<Mode> {
  const key = text.trim().toLowerCase();
  const cached = cacheGet(key);
  if (cached) return cached;

  if (!llmConfigured()) {
    const mode = detectModeRegex(text);
    cacheSet(key, mode);
    return mode;
  }

  try {
    const mode = await classifyWithOpenAI(text);
    cacheSet(key, mode);
    return mode;
  } catch (err) {
    console.log(`[router] OpenAI classify failed, falling back to regex: ${err instanceof Error ? err.message : String(err)}`);
    const mode = detectModeRegex(text);
    cacheSet(key, mode);
    return mode;
  }
}
