// Omi → the brain. Omi (phone, desktop, or the wearable) records what the
// owner says and hears. Every OMI_SYNC_INTERVAL_MIN this pulls the conversations
// Omi has finished since the last pass, reads each transcript, and keeps the
// durable parts — the same shape the iMessage reader writes:
//   promises the owner made   → commitment facts (Brain Pulse surfaces them)
//   their dated to-dos        → tasks (the morning brief surfaces them)
//   people they talked with   → people + an interaction (keeps "last contact" true)
//   decisions                 → decision facts
// Everything from Omi is saved as owner-private (sensitive), so none of it can
// reach a shared or family chat. Omi's own to-do list is ignored on purpose:
// one extractor means one copy of each task. Nothing here texts the owner.
// On-demand lookups ("what did I tell Alex yesterday?") go through the Omi
// connector the agent has (mcp-servers.json → registry key "omi", read-only).

import { join } from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { saveFact, upsertPerson, addInteraction, createTask, getTaskById, getMemory, setMemory } from './db.js';
import { pushTaskToGoogle } from './sync/tasks-sync.js';
import { extractFirstJson, extractionComplete, makeLogger } from './lib/daemon.js';
import { parseBoolEnv, parseNumEnv, parseStrEnv } from './lib/env.js';
import { OPENAI_MODEL } from './lib/openai.js';

const OMI_URL = 'https://api.omi.me/v1/mcp';
const MEM_GROUP = 'omi';
const SEEN_KEY = 'seen_conversations';
const SEEN_MAX = 1000;
const TRANSCRIPT_CHARS = 14_000;
const log = makeLogger(process.env.OMI_SYNC_LOG || join(process.cwd(), 'logs', 'omi-sync.log'), false);

export interface OmiCard { id: string; title: string; when: string; discarded: boolean }
export interface OmiExtract {
  commitments?: Array<{ counterpart?: string; text: string }>;
  todos?: Array<{ title: string; due?: string | null }>;
  people?: Array<{ name: string; note?: string }>;
  decisions?: Array<{ subject?: string; text: string }>;
}

export interface OmiDeps {
  call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  extract: (prompt: string) => Promise<string>;
  now: () => number;
  pushTask: (task: NonNullable<ReturnType<typeof getTaskById>>) => Promise<void>;
}

let client: Client | null = null;
async function omiCall(tool: string, args: Record<string, unknown>): Promise<string> {
  if (!client) {
    const key = process.env.OMI_MCP_KEY?.trim();
    if (!key) throw new Error('OMI_MCP_KEY is not set');
    const c = new Client({ name: 'assistant-omi-sync', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(OMI_URL), { requestInit: { headers: { Authorization: `Bearer ${key}` } } }));
    client = c;
  }
  try {
    const r = await client.callTool({ name: tool, arguments: args });
    return (r.content as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
  } catch (err) {
    // A dropped session reconnects on the next call.
    try { await client.close(); } catch { /* already gone */ }
    client = null;
    throw err;
  }
}

const defaultDeps: OmiDeps = {
  call: omiCall,
  extract: (prompt) => extractionComplete({ prompt, maxTokens: 1500, openaiModel: parseStrEnv('OPENAI_MODEL', OPENAI_MODEL), log, caller: 'omi-sync' }),
  now: () => Date.now(),
  pushTask: pushTaskToGoogle,
};
let deps = defaultDeps;
export function setOmiDeps(over: Partial<OmiDeps> | null): void { deps = over ? { ...defaultDeps, ...over } : defaultDeps; }

const ymd = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Conversation cards from get_conversations, whatever field names Omi uses. */
export function parseCards(text: string): OmiCard[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return []; }
  const list = (data as { conversations?: unknown[] })?.conversations;
  if (!Array.isArray(list)) return [];
  return list.flatMap((raw) => {
    const c = raw as Record<string, unknown>;
    const s = (c.structured ?? {}) as Record<string, unknown>;
    const id = str(c.id) || str(c.conversation_id);
    if (!id) return [];
    return [{
      id,
      title: str(c.title) || str(s.title) || 'a conversation',
      when: str(c.finished_at) || str(c.started_at) || str(c.created_at) || '',
      discarded: c.discarded === true,
    }];
  });
}

function seenIds(): string[] {
  try { return JSON.parse(getMemory(MEM_GROUP, SEEN_KEY) ?? '[]') as string[]; } catch { return []; }
}
function markSeen(ids: string[]): void {
  const all = [...seenIds(), ...ids];
  setMemory(MEM_GROUP, SEEN_KEY, JSON.stringify(all.slice(-SEEN_MAX)));
}

