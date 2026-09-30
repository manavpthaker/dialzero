// Claude as the assistant's model. The rest of the code speaks one request/
// response shape (the Responses-style items in lib/openai.ts: `input` items in,
// `output` items out, function_call / function_call_output for tools). This file
// translates that shape to Claude's Messages API and back, so the agent loop,
// router, planner, daemons and web search run on Claude without their own
// Claude branch.
//
// Claude's own content (thinking blocks, server-tool blocks) is carried on the
// output items under `_claude` and replayed verbatim on the next turn, which is
// what the Messages API requires for multi-turn tool use with thinking on.

import Anthropic from '@anthropic-ai/sdk';
import { parseNumEnv, parseStrEnv } from './env.js';
import { recordLlmUsage } from './llm-usage.js';
import { assertWithinBudget } from './token-budget.js';
import { currentLlmContext } from './llm-context.js';
import type { OpenAIResponse, OpenAIResponseOptions } from './openai.js';

/** Main model: the agent loop, briefs, anything that needs judgment. */
export const CLAUDE_MODEL = parseStrEnv('CLAUDE_MODEL', 'claude-opus-5');
/** Quick model: classification, retrieval planning, pre-filters, web search. */
export const CLAUDE_FAST_MODEL = parseStrEnv('CLAUDE_FAST_MODEL', 'claude-haiku-4-5');

const TIMEOUT_MS = parseNumEnv('ANTHROPIC_TIMEOUT_MS', 120_000);
const MAX_RETRIES = parseNumEnv('ANTHROPIC_MAX_RETRIES', 3);
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Server-tool turns can pause mid-search; resume at most this many times. */
const MAX_PAUSE_RESUMES = 4;

let client: Anthropic | null = null;
function claude(): Anthropic {
  if (!client) client = new Anthropic({ timeout: TIMEOUT_MS, maxRetries: MAX_RETRIES });
  return client;
}

/** Test seam: swap the client for a stub so tests never hit the network. */
export function setClaudeClientForTests(stub: unknown): void {
  client = stub as Anthropic;
}

/**
 * Callers name OpenAI models (the router model, the main model). Map them onto
 * the two Claude models: the router/"fast" name goes to the quick model, any
 * explicit claude-* name passes through, everything else is the main model.
 */
export function claudeModelFor(requested: string, fastNames: string[]): string {
  if (requested.startsWith('claude-')) return requested;
  return fastNames.includes(requested) ? CLAUDE_FAST_MODEL : CLAUDE_MODEL;
}

function isHaiku(model: string): boolean {
  return model.startsWith('claude-haiku');
}

// ── input translation ────────────────────────────────────────────────────────

type Block = Record<string, unknown>;
type Msg = { role: 'user' | 'assistant'; content: Block[] };

function dataUrlParts(url: string): { mediaType: string; data: string } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  return m ? { mediaType: m[1], data: m[2] } : null;
}

/** One Responses-style content part → a Claude content block (or null to drop it). */
function partToBlock(part: Block): Block | null {
  const type = part.type;
  if ((type === 'input_text' || type === 'output_text' || type === 'text') && typeof part.text === 'string') {
    return part.text.trim() ? { type: 'text', text: part.text } : null;
  }
  if (type === 'input_image' && typeof part.image_url === 'string') {
    const d = dataUrlParts(part.image_url);
    return d
      ? { type: 'image', source: { type: 'base64', media_type: d.mediaType, data: d.data } }
      : { type: 'image', source: { type: 'url', url: part.image_url } };
  }
  if (type === 'input_file' && typeof part.file_data === 'string') {
    const d = dataUrlParts(part.file_data);
    return d ? { type: 'document', source: { type: 'base64', media_type: d.mediaType, data: d.data } } : null;
  }
  return null;
}

