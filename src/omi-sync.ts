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
import { getOwner, getProfileConfig, ownerRef } from './config.js';
import { localYmd as localDay } from './lib/time.js';
import { similarOpenTask } from './lib/task-dedupe.js';
import dbh from './db.js';
import { withLlmContext } from './lib/llm-context.js';
import { dedupeSegments, fingerprint, overlap, parseSegments, recordingQuality, transcriptParts, wordCount, type Segment } from './lib/omi-transcript.js';
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
/** Under this many words, a recording is read as a voice note. */
const VOICE_NOTE_WORDS = 80;
// A short recording that is only "remind me to call the dentist tomorrow" is still read.
// "You still need to go to the eye doctor" (someone else, 24 words) and "…to remember that" were
// skipped or kept as chatter: any need/have-to, a note to oneself, or a title Omi gave as a
// reminder counts.
const TODO_CUE = /\b(remind(er)?|remember( that| to)?|don'?t (let me )?forget|(need|needs|have|has|got) to|gotta|should|i'?ll|i will|going to|gonna|wanna|to-?do|call|email|text|send|buy|order|pick up|drop off|return|book|schedule|pay|cancel|renew|follow up|appointment)\b/i;
const PRINTS_KEY = 'fingerprints';
// Omi often has no transcript yet when a conversation first looks finished (41 of 100 reads
// in one audit came back empty and were marked done). Retry those this long, then give up.
const AWAIT_KEY = 'awaiting_transcript';
const AWAIT_MAX_MS = 48 * 3_600_000;
// Omi keeps adding to a conversation after it was read (one gained 41 minutes): re-read the new part.
const READ_KEY = 'read_ends';
const GROWN_MS = 10 * 60_000;
// A late upload carries its start time, so look back far enough to still see it.
const WINDOW_DAYS = 4;
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

class OmiError extends Error {}

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
    const text = (r.content as Array<{ type: string; text?: string }>).filter((p) => p.type === 'text').map((p) => p.text ?? '').join('\n');
    // An error reply used to be read as an empty transcript and the conversation marked done.
    if (r.isError) throw new OmiError(`Omi ${tool} failed: ${text.slice(0, 200)}`);
    return text;
  } catch (err) {
    if (err instanceof OmiError) throw err;
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
/** The owner's calendar day (their configured timezone), so "tomorrow" said at 9pm isn't a day late. */
export const localYmd = (ms: number) => localDay(new Date(ms));
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
  const add = new Set(ids);
  const all = [...seenIds().filter((id) => !add.has(id)), ...add];
  setMemory(MEM_GROUP, SEEN_KEY, JSON.stringify(all.slice(-SEEN_MAX)));
}

interface Household { name: string; fullName?: string; aliases: string[]; relationship?: string }

/** The people around the owner: messaging members plus the profile's inner circle, with the names Omi hears. */
export function householdPeople(): Household[] {
  try {
    const cfg = getProfileConfig();
    // Members carry messaging fields; nicknames (and often full names) live on the profile's people list.
    const all: Household[] = [
      ...(cfg.members ?? []).map((m) => ({ name: m.name, fullName: m.fullName, aliases: [] as string[], relationship: 'lives with the owner' })),
      ...(cfg.people ?? []).map((p) => ({ name: p.name, fullName: p.fullName, aliases: Array.isArray(p.aliases) ? p.aliases.map(String) : [], relationship: p.relationship })),
    ];
    const byName = new Map<string, Household>();
    for (const h of all) {
      if (!h.name) continue;
      const k = h.name.toLowerCase();
      const was = byName.get(k);
      byName.set(k, was ? { name: was.name, fullName: was.fullName || h.fullName, aliases: [...new Set([...was.aliases, ...h.aliases])], relationship: h.relationship || was.relationship } : h);
    }
    return [...byName.values()];
  } catch { return []; }
}

/** The household person a spoken name (or a mishearing of it) means. */
function householdMatch(name: string): Household | undefined {
  const n = name.trim().toLowerCase();
  return householdPeople().find((h) => [h.name, h.fullName ?? '', ...h.aliases].some((x) => x && (x.toLowerCase() === n || x.toLowerCase().split(/\s+/)[0] === n)));
}