export function extractPrompt(card: OmiCard, transcript: string, today: string): string {
  return `This is one conversation Omi recorded on the owner's phone/computer ("${card.title}"${card.when ? `, ${card.when}` : ''}). In the transcript the owner is the speaker marked as the user (is_user true / "You" / "user"); everyone else is someone they were talking to, or audio around them (TV, podcast, video, a call on speaker). Reply with JSON only, no prose.

{
  "commitments": [{"counterpart": "who they promised", "text": "what THE OWNER said they'd do"}],
  "todos": [{"title": "a concrete thing THE OWNER must do", "due": "YYYY-MM-DD or null"}],
  "people": [{"name": "a real person they actually talked with or about", "note": "one short line on what they discussed"}],
  "decisions": [{"subject": "topic", "text": "what was decided"}]
}

Rules:
- Only what the owner themselves said or agreed to. Skip promises made to them, and skip anything from media, ads, or background audio.
- todos: only clear, real tasks the owner must do ("I'll send the deck Friday"). Resolve relative dates against today (${today}); no date → null. If in doubt, leave it out.
- people: real names only. Skip the owner, celebrities, and people only heard on media.
- Omit any empty section. If nothing durable happened (small talk, a show playing), reply {}.

TRANSCRIPT:
${transcript.slice(0, TRANSCRIPT_CHARS)}`;
}

export function writeBack(parsed: OmiExtract, card: OmiCard): { facts: number; tasks: number; people: number } {
  const ref = `omi:${card.id}`;
  const at = card.when || new Date(deps.now()).toISOString();
  const out = { facts: 0, tasks: 0, people: 0 };
  for (const c of parsed.commitments ?? []) {
    if (!c.text?.trim()) continue;
    saveFact({ subject: (c.counterpart || 'omi').trim() || 'omi', predicate: 'promised', object: c.text.trim(), fact_type: 'commitment', source: 'omi', source_ref: ref, sensitive: true });
    out.facts++;
  }
  for (const d of parsed.decisions ?? []) {
    if (!d.text?.trim()) continue;
    saveFact({ subject: (d.subject || 'omi').trim() || 'omi', predicate: 'decided', object: d.text.trim(), fact_type: 'decision', source: 'omi', source_ref: ref, sensitive: true });
    out.facts++;
  }
  for (const t of parsed.todos ?? []) {
    if (!t.title?.trim()) continue;
    const due = t.due && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : undefined;
    const id = createTask({ title: t.title.trim(), group_id: 'admin', assignee: 'owner', due_date: due, source: 'omi', source_ref: ref, sync_to_google: true, notes: `From a conversation Omi recorded: ${card.title}` });
    const task = getTaskById(id);
    if (task) deps.pushTask(task).catch((err) => log(`google task push failed: ${err}`));
    out.tasks++;
  }
  for (const p of parsed.people ?? []) {
    if (!p.name?.trim()) continue;
    const personId = upsertPerson({ name: p.name.trim() });
    addInteraction({ person_id: personId, channel: 'in-person', summary: (p.note || card.title).slice(0, 200), ref, occurred_at: at });
    out.people++;
  }
  return out;
}

/** One pass. Returns how many conversations were read. */
export async function omiSyncTick(): Promise<number> {
  const now = deps.now();
  const cards: OmiCard[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const text = await deps.call('get_conversations', { start_date: ymd(now - 2 * 86_400_000), end_date: ymd(now + 86_400_000), limit: 50, ...(cursor ? { cursor } : {}) });
    cards.push(...parseCards(text));
    try { cursor = (JSON.parse(text) as { next_cursor?: string }).next_cursor || undefined; } catch { cursor = undefined; }
    if (!cursor) break;
  }
  const seen = new Set(seenIds());
  const fresh = cards.filter((c) => !seen.has(c.id));
  if (!fresh.length) return 0;
  const skip = fresh.filter((c) => c.discarded).map((c) => c.id);
  if (skip.length) markSeen(skip);
  let read = 0;
  for (const card of fresh.filter((c) => !c.discarded)) {
    const transcript = await deps.call('get_conversation_by_id', { conversation_id: card.id, max_chars: TRANSCRIPT_CHARS });
    const reply = await deps.extract(extractPrompt(card, transcript, ymd(now)));
    const json = extractFirstJson(reply, '{', '}');
    if (!json) { log(`${card.id}: no JSON from the extractor; will retry next pass`); continue; }
    let parsed: OmiExtract;
    try { parsed = JSON.parse(json) as OmiExtract; } catch { log(`${card.id}: unreadable JSON; will retry next pass`); continue; }
    const counts = writeBack(parsed, card);
    markSeen([card.id]);
    read++;
    log(`${card.id} "${card.title}": ${JSON.stringify(counts)}`);
  }
  setMemory(MEM_GROUP, 'omi-sync_last_tick', new Date(now).toISOString());
  return read;
}

let running = false;
export function startOmiSync(): void {
  if (!parseBoolEnv('OMI_SYNC_ENABLED', true) || !process.env.OMI_MCP_KEY?.trim()) {
    console.log('[omi-sync] off (set OMI_MCP_KEY to enable)');
    return;
  }
  const everyMs = parseNumEnv('OMI_SYNC_INTERVAL_MIN', 15) * 60_000;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await omiSyncTick(); } catch (err) { log(`tick failed: ${err instanceof Error ? err.message : err}`); } finally { running = false; }
  };
  setTimeout(tick, 60_000);
  setInterval(tick, everyMs);
  console.log(`[omi-sync] reading new Omi conversations every ${everyMs / 60_000} min`);
}
