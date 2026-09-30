import { parseNumEnv, parseStrEnv } from './env.js';
import { recordLlmUsage } from './llm-usage.js';
import { assertWithinBudget } from './token-budget.js';
import { currentLlmContext } from './llm-context.js';
import { claudeSelected, createClaudeResponse } from './anthropic.js';

/**
 * Small Responses API adapter used by the bot. Keeping the HTTP boundary here
 * means the agent/tool loop does not depend on a vendor SDK response shape and
 * makes the provider easy to replace or test.
 */

const API_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
const REQUEST_TIMEOUT_MS = parseNumEnv('OPENAI_TIMEOUT_MS', 120_000);

export const OPENAI_MODEL = parseStrEnv('OPENAI_MODEL', 'gpt-5.6-terra');
export const OPENAI_ROUTER_MODEL = parseStrEnv('OPENAI_ROUTER_MODEL', 'gpt-5.6-luna');

/** Model names that mean "the quick model" (mapped to CLAUDE_FAST_MODEL when Claude is the provider). */
function fastModelNames(): string[] {
  return [OPENAI_ROUTER_MODEL, 'gpt-5.6-luna', process.env.OPENAI_RETRIEVAL_MODEL, process.env.OPENAI_SEARCH_MODEL]
    .filter((n): n is string => Boolean(n && n.trim()))
    .map((n) => n.trim());
}

/** Which provider serves the assistant's model calls: 'claude' or 'openai'. */
export function llmProvider(): 'claude' | 'openai' {
  return claudeSelected() ? 'claude' : 'openai';
}

/** True when the selected provider has an API key, i.e. model calls can work. */
export function llmConfigured(): boolean {
  return llmProvider() === 'claude' ? Boolean(process.env.ANTHROPIC_API_KEY) : Boolean(process.env.OPENAI_API_KEY);
}

export interface OpenAIResponse {
  id?: string;
  output?: Array<Record<string, unknown>>;
  output_text?: string;
  usage?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenAIResponseOptions {
  model: string;
  instructions?: string;
  input: unknown;
  tools?: unknown[];
  maxOutputTokens?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  signal?: AbortSignal;
}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) throw new Error('OPENAI_API_KEY is not configured');
  return key;
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Classify a failure for the meter's error_kind column. */
function errorKind(status: number | null, timedOut: boolean): string {
  if (timedOut) return 'timeout';
  if (status === null) return 'network';
  if (status === 429) return '429';
  if (status >= 500) return '5xx';
  return '4xx';
}

// Retry policy. Before this existed the adapter was a bare fetch: a 429 threw
// straight through to the caller, which for an inbound message meant the user
// got a raw "Error: OpenAI 429: ..." in the chat, and for a pulse meant the run
// died silently in a catch.
const MAX_ATTEMPTS = parseNumEnv('OPENAI_MAX_ATTEMPTS', 4);

/**
 * Sleep that gives up early if the overall request budget is spent. Without
 * this, a timeout firing mid-backoff would still wait out the full delay before
 * noticing there is no point.
 */
function backoffSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Honor Retry-After when the server sends it; otherwise exponential + jitter. */
function backoffMs(res: Response | null, attempt: number): number {
  const header = res?.headers.get('retry-after');
  const retryAfter = header ? Number(header) : NaN;
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return Math.min(30_000, retryAfter * 1000);
  return Math.min(30_000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

/** Make a Responses API request with a bounded timeout and useful errors. */
export async function createOpenAIResponse(opts: OpenAIResponseOptions): Promise<OpenAIResponse> {
  // One switch for every caller: agent loop, router, planner, daemons, search.
  if (claudeSelected()) return createClaudeResponse(opts, fastModelNames());
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), REQUEST_TIMEOUT_MS);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout.signal]) : timeout.signal;

  // The timeout budget spans the WHOLE call including retries, deliberately.
  // A per-attempt timeout would let 4 attempts stack to 4x REQUEST_TIMEOUT_MS,
  // and on the interactive lane that is a user staring at a dead chat for eight
  // minutes. Bounded total latency beats maximal retry.
  try {
    const body: Record<string, unknown> = {
      model: opts.model,
      input: opts.input,
      max_output_tokens: opts.maxOutputTokens ?? 2000,
    };
    if (opts.instructions) body.instructions = opts.instructions;
    if (opts.tools?.length) body.tools = opts.tools;
    if (opts.reasoningEffort) body.reasoning = { effort: opts.reasoningEffort };
    const payload = JSON.stringify(body);

    const meter = (attempt: number, startedAt: number, kind: string) => recordLlmUsage({
      provider: 'openai',
      model: opts.model,
      latencyMs: Date.now() - startedAt,
      ok: false,
      errorKind: kind,
      attempt,
    });

    // The unskippable gate. A pre-flight check at the top of a pulse cannot stop
    // a 12-turn agent loop that goes over budget on turn 8, because by then the
    // decision to run has already been made. Checking here — inside the HTTP
    // boundary, before every request — is the only placement a runaway loop
    // cannot route around. `interactive` short-circuits before any DB work, so
    // a reply never pays for this.
    const lane = currentLlmContext().lane;
    await assertWithinBudget(lane);

    let lastError: Error = new Error('OpenAI: no attempt was made');

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const started = Date.now();
      let response: Response;

      try {
        response = await fetch(`${API_URL}/responses`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey()}`,
            'content-type': 'application/json',
          },
          body: payload,
          signal,
        });
      } catch (err) {
        // An abort is terminal either way, but for different reasons: the
        // caller cancelling is not our failure, and the timeout budget being
        // spent means there is nothing left to retry into.
        if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
          meter(attempt, started, errorKind(null, timeout.signal.aborted));
          throw err;
        }
        // A fetch-level TypeError is DNS/socket/TLS — transient far more often
        // than not on a home network, and the case notion-client.ts does not
        // cover. Worth a retry.
        meter(attempt, started, 'network');
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < MAX_ATTEMPTS && !signal.aborted) {
          await backoffSleep(backoffMs(null, attempt), signal);
          continue;
        }
        throw lastError;
      }

      // Retryable server-side conditions. Metered per attempt, so retry
      // pressure shows up as rows rather than as an invisible slowdown.
      if (response.status === 429 || response.status >= 500) {
        meter(attempt, started, errorKind(response.status, false));
        const detail = (await response.text()).slice(0, 500);
        lastError = new Error(`OpenAI ${response.status}: ${detail}`);
        if (attempt < MAX_ATTEMPTS && !signal.aborted) {
          await backoffSleep(backoffMs(response, attempt), signal);
          continue;
        }
        throw lastError;
      }

      const text = await response.text();

      // Any other 4xx is deterministic — a malformed input array fails
      // identically four times, just four times slower. Fail fast.
      if (!response.ok) {
        meter(attempt, started, errorKind(response.status, false));
        throw new Error(`OpenAI ${response.status}: ${text.slice(0, 500)}`);
      }

      let parsed: OpenAIResponse;
      try {
        parsed = JSON.parse(text) as OpenAIResponse;
      } catch {
        meter(attempt, started, 'non-json');
        throw new Error(`OpenAI returned non-JSON response: ${text.slice(0, 200)}`);
      }

      // `usage` has been on this interface since the adapter was written and was
      // never read, so the bot had no idea what it spent. Reasoning tokens are
      // already counted inside output_tokens — recorded separately for
      // visibility, never added again when pricing.
      const u = (parsed.usage ?? {}) as Record<string, unknown>;
      const inDetails = (u.input_tokens_details ?? {}) as Record<string, unknown>;
      const outDetails = (u.output_tokens_details ?? {}) as Record<string, unknown>;
      recordLlmUsage({
        provider: 'openai',
        model: opts.model,
        inputTokens: num(u.input_tokens),
        cachedInputTokens: num(inDetails.cached_tokens),
        outputTokens: num(u.output_tokens),
        reasoningTokens: num(outDetails.reasoning_tokens),
        latencyMs: Date.now() - started,
        ok: true,
        attempt,
      });
      return parsed;
    }

    throw lastError;
  } finally {
    clearTimeout(timer);
  }
}

export function openAITextFromResponse(response: OpenAIResponse): string {
  if (typeof response.output_text === 'string' && response.output_text.trim()) {
    return response.output_text.trim();
  }
  const texts: string[] = [];
  for (const item of response.output || []) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content as Array<Record<string, unknown>>) {
      if (part.type === 'output_text' && typeof part.text === 'string') texts.push(part.text);
    }
  }
  return texts.join('\n').trim();
}

export interface OpenAIFunctionCall {
  type: 'function_call';
  name: string;
  arguments: string;
  call_id: string;
  [key: string]: unknown;
}

export function openAIFunctionCalls(response: OpenAIResponse): OpenAIFunctionCall[] {
  return (response.output || []).filter(
    (item): item is OpenAIFunctionCall =>
      item.type === 'function_call' &&
      typeof item.name === 'string' &&
      typeof item.arguments === 'string' &&
      typeof item.call_id === 'string',
  );
}

export function toOpenAIFunctionTool(definition: {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    type: 'function',
    name: definition.name,
    description: definition.description || '',
    parameters: definition.input_schema,
    strict: false,
  };
}

export function toolOutputToOpenAI(output: unknown): string | Array<Record<string, unknown>> {
  if (!Array.isArray(output)) {
    return typeof output === 'string' ? output : JSON.stringify(output);
  }

  const parts: Array<Record<string, unknown>> = [];
  for (const block of output as Array<Record<string, unknown>>) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push({ type: 'input_text', text: block.text });
      continue;
    }
    if (block.type === 'image') {
      const source = block.source as Record<string, unknown> | undefined;
      if (source?.type === 'base64' && typeof source.data === 'string') {
        const mediaType = typeof source.media_type === 'string' ? source.media_type : 'image/jpeg';
        parts.push({ type: 'input_image', image_url: `data:${mediaType};base64,${source.data}` });
        continue;
      }
    }
    parts.push({ type: 'input_text', text: JSON.stringify(block) });
  }
  return parts.length ? parts : 'Done (no output).';
}

export async function openAIText(opts: {
  model: string;
  system?: string;
  prompt: string;
  maxOutputTokens?: number;
  reasoningEffort?: OpenAIResponseOptions['reasoningEffort'];
  signal?: AbortSignal;
}): Promise<string> {
  const response = await createOpenAIResponse({
    model: opts.model,
    instructions: opts.system,
    input: opts.prompt,
    maxOutputTokens: opts.maxOutputTokens,
    reasoningEffort: opts.reasoningEffort,
    signal: opts.signal,
  });
  return openAITextFromResponse(response);
}