/**
 * Who lives with the owner, and what's known about their work, so a recording where a
 * partner talks about THEIR job isn't filed as the owner's (Omi sometimes labels another
 * household voice as the user; their colleagues became the owner's contacts and their
 * follow-ups became the owner's tasks).
 */
export function householdContext(): string {
  const people = householdPeople();
  if (!people.length) return '';
  const db = dbh as unknown as { prepare: (s: string) => { all: (...a: unknown[]) => unknown[] } };
  const lines = people.map((h) => {
    const name = h.fullName || h.name;
    const first = name.split(/\s+/)[0].toLowerCase();
    const known = db.prepare(`SELECT predicate, object FROM facts WHERE active = 1 AND (lower(subject) = ? OR lower(subject) LIKE ?) AND (predicate LIKE 'work%' OR predicate LIKE '%colleague%' OR predicate LIKE 'job%') ORDER BY id DESC LIMIT 4`)
      .all(name.toLowerCase(), `${first} %`) as Array<{ predicate: string; object: string }>;
    const also = h.aliases.length ? ` (also heard as ${h.aliases.join(', ')})` : '';
    const rel = h.relationship ? `, ${h.relationship}` : '';
    return `- ${name}${also}${rel}${known.length ? `: ${known.map((k) => `${k.predicate}: ${k.object}`).join('; ').slice(0, 300)}` : ''}`;
  });
  return `\nPeople close to the owner (their voices are often in these recordings, and Omi sometimes labels them as the owner):\n${lines.join('\n')}\n`;
}

/** "Alex" → the full name on their contact record ("alex rivera"), so facts stay on one person. */
function fullName(name: string): string {
  const h = householdMatch(name);
  if (h?.fullName) return h.fullName.toLowerCase();
  const n = (h?.name ?? name).trim().toLowerCase();
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
  // A household member by any name Omi hears (full name, nickname, a mishearing) goes to
  // their one record (bare first-name and nickname records kept appearing).
  const h = householdMatch(name);
  const n = (h?.fullName || h?.name || name).trim();
  const low = n.toLowerCase();
  const q = dbh as unknown as { prepare: (s: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] } };
  if (low.includes(' ')) {
    const exact = q.prepare(`SELECT p.id FROM people p LEFT JOIN interactions i ON i.person_id = p.id WHERE lower(p.name) = ? GROUP BY p.id ORDER BY max(i.occurred_at) DESC, p.id LIMIT 1`).get(low) as { id: number } | undefined;
    return exact?.id ?? upsertPerson({ name: n });
  }
  const household = householdPeople().map((x) => x.name.toLowerCase());
  const since = new Date(deps.now() - 60 * 86_400_000).toISOString().slice(0, 19).replace('T', ' ');
  const full = q.prepare(`SELECT lower(p.name) AS name, p.id, max(i.occurred_at) AS last, sum(i.occurred_at >= ?) AS lately FROM people p LEFT JOIN interactions i ON i.person_id = p.id
    WHERE lower(p.name) LIKE ? GROUP BY p.id ORDER BY lately DESC, last DESC`).all(since, `${low} %`) as Array<{ name: string; id: number; last: string | null; lately: number | null }>;
  const recent = full.filter((r) => household.includes(low) || (r.last && Date.parse(`${r.last.replace(' ', 'T')}Z`) >= deps.now() - 60 * 86_400_000));
  if (new Set(recent.map((r) => r.name)).size === 1) return recent[0].id;
  // Two recent people with that first name: the one the owner is in touch with far more often
  // (a colleague over someone met once), rather than a stray bare-name record that's someone else.
  const [top, next] = recent;
  if (top && (top.lately ?? 0) >= 3 && (top.lately ?? 0) >= 3 * (next?.lately ?? 0)) return top.id;
  // Otherwise an earlier bare-name placeholder, but never a bare record that's a real contact (its own email or phone).
  const bare = q.prepare(`SELECT p.id FROM people p LEFT JOIN interactions i ON i.person_id = p.id WHERE lower(p.name) = ?
    AND NOT EXISTS (SELECT 1 FROM person_emails e WHERE e.person_id = p.id) AND NOT EXISTS (SELECT 1 FROM person_phones f WHERE f.person_id = p.id)
    GROUP BY p.id ORDER BY max(i.occurred_at) DESC, p.id LIMIT 1`).get(low) as { id: number } | undefined;
  return bare?.id ?? upsertPerson({ name: n });
}

