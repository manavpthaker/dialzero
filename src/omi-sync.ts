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
import { saveFact, upsertPerson, addInteraction, createTask, getTaskById, getOpenTasks, getMemory, setMemory } from './db.js';
import { pushTaskToGoogle } from './sync/tasks-sync.js';
import { extractFirstJson, extractionComplete, makeLogger } from './lib/daemon.js';
import { parseBoolEnv, parseNumEnv, parseStrEnv } from './lib/env.js';
import { OPENAI_MODEL } from './lib/openai.js';
import { getProfileConfig } from './config.js';
import { similarOpenTask } from './lib/task-dedupe.js';
import dbh from './db.js';
import { withLlmContext } from './lib/llm-context.js';
import { compactTranscript, fingerprint, overlap, parseSegments, recordingQuality, wordCount, type Segment } from './lib/omi-transcript.js';
import { recordConversation, type TalkInfo } from './speech-coach.js';

const OMI_URL = 'https://api.omi.me/v1/mcp';
const MEM_GROUP = 'omi';
const SEEN_KEY = 'seen_conversations';
const SEEN_MAX = 1000;
const TRANSCRIPT_CHARS = 24_000;
// Omi keeps adding to a conversation, merges fragments and re-titles it for a while after
// it first shows up; reading at first sight lost the end of calls and spent 70% of reads on
// "Yeah." fragments that later vanished. Read only once it has been quiet this long.
const SETTLE_MIN = () => parseNumEnv('OMI_SETTLE_MIN', 45);
const MIN_WORDS = 25;
// A short recording that is only "remind me to call the dentist tomorrow" is still read.
const TODO_CUE = /\b(remind me|remember to|don'?t (let me )?forget|i (still )?(need|have|got) to|i gotta|i should|i'?ll|i will|i'?m going to|gonna|call|email|text|send|buy|order|pick up|drop off|return|book|schedule|pay|cancel|renew|follow up)\b/i;
const PRINTS_KEY = 'fingerprints';
const log = makeLogger(process.env.OMI_SYNC_LOG || join(process.cwd(), 'logs', 'omi-sync.log'), false);

export interface OmiCard { id: string; title: string; when: string; discarded: boolean; start?: string; end?: string }
export interface OmiExtract {
  commitments?: Array<{ counterpart?: string; text: string }>;
  todos?: Array<{ title: string; due?: string | null }>;
  people?: Array<{ name: string; note?: string }>;
  decisions?: Array<{ subject?: string; text: string }>;
  /** Someone else in the recording (a partner talking about their own work) talking about THEIR life: kept as facts about them. */
  others?: Array<{ person: string; text: string }>;
  /** Useful things the owner watched or listened to (tutorials, reviews, talks), kept to look up later. */
  watched?: Array<{ source?: string; topic: string; takeaways: string[] }>;
  /** Was the owner really talking with people, where, and with whom (feeds the speaking coach). */
  talk?: TalkInfo;
}

export interface OmiDeps {
  call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  extract: (prompt: string) => Promise<string>;
  now: () => number;
  pushTask: (task: NonNullable<ReturnType<typeof getTaskById>>) => Promise<void>;
}

let client: Client | null = null;
export async function omiCall(tool: string, args: Record<string, unknown>): Promise<string> {
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
      start: str(c.started_at) || str(c.created_at) || undefined,
      end: str(c.finished_at) || undefined,
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

/** Recent open tasks, so a call heard twice (or reworded) doesn't land on the owner's list twice. */
function onOwnersList(): string[] {
  try {
    const cutoff = Date.now() - 21 * 86_400_000;
    return getOpenTasks().filter((t) => Date.parse(`${t.created_at.replace(' ', 'T')}Z`) >= cutoff).slice(0, 40).map((t) => t.title);
  } catch { return []; }
}

/**
 * The contact a spoken name means. Omi only gives first names and upsertPerson matches on
 * email/phone/LinkedIn, so every recording made a new "Casey" (six in one week).
 * Full-name match, else the one person with that first name the owner has been in touch
 * with in the last 60 days (or who lives with them), else an earlier record with the bare name, else new.
 */
export function personIdFor(name: string): number {
  const n = name.trim();
  const low = n.toLowerCase();
  const q = dbh as unknown as { prepare: (s: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] } };
  if (low.includes(' ')) {
    const exact = q.prepare(`SELECT p.id FROM people p LEFT JOIN interactions i ON i.person_id = p.id WHERE lower(p.name) = ? GROUP BY p.id ORDER BY max(i.occurred_at) DESC, p.id LIMIT 1`).get(low) as { id: number } | undefined;
    return exact?.id ?? upsertPerson({ name: n });
  }
  let household: string[] = [];
  try { household = (getProfileConfig().members ?? []).map((m) => String((m as { name?: string }).name ?? '').toLowerCase()); } catch { /* no profile */ }
  const full = q.prepare(`SELECT lower(p.name) AS name, p.id, max(i.occurred_at) AS last FROM people p LEFT JOIN interactions i ON i.person_id = p.id
    WHERE lower(p.name) LIKE ? GROUP BY p.id ORDER BY last DESC`).all(`${low} %`) as Array<{ name: string; id: number; last: string | null }>;
  const recent = full.filter((r) => household.includes(low) || (r.last && Date.parse(`${r.last.replace(' ', 'T')}Z`) >= deps.now() - 60 * 86_400_000));
  if (new Set(recent.map((r) => r.name)).size === 1) return recent[0].id;
  const bare = q.prepare(`SELECT p.id FROM people p LEFT JOIN interactions i ON i.person_id = p.id WHERE lower(p.name) = ? GROUP BY p.id ORDER BY max(i.occurred_at) DESC, p.id LIMIT 1`).get(low) as { id: number } | undefined;
  return bare?.id ?? upsertPerson({ name: n });
}

export function extractPrompt(card: OmiCard, transcript: string, today: string, onList: string[] = []): string {
  return `This is one conversation Omi recorded on the owner's phone/computer ("${card.title}"${card.when ? `, ${card.when}` : ''}). In the transcript the owner is the speaker marked as the user (is_user true / "You" / "user"); everyone else is someone they were talking to, or audio around them (TV, podcast, video, a call on speaker).${householdContext()}
Reply with JSON only, no prose.

{
  "commitments": [{"counterpart": "who they promised", "text": "what THE OWNER said they'd do"}],
  "todos": [{"title": "a concrete thing THE OWNER must do", "due": "YYYY-MM-DD or null"}],
  "people": [{"name": "a real person they actually talked with or about", "note": "one short line on what they discussed"}],
  "decisions": [{"subject": "topic", "text": "what was decided"}],
  "others": [{"person": "full name of the household member (or other named speaker)", "text": "what they said about THEIR own work or life worth remembering: colleagues, projects, goals, worries, events"}],
  "watched": [{"source": "what it was, e.g. 'YouTube interview on gel-supported 3D printing'", "topic": "2-5 word subject", "takeaways": ["specific point, number, name, product or how-to step worth remembering"]}],
  "talk": {"real": true, "setting": "work | family | social | other", "with": ["first names of the people the owner talked with"]}
}

Rules:
- WHO IS SPEAKING: if the main speaker is clearly someone else, even when Omi labels them as the user (e.g. a partner on a call with THEIR boss about THEIR team, goals and colleagues), it is NOT the owner's: put it under "others" with that person's name and leave commitments/todos/people/decisions empty for those parts. Their colleagues are not the owner's contacts; their follow-ups are not the owner's tasks.
- commitments/todos/people/decisions: only what the owner themselves said or agreed to, about their own life and work. Skip promises made to them, and anything from media, ads, or background audio.
- watched: the one exception for media. When the audio is something USEFUL the owner watched or listened to (a tutorial, how-to, product or film review, product demo, talk, interview, lecture, news analysis), add one item per piece with 2-6 concrete takeaways they could want to look up later. NEVER for TV shows, movies, dramas, sketches, comedy, music or ads: skip those entirely.
- todos: ONLY when the owner explicitly commits to or asks for a reminder about a real errand or piece of work ("remind me to…", "I need to call…", "I'll send the deck Friday"). NEVER household moment-to-moment instructions or chores said in passing (shower, floss, laundry, "get it over there", "put that back"), things said to or about a child, or things someone else will do. Resolve relative dates against today (${today}); no date → null. If in doubt, leave it out: most conversations have zero todos.
- people: real names only. Skip the owner, celebrities, and people only heard on media.
- talk: ALWAYS include it. real = the owner themselves was talking with people who were there or on a call (false for media, background audio, or a recording that is mostly someone else, like a partner's work call). setting = work (clients, colleagues, prospects, business), family (partner, kids, relatives), social (friends, neighbors), or other. with = first names; for family use the names in the household list above (Omi often mishears them).
- Omit any other empty section. If nothing durable happened (small talk, a show or movie playing), reply with only "talk".
${onList.length ? `- Already on the owner's task list (never add these again, even reworded):\n${onList.map((t) => `  - ${t}`).join('\n')}\n` : ''}
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
    const personId = personIdFor(p.name);
    addInteraction({ person_id: personId, channel: 'in-person', summary: (p.note || card.title).slice(0, 200), ref, occurred_at: at });
    out.people++;
  }
  return out;
}

