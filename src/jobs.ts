// The job tracker: one list of everything the bot is doing or watching for the
// owner, in plain words, so nothing they asked for goes quiet.
//
// Engines keep their own ledgers (actions for website jobs and bookings, the
// errands table for calls). A job row is the owner-facing record on top: a
// title, a one-line progress, and "waiting on you" (a login, a texted code, a
// decision) so a job pauses for them instead of dying. Errands are read straight
// from their own table, so their runner needs no hooks.
//
// Engines register how to resume and stop their kind (registerJobKind); the
// tools in tools/jobs.ts (whats_going_on, stop_job, answer_job) work across all.

import {
  insertJob, getJob, getJobByRef, patchJob, listOpenJobRows, listErrands, listRecentJobRows,
  type JobRow, type ErrandRow,
} from './db.js';

export type WaitNeed = 'login' | 'code' | 'link' | 'decision' | 'info';
export type ItemStatus = 'waiting_on_you' | 'working' | 'watching';

const CODE_TTL_MS = 10 * 60_000;

// ── Engine hooks ─────────────────────────────────────────────────────────────

interface KindHooks {
  /** Pick the job back up after the owner answered. */
  resume?: (job: JobRow) => void;
  /** Stop it now. Returns one plain line for the owner. */
  stop?: (job: JobRow) => Promise<string> | string;
}
const hooks: Record<string, KindHooks> = {};
export function registerJobKind(kind: string, h: KindHooks): void { hooks[kind] = { ...hooks[kind], ...h }; }

// ── Lifecycle ────────────────────────────────────────────────────────────────

export function openJob(kind: string, title: string, ref?: string, opts: { status?: string; next_check_at?: string | null; check_spec?: unknown; parent_id?: number } = {}): number {
  if (ref) {
    const existing = getJobByRef(ref);
    if (existing && ['working', 'waiting_on_you', 'watching'].includes(existing.status)) return existing.id;
  }
  return insertJob({
    title: title.trim().replace(/\s+/g, ' ').slice(0, 160),
    kind, ref: ref ?? null, status: opts.status ?? 'working',
    next_check_at: opts.next_check_at ?? null,
    check_spec: opts.check_spec == null ? null : JSON.stringify(opts.check_spec),
    parent_id: opts.parent_id ?? null,
  });
}

export function setJobProgress(id: number, line: string): void {
  patchJob(id, { progress: line.trim().slice(0, 240) });
}

/** The job needs the owner: a login, a code, a decision. It waits, it doesn't fail. */
export function waitOnOwner(id: number, need: WaitNeed, ask: string, codeHost?: string | null): void {
  patchJob(id, { status: 'waiting_on_you', waiting_for: need, ask: ask.trim(), answer: null, answered_at: null, code_host: codeHost ?? null });
}

export function finishJob(id: number, status: 'done' | 'failed' | 'stopped', outcome: string): void {
  patchJob(id, { status, outcome: outcome.trim().slice(0, 400), waiting_for: null, ask: null, answer: null, finished_at: new Date().toISOString() });
}

/**
 * The texted code for a job, once: cleared on read, and only within 10 minutes
 * of the owner sending it (codes expire fast; an old one is worse than none).
 */
export function takeCode(jobId: number): string | null {
  const j = getJob(jobId);
  if (!j?.answer || j.waiting_for !== 'code' || !j.answered_at) return null;
  patchJob(jobId, { answer: null });
  if (Date.now() - Date.parse(j.answered_at) > CODE_TTL_MS) return null;
  return j.answer;
}

/** The emailed sign-in link for a job, once, within 10 minutes (opened by open_sign_in_link). */
export function takeLink(jobId: number): string | null {
  const j = getJob(jobId);
  if (!j?.answer || j.waiting_for !== 'link' || !j.answered_at) return null;
  patchJob(jobId, { answer: null });
  if (Date.now() - Date.parse(j.answered_at) > CODE_TTL_MS) return null;
  return j.answer;
}

/** A non-code answer for the next run's prompt, once. */
export function takeAnswer(jobId: number): { ask: string; answer: string; need: string } | null {
  const j = getJob(jobId);
  if (!j?.answer || j.waiting_for === 'code' || j.waiting_for === 'link') return null;
  patchJob(jobId, { answer: null });
  return { ask: j.ask ?? '', answer: j.answer, need: j.waiting_for ?? 'info' };
}