export interface PromptExtras {
  /** Omi's own summary of the whole conversation (it has heard all of it). */
  overview?: string;
  /** To-dos Omi itself noted from this conversation: hints to confirm, not to copy blindly. */
  omiTodos?: string[];
  /** Which part of a long transcript this is. */
  part?: { n: number; of: number };
  /** Only the part recorded after the assistant last read it. */
  continued?: boolean;
  /** A short recording (a voice note): what the owner says they need to do is a to-do, chores included. */
  voiceNote?: boolean;
}

function getOwnerNames(): string[] {
  try { const o = getOwner(); return [o.name, o.shortName ?? '', o.fullName ?? ''].filter(Boolean).map((n) => n.toLowerCase()); } catch { return []; }
}

function ownerName(): string {
  try { return ownerRef().fullName || 'the owner'; } catch { return 'the owner'; }
}

export function extractPrompt(card: OmiCard, transcript: string, today: string, onList: string[] = [], x: PromptExtras = {}): string {
  const owner = ownerName();
  const first = owner.split(/\s+/)[0];
  const part = x.part && x.part.of > 1 ? `\nThis is part ${x.part.n} of ${x.part.of} of a long transcript; extract only what is in this part.` : '';
  const continued = x.continued ? `\nThe start of this conversation was already read; this is only what was recorded after that.` : '';
  const note = x.voiceNote ? `\nThis is a SHORT recording, likely a note to self: anything the owner (or someone talking to them) says they need to do, should remember or will do later is a todo, even a household chore ("take out the dishes before pickup, remember that", "you still need to go to the eye doctor"). Skip only what's done on the spot ("I'll grab it now").` : '';
  const overview = x.overview?.trim() ? `\nOmi's summary of the whole conversation: ${x.overview.trim().slice(0, 1500)}` : '';
  const hints = x.omiTodos?.length ? `\nTo-dos Omi itself noted from this conversation (it heard all of it; keep the ones that are really the owner's, worded as their to-dos, and skip the rest):\n${x.omiTodos.slice(0, 15).map((t) => `  - ${t}`).join('\n')}` : '';
  return `This is one conversation Omi recorded on the owner's phone/computer ("${card.title}"${card.when ? `, ${card.when}` : ''}). The owner is ${owner}. In the transcript the owner is usually the speaker marked as the user ("You"); everyone else is someone they were talking to, or audio around them (TV, podcast, video, a call on speaker). In meetings Omi often marks no one as the owner: then work out which speaker is ${first} from context (people call them ${first}, they introduce themselves, they're the one being onboarded or asked to do things).${householdContext()}${overview}${hints}${part}${continued}${note}
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
- commitments/todos/people/decisions: only what the owner themselves said or agreed to, or was clearly asked to do, about their own life and work. Skip promises other people made to them, and anything from media, ads, or background audio.
- watched: the one exception for media. NEVER for a meeting, call, training, onboarding or all-hands the owner was part of: that's their work, not media. When the audio is something USEFUL the owner watched or listened to (a tutorial, how-to, product or film review, product demo, talk, interview, lecture, news analysis), add one item per piece with 2-6 concrete takeaways they could want to look up later. NEVER for TV shows, movies, dramas, sketches, comedy, music or ads: skip those entirely.
- todos (in a voice note, see above, the bar is lower): ONLY when the owner explicitly commits to or asks for a reminder about a real errand or piece of work ("remind me to…", "I need to call…", "I'll send the deck Friday"), or a colleague, manager or organizer assigns them something at work ("fill out the conflict-of-interest form", "upload your I-9 by Friday", "send me a recap every Friday"). In an orientation or meeting, what attendees are told to do (forms, uploads, invites to accept, trainings) is the owner's to-do too. A promise they make to deliver something ("I'll put together the phase-two plan", "I'll check the backend") is BOTH a commitment and a todo. Calendar changes they agree to ("block Thursdays at 4:30") are todos. NEVER household moment-to-moment instructions or chores said in passing (shower, floss, laundry, "get it over there", "put that back"), things said to or about a child, or things someone else will do. Resolve relative dates against today (${today}); no date → null. If in doubt, leave it out: most conversations have zero todos.
- people: real names only, people the owner actually knows or dealt with; in a meeting, at most the 6 who mattered most to them (who they spoke with, who assigned or owns their follow-ups). Skip ${first} themselves, names Omi clearly mangled, celebrities, athletes, characters, and anyone only heard on TV, radio, podcasts or video.
- talk: ALWAYS include it. real = the owner themselves was talking with people who were there or on a call (false for media, background audio, or a recording that is mostly someone else, like a partner's work call). setting = work (clients, colleagues, prospects, business), family (partner, kids, relatives), social (friends, neighbors), or other. with = first names; for family use the names in the household list above (Omi often mishears them).
- Omit any other empty section. If nothing durable happened (small talk, a show or movie playing), reply with only "talk".
${onList.length ? `- Already on the owner's task list (never add these again, even reworded):\n${onList.map((t) => `  - ${t}`).join('\n')}\n` : ''}
TRANSCRIPT:
${transcript.slice(0, TRANSCRIPT_CHARS + 200)}`;
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
  // A real work conversation isn't media (work meetings were once saved as public "watched" notes).
  const workTalk = parsed.talk?.real === true && parsed.talk.setting === 'work';
  for (const w of workTalk ? [] : parsed.watched ?? []) {
    const points = (w.takeaways ?? []).map((t) => String(t).trim()).filter(Boolean).slice(0, 6);
    if (!w.topic?.trim() || !points.length) continue;
    // Not personal, so not sensitive: "what was that 3D printing video?" should find it.
    saveFact({ subject: w.topic.trim().toLowerCase(), predicate: `watched: ${(w.source || card.title).trim().slice(0, 120)}`, object: points.join('; '), fact_type: 'reference', source: 'omi-media', source_ref: ref, sensitive: false });
    out.facts++;
  }
  const me = new Set([getOwnerNames()].flat());
  for (const p of (parsed.people ?? []).slice(0, 8)) {
    if (!p.name?.trim() || me.has(p.name.trim().toLowerCase())) continue; // never a contact for themselves
    const personId = personIdFor(p.name);
    addInteraction({ person_id: personId, channel: 'in-person', summary: (p.note || card.title).slice(0, 200), ref, occurred_at: at });
    out.people++;
  }
  return out;
}

interface Print { id: string; at: number; fp: string[]; start?: number; end?: number; words?: number }
function recentPrints(now: number): Print[] {
  try { return (JSON.parse(getMemory(MEM_GROUP, PRINTS_KEY) ?? '[]') as Print[]).filter((p) => now - p.at < 3 * 86_400_000); } catch { return []; }
}

const mem = <T>(key: string, fallback: T): T => { try { return JSON.parse(getMemory(MEM_GROUP, key) ?? '') as T; } catch { return fallback; } };
const ms = (iso?: string) => { const t = Date.parse(iso ?? ''); return Number.isFinite(t) ? t : undefined; };

/**
 * The same audio recorded twice: most of the words match AND the recordings overlap in
 * time. Words alone matched a bedtime story to the next night's (the same story) and a
 * 53-minute meeting to a fragment of itself, and both real conversations were dropped.
 */
export function sameRecording(a: Print, b: Print): boolean {
  if (overlap(a.fp, b.fp) < 0.5) return false;
  if (a.start != null && a.end != null && b.start != null && b.end != null) {
    const slack = 10 * 60_000;
    if (a.start > b.end + slack || b.start > a.end + slack) return false;
  }
  // A much fuller copy (the whole meeting, not the first fragment of it) is read anyway.
  if (a.words && b.words && a.words > b.words * 1.5) return false;
  return true;
}

/** Omi's own to-do list, by conversation, as hints for the one extractor. */
async function omiTodosByConversation(now: number): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  try {
    const since = new Date(now - (WINDOW_DAYS + 1) * 86_400_000).toISOString().replace('Z', '+00:00');
    const text = await deps.call('get_action_items', { updated_since: since, limit: 500 });
    const data = JSON.parse(text) as { action_items?: unknown[] } | unknown[];
    const items = (Array.isArray(data) ? data : data.action_items ?? []) as Array<Record<string, unknown>>;
    for (const it of items) {
      const id = str(it.conversation_id);
      const d = str(it.description).trim();
      if (!id || !d) continue;
      out.set(id, [...(out.get(id) ?? []), d]);
    }
  } catch (err) { log(`omi to-do hints unavailable: ${err instanceof Error ? err.message : err}`); }
  return out;
}

function overviewOf(raw: string): string {
  try {
    const d = JSON.parse(raw) as Record<string, unknown>;
    const o = (d.conversation ?? d) as Record<string, unknown>;
    return str((o.structured as Record<string, unknown> | undefined)?.overview) || str(o.overview);
  } catch { return ''; }
}

/** Results of several transcript parts as one, without repeating the same item. */
function mergeExtracts(list: OmiExtract[]): OmiExtract {
  const out: OmiExtract = {};
  const keyed = <T>(items: T[], key: (t: T) => string) => { const seen = new Set<string>(); return items.filter((t) => { const k = key(t).toLowerCase().replace(/\W+/g, ' ').trim(); if (!k || seen.has(k)) return false; seen.add(k); return true; }); };
  const all = <K extends keyof OmiExtract>(k: K) => list.flatMap((e) => (e[k] ?? []) as never[]);
  out.commitments = keyed(all('commitments') as NonNullable<OmiExtract['commitments']>, (c) => c.text ?? '');
  out.todos = keyed(all('todos') as NonNullable<OmiExtract['todos']>, (t) => t.title ?? '');
  out.people = keyed(all('people') as NonNullable<OmiExtract['people']>, (p) => p.name ?? '');
  out.decisions = keyed(all('decisions') as NonNullable<OmiExtract['decisions']>, (d) => d.text ?? '');
  out.others = keyed(all('others') as NonNullable<OmiExtract['others']>, (o) => `${o.person} ${o.text}`);
  out.watched = keyed(all('watched') as NonNullable<OmiExtract['watched']>, (w) => w.topic ?? '');
  const talks = list.map((e) => e.talk).filter(Boolean) as TalkInfo[];
  if (talks.length) out.talk = { ...(talks.find((t) => t.real) ?? talks[0]), with: [...new Set(talks.flatMap((t) => t.with ?? []))] };
  return out;
}

/**
 * Read one conversation's transcript (in parts when it's long) and merge what the model
 * found. Writes nothing. Null when the model's reply couldn't be read (retry later).
 */
export async function extractSegments(card: OmiCard, segs: Segment[], raw: string, o: { today: string; onList: string[]; omiTodos?: string[]; continued?: boolean; voiceNote?: boolean }): Promise<{ parsed: OmiExtract; parts: number } | null> {
  const parts = transcriptParts(segs, TRANSCRIPT_CHARS);
  const extras = { overview: overviewOf(raw), omiTodos: o.omiTodos ?? [], continued: o.continued, voiceNote: o.voiceNote ?? segs.reduce((n, x) => n + wordCount(x.text), 0) < VOICE_NOTE_WORDS };
  const results: OmiExtract[] = [];
  for (let i = 0; i < parts.length; i++) {
    const reply = await deps.extract(extractPrompt(card, parts[i], o.today, o.onList, { ...extras, part: { n: i + 1, of: parts.length } }));
    const json = extractFirstJson(reply, '{', '}');
    if (!json) { log(`${card.id}: no JSON from the extractor; will retry next pass`); return null; }
    try { results.push(JSON.parse(json) as OmiExtract); } catch { log(`${card.id}: unreadable JSON; will retry next pass`); return null; }
  }
  return { parsed: mergeExtracts(results), parts: parts.length };
}

/** What the assistant would keep from these conversations, re-read with today's rules; `apply` writes it. */
export async function rereadConversations(ids: string[], apply: boolean): Promise<Array<{ id: string; title: string; when: string; card?: OmiCard; upTo?: number; parsed?: OmiExtract; note?: string; wrote?: { facts: number; tasks: number; people: number } }>> {
  const now = deps.now();
  const cards = new Map<string, OmiCard>();
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const text = await deps.call('get_conversations', { start_date: ymd(now - 10 * 86_400_000), end_date: ymd(now + 86_400_000), limit: 50, ...(cursor ? { cursor } : {}) });
    for (const c of parseCards(text)) cards.set(c.id, c);
    try { cursor = (JSON.parse(text) as { next_cursor?: string }).next_cursor || undefined; } catch { cursor = undefined; }
    if (!cursor) break;
  }
  const hints = await omiTodosByConversation(now);
  const onList = onOwnersList();
  const readEnds = mem<Record<string, { end: string; upTo: number }>>(READ_KEY, {});
  const out: Awaited<ReturnType<typeof rereadConversations>> = [];
  for (const id of ids) {
    const card = cards.get(id) ?? [...cards.values()].find((c) => c.id.startsWith(id));
    if (!card) { out.push({ id, title: '?', when: '', note: 'not in Omi any more' }); continue; }
    const raw = await deps.call('get_conversation_by_id', { conversation_id: card.id, max_chars: 100_000, max_segments: 500 });
    const segs = dedupeSegments(parseSegments(raw));
    if (!segs.length) { out.push({ id: card.id, title: card.title, when: card.when, note: 'still no transcript' }); continue; }
    const got = await extractSegments(card, segs, raw, { today: localYmd(Date.parse(card.when) || now), onList, omiTodos: hints.get(card.id) ?? [] });
    if (!got) { out.push({ id: card.id, title: card.title, when: card.when, note: 'the model reply was unreadable' }); continue; }
    const row: (typeof out)[number] = { id: card.id, title: card.title, when: card.when, card, upTo: segs.reduce((m, x) => Math.max(m, x.end), 0), parsed: got.parsed };
    if (apply) {
      row.wrote = writeBack(got.parsed, card);
      markSeen([card.id]);
      readEnds[card.id] = { end: card.end ?? card.when, upTo: segs.reduce((m, x) => Math.max(m, x.end), 0) };
    }
    out.push(row);
  }
  if (apply) setMemory(MEM_GROUP, READ_KEY, JSON.stringify(Object.fromEntries(Object.entries(readEnds).slice(-300))));
  return out;
}

/** Write a reviewed re-read (from rereadConversations, possibly trimmed) exactly as approved. */
export function applyReread(rows: Array<{ card: OmiCard; parsed: OmiExtract; upTo?: number }>): Array<{ id: string; wrote: { facts: number; tasks: number; people: number } }> {
  const readEnds = mem<Record<string, { end: string; upTo: number }>>(READ_KEY, {});
  const out = rows.map((r) => {
    const wrote = writeBack(r.parsed, r.card);
    markSeen([r.card.id]);
    readEnds[r.card.id] = { end: r.card.end ?? r.card.when, upTo: r.upTo ?? 0 };
    return { id: r.card.id, wrote };
  });
  setMemory(MEM_GROUP, READ_KEY, JSON.stringify(Object.fromEntries(Object.entries(readEnds).slice(-300))));
  return out;
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
    const text = await deps.call('get_conversations', { start_date: ymd(now - WINDOW_DAYS * 86_400_000), end_date: ymd(now + 86_400_000), limit: 50, ...(cursor ? { cursor } : {}) });
    cards.push(...parseCards(text));
    try { cursor = (JSON.parse(text) as { next_cursor?: string }).next_cursor || undefined; } catch { cursor = undefined; }
    if (!cursor) break;
  }
  const seen = new Set(seenIds());
  const readEnds = mem<Record<string, { end: string; upTo: number }>>(READ_KEY, {});
  // Read before and recorded more since (Omi merged in the rest): read the new part.
  const grown = (c: OmiCard) => {
    const was = readEnds[c.id];
    const end = ms(c.end);
    const before = ms(was?.end);
    return !!was && end != null && before != null && end - before > GROWN_MS && now - end < 86_400_000;
  };
  const fresh = cards.filter((c) => !seen.has(c.id) || grown(c));
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
  const awaiting = mem<Record<string, number>>(AWAIT_KEY, {});
  const hints = await omiTodosByConversation(now);

  // Read them all first: tiny fragments are dropped, and the same audio recorded twice
  // (phone + desktop) is read once, from the cleaner copy.
  const got: Array<{ card: OmiCard; raw: string; segs: Segment[]; rawSegs: Segment[]; fp: string[]; q: number; words: number; upTo: number }> = [];
  for (const card of ready) {
    const raw = await deps.call('get_conversation_by_id', { conversation_id: card.id, max_chars: 100_000, max_segments: 500 });
    const rawSegs = parseSegments(raw);
    const all = dedupeSegments(rawSegs);
    if (!all.length) {
      // No transcript yet: Omi is still processing it. Never mark it read on an empty reply.
      const first = awaiting[card.id] ?? now;
      if (now - first >= AWAIT_MAX_MS) {
        markSeen([card.id]);
        delete awaiting[card.id];
        log(`${card.id} "${card.title}": gave up, still no transcript after ${Math.round(AWAIT_MAX_MS / 3_600_000)}h`);
      } else {
        if (!(card.id in awaiting)) log(`${card.id} "${card.title}": no transcript yet; will retry`);
        awaiting[card.id] = first;
      }
      continue;
    }
    delete awaiting[card.id];
    const was = seen.has(card.id) ? readEnds[card.id] : undefined;
    const segs = was ? all.filter((x) => x.start >= was.upTo - 30) : all;
    const upTo = all.reduce((m, x) => Math.max(m, x.end), 0);
    const words = segs.reduce((n, x) => n + wordCount(x.text), 0);
    if (!was && words < MIN_WORDS && !TODO_CUE.test(`${card.title} ${segs.map((x) => x.text).join(' ')}`)) {
      markSeen([card.id]);
      log(`${card.id} "${card.title}": skipped, only ${words} words`);
      continue;
    }
    if (was && words < MIN_WORDS) {
      readEnds[card.id] = { end: card.end ?? was.end, upTo };
      continue;
    }
    got.push({ card, raw, segs, rawSegs, fp: fingerprint(rawSegs), q: recordingQuality(rawSegs), words: all.reduce((n, x) => n + wordCount(x.text), 0), upTo });
  }
  setMemory(MEM_GROUP, AWAIT_KEY, JSON.stringify(Object.fromEntries(Object.entries(awaiting).slice(-300))));
  got.sort((a, b) => b.q - a.q);
  const prints = recentPrints(now);
  const onList = onOwnersList();
  const today = localYmd(now);
  let read = 0;
  for (const g of got) {
    const continued = seen.has(g.card.id);
    const mine: Print = { id: g.card.id, at: now, fp: g.fp, start: ms(g.card.start), end: ms(g.card.end), words: g.words };
    const dup = continued ? undefined : prints.find((p) => p.id !== g.card.id && sameRecording(mine, p));
    if (dup) {
      markSeen([g.card.id]);
      log(`${g.card.id} "${g.card.title}": skipped, same recording as ${dup.id}`);
      continue;
    }
    const out = await extractSegments(g.card, g.segs, g.raw, { today, onList, omiTodos: continued ? [] : hints.get(g.card.id) ?? [], continued, voiceNote: !continued && g.words < VOICE_NOTE_WORDS });
    if (!out) continue;
    const { parsed, parts } = out;
    const counts = writeBack(parsed, g.card);
    markSeen([g.card.id]);
    readEnds[g.card.id] = { end: g.card.end ?? g.card.when, upTo: g.upTo };
    if (g.fp.length && !continued) prints.push(mine);
    read++;
    log(`${g.card.id} "${g.card.title}": ${JSON.stringify(counts)}${parsed.talk?.real ? ` talk:${parsed.talk.setting ?? '?'}` : ''}${parts > 1 ? ` (${parts} parts)` : ''}${continued ? ' (the new part)' : ''}`);
    if (!continued) {
      // The speaking coach counts what was really said, repeats and all.
      try { await recordConversation(g.card, g.rawSegs, parsed.talk); } catch (err) { log(`${g.card.id}: speaking review failed: ${err instanceof Error ? err.message : err}`); }
    }
  }
  setMemory(MEM_GROUP, READ_KEY, JSON.stringify(Object.fromEntries(Object.entries(readEnds).slice(-300))));
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
