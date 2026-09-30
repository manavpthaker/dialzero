import { parseNumEnv } from './env.js';
import { recordLlmUsage } from './llm-usage.js';
import { isModuleOn } from '../modules.js';

// Local-model provider seam (Odysseus Phase A). Talks to an Ollama server on the
// mini (LOCAL_LLM_BASE_URL, default off when unset) so latency-insensitive
// extraction work can run off-API. Callers must treat this as best-effort and
// fall back to OpenAI on any throw — the local model is an optimization, never
// a dependency (same discipline as router→regex and planner→heuristic).
//
// Deliberately the Ollama-native /api/chat endpoint, not the OpenAI-compat one:
// native lets us pass `think: false` (qwen3 burns minutes of reasoning tokens on
// a base-M4 otherwise) and `format: 'json'` (constrains output to valid JSON).
// If the server is ever swapped for LM Studio/MLX, adapt this one helper.

const BASE_URL = (process.env.LOCAL_LLM_BASE_URL || '').replace(/\/+$/, '');
const MODEL = process.env.LOCAL_LLM_MODEL || '';
const TIMEOUT_MS = parseNumEnv('LOCAL_LLM_TIMEOUT_MS', 120_000);
// Ollama's default context (4k) silently truncates the front of a big extraction
// batch (100 iMessages ≈ 15k tokens), so we set it explicitly. KV cache for 16k
// on an 8B q4 model fits the 16GB mini alongside the assistant stack.
const NUM_CTX = parseNumEnv('LOCAL_LLM_NUM_CTX', 16_384);

export function localLlmEnabled(): boolean {
  // The `local-model` module turns itself on once both settings are filled in;
  // MODULES_OFF=local-model or profile modules.local-model=false turns it off.
  return BASE_URL !== '' && MODEL !== '' && isModuleOn('local-model');
}

export function localLlmModel(): string {
  return MODEL;
}

/**
 * One-shot completion against the local model. `json: true` forces valid-JSON
 * output (Ollama grammar constraint). Throws on disabled/timeout/HTTP error/
 * empty body — callers fall back to OpenAI.
 */
export async function localChatComplete(opts: {
  prompt: string;
  maxTokens?: number;
  json?: boolean;
  timeoutMs?: number;
}): Promise<string> {
  if (!localLlmEnabled()) throw new Error('local LLM not configured (LOCAL_LLM_BASE_URL / LOCAL_LLM_MODEL)');
  const { prompt, maxTokens = 2000, json = false, timeoutMs = TIMEOUT_MS } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        think: false,
        // Ollama unloads after 5 idle minutes by default, and the daemons tick
        // every 10-15, so every tick paid a cold load that could blow the
        // timeout and trip the breaker. Keep it resident between ticks.
        keep_alive: process.env.LOCAL_LLM_KEEP_ALIVE || '30m',
        ...(json ? { format: 'json' } : {}),
        options: { num_predict: maxTokens, num_ctx: NUM_CTX, temperature: 0 },
      }),
    });
    if (!res.ok) {
      recordLlmUsage({
        provider: 'local', model: MODEL, latencyMs: Date.now() - started,
        ok: false, errorKind: res.status >= 500 ? '5xx' : '4xx',
      });
      throw new Error(`local LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    // Belt-and-braces: strip a <think> block in case a model ignores think:false.
    const text = (data.message?.content || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    // Metered at cost 0 (local inference is free at the margin), but the token
    // and latency counts are what make the local-vs-OpenAI ratio measurable —
    // strictly better than the count-only local_llm_stats blob, and what a
    // fallback-storm alarm needs to see.
    recordLlmUsage({
      provider: 'local',
      model: MODEL,
      inputTokens: data.prompt_eval_count ?? 0,
      outputTokens: data.eval_count ?? 0,
      latencyMs: Date.now() - started,
      ok: Boolean(text),
      errorKind: text ? null : 'empty',
    });
    if (!text) throw new Error('local LLM returned empty content');
    return text;
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      recordLlmUsage({
        provider: 'local', model: MODEL, latencyMs: Date.now() - started,
        ok: false, errorKind: 'timeout',
      });
    } else if (err instanceof TypeError) {
      // Ollama not running / refused the connection — the exact condition the
      // circuit breaker needs to see repeatedly before it opens.
      recordLlmUsage({
        provider: 'local', model: MODEL, latencyMs: Date.now() - started,
        ok: false, errorKind: 'network',
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
