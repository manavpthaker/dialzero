// The owner's texts → who's waiting on whom. When Messages on this Mac is signed in to
// the owner's OWN Apple ID, imessage_log holds their personal threads. Every
// TEXT_LOOPS_INTERVAL_MIN this reads the threads that changed, with recent context, and
// keeps the open loops:
//   owe_reply        someone asked the owner something they haven't answered → waiting on the owner
//   i_promised       the owner said they'd do something                       → waiting on the owner
//   waiting_on_them  the owner asked and is waiting for an answer             → watching
//   plan             a dated plan the owner agreed to                         → watching
// Each loop is a job (kind text_loop), so it shows in the job list, check-ins and the
// "waiting on you" context without new plumbing, and answer_job / stop_job work on it.
// A reply from the owner in the thread closes what they owed there. Nothing here sends a text.
//
// Never read: the family chat and anything else with a privacy_scope, the configured
// GROUP_* chats, and 1:1 chats with the owner or household members (those are
// conversations with the assistant, not the owner's own threads). With a separate Apple
// ID for the assistant that leaves nothing to read, so the pass is a no-op.

import { join } from 'path';
import db, { findPersonByPhone, findPersonByEmail, getMemory, setMemory, listOpenJobRows, type JobRow } from './db.js';
import { openJob, waitOnOwner, finishJob, registerJobKind, journal } from './jobs.js';
import { extractFirstJson, extractionComplete, makeLogger } from './lib/daemon.js';
import { parseNumEnv, parseStrEnv } from './lib/env.js';
import { OPENAI_MODEL } from './lib/openai.js';
import { withLlmContext } from './lib/llm-context.js';
import { getTimezone, ownerRef } from './config.js';
import { tzAbbrev } from './lib/time.js';
import { resolveUser } from './user-resolver.js';

const MEM = 'text-loops';
const KIND = 'text_loop';
const CONTEXT_MSGS = 20;
const MAX_OPEN = 15;
const STALE_DAYS = 7;
const FIRST_RUN_DAYS = 5;
const log = makeLogger(process.env.TEXT_LOOPS_LOG || join(process.cwd(), 'logs', 'text-loops.log'), false);

export type LoopKind = 'owe_reply' | 'i_promised' | 'waiting_on_them' | 'plan';
export interface FoundLoop { kind: LoopKind; who?: string; summary: string; due?: string | null; evidence?: string; confidence?: number }
export interface LoopReply { loops?: FoundLoop[]; resolved?: number[] }

export interface TextRow { id: number; chat_id: string; chat_name: string | null; sender: string | null; direction: string; text: string; ts: string }

export interface TextLoopDeps {
  extract: (prompt: string) => Promise<string>;
  now: () => number;
}

const defaultDeps: TextLoopDeps = {
  extract: (prompt) => extractionComplete({ prompt, maxTokens: 900, openaiModel: parseStrEnv('OPENAI_MODEL', OPENAI_MODEL), log, caller: 'text-loops' }),
  now: () => Date.now(),
};
let deps = defaultDeps;
export function setTextLoopDeps(over: Partial<TextLoopDeps> | null): void { deps = over ? { ...defaultDeps, ...over } : defaultDeps; }

// ── What's noise ────────────────────────────────────────────────────────────

