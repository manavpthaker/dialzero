import db, { getMemory, setMemory } from '../db.js';
import { isQuietHours } from './time-et.js';
import { getBotName, getTimezone } from '../config.js';

/**
 * Progress updates on work the owner started (errands, website jobs): they
 * hear how it's going without asking, but not a barrage. So:
 *  - milestones (a person reached, moving to the next company, pushed to
 *    tomorrow, paused on a problem, done, stuck) always go out;
 *  - in-between progress waits at least GAP_MIN since the last update on that
 *    job, and at most DAILY_CAP of them a day;
 *  - the same text twice in a row is never sent;
 *  - a job that's been quiet for SILENCE_H gets one "still on it" line.
 * Everything is a `reply` interrupt (the owner is waiting on it), so quiet hours hold
 * it for the morning instead of dropping it.
 */

const GAP_MIN = 45;
const DAILY_CAP = 8;
export const SILENCE_H = 3;

type Sender = (subject: string, text: string, source: string) => Promise<void>;
let senderOverride: Sender | null = null;
/** Tests swap this so nothing is texted. */
export function setJobUpdateSender(fn: Sender | null): void { senderOverride = fn; }

async function send(subject: string, text: string, source: string): Promise<void> {
  if (senderOverride) return senderOverride(subject, text, source);
  const { sendInterrupt } = await import('../cos-outbound.js');
  await sendInterrupt({ source, subject, kind: 'reply', text });
}

/** Never show the owner raw API errors, JSON or stack traces. */
export function cleanUpdate(text: string): string {
  let t = text.replace(/\{[\s\S]*\}/g, ' ').replace(/\s+/g, ' ').trim();
  if (isInfraError(text)) t = t.replace(/(Browser error: )?OpenAI \d{3}:?/i, '').trim() || `${getBotName()}'s AI service had an error.`;
  return t.length > 320 ? `${t.slice(0, 317).replace(/\s+\S*$/, '')}…` : t;
}

/** The assistant's own plumbing failing (AI credit, rate limits, outages), not the website or the business. */
export function isInfraError(text: string): boolean {
  return /insufficient_quota|credit_balance|no credits remaining|OpenAI (429|5\d\d)|rate.?limit|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|Background LLM budget/i.test(text);
}

interface Sent { created_at: string; text_hash: string | null; text_preview: string | null }

function sentFor(key: string, sinceSql: string): Sent[] {
  return db.prepare(
    `SELECT created_at, text_hash, text_preview FROM outbound_log
     WHERE (subject = ? OR subject LIKE ?) AND decision IN ('sent', 'deferred') AND created_at >= ?
     ORDER BY id DESC`,
  ).all(key, `${key}:%`, sinceSql) as Sent[];
}

function sqlAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').slice(0, 19);
}

/** When the owner last heard anything about this job (null = never). */
export function lastUpdateAt(key: string): number | null {
  const row = sentFor(key, '1970-01-01')[0];
  return row ? Date.parse(`${row.created_at.replace(' ', 'T')}Z`) : null;
}

interface Mine { at: number; body: string; day: string; count: number }
const dayLocal = (t = Date.now()) => new Date(t).toLocaleDateString('en-US', { timeZone: getTimezone() });
function mine(key: string): Mine | null {
  try { const raw = getMemory('job-updates', key); return raw ? JSON.parse(raw) as Mine : null; } catch { return null; }
}

export async function updateOwner(
  key: string,
  text: string,
  opts: { milestone?: boolean; source?: string; send?: (subject: string, text: string) => Promise<void> } = {},
): Promise<boolean> {
  const body = cleanUpdate(text);
  if (!body) return false;
  const prev = mine(key);
  if (prev?.body === body) return false;
  const today = dayLocal();
  const countToday = prev?.day === today ? prev.count : 0;
  if (!opts.milestone) {
    const last = Math.max(prev?.at ?? 0, lastUpdateAt(key) ?? 0);
    if (Date.now() - last < GAP_MIN * 60_000) return false;
    if (countToday >= DAILY_CAP) return false;
  }
  try {
    if (opts.send) await opts.send(key, body);
    else await send(key, body, opts.source ?? 'job-updates');
    setMemory('job-updates', key, JSON.stringify({ at: Date.now(), body, day: today, count: countToday + 1 }));
    return true;
  } catch (err) {
    console.error(`[job-updates] could not update the owner on ${key}:`, err);
    return false;
  }
}

/** The "still on it" check: true when a running job has been silent too long. */
export function dueForCheckIn(key: string, startedAt: number, now = Date.now()): boolean {
  if (isQuietHours()) return false;
  const last = Math.max(lastUpdateAt(key) ?? 0, mine(key)?.at ?? 0, startedAt);
  return now - last >= SILENCE_H * 3600_000;
}

/** "Tue 9:02am" from a UTC SQLite time or ISO string. */
export function fmtWhen(when: string | Date | number): string {
  const d = when instanceof Date ? when
    : typeof when === 'number' ? new Date(when)
      : new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(when) ? when : `${when.replace(' ', 'T')}Z`);
  const now = new Date();
  const day = (x: Date) => x.toLocaleDateString('en-US', { timeZone: getTimezone() });
  const time = d.toLocaleTimeString('en-US', { timeZone: getTimezone(), hour: 'numeric', minute: '2-digit' })
    .replace(' ', '').toLowerCase();
  if (day(d) === day(now)) return `today ${time}`;
  if (day(d) === day(new Date(now.getTime() + 86400_000))) return `tomorrow ${time}`;
  return `${d.toLocaleDateString('en-US', { timeZone: getTimezone(), weekday: 'short' })} ${time}`;
}