/** The code typed in a reply: the longest run of 4-8 digits, else a 6-8 char token. */
export function extractCode(text: string): string | null {
  const digits = text.replace(/(\d)[\s-](?=\d)/g, '$1').match(/\b\d{4,8}\b/g);
  if (digits?.length) return digits.sort((a, b) => b.length - a.length)[0];
  const tok = text.match(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{6,8}\b/);
  return tok ? tok[0] : null;
}

// ── One list across engines ──────────────────────────────────────────────────

export interface OpenItem {
  key: string;            // job:N | errand:N
  title: string;
  status: ItemStatus;
  line: string;           // plain words, no numbers or ids
  ask?: string;
  since: string;
}

function ago(iso: string): string {
  const ms = Date.now() - Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 36 ? `${h}h ago` : `${Math.round(h / 24)} days ago`;
}

function jobItem(j: JobRow): OpenItem {
  const status = j.status as ItemStatus;
  const line = status === 'waiting_on_you'
    ? `${j.title} Waiting on you: ${j.ask ?? 'your answer'} (asked ${ago(j.updated_at)})`
    : status === 'watching'
      ? `${j.title}${j.progress ? ` ${j.progress}` : ''}`
      : `${j.title}${j.progress ? ` Last: ${j.progress}` : ' Working on it.'}`;
  return { key: `job:${j.id}`, title: j.title, status, line, ask: j.ask ?? undefined, since: j.updated_at };
}

function errandItem(r: ErrandRow): OpenItem {
  let goal = r.goal;
  try { goal = (JSON.parse(r.envelope_json) as { goal?: string }).goal ?? r.goal; } catch { /* keep goal */ }
  const title = goal.charAt(0).toUpperCase() + goal.slice(1);
  if (r.status === 'waiting') {
    return { key: `errand:${r.id}`, title, status: 'waiting_on_you', line: `${title}: waiting on you: ${r.outcome ?? 'your answer'}`, ask: r.outcome ?? undefined, since: r.updated_at };
  }
  const calls = r.calls_made ? `${r.calls_made} call${r.calls_made === 1 ? '' : 's'} so far` : 'calling soon';
  const detail = errandLine ? errandLine(r) : `${r.call_state ? 'on a call now' : calls}.`;
  return { key: `errand:${r.id}`, title, status: 'working', line: `${title}: ${detail}`, since: r.updated_at };
}

// errands.ts fills this in (what the calls ran into + the real next call time, in the owner's timezone);
// a setter instead of an import keeps jobs.ts out of the errands import graph.
let errandLine: ((r: ErrandRow) => string) | null = null;
export function setErrandLine(fn: (r: ErrandRow) => string): void { errandLine = fn; }

export function openItems(): OpenItem[] {
  const items = [
    // Practice runs are tests: never in the owner's list, check-ins, or reply context.
    ...listOpenJobRows(30).filter((j) => !j.title.startsWith('Practice:')).map(jobItem),
    ...listErrands({ open: true, limit: 10 }).map(errandItem),
  ];
  const order: Record<ItemStatus, number> = { waiting_on_you: 0, working: 1, watching: 2 };
  return items.sort((a, b) => order[a.status] - order[b.status]);
}

/** Grouped plain-words list, for "what are you working on". */
export function describeOpenItems(recentHours = 24): string {
  const items = openItems();
  const group = (s: ItemStatus, head: string) => {
    const xs = items.filter((i) => i.status === s);
    return xs.length ? `${head}\n${xs.map((i) => `- ${i.line}`).join('\n')}` : '';
  };
  const since = new Date(Date.now() - recentHours * 3_600_000).toISOString();
  const done = listRecentJobRows(since, 5).filter((j) => j.status !== 'stopped');
  const finished = done.length ? `Finished lately\n${done.map((j) => `- ${j.title} ${j.status === 'done' ? '✅' : '⚠️'} ${j.outcome ?? ''}`.trim()).join('\n')}` : '';
  const out = [group('waiting_on_you', 'Waiting on you'), group('working', 'Working on'), group('watching', 'Keeping an eye on'), finished].filter(Boolean).join('\n\n');
  return out || 'Nothing in progress.';
}

const STOP = new Set(['the', 'a', 'an', 'my', 'that', 'this', 'it', 'one', 'job', 'thing', 'for', 'and', 'to', 'of', 'on', 'with', 'then', 'please']);
const tokens = (t: string) => t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));

/**
 * Which open item the owner means. A blank or vague "which" picks the only
 * candidate; otherwise word overlap with the title (and the question asked).
 */
