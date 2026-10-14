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
import { getProfileConfig } from './config.js';
import { similarOpenTask } from './lib/task-dedupe.js';
import dbh from './db.js';

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
  /** Someone else in the recording (a partner talking about their own work) talking about THEIR life: kept as facts about them. */
  others?: Array<{ person: string; text: string }>;
  /** Useful things the owner watched or listened to (tutorials, reviews, talks), kept to look up later. */
  watched?: Array<{ source?: string; topic: string; takeaways: string[] }>;
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
      // TV/YouTube the desktop app overheard (Omi tags it "entertainment"): nothing of the owner's in it.
      discarded: c.discarded === true || str(s.category) === 'entertainment',
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

/**
 * Who lives with the owner, and what's known about their work, so a recording where a
 * partner talks about THEIR job isn't filed as the owner's (Omi sometimes labels another
 * household voice as the user; their colleagues became the owner's contacts and their
 * follow-ups became the owner's tasks).
 */
export function householdContext(): string {
  let members: string[] = [];
  try { members = (getProfileConfig().members ?? []).map((m) => (m as { name?: string }).name ?? '').filter(Boolean); } catch { /* no profile */ }
  if (!members.length) return '';
  const db = dbh as unknown as { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } };
  const lines = members.map((name) => {
    const first = name.split(/\s+/)[0].toLowerCase();
    const known = db.prepare(`SELECT predicate, object FROM facts WHERE active = 1 AND (lower(subject) = ? OR lower(subject) LIKE ?) AND (predicate LIKE 'work%' OR predicate LIKE '%colleague%' OR predicate LIKE 'job%') ORDER BY id DESC LIMIT 4`)
      .all(name.toLowerCase(), `${first} %`) as Array<{ predicate: string; object: string }>;
    return `- ${name}${known.length ? `: ${known.map((k) => `${k.predicate}: ${k.object}`).join('; ').slice(0, 300)}` : ''}`;
  });
  return `\nPeople who live with the owner (their voices are often in these recordings, and Omi sometimes labels them as the owner):\n${lines.join('\n')}\n`;
}

/** "Alex" → the full name on their contact record ("alex rivera"), so facts stay on one person. */
function fullName(name: string): string {
  const n = name.trim().toLowerCase();
  if (n.includes(' ')) return n;
  const db = dbh as unknown as { prepare: (s: string) => { get: (...a: unknown[]) => unknown } };
  const row = db.prepare(`SELECT name FROM people WHERE lower(name) LIKE ? ORDER BY id LIMIT 1`).get(`${n} %`) as { name?: string } | undefined;
  return (row?.name ?? n).toLowerCase();
}

export function extractPrompt(card: OmiCard, transcript: string, today: string): string {
  return `This is one conversation Omi recorded on the owner's phone/computer ("${card.title}"${card.when ? `, ${card.when}` : ''}). In the transcript the owner is the speaker marked as the user (is_user true / "You" / "user"); everyone else is someone they were talking to, or audio around them (TV, podcast, video, a call on speaker).${householdContext()}
Reply with JSON only, no prose.

{
  "commitments": [{"counterpart": "who they promised", "text": "what THE OWNER said they'd do"}],
  "todos": [{"title": "a concrete thing THE OWNER must do", "due": "YYYY-MM-DD or null"}],
  "people": [{"name": "a real person they actually talked with or about", "note": "one short line on what they discussed"}],
  "decisions": [{"subject": "topic", "text": "what was decided"}],
  "others": [{"person": "full name of the household member (or other named speaker)", "text": "what they said about THEIR own work or life worth remembering: colleagues, projects, goals, worries, events"}],
  "watched": [{"source": "what it was, e.g. 'YouTube interview on gel-supported 3D printing'", "topic": "2-5 word subject", "takeaways": ["specific point, number, name, product or how-to step worth remembering"]}]
}

Rules:
- WHO IS SPEAKING: if the main speaker is clearly someone else, even when Omi labels them as the user (e.g. a partner on a call with THEIR boss about THEIR team, goals and colleagues), it is NOT the owner's: put it under "others" with that person's name and leave commitments/todos/people/decisions empty for those parts. Their colleagues are not the owner's contacts; their follow-ups are not the owner's tasks.
- commitments/todos/people/decisions: only what the owner themselves said or agreed to, about their own life and work. Skip promises made to them, and anything from media, ads, or background audio.
- watched: the one exception for media. When the audio is something USEFUL the owner watched or listened to (a tutorial, how-to, product or film review, product demo, talk, interview, lecture, news analysis), add one item per piece with 2-6 concrete takeaways they could want to look up later. NEVER for TV shows, movies, dramas, sketches, comedy, music or ads: skip those entirely.
- todos: ONLY when the owner explicitly commits to or asks for a reminder about a real errand or piece of work ("remind me to…", "I need to call…", "I'll send the deck Friday"). NEVER household moment-to-moment instructions or chores said in passing (shower, floss, laundry, "get it over there", "put that back"), things said to or about a child, or things someone else will do. Resolve relative dates against today (${today}); no date → null. If in doubt, leave it out: most conversations have zero todos.
- people: real names only. Skip the owner, celebrities, and people only heard on media.
- Omit any empty section. If nothing durable happened (small talk, a show or movie playing), reply {}.

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
    if (similarOpenTask(t.title)) continue; // heard again in another recording: already on the list
    const due = t.due && /^\d{4}-\d{2}-\d{2}$/.test(t.due) ? t.due : undefined;
    const id = createTask({ title: t.title.trim(), group_id: 'admin', assignee: 'owner', due_date: due, source: 'omi', source_ref: ref, sync_to_google: true, notes: `From a conversation Omi recorded: ${card.title}` });
    const task = getTaskById(id);
    if (task) deps.pushTask(task).catch((err) => log(`google task push failed: ${err}`));
    out.tasks++;
  }
  for (const o of parsed.others ?? []) {
    if (!o.person?.trim() || !o.text?.trim()) continue;
    saveFact({ subject: fullName(o.person), predicate: 'said (recorded)', object: o.text.trim(), fact_type: 'fact', source: 'omi', source_ref: ref, sensitive: true });
    out.facts++;
  }
  for (const w of parsed.watched ?? []) {
    const points = (w.takeaways ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 6);
    if (!w.topic?.trim() || !points.length) continue;
    // Not personal, so not sensitive: "what was that 3D printing video?" should find it.
    saveFact({ subject: w.topic.trim().toLowerCase(), predicate: `watched: ${(w.source || card.title).trim().slice(0, 120)}`, object: points.join('; '), fact_type: 'reference', source: 'omi-media', source_ref: ref, sensitive: false });
    out.facts++;
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