function contentToBlocks(content: unknown): Block[] {
  if (typeof content === 'string') return content.trim() ? [{ type: 'text', text: content }] : [];
  if (!Array.isArray(content)) return [];
  return (content as Block[]).map(partToBlock).filter((b): b is Block => b !== null);
}

function toolResultContent(output: unknown): string | Block[] {
  if (typeof output === 'string') return output || '(no output)';
  const blocks = contentToBlocks(output);
  return blocks.length ? blocks : '(no output)';
}

/**
 * Responses-style input (a string, or a list of role messages / output items /
 * function_call_output items) → Claude messages. Consecutive same-role turns are
 * merged, and each assistant turn that came from Claude is replayed exactly.
 */
export function toClaudeMessages(input: unknown): Msg[] {
  const messages: Msg[] = [];
  const push = (role: Msg['role'], blocks: Block[]) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: [...blocks] });
  };

  if (typeof input === 'string') {
    push('user', [{ type: 'text', text: input }]);
    return messages;
  }
  for (const raw of (Array.isArray(input) ? input : []) as Block[]) {
    if (raw._claude_part) continue; // its content rides on the item that carries _claude
    if (Array.isArray(raw._claude)) {
      push('assistant', raw._claude as Block[]);
      continue;
    }
    if (raw.type === 'function_call_output') {
      push('user', [{ type: 'tool_result', tool_use_id: String(raw.call_id), content: toolResultContent(raw.output) }]);
      continue;
    }
    if (raw.type === 'function_call') {
      let args: unknown = {};
      try { args = JSON.parse(String(raw.arguments || '{}')); } catch { /* keep {} */ }
      push('assistant', [{ type: 'tool_use', id: String(raw.call_id), name: String(raw.name), input: args }]);
      continue;
    }
    if (raw.type === 'reasoning') continue; // another provider's reasoning; nothing to replay
    const role = raw.role === 'assistant' || raw.type === 'message' ? 'assistant' : 'user';
    push(role, contentToBlocks(raw.content));
  }
  // The Messages API needs a user turn first.
  if (messages[0]?.role === 'assistant') messages.unshift({ role: 'user', content: [{ type: 'text', text: '(continuing)' }] });
  return messages;
}

/** Responses-style tool list → Claude tools. The hosted web_search maps to Claude's server tool. */
export function toClaudeTools(tools: unknown[] | undefined, model: string): Block[] {
  const out: Block[] = [];
  for (const t of (tools ?? []) as Block[]) {
    if (t.type === 'function' && typeof t.name === 'string') {
      out.push({ name: t.name, description: String(t.description ?? ''), input_schema: (t.parameters as Block) ?? { type: 'object', properties: {} } });
    } else if (t.type === 'web_search') {
      // Dynamic-filtering search on current Opus/Sonnet; the basic variant elsewhere.
      out.push(isHaiku(model)
        ? { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
        : { type: 'web_search_20260209', name: 'web_search', max_uses: 5 });
    }
  }
  return out;
}

// ── output translation ───────────────────────────────────────────────────────

/** Claude content → Responses-style output items (text message + function calls). */
export function fromClaudeContent(content: Block[], stopReason: string | null): OpenAIResponse['output'] {
  const texts: Block[] = [];
  const calls: Block[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      const annotations = ((block.citations as Block[] | undefined) ?? [])
        .filter((c) => typeof c.url === 'string')
        .map((c) => ({ type: 'url_citation', url: c.url, title: c.title }));
      texts.push({ type: 'output_text', text: block.text, annotations });
    } else if (block.type === 'tool_use') {
      calls.push({
        type: 'function_call',
        name: block.name,
        call_id: block.id,
        arguments: JSON.stringify(block.input ?? {}),
        _claude_part: true,
      });
    }
  }
  if (stopReason === 'refusal' && !texts.length) {
    texts.push({ type: 'output_text', text: "I can't help with that one.", annotations: [] });
  }
  return [
    { type: 'message', role: 'assistant', content: texts, _claude: content },
    ...calls,
  ];
}

