// Claude provider tests: request/response translation and provider selection.
// A stub client stands in for the Anthropic SDK, so nothing touches the network.
//   npm run test:claude-provider
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'dialzero-claude-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.LLM_BUDGET_ENFORCED = 'false';
process.env.OPENAI_ROUTER_MODEL = 'gpt-5.6-luna';
delete process.env.CLAUDE_MODEL;
delete process.env.CLAUDE_FAST_MODEL;

const claude = await import('../src/lib/anthropic.js');
const openai = await import('../src/lib/openai.js');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

type Call = Record<string, unknown>;
const calls: Call[] = [];
let replies: Array<Record<string, unknown>> = [];
claude.setClaudeClientForTests({
  beta: {
    messages: {
      create: async (params: Call) => {
        calls.push(JSON.parse(JSON.stringify(params)));
        const next = replies.shift();
        if (!next) throw new Error('stub: no reply queued');
        return { id: `msg_${calls.length}`, model: params.model, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0 }, ...next };
      },
    },
  },
});

function useClaude() {
  process.env.LLM_PROVIDER = 'claude';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  delete process.env.OPENAI_API_KEY;
}

try {
  await check('provider: explicit choice wins, otherwise whichever key exists (OpenAI if both)', () => {
    const saved = { ...process.env };
    process.env.LLM_PROVIDER = 'openai'; process.env.ANTHROPIC_API_KEY = 'x'; delete process.env.OPENAI_API_KEY;
    assert.equal(openai.llmProvider(), 'openai');
    assert.equal(openai.llmConfigured(), false);
    delete process.env.LLM_PROVIDER;
    assert.equal(openai.llmProvider(), 'claude');
    process.env.OPENAI_API_KEY = 'y';
    assert.equal(openai.llmProvider(), 'openai');
    process.env.LLM_PROVIDER = 'claude';
    assert.equal(openai.llmProvider(), 'claude');
    assert.equal(openai.llmConfigured(), true);
    for (const k of ['LLM_PROVIDER', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  await check('model mapping: router names go to Haiku, everything else to Opus 5, claude-* passes through', () => {
    const fast = ['gpt-5.6-luna'];
    assert.equal(claude.claudeModelFor('gpt-5.6-luna', fast), 'claude-haiku-4-5');
    assert.equal(claude.claudeModelFor('gpt-5.6-terra', fast), 'claude-opus-5');
    assert.equal(claude.claudeModelFor('claude-sonnet-5', fast), 'claude-sonnet-5');
  });

  await check('input translation: images, PDFs, tool results merge into one user turn, Claude turns replay exactly', () => {
    const raw = [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'tool_use', id: 'tu_1', name: 'list_events', input: {} }, { type: 'tool_use', id: 'tu_2', name: 'list_tasks', input: {} }];
    const msgs = claude.toClaudeMessages([
      { role: 'user', content: [
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
        { type: 'input_file', filename: 'a.pdf', file_data: 'data:application/pdf;base64,BBBB' },
        { type: 'input_text', text: 'what is on today?' },
      ] },
      { type: 'message', role: 'assistant', content: [], _claude: raw },
      { type: 'function_call', name: 'list_events', call_id: 'tu_1', arguments: '{}', _claude_part: true },
      { type: 'function_call', name: 'list_tasks', call_id: 'tu_2', arguments: '{}', _claude_part: true },
      { type: 'function_call_output', call_id: 'tu_1', output: 'Dentist 3pm' },
      { type: 'function_call_output', call_id: 'tu_2', output: [{ type: 'input_text', text: '2 tasks' }] },
    ]) as Array<{ role: string; content: Array<Record<string, any>> }>;
    assert.equal(msgs.length, 3);
    assert.deepEqual(msgs[0].content.map((b) => b.type), ['image', 'document', 'text']);
    assert.equal(msgs[0].content[0].source.media_type, 'image/png');
    assert.equal(msgs[0].content[1].source.media_type, 'application/pdf');
    assert.deepEqual(msgs[1].content, raw, 'assistant turn (incl. thinking) replayed verbatim');
    assert.equal(msgs[2].role, 'user');
    assert.deepEqual(msgs[2].content.map((b) => b.tool_use_id), ['tu_1', 'tu_2'], 'parallel results in ONE user message');
    assert.deepEqual(msgs[2].content[1].content, [{ type: 'text', text: '2 tasks' }]);
  });

  await check('tools: function tools convert; hosted web search maps per model', () => {
    const fn = { type: 'function', name: 'save_fact', description: 'd', parameters: { type: 'object', properties: { a: { type: 'string' } } } };
    const opus = claude.toClaudeTools([fn, { type: 'web_search' }], 'claude-opus-5');
    assert.deepEqual(opus[0], { name: 'save_fact', description: 'd', input_schema: fn.parameters });
    assert.equal(opus[1].type, 'web_search_20260209');
    assert.equal(claude.toClaudeTools([{ type: 'web_search' }], 'claude-haiku-4-5')[0].type, 'web_search_20250305');
  });

  await check('agent turn: tool_use comes back as function calls; next turn replays thinking + sends results', async () => {
    useClaude();
    calls.length = 0;
    replies = [
      { stop_reason: 'tool_use', content: [
        { type: 'thinking', thinking: '', signature: 's1' },
        { type: 'text', text: 'Checking.' },
        { type: 'tool_use', id: 'toolu_1', name: 'list_events', input: { day: 'today' } },
      ] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Dentist at 3.' }] },
    ];
    const input: unknown[] = [{ role: 'user', content: [{ type: 'input_text', text: "what's today?" }] }];
    const tools = [{ type: 'function', name: 'list_events', description: 'x', parameters: { type: 'object', properties: {} } }];
    const r1 = await openai.createOpenAIResponse({ model: 'gpt-5.6-terra', instructions: 'You are an assistant.', input, tools, reasoningEffort: 'low' });
    const fcs = openai.openAIFunctionCalls(r1);
    assert.equal(fcs.length, 1);
    assert.equal(fcs[0].call_id, 'toolu_1');
    assert.deepEqual(JSON.parse(fcs[0].arguments), { day: 'today' });
    const first = calls[0] as Record<string, any>;
    assert.equal(first.model, 'claude-opus-5');
    assert.deepEqual(first.output_config, { effort: 'low' });
    assert.equal(first.fallbacks, 'default');
    assert.deepEqual(first.betas, ['server-side-fallback-2026-07-01']);
    assert.equal(first.system[0].text, 'You are an assistant.');
    assert.ok(first.max_tokens >= 16000);

    input.push(...(r1.output || []));
    input.push({ type: 'function_call_output', call_id: 'toolu_1', output: 'Dentist 3pm' });
    const r2 = await openai.createOpenAIResponse({ model: 'gpt-5.6-terra', input, tools });
    assert.equal(openai.openAITextFromResponse(r2), 'Dentist at 3.');
    const second = calls[1] as Record<string, any>;
    assert.equal(second.messages[1].role, 'assistant');
    assert.equal(second.messages[1].content[0].type, 'thinking', 'thinking block replayed');
    assert.equal(second.messages[2].content[0].type, 'tool_result');
  });

  await check('quick calls use Haiku with no effort, thinking, or fallback settings', async () => {
    useClaude();
    calls.length = 0;
    replies = [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'sync' }] }];
    const out = await openai.openAIText({ model: 'gpt-5.6-luna', prompt: 'classify', maxOutputTokens: 8, reasoningEffort: 'none' });
    assert.equal(out, 'sync');
    const p = calls[0] as Record<string, any>;
    assert.equal(p.model, 'claude-haiku-4-5');
    assert.equal(p.output_config, undefined);
    assert.equal(p.fallbacks, undefined);
    assert.equal(p.thinking, undefined);
  });

  await check('web search: a paused turn is resumed, citations become url annotations', async () => {
    useClaude();
    calls.length = 0;
    replies = [
      { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 'srv_1', name: 'web_search', input: { query: 'x' } }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Open 9-5.', citations: [{ type: 'web_search_result_location', url: 'https://example.com/hours', title: 'Hours' }] }] },
    ];
    const res = await openai.createOpenAIResponse({ model: 'gpt-5.6-luna', input: 'hours?', tools: [{ type: 'web_search' }] });
    assert.equal(calls.length, 2, 'resumed once');
    assert.equal((calls[1] as any).messages.at(-1).role, 'assistant');
    const part = (res.output?.[0].content as Array<Record<string, any>>)[0];
    assert.equal(part.text, 'Open 9-5.');
    assert.equal(part.annotations[0].url, 'https://example.com/hours');
  });

  await check('a refusal with no text still gives the owner a plain reply', async () => {
    useClaude();
    replies = [{ stop_reason: 'refusal', content: [] }];
    const res = await openai.createOpenAIResponse({ model: 'gpt-5.6-terra', input: 'x' });
    assert.match(openai.openAITextFromResponse(res), /can't help/);
  });

  console.log(`\nClaude provider tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
