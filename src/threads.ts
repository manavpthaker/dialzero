// Ongoing topics, so the owner never has to say "back to the travel chat".
//
// The chat history only holds the last ~75 messages. A topic that goes quiet
// for days (a trip being planned, a billing mess, a school form) scrolls out,
// and "ok what about flights" lands with no context. Each real topic keeps a
// running record here: what's decided, the options on the table, open
// questions, and pointers (emails sent, research, jobs).
//
//   before a reply: pickThreads() matches the message (+ the last few turns)
//     to the open topics it continues, even with no cue words, and
//     threadBlock() puts their records in the prompt.
//   after a reply: updateThreads() folds the exchange into the topic, or starts
//     one when this is a real multi-turn subject. Off the reply path.
// Per chat (group_id), so the Family chat's topics are its own.

import db, { type MessageRow } from './db.js';
import { OPENAI_ROUTER_MODEL, openAIText } from './lib/openai.js';
import { extractFirstJson } from './lib/daemon.js';
import { withLlmContext } from './lib/llm-context.js';
import { getBotName } from './config.js';

export interface Thread {
  id: number; group_id: string; title: string; summary: string;
  details: string; open_questions: string; status: 'open' | 'closed';
  created_at: string; last_active_at: string;
}

let ready = false;
function ensure(): void {
  if (ready) return;
  db.exec(`CREATE TABLE IF NOT EXISTS threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT, group_id TEXT NOT NULL, title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '', details TEXT NOT NULL DEFAULT '', open_questions TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS threads_group_active ON threads(group_id, status, last_active_at)');
  ready = true;
}

/** Open topics for a chat, most recently active first. Quiet for 60 days → closed. */
export function openThreads(groupId: string, limit = 15): Thread[] {
  ensure();
  db.prepare(`UPDATE threads SET status = 'closed' WHERE status = 'open' AND last_active_at < datetime('now', '-60 days')`).run();
  return db.prepare(`SELECT * FROM threads WHERE group_id = ? AND status = 'open' ORDER BY last_active_at DESC LIMIT ?`).all(groupId, limit) as Thread[];
}
export function getThread(id: number): Thread | undefined {
  ensure();
  return db.prepare('SELECT * FROM threads WHERE id = ?').get(id) as Thread | undefined;
}

export interface ThreadDeps { complete: (system: string, prompt: string, maxTokens: number) => Promise<string> }
const defaultDeps: ThreadDeps = {
  complete: (system, prompt, maxTokens) => openAIText({ model: process.env.OPENAI_THREADS_MODEL || OPENAI_ROUTER_MODEL, system, prompt, maxOutputTokens: maxTokens, reasoningEffort: 'low' }),
};
let deps = defaultDeps;
export function setThreadDeps(over: Partial<ThreadDeps> | null): void { deps = over ? { ...defaultDeps, ...over } : defaultDeps; }

const turnLines = (rows: Array<Pick<MessageRow, 'role' | 'content'>>, each = 400) =>
  rows.map((m) => `${m.role === 'assistant' ? getBotName() : 'Owner'}: ${m.content.replace(/\s+/g, ' ').slice(0, each)}`).join('\n');
const catalog = (ts: Thread[]) => ts.map((t) => `#${t.id} ${t.title} — ${t.summary.slice(0, 160)} (last ${t.last_active_at.slice(0, 10)})`).join('\n');

/** Which open topics does this message continue? Empty for a new subject or small talk. */
export async function pickThreads(groupId: string, message: string, recent: Array<Pick<MessageRow, 'role' | 'content'>>): Promise<Thread[]> {
  const open = openThreads(groupId);
  if (!open.length || !message.trim()) return [];
  try {
    const raw = await Promise.race([
      deps.complete(
        'You match a new message to the ongoing topics it continues. People rarely name the topic: "what about flights", "the second one", "did they answer", "ok book it" continue whatever topic fits, using the recent turns and each topic\'s summary. Reply with JSON only: {"ids": [<topic ids>]}. Up to 2 ids, most likely first. [] if it is a new subject or small talk.',
        `Open topics:\n${catalog(open)}\n\nRecent turns:\n${turnLines(recent.slice(-6))}\n\nNew message: ${message.slice(0, 600)}`,
        120,
      ),
      new Promise<string>((r) => setTimeout(() => r(''), 4000)),
    ]);
    const json = extractFirstJson(raw, '{', '}');
    const ids = json ? ((JSON.parse(json) as { ids?: unknown[] }).ids ?? []).map(Number).filter(Number.isInteger) : [];
    return ids.map((id) => open.find((t) => t.id === id)).filter((t): t is Thread => !!t).slice(0, 2);
  } catch { return []; }
}

/** The prompt block for the matched topics. */
export function threadBlock(threads: Thread[]): string {
  if (!threads.length) return '';
  return `\n--- Ongoing topic${threads.length > 1 ? 's' : ''} this message continues (they don't need to repeat any of this) ---\n${threads.map((t) => [
    `${t.title} (since ${t.created_at.slice(0, 10)}, last ${t.last_active_at.slice(0, 10)})`,
    t.summary && `Where it stands: ${t.summary}`,
    t.details && `Details:\n${t.details}`,
    t.open_questions && `Open: ${t.open_questions}`,
  ].filter(Boolean).join('\n')).join('\n\n')}`;
}

/**
 * After a reply: fold this exchange into the topic(s) it continued, or start a
 * topic when it's a real multi-turn subject (a plan, a purchase, a problem to
 * solve, research). Returns the thread ids touched.
 */
export async function updateThreads(groupId: string, exchange: Array<Pick<MessageRow, 'role' | 'content'>>, matched: Thread[]): Promise<number[]> {
  ensure();
  if (!exchange.length) return [];
  const raw = await withLlmContext({ caller: 'threads', lane: 'batch' }, () => deps.complete(
    `You keep the running record of ongoing topics for a personal assistant. Given the topics this exchange continued and the exchange itself, return the updated records. Rules:
- Update a matched topic only with what changed: decisions, the options still on the table (with the specifics: names, dates, prices, links), what's done, what's open. Keep it current, not a log. summary ≤ 300 chars; details ≤ 1200 chars as short lines; open_questions ≤ 300 chars.
- Start a NEW topic only for a real subject likely to come up again (planning a trip, buying something, a problem being sorted out, a project, research). Not for one-off questions, quick facts, small talk, or a single errand that's already finished.
- If a topic is clearly finished ("booked", "done", "never mind"), set close: true.
Reply with JSON only: {"updates": [{"id": <id or null for new>, "title": "short name", "summary": "...", "details": "...", "open_questions": "...", "close": false}]}  ([] if nothing to record).`,
    `Matched topics:\n${matched.length ? matched.map((t) => `#${t.id} ${t.title}\nSummary: ${t.summary}\nDetails: ${t.details}\nOpen: ${t.open_questions}`).join('\n\n') : '(none)'}\n\nExchange:\n${turnLines(exchange, 1800)}`,
    1500,
  ));
  const json = extractFirstJson(raw, '{', '}');
  if (!json) return [];
  let updates: Array<{ id?: number | null; title?: string; summary?: string; details?: string; open_questions?: string; close?: boolean }> = [];
  try { updates = (JSON.parse(json) as { updates?: typeof updates }).updates ?? []; } catch { return []; }
  const touched: number[] = [];
  for (const u of updates.slice(0, 3)) {
    const clip = (s: unknown, n: number) => String(s ?? '').trim().slice(0, n);
    const known = u.id != null ? matched.find((t) => t.id === Number(u.id)) : undefined;
    if (known) {
      db.prepare(`UPDATE threads SET title = ?, summary = ?, details = ?, open_questions = ?, status = ?, last_active_at = datetime('now') WHERE id = ?`)
        .run(clip(u.title, 80) || known.title, clip(u.summary, 400) || known.summary, clip(u.details, 1600) || known.details, clip(u.open_questions, 400), u.close ? 'closed' : 'open', known.id);
      touched.push(known.id);
    } else if (u.id == null && clip(u.title, 80) && !u.close) {
      const r = db.prepare(`INSERT INTO threads (group_id, title, summary, details, open_questions) VALUES (?, ?, ?, ?, ?)`)
        .run(groupId, clip(u.title, 80), clip(u.summary, 400), clip(u.details, 1600), clip(u.open_questions, 400));
      touched.push(Number(r.lastInsertRowid));
    }
  }
  return touched;
}