interface Print { id: string; at: number; fp: string[] }
function recentPrints(now: number): Print[] {
  try { return (JSON.parse(getMemory(MEM_GROUP, PRINTS_KEY) ?? '[]') as Print[]).filter((p) => now - p.at < 3 * 86_400_000); } catch { return []; }
}

/** One pass. Returns how many conversations were read. */
export async function omiSyncTick(): Promise<number> {
  // Attributed so its cost shows as omi-sync, not "unknown".
  return withLlmContext({ caller: 'omi-sync', lane: 'ambient' }, () => syncPass());
}

async function syncPass(): Promise<number> {
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
  const settleMs = SETTLE_MIN() * 60_000;
  const settled = (c: OmiCard) => {
    const t = Date.parse(c.end || c.start || '');
    return !Number.isFinite(t) || now - t >= settleMs;
  };
  const ready = fresh.filter((c) => !c.discarded && settled(c));
  if (!ready.length) return 0;

  // Read them all first: tiny fragments are dropped, and the same audio recorded twice
  // (phone + desktop) is read once, from the cleaner copy.
  const got: Array<{ card: OmiCard; raw: string; segs: Segment[]; fp: string[]; q: number }> = [];
  for (const card of ready) {
    const raw = await deps.call('get_conversation_by_id', { conversation_id: card.id, max_chars: 40_000, max_segments: 500 });
    const segs = parseSegments(raw);
    const words = segs.reduce((n, x) => n + wordCount(x.text), 0);
    if (segs.length && words < MIN_WORDS && !TODO_CUE.test(segs.map((x) => x.text).join(' '))) {
      markSeen([card.id]);
      log(`${card.id} "${card.title}": skipped, only ${words} words`);
      continue;
    }
    got.push({ card, raw, segs, fp: fingerprint(segs), q: recordingQuality(segs) });
  }
  got.sort((a, b) => b.q - a.q);
  const prints = recentPrints(now);
  const onList = onOwnersList();
  let read = 0;
  for (const g of got) {
    const dup = prints.find((p) => overlap(g.fp, p.fp) >= 0.5);
    if (dup) {
      markSeen([g.card.id]);
      log(`${g.card.id} "${g.card.title}": skipped, same recording as ${dup.id}`);
      continue;
    }
    const transcript = g.segs.length ? compactTranscript(g.segs, TRANSCRIPT_CHARS) : g.raw.slice(0, TRANSCRIPT_CHARS);
    const reply = await deps.extract(extractPrompt(g.card, transcript, ymd(now), onList));
    const json = extractFirstJson(reply, '{', '}');
    if (!json) { log(`${g.card.id}: no JSON from the extractor; will retry next pass`); continue; }
    let parsed: OmiExtract;
    try { parsed = JSON.parse(json) as OmiExtract; } catch { log(`${g.card.id}: unreadable JSON; will retry next pass`); continue; }
    const counts = writeBack(parsed, g.card);
    markSeen([g.card.id]);
    if (g.fp.length) prints.push({ id: g.card.id, at: now, fp: g.fp });
    read++;
    log(`${g.card.id} "${g.card.title}": ${JSON.stringify(counts)}${parsed.talk?.real ? ` talk:${parsed.talk.setting ?? '?'}` : ''}`);
    try { await recordConversation(g.card, g.segs, parsed.talk); } catch (err) { log(`${g.card.id}: speaking review failed: ${err instanceof Error ? err.message : err}`); }
  }
  setMemory(MEM_GROUP, PRINTS_KEY, JSON.stringify(prints.slice(-150)));
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