function textOf(output: OpenAIResponse['output']): string {
  const out: string[] = [];
  for (const item of output ?? []) {
    for (const part of (Array.isArray(item.content) ? item.content : []) as Block[]) {
      if (part.type === 'output_text' && typeof part.text === 'string') out.push(part.text);
    }
  }
  return out.join('\n').trim();
}

// ── the call ─────────────────────────────────────────────────────────────────

/**
 * Same contract as createOpenAIResponse, served by Claude. `opts.model` is an
 * OpenAI name; `fastNames` says which names mean "the quick model".
 */
export async function createClaudeResponse(opts: OpenAIResponseOptions, fastNames: string[]): Promise<OpenAIResponse> {
  const model = claudeModelFor(opts.model, fastNames);
  const haiku = isHaiku(model);
  await assertWithinBudget(currentLlmContext().lane);

  const messages = toClaudeMessages(opts.input);
  const tools = toClaudeTools(opts.tools, model);
  // Thinking tokens count against max_tokens on the main model, so leave room.
  const maxTokens = haiku ? Math.max(opts.maxOutputTokens ?? 2000, 1024) : Math.max(opts.maxOutputTokens ?? 2000, 16_000);
  const effort = opts.reasoningEffort === 'none' ? 'low' : opts.reasoningEffort;

  const params: Record<string, unknown> = {
    model,
    max_tokens: maxTokens,
    messages,
    ...(opts.instructions ? { system: [{ type: 'text', text: opts.instructions, cache_control: { type: 'ephemeral' } }] } : {}),
    ...(tools.length ? { tools } : {}),
    // Haiku 4.5 takes no effort setting; the main model thinks adaptively by default.
    ...(!haiku && effort ? { output_config: { effort } } : {}),
    // On a policy decline, let the API re-run the request on a fallback model.
    ...(!haiku ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
  };

  const started = Date.now();
  let response: Anthropic.Beta.BetaMessage;
  const allContent: Block[] = [];
  try {
    const create = (p: Record<string, unknown>) => claude().beta.messages.create(
      p as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming,
      opts.signal ? { signal: opts.signal } : undefined,
    );
    response = await create(params);
    allContent.push(...(response.content as unknown as Block[]));
    // A long server-side web search can pause the turn; resume it with the
    // partial assistant content appended, as the API expects.
    for (let i = 0; response.stop_reason === 'pause_turn' && i < MAX_PAUSE_RESUMES; i++) {
      response = await create({ ...params, messages: [...messages, { role: 'assistant', content: allContent }] });
      allContent.push(...(response.content as unknown as Block[]));
    }
  } catch (err) {
    recordLlmUsage({
      provider: 'anthropic',
      model,
      latencyMs: Date.now() - started,
      ok: false,
      errorKind: err instanceof Anthropic.APIError && err.status ? (err.status === 429 ? '429' : err.status >= 500 ? '5xx' : '4xx')
        : err instanceof Error && err.name === 'AbortError' ? 'timeout' : 'network',
      attempt: 1,
    });
    throw err;
  }

  const usage = response.usage as unknown as Record<string, number | null | undefined>;
  recordLlmUsage({
    provider: 'anthropic',
    model: response.model || model,
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    latencyMs: Date.now() - started,
    ok: true,
    attempt: 1,
  });

  const output = fromClaudeContent(allContent, response.stop_reason);
  return { id: response.id, output, output_text: textOf(output), usage: usage as Record<string, unknown> };
}

/** True when this process should use Claude for the assistant's model calls. */
export function claudeSelected(): boolean {
  const choice = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
  if (choice === 'claude' || choice === 'anthropic') return true;
  if (choice === 'openai') return false;
  // Not chosen explicitly: use whichever key is present, preferring OpenAI when both are.
  return !process.env.OPENAI_API_KEY && Boolean(process.env.ANTHROPIC_API_KEY);
}