const TAPBACK = /^(loved|liked|disliked|laughed at|emphasized|questioned|reacted [^ ]+ to)\s+[“"']/i;
const CODE = /\b(code|passcode|verification|one[- ]time|otp)\b[^\n]{0,40}\b\d{4,8}\b|\b\d{4,8}\b[^\n]{0,30}\b(is your|code)\b/i;
/** Short codes (5-6 digit senders, "32665(smsft)") are businesses and alerts, not people waiting on the owner. */
const isShortCode = (chatId: string) => /^\d{3,6}(\(|$)/.test(chatId);
export const isNoise = (r: Pick<TextRow, 'chat_id' | 'text'>) => isShortCode(r.chat_id) || TAPBACK.test(r.text.trim()) || CODE.test(r.text);

/** Chats that are the assistant's own conversations, never the owner's personal threads. */
export function isAssistantChat(chatId: string): boolean {
  const groups = Object.entries(process.env)
    .filter(([k, v]) => k.startsWith('GROUP_') && v?.trim())
    .map(([, v]) => v!.trim());
  if (groups.includes(chatId)) return true;
  try { return resolveUser(chatId) != null; } catch { return false; }
}

// ── Names ───────────────────────────────────────────────────────────────────

/** A contact's name for a known handle, else the chat's name, else the handle itself. */
export function nameFor(handle: string | null, chatName?: string | null): string {
  if (handle && handle !== 'me') {
    try {
      const p = handle.includes('@') ? findPersonByEmail(handle) : findPersonByPhone(handle);
      if (p?.name) return p.name;
    } catch { /* unknown */ }
  }
  return chatName?.trim() || handle || 'someone';
}

// ── State ───────────────────────────────────────────────────────────────────

interface LoopSpec { chat_id: string; loop: LoopKind; who?: string; last_ts: string }
function specOf(j: JobRow): LoopSpec | null { try { return JSON.parse(j.check_spec ?? '') as LoopSpec; } catch { return null; } }
export function openLoops(chatId?: string): Array<{ job: JobRow; spec: LoopSpec }> {
  return listOpenJobRows(200).filter((j) => j.kind === KIND).flatMap((job) => {
    const spec = specOf(job);
    return spec && (!chatId || spec.chat_id === chatId) ? [{ job, spec }] : [];
  });
}

// ── The prompt ──────────────────────────────────────────────────────────────

const local = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: getTimezone(), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function loopPrompt(chatLabel: string, group: boolean, msgs: TextRow[], open: Array<{ id: number; kind: LoopKind; summary: string }>, nowMs: number): string {
  const { name: owner, pronouns: p } = (() => { try { return ownerRef(); } catch { return { name: 'the owner', pronouns: { subject: 'they', object: 'them', possessive: 'their' } }; } })();
  const lines = msgs.map((m) => `[${local(m.ts)}] ${m.direction === 'out' ? `${owner} (the owner)` : nameFor(m.sender, group ? null : m.chat_name)}: ${m.text.replace(/\s+/g, ' ').slice(0, 500)}`);
  return `These are the latest texts in ${group ? `the group chat "${chatLabel}"` : `${owner}'s thread with ${chatLabel}`}. ${owner} is "the owner" (${p.subject}/${p.object}/${p.possessive}). Now is ${local(new Date(nowMs).toISOString())} (${tzAbbrev()}).
Find what is still OPEN for the owner in this thread. Reply with JSON only:
{"loops": [{"kind": "owe_reply | i_promised | waiting_on_them | plan", "who": "first name", "summary": "one short line in plain words, e.g. 'Sam asked if you're in for Saturday dinner at 7'", "due": "YYYY-MM-DD or null", "evidence": "the few words it rests on", "confidence": 0.0-1.0}], "resolved": [ids of the already-open items below that this thread shows are done]}

Rules:
- owe_reply: someone asked the OWNER a real question or for a decision, and the owner has not answered it in a later message. Not rhetorical questions, not "how are you", not group chatter aimed at others, not something a later message already settled.
- i_promised: the owner said they would do something for someone ("I'll send it tonight", "let me check and get back to you") and hasn't shown it done.
- waiting_on_them: the owner asked someone for something and they haven't answered yet.
- plan: a concrete plan with a date or time the owner agreed to (dinner Saturday 7pm). Not vague "we should hang out".
- Skip: ads, alerts, delivery and bank notices, codes, small talk, jokes, reactions, anything already handled in the thread, and anything older than a week with no follow-up.
- Group chats: only what involves the owner directly (asked of them, promised by them, or a plan they said yes to).
- Most threads have nothing open: then reply {"loops": [], "resolved": [...]}.
- Use confidence below 0.6 when unsure.
${open.length ? `\nAlready open for this thread (mark resolved if done; never add these again, even reworded):\n${open.map((o) => `- [${o.id}] ${o.kind}: ${o.summary}`).join('\n')}\n` : ''}
TEXTS (oldest first):
${lines.join('\n')}`;
}

const TITLES: Record<LoopKind, (who: string, s: string) => string> = {
  owe_reply: (who, s) => `Reply to ${who}: ${s}`,
  i_promised: (who, s) => `You told ${who}: ${s}`,
  waiting_on_them: (who, s) => `Waiting on ${who}: ${s}`,
  plan: (_who, s) => `Plan: ${s}`,
};
const tidy = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/\.$/, '');

// ── One pass ────────────────────────────────────────────────────────────────

export interface PassResult { chats: number; added: number; closed: number; proposed: Array<{ chat: string; loop: FoundLoop }> }

/**
 * Read the threads with new texts since the last pass. `dryRun` reads and reports what it
 * would open or close, and writes nothing (no jobs, no watermark).
 */
export async function textLoopsPass(opts: { dryRun?: boolean; sinceDays?: number } = {}): Promise<PassResult> {
  return withLlmContext({ caller: 'text-loops', lane: 'ambient' }, () => pass(opts));
}

const SELECT = `SELECT id, chat_id, chat_name, sender, direction, text, ts FROM imessage_log`;

async function pass(opts: { dryRun?: boolean; sinceDays?: number }): Promise<PassResult> {
  const now = deps.now();
  const out: PassResult = { chats: 0, added: 0, closed: 0, proposed: [] };
  const watermark = opts.sinceDays != null ? 0 : Number(getMemory(MEM, 'last_id') ?? 0);
  const floor = new Date(now - (opts.sinceDays ?? (watermark ? STALE_DAYS : FIRST_RUN_DAYS)) * 86_400_000).toISOString();
  const fresh = db.prepare(`${SELECT}
    WHERE id > ? AND ts >= ? AND privacy_scope IS NULL AND text IS NOT NULL AND trim(text) != '' ORDER BY id LIMIT 3000`).all(watermark, floor) as TextRow[];
  if (!fresh.length) return out;
  const maxId = fresh.reduce((m, r) => Math.max(m, r.id), watermark);
  const chats = new Map<string, TextRow[]>();
  for (const r of fresh) {
    if (isNoise(r) || isAssistantChat(r.chat_id)) continue;
    chats.set(r.chat_id, [...(chats.get(r.chat_id) ?? []), r]);
  }

  for (const [chatId, rows] of chats) {
    const context = (db.prepare(`${SELECT}
      WHERE chat_id = ? AND ts >= ? AND privacy_scope IS NULL ORDER BY ts DESC LIMIT ?`).all(chatId, new Date(now - 14 * 86_400_000).toISOString(), CONTEXT_MSGS) as TextRow[])
      .reverse().filter((r) => r.text?.trim() && !isNoise(r));
    if (!context.length) continue;
    const open = openLoops(chatId);
    const lastMine = [...context].reverse().find((r) => r.direction === 'out');
    const repliedSince = (o: { spec: LoopSpec }) => o.spec.loop === 'owe_reply' && !!lastMine && lastMine.ts > o.spec.last_ts;
    // The owner replied after an open "reply to" item was raised: that one's handled.
    for (const o of open.filter(repliedSince)) {
      out.closed++;
      if (!opts.dryRun) finishJob(o.job.id, 'done', 'You replied.');
    }
    // Only the owner's own messages since the last pass and nothing open here: nothing new to find.
    const stillOpen = open.filter((o) => !repliedSince(o));
    if (rows.every((r) => r.direction === 'out') && !stillOpen.length && !rows.some((r) => /\b(i'?ll|i will|let me|gonna|going to)\b/i.test(r.text))) continue;

    const group = !chatId.startsWith('+') && !chatId.includes('@');
    const chatName = context.find((r) => r.chat_name)?.chat_name ?? null;
    const label = group ? (chatName ?? 'a group chat') : nameFor(chatId, chatName);
    out.chats++;
    const reply = await deps.extract(loopPrompt(label, group, context, stillOpen.map((o) => ({ id: o.job.id, kind: o.spec.loop, summary: o.job.title })), now));
    const json = extractFirstJson(reply, '{', '}');
    let parsed: LoopReply = {};
    try { parsed = json ? JSON.parse(json) as LoopReply : {}; } catch { log(`${chatId}: unreadable reply`); continue; }

    for (const id of parsed.resolved ?? []) {
      const o = stillOpen.find((x) => x.job.id === Number(id));
      if (!o) continue;
      out.closed++;
      if (!opts.dryRun) finishJob(o.job.id, 'done', 'Settled in the thread.');
    }
    const lastTs = context[context.length - 1].ts;
    for (const l of parsed.loops ?? []) {
      if (!l?.summary?.trim() || !['owe_reply', 'i_promised', 'waiting_on_them', 'plan'].includes(l.kind)) continue;
      if ((l.confidence ?? 1) < 0.6) continue;
      const who = tidy(l.who || label);
      out.proposed.push({ chat: label, loop: { ...l, who } });
      if (opts.dryRun) continue;
      const title = TITLES[l.kind](who, tidy(l.summary)).slice(0, 160);
      const ref = `text:${chatId}:${l.kind}:${tidy(l.summary).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 60)}`;
      const waiting = l.kind === 'owe_reply' || l.kind === 'i_promised';
      const before = openLoops(chatId).length;
      const id = openJob(KIND, title, ref, { status: waiting ? 'waiting_on_you' : 'watching', check_spec: { chat_id: chatId, loop: l.kind, who, last_ts: lastTs } satisfies LoopSpec });
      if (openLoops(chatId).length === before) continue; // the same loop is already open
      if (waiting) waitOnOwner(id, 'decision', l.kind === 'owe_reply' ? `Reply to ${who}` : `Do what you told ${who}`);
      if (l.evidence) journal(id, 'evidence', l.evidence.slice(0, 200));
      out.added++;
    }
  }
  if (!opts.dryRun) {
    expireStale(now);
    setMemory(MEM, 'last_id', String(maxId));
    setMemory(MEM, 'last_tick', new Date(now).toISOString());
  }
  log(`pass${opts.dryRun ? ' (dry run)' : ''}: ${fresh.length} new texts, ${out.chats} threads read, ${out.added} opened, ${out.closed} closed`);
  return out;
}

/** Loops nobody touched for a week go quiet, and the list never grows past MAX_OPEN. */
function expireStale(now: number): void {
  const loops = openLoops().sort((a, b) => b.job.id - a.job.id);
  loops.forEach((o, i) => {
    const age = now - Date.parse(`${o.job.updated_at.replace(' ', 'T')}${o.job.updated_at.includes('Z') ? '' : 'Z'}`);
    if (i >= MAX_OPEN || age > STALE_DAYS * 86_400_000) finishJob(o.job.id, 'stopped', 'Went quiet: nothing in the thread for a week.');
  });
}

// ── Done / stop from chat ───────────────────────────────────────────────────

registerJobKind(KIND, {
  // The owner answered it ("done", "told them yes"): that's handled.
  resume: (job) => finishJob(job.id, 'done', job.answer ? `Handled: ${job.answer}`.slice(0, 200) : 'Handled.'),
  stop: (job) => { finishJob(job.id, 'stopped', 'Dismissed.'); return `Dismissed: ${job.title}.`; },
});

let running = false;
export function startTextLoops(): void {
  const everyMs = parseNumEnv('TEXT_LOOPS_INTERVAL_MIN', 10) * 60_000;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await textLoopsPass(); } catch (err) { log(`tick failed: ${err instanceof Error ? err.message : err}`); } finally { running = false; }
  };
  setTimeout(tick, 90_000);
  setInterval(tick, everyMs);
  console.log(`[text-loops] reading the owner's text threads every ${everyMs / 60_000} min`);
}