export function matchItem(which: string, filter?: (i: OpenItem) => boolean): { item: OpenItem } | { ambiguous: OpenItem[] } | { none: true } {
  const pool = openItems().filter(filter ?? (() => true));
  if (!pool.length) return { none: true };
  const want = tokens(which);
  if (!want.length) return pool.length === 1 ? { item: pool[0] } : { ambiguous: pool };
  const scored = pool
    .map((i) => ({ i, score: tokens(`${i.title} ${i.ask ?? ''}`).filter((w) => want.some((x) => w.startsWith(x) || x.startsWith(w))).length }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (!scored.length) return pool.length === 1 ? { item: pool[0] } : { none: true };
  if (scored.length > 1 && scored[0].score === scored[1].score) return { ambiguous: scored.filter((x) => x.score === scored[0].score).map((x) => x.i) };
  return { item: scored[0].i };
}

function which(list: OpenItem[]): string {
  return list.slice(0, 4).map((i) => i.title.replace(/\.$/, '')).join(' or ');
}

/** The owner answered a waiting job: store it and pick the job back up. */
export async function answerItem(whichText: string, answer: string): Promise<string> {
  const m = matchItem(whichText, (i) => i.status === 'waiting_on_you');
  if ('none' in m) return 'Nothing is waiting on them right now. Handle their message normally.';
  if ('ambiguous' in m) return `More than one thing is waiting on them. Ask which, in plain words: ${which(m.ambiguous)}?`;
  const [kind, idStr] = m.item.key.split(':');
  const id = Number(idStr);
  if (kind === 'errand') {
    const { addErrandNote } = await import('./errands.js');
    addErrandNote(id, answer);
    return `Passed on. Tell them in one line that you're back on it (${m.item.title.replace(/\.$/, '')}).`;
  }
  const job = getJob(id)!;
  let stored = answer.trim();
  if (job.waiting_for === 'code') {
    const code = extractCode(answer);
    if (!code) return 'That job is waiting for a code, and their message has none. Ask them for the code in one line.';
    stored = code;
  }
  if (job.waiting_for === 'link') {
    const link = answer.match(/https:\/\/[^\s<>"]+/)?.[0];
    if (!link) return 'That job is waiting for the sign-in link, and their message has none. Ask them to forward the email or paste the link.';
    stored = link;
  }
  patchJob(id, { answer: stored, answered_at: new Date().toISOString(), status: 'working' });
  const resume = hooks[job.kind]?.resume;
  if (resume) setTimeout(() => resume(getJob(id)!), 200);
  return job.waiting_for === 'code'
    ? `Got the code; entering it now. Tell them in a few words, e.g. "Got it, entering it now."`
    : `Back on it. Tell them in one short line.`;
}

/** Stop an open item now. */
export async function stopItem(whichText: string): Promise<string> {
  const m = matchItem(whichText);
  if ('none' in m) return 'Nothing matching is in progress.';
  if ('ambiguous' in m) return `Ask which one to stop, in plain words: ${which(m.ambiguous)}?`;
  const [kind, idStr] = m.item.key.split(':');
  const id = Number(idStr);
  if (kind === 'errand') {
    const { cancelErrand } = await import('./errands.js');
    cancelErrand(id);
    return `Stopped: ${m.item.title.replace(/\.$/, '')}.`;
  }
  const job = getJob(id)!;
  const stop = hooks[job.kind]?.stop;
  const said = stop ? await stop(job) : '';
  if (getJob(id)?.status !== 'stopped') finishJob(id, 'stopped', 'Stopped by the owner.');
  return said || `Stopped: ${job.title.replace(/\.$/, '')}.`;
}

/** Short block for the prompt, so a bare reply ("482913", "done") maps to the right job. */
export function waitingBlock(): string {
  // Only what's been waiting on the owner in the last day: an old ask in every
  // message's context turns unrelated short replies into "answers" to it.
  // Older ones stay in whats_going_on and the check-ins.
  const dayAgo = Date.now() - 24 * 3_600_000;
  const waiting = openItems().filter((i) => i.status === 'waiting_on_you' && Date.parse(i.since.includes('T') ? i.since : `${i.since.replace(' ', 'T')}Z`) >= dayAgo);
  if (!waiting.length) return '';
  return `## Waiting on the owner\n${waiting.map((i) => `- ${i.line}`).join('\n')}\nIf their message answers one of these (a code, "done", "logged in", a choice), call answer_job with their words. Don't ask them which unless it's truly unclear.`;
}
