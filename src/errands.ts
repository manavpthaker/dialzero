// Errands (docs/ERRANDS.md, Phase 1: calls only).
//
// An errand is a goal plus an envelope the owner approved once: who may be
// called (in order), what may be shared, the time window, and a call cap. After
// `go #action:N`, the runner works it forward on its own:
//
//   active ──call──▶ (dialing → connected → result) ──▶ done | retry | next target
//      │                                                   │
//      └──── blocked / out of calls / past deadline ──────▶ waiting (on the owner) | failed
//
// Deliberately deterministic: the runner picks who to call next and when, and
// the realtime model only handles the conversation itself. Anything outside the
// envelope (a new number, a price, a payment) comes back to the owner as a
// question; nothing here spends money.
//
// Messaging (src/cos-outbound.ts rules): a finished errand is a check-in item; a
// blocked one is a `decision` (also the check-in); either becomes `time-critical`
// when the deadline is within a day. Individual call attempts are never texted.
//
// Phase 2: anything booked on a call goes on the owner's calendar, and a business
// calling the bot's number back about a recent errand is answered with that
// errand's context (the owner hears about it as a reply).

import { preferencesFor } from './lib/preferences.js';
import {
  toDialable, isFictionalNumber, placeErrandCall, setErrandCallHooks, setOneOffCallStarter, isPhoneConfigured, twilioCallInfo,
  type CallResult, type CallBooking, type CallbackMatch,
} from './phone.js';
import { sendInterrupt } from './cos-outbound.js';
import { updateOwner, fmtWhen, dueForCheckIn } from './lib/job-updates.js';
import { setErrandLine } from './jobs.js';
import { createCalendarEventRaw } from './tools/calendar.js';
import { normalizePhone } from './lib/phone.js';
import { todayET } from './lib/time-et.js';
import { localOffset } from './lib/time.js';
import { checkDone } from './lib/verify.js';
import { getBotName, getOwner, getTimezone } from './config.js';
import {
  createErrand, getErrand, updateErrand, getDueErrands, getErrandsInCall, getErrandsForCallback, addErrandEvent,
  getErrandEvents,
  listErrands, countErrandCallsToday, getMemory, setMemory, proposeAction, confirmAction, markActionExecuting,
  markActionDone, markActionFailed, findPersonByPhone, addCallNote, callNotesFor, saveFact,
  type Action, type ErrandRow, type CallNoteRow,
} from './db.js';

const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => { const n = Number(env(k)); return Number.isFinite(n) && n > 0 ? n : d; };

export const MAX_TARGETS = 3;
const DEFAULT_MAX_CALLS = 4;
const HARD_MAX_CALLS = 8;
/** Attempts on one target before moving to the next. */
const ATTEMPTS_PER_TARGET = 2;
const RETRY_GAP_MS = () => num('ERRAND_RETRY_GAP_MIN', 120) * 60_000;
const DAILY_CALL_CAP = () => num('ERRAND_DAILY_CALL_CAP', 10);
/** A dial that never connects within this is a no-answer (Twilio sends us nothing). */
const DIAL_TIMEOUT_MS = 4 * 60_000;
/** A connected call with no result after this is treated as dropped. */
const CONNECTED_TIMEOUT_MS = () => (num('PHONE_MAX_CALL_MIN', 15) + 5) * 60_000;
const TICK_MS = 5 * 60_000;

export function errandsEnabled(): boolean {
  return env('ERRANDS_ENABLED', 'true') !== 'false';
}

// ── Envelope ────────────────────────────────────────────────────────────────

export interface ErrandTarget { name: string; phone: string; hours?: OpenSpan[] }

/** When a business is open: days 0=Sun..6=Sat, minutes after midnight, local time. */
export interface OpenSpan { days: number[]; open: number; close: number }

const DAY_IDX: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
function dayList(raw: string): number[] {
  const t = raw.toLowerCase().replace(/\s+/g, '');
  if (/daily|everyday|all/.test(t)) return [0, 1, 2, 3, 4, 5, 6];
  const out = new Set<number>();
  for (const part of t.split(',')) {
    const m = part.match(/^([a-z]{3})[a-z]*(?:-([a-z]{3})[a-z]*)?$/);
    if (!m || DAY_IDX[m[1]] === undefined) continue;
    const a = DAY_IDX[m[1]];
    const b = m[2] !== undefined && DAY_IDX[m[2]] !== undefined ? DAY_IDX[m[2]] : a;
    for (let d = a; ; d = (d + 1) % 7) { out.add(d); if (d === b) break; }
  }
  return [...out];
}
function minutes(raw: string): number | null {
  const m = String(raw).trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = Number(m[1]) % 12;
  if (!m[3] && Number(m[1]) >= 12) h = Number(m[1]);
  if (m[3] === 'pm') h += 12;
  if (!m[3] && Number(m[1]) === 24) h = 24;
  return h * 60 + Number(m[2] ?? 0);
}
/** [{days:"Tue-Sun", open:"5pm", close:"9:30pm"}] → spans; anything unreadable is dropped. */
export function parseHours(raw: unknown): OpenSpan[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const spans: OpenSpan[] = [];
  for (const r of raw as Array<Record<string, unknown>>) {
    const days = dayList(String(r.days ?? ''));
    const open = minutes(String(r.open ?? ''));
    const close = minutes(String(r.close ?? ''));
    if (days.length && open !== null && close !== null && close > open) spans.push({ days, open, close });
  }
  return spans.length ? spans : undefined;
}

/** Open now, with a margin: not in the first 5 or last 20 minutes (they're busy opening or closing). */
export function isOpenAt(hours: OpenSpan[] | undefined, at = new Date()): boolean {
  if (!hours?.length) return true;
  const { dow, hour, minute } = etParts(at);
  const m = hour * 60 + minute;
  return hours.some((h) => h.days.includes(dow) && m >= h.open + 5 && m <= h.close - 20);
}

/** The next time (15-min steps) that's both inside calling rules and inside their hours. */
export function nextOpenTime(hours: OpenSpan[] | undefined, from = new Date(), alsoCallingHours = true): Date {
  const t = new Date(from.getTime());
  for (let i = 0; i < 4 * 24 * 8; i++) {
    if (isOpenAt(hours, t) && (!alsoCallingHours || inCallingHours(t))) return t;
    t.setTime(t.getTime() + 5 * 60_000);
  }
  return t;
}
export interface Envelope {
  goal: string;
  deadline: string | null;      // YYYY-MM-DD, local
  targets: ErrandTarget[];      // called in order; later ones are backups
  share: string;                // exactly what may be told to the other side
  window: string;               // e.g. "Wed or Thu after 3pm" — what to aim for
  max_calls: number;
  keep_transcript: boolean;
  notes: string[];              // owner updates after approval ("use Thursday instead")
  /**
   * The owner asked for this call themselves and is waiting on it: dial now (even
   * outside calling hours, e.g. to leave a voicemail), retry sooner, and report
   * the result as a reply rather than a check-in item.
   */
  reply_mode?: boolean;
  /** A practice call (the morning check): never texts the owner, writes no call notes. */
  silent?: boolean;
}

type Prepared = { payload: Record<string, unknown>; summary: string } | { error: string };

function ownerPhones(): string[] {
  const o = getOwner();
  return [process.env[o.phoneEnv || `USER_${o.id.toUpperCase()}`], ...env('PHONE_OWNER_NUMBERS').split(',')]
    .map((r) => normalizePhone(r || '')).filter((p) => p.length === 10);
}

function fmtPhone(e164: string): string {
  const d = e164.replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}` : e164;
}

/**
 * Validate an errand proposal and write its summary from the payload, so the
 * owner approves the real envelope (same Preparer contract as send/call).
 */
export function prepareErrand(p: Record<string, unknown>): Prepared {
  const goal = String(p.goal ?? '').trim();
  if (!goal) return { error: 'errand needs "goal": what should be done.' };

  const deadlineRaw = String(p.deadline ?? '').trim();
  if (deadlineRaw && !/^\d{4}-\d{2}-\d{2}$/.test(deadlineRaw)) return { error: 'deadline must be YYYY-MM-DD.' };
  if (deadlineRaw && deadlineRaw < todayET()) return { error: `deadline ${deadlineRaw} is in the past.` };

  const rawTargets = Array.isArray(p.targets) ? p.targets as Array<Record<string, unknown>> : [];
  if (rawTargets.length === 0) return { error: 'errand needs "targets": at least one {name, phone} to call. Research them first (web_search / fetch_url).' };
  if (rawTargets.length > MAX_TARGETS) return { error: `at most ${MAX_TARGETS} targets per errand (first choice + backups).` };

  const personalOk = p.personal_ok === true;
  const targets: ErrandTarget[] = [];
  for (const t of rawTargets) {
    const name = String(t.name ?? '').trim();
    const dial = toDialable(String(t.phone ?? ''));
    if (!name) return { error: 'every target needs a "name".' };
    if (!dial) return { error: `"${String(t.phone ?? '')}" (${name}) is not a US number the bot can call (emergency, premium, and short numbers are blocked).` };
    if (isFictionalNumber(dial)) return { error: `${name}'s number ${fmtPhone(dial)} is a made-up 555-01xx number. Find the real one (web_search / fetch_url) or ask the owner; never guess.` };
    if (ownerPhones().includes(normalizePhone(dial))) return { error: `${name}'s number is your own number.` };
    // AI-voice calls to a person's cell need their prior consent (FCC 2024);
    // errands default to businesses. A known contact needs an explicit OK.
    const person = findPersonByPhone(dial);
    if (person && !personalOk) {
      return { error: `${fmtPhone(dial)} belongs to ${person.name}, a personal contact. Errands call businesses; to call a person, confirm they're OK getting a call from ${getBotName()}, then pass personal_ok: true.` };
    }
    const hours = parseHours(t.hours);
    if (!targets.some((x) => x.phone === dial)) targets.push({ name, phone: dial, ...(hours ? { hours } : {}) });
  }

  const share = String(p.share ?? '').trim();
  const window = String(p.window ?? '').trim();
  const maxCalls = Math.min(HARD_MAX_CALLS, Math.max(1, Math.round(Number(p.max_calls) || DEFAULT_MAX_CALLS)));
  const keepTranscript = p.keep_transcript === true || p.keep_transcript === 'true';
  const notes = Array.isArray(p.notes) ? (p.notes as unknown[]).map(String).filter(Boolean) : [];

  const env: Envelope = { goal, deadline: deadlineRaw || null, targets, share, window, max_calls: maxCalls, keep_transcript: keepTranscript, notes };
  return { payload: env as unknown as Record<string, unknown>, summary: summarizeEnvelope(env) };
}

/** Short enough to read on a phone: what, who, what it shares, the transcript choice. */
export function summarizeEnvelope(e: Envelope): string {
  const [first, ...backups] = e.targets;
  const who = `${first.name} ${fmtPhone(first.phone)}${backups.length ? ` (backup: ${backups.map((t) => t.name).join(', ')})` : ''}`;
  const lines = [
    `🧾 ${e.goal}${e.deadline ? `, by ${e.deadline}` : ''}${e.window ? `, aiming for ${e.window}` : ''}`,
    `Calls: ${who}, up to ${e.max_calls}x`,
    e.share ? `Shares: ${e.share}` : '',
    e.keep_transcript ? 'Keeping a transcript' : 'No transcript ("keep transcript" to record)',
    ...e.notes.map((n) => `Note: ${n}`),
  ];
  return lines.filter(Boolean).join('\n');
}

function envelopeOf(row: ErrandRow): Envelope {
  return JSON.parse(row.envelope_json) as Envelope;
}

// ── Activation (the `errand` executor, runs inside confirm_action) ──────────

export async function runErrandAction(action: Action): Promise<{ outcome: string; actual_cost_cents: number }> {
  if (!errandsEnabled()) throw new Error('errands are switched off (ERRANDS_ENABLED=false)');
  if (!isPhoneConfigured()) throw new Error('phone calling is not configured, so errands cannot run');
  const env = JSON.parse(action.payload_json) as Envelope;
  const id = createErrand({ action_id: action.id, goal: env.goal, deadline: env.deadline, envelope_json: action.payload_json });
  addErrandEvent(id, 'started', `approved as action #${action.id}`);
  // Work it now rather than waiting for the next tick.
  later(1000, () => { void processErrand(id); });
  return { outcome: `Errand #${id} started. I'll work on it and report back in your check-in.`, actual_cost_cents: 0 };
}

/**
 * Start a call the owner asked for themselves: no proposal, no "go". Same runner,
 * so a dial that never connects is still noticed and reported.
 */
export function startCallNow(env: Envelope, actionId: number | null): number {
  const e: Envelope = { ...env, reply_mode: true };
  const id = createErrand({ action_id: actionId, goal: e.goal, deadline: e.deadline, envelope_json: JSON.stringify(e) });
  addErrandEvent(id, 'started', actionId ? `approved as action #${actionId}` : 'owner asked for this call');
  later(500, () => { void processErrand(id); });
  return id;
}

// ── Calling hours ───────────────────────────────────────────────────────────

/** Business calling hours on the local clock: Mon–Sat, ERRAND_CALL_START–ERRAND_CALL_END (default 9–18). */
function etParts(at: Date): { dow: number; hour: number; minute: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: getTimezone(), weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false });
  const parts = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  const dows: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { dow: dows[parts.weekday] ?? 1, hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

/** "Mon–Sat 9–6", from the configured calling hours. */
function callingHoursText(): string {
  const h = (n: number) => String(n % 12 || 12);
  return `Mon–Sat ${h(num('ERRAND_CALL_START', 9))}–${h(num('ERRAND_CALL_END', 18))}`;
}

export function inCallingHours(at = new Date()): boolean {
  const start = num('ERRAND_CALL_START', 9);
  const end = num('ERRAND_CALL_END', 18);
  const { dow, hour } = etParts(at);
  return dow !== 0 && hour >= start && hour < end;
}

/** Next instant (checked in 15-minute steps) that falls inside calling hours. */
export function nextCallingTime(from = new Date()): Date {
  const t = new Date(from.getTime());
  for (let i = 0; i < 4 * 24 * 8; i++) {
    if (inCallingHours(t)) return t;
    t.setTime(t.getTime() + 15 * 60_000);
  }
  return t;
}

function sqlTime(d: Date): string {
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

function deadlinePassed(e: Envelope): boolean {
  return !!e.deadline && todayET() > e.deadline;
}

function deadlineSoon(e: Envelope): boolean {
  if (!e.deadline) return false;
  const end = new Date(`${e.deadline}T23:59:00${localOffset(new Date(`${e.deadline}T12:00:00Z`))}`).getTime();
  return end - Date.now() < 24 * 3600_000;
}

// ── Owner notifications ─────────────────────────────────────────────────────

type NotifyKind = 'done' | 'blocked' | 'failed' | 'callback';
type Notify = (row: ErrandRow, kind: NotifyKind, text: string) => Promise<void>;
let notifyOverride: Notify | null = null;
/** Tests swap this out so nothing is texted. */
export function setErrandNotifier(fn: Notify | null): void { notifyOverride = fn; }

/** Timers here must never keep a script (or a test) alive. */
function later(ms: number, fn: () => void): void {
  setTimeout(fn, ms).unref();
}

async function tellOwner(row: ErrandRow, kind: NotifyKind, text: string): Promise<void> {
  if (notifyOverride) return notifyOverride(row, kind, text);
  if (envelopeOf(row).silent) return;
  const env = envelopeOf(row);
  const subject = `errand:${row.id}`;
  if (kind === 'callback') {
    // Someone called back: news the owner would want now, not at the next check-in.
    try {
      await sendInterrupt({ source: 'errands', subject: `${subject}:callback`, kind: 'reply', text });
    } catch (err) {
      console.error(`[errands] could not notify about #${row.id} callback:`, err);
    }
    return;
  }
  const headline = kind === 'done' ? '✅' : kind === 'blocked' ? '🧾' : '⚠️';
  const who = env.targets[Math.min(row.target_idx, env.targets.length - 1)]?.name;
  const body = env.reply_mode
    ? `📞 ${who}: ${text}`
    : `${headline} ${shortGoal(env.goal)}: ${text}`;
  // The owner approved this errand and is waiting on it: results go to them
  // directly, not into the next check-in.
  await updateOwner(subject, body, { milestone: true, source: 'errands' });
}

function shortGoal(goal: string): string {
  const g = goal.replace(/\s+/g, ' ').trim();
  return g.length > 70 ? `${g.slice(0, 67).replace(/\s+\S*$/, '')}…` : g;
}

/** One progress line between calls. Milestones: moved to the next place, or pushed to another day. */
async function progressUpdate(row: ErrandRow, line: string, milestone: boolean): Promise<void> {
  if (notifyOverride || envelopeOf(row).silent) return;
  await updateOwner(`errand:${row.id}`, `📞 ${shortGoal(envelopeOf(row).goal)}: ${line}`, { milestone, source: 'errands' });
}

/** " (Spoke with Pat, front desk; ref 4471.)" for the owner's texts. */
function whoSaid(result: CallResult): string {
  const n = result.notes;
  if (!n?.spokeWith && !n?.reference) return '';
  const bits = [n.spokeWith && !/automated|voicemail/i.test(n.spokeWith) ? `Spoke with ${n.spokeWith}` : '', n.reference ? `ref ${n.reference}` : ''].filter(Boolean);
  return bits.length ? ` (${bits.join('; ')}.)` : '';
}

/** Plain words for what a call ran into. */
function plainResult(result: CallResult): string {
  const menu = result.menuLog?.length ? ` (phone menu: ${result.menuLog.join('; ').replace(/Pressed (\d) \(([^)]*)\)/g, 'pressed $1 for $2')})` : '';
  if (result.status === 'voicemail') return `went to voicemail${result.botSaid ? ', left a message' : ''}`;
  const theySaid = result.transcriptTail?.split('\n').filter((l) => l.startsWith('Them: ')).at(-1)?.slice(6).trim();
  const heard = theySaid ? `; last thing they said: "${theySaid.slice(0, 120)}"` : '';
  if (result.endedWithoutOutcome || /without a recorded outcome/i.test(result.outcome)) return `the call dropped${theySaid ? '' : ' before I reached anyone'}${menu}${heard}`;
  const o = result.outcome.replace(/\s+/g, ' ').trim().replace(/\.$/, '');
  return `${o.length > 160 ? `${o.slice(0, 157)}…` : o}${menu}`;
}

// ── Bookings → calendar ─────────────────────────────────────────────────────

export interface CalendarBooking {
  title: string; description: string; date: string; startTime: string; endTime: string;
  location?: string; sourceRef: string;
}
type CalendarCreator = (b: CalendarBooking) => Promise<{ eventId: string | null; htmlLink: string | null }>;
let calendarOverride: CalendarCreator | null = null;
/** Tests swap this out so nothing reaches Google. */
export function setErrandCalendar(fn: CalendarCreator | null): void { calendarOverride = fn; }

/** A Date as local wall-clock date + HH:MM. */
function etDateTime(d: Date): { date: string; time: string } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: getTimezone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/**
 * Put a booking from a call on the owner's calendar and log it. Never throws:
 * a calendar problem must not undo a finished errand. Returns the sentence the
 * owner sees.
 */
async function addBookingToCalendar(row: ErrandRow, booking: CallBooking, placeName: string): Promise<string> {
  try {
    const start = new Date(booking.start);
    if (!booking.start || Number.isNaN(start.getTime())) throw new Error(`no clear start time ("${booking.start}")`);
    const endRaw = booking.end ? new Date(booking.end) : null;
    const end = endRaw && !Number.isNaN(endRaw.getTime()) && endRaw > start ? endRaw : new Date(start.getTime() + 3600_000);
    const s = etDateTime(start);
    const e = etDateTime(end);
    const base = booking.title || row.goal;
    const title = base.toLowerCase().includes(placeName.toLowerCase()) ? base : `${base} — ${placeName}`;
    const description = [
      booking.confirmation ? `Confirmation: ${booking.confirmation}` : '',
      `Booked by ${getBotName()} (errand #${row.id})`,
    ].filter(Boolean).join('\n');
    const create = calendarOverride ?? createCalendarEventRaw;
    const { eventId, htmlLink } = await create({
      title, description, date: s.date, startTime: s.time,
      // The calendar helper keeps an event on one day; clamp an overnight end.
      endTime: e.date === s.date ? e.time : '23:59',
      location: booking.location, sourceRef: `errand:${row.id}`,
    });
    addErrandEvent(row.id, 'booked', `${title} ${s.date} ${s.time}${booking.confirmation ? ` (conf ${booking.confirmation})` : ''}; event ${eventId ?? '?'}${htmlLink ? ` ${htmlLink}` : ''}`);
    return 'Added to your calendar.';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[errands] could not add errand #${row.id} booking to the calendar:`, msg);
    addErrandEvent(row.id, 'calendar_error', msg);
    return "Couldn't add it to your calendar, so add it yourself.";
  }
}

function finish(row: ErrandRow, status: 'done' | 'failed', outcome: string): void {
  updateErrand(row.id, { status, outcome, call_state: null, call_started_at: null, next_check_at: null, finished_at: sqlTime(new Date()) });
  addErrandEvent(row.id, status, outcome);
}

/**
 * What the calls actually ran into, in plain words, for the owner: how many
 * calls, where they got stuck (a menu, voicemail, no answer), and the keys
 * pressed. "Used all 2 calls" told the owner nothing they could act on.
 */
export function whatHappened(id: number): string {
  const results = getErrandEvents(id, 30).filter((e) => e.type === 'call_result').reverse();
  if (!results.length) return "couldn't get through.";
  const details = results.map((e) => String(e.detail ?? ''));
  const lines = details.map((d) => d.split('\n')[0].replace(/\s*Menu:.*$/, '').replace(/^[^:]+:\s*/, ''));
  const menus = details.map((d) => d.match(/Menu: ([^\n]*)/)?.[1]).filter(Boolean) as string[];
  const kinds = lines.map((l) => (/no one engaged|hold music|silence/i.test(l) ? 'menu' : /voicemail/i.test(l) ? 'voicemail' : /no answer/i.test(l) ? 'no answer' : 'other'));
  const n = results.length;
  let what: string;
  if (kinds.every((k) => k === 'menu')) {
    const path = menus.at(-1)?.replace(/Pressed (\d) \(([^)]*)\)/g, '$1 ($2)').replace(/;\s*/g, ' → ');
    what = `couldn't reach a person in ${n} call${n === 1 ? '' : 's'}. Their phone menu${path ? ` (I pressed ${path})` : ''} never got me to anyone or a working voicemail.`;
  } else if (kinds.every((k) => k === 'no answer')) {
    what = `no one picked up (${n} call${n === 1 ? '' : 's'}).`;
  } else {
    const last = lines.at(-1)!.replace(/^(retry_later|voicemail|blocked|failed)\s*[—-]\s*/, '');
    const dropped = /without a recorded outcome/i.test(last) ? `the call dropped before I reached anyone${menus.at(-1) ? ` (phone menu: ${menus.at(-1)!.replace(/Pressed (\d) \(([^)]*)\)/g, 'pressed $1 for $2')})` : ''}.` : last;
    what = `${n} call${n === 1 ? '' : 's'}; last one: ${dropped}`;
  }
  return what;
}

function block(row: ErrandRow, reason: string): void {
  updateErrand(row.id, { status: 'waiting', outcome: reason, call_state: null, call_started_at: null, next_check_at: null });
  addErrandEvent(row.id, 'blocked', reason);
}

// ── Call notes: who we spoke with and what they said ────────────────────────

function noteDay(at: string): string {
  return new Date(`${at.replace(' ', 'T')}Z`).toLocaleDateString('en-US', { timeZone: getTimezone(), weekday: 'short', month: 'short', day: 'numeric' });
}

/** "Mon, Oct 5: spoke with Pat (front desk). They said … Ref 4471. They'll …" */
export function noteLine(n: CallNoteRow): string {
  const parts = [
    n.direction === 'callback' ? 'they called us back' : '',
    n.spoke_with ? `spoke with ${n.spoke_with}` : '',
    n.said ? `they said: ${n.said}` : n.summary,
    n.reference ? `reference ${n.reference}` : '',
    n.direct_line ? `direct line: ${n.direct_line}` : '',
    n.promised ? `they said they'd ${n.promised.replace(/^(they('ll| will)|will)\s+/i, '')}` : '',
  ].filter(Boolean);
  return `${noteDay(n.at)}: ${parts.join('. ')}`.replace(/\.\./g, '.');
}

/** Save what a call learned, for the next call to this place and for "who did we talk to". */
export function recordCallNote(row: ErrandRow, target: ErrandTarget, result: CallResult, direction: 'out' | 'callback' = 'out'): void {
  if (envelopeOf(row).silent) return;
  const n = result.notes;
  const engaged = !/no one engaged/i.test(result.outcome) || !!result.menuLog?.length;
  if (!n && !engaged) return;
  const menu = result.menuLog?.length ? `Phone menu: ${result.menuLog.join('; ')}.` : '';
  try {
    const id = addCallNote({
      phone: target.phone, business: target.name, errand_id: row.id, direction, status: result.status,
      spoke_with: n?.spokeWith ?? null,
      said: [n?.said, menu].filter(Boolean).join(' ') || null,
      reference: n?.reference ?? null, direct_line: n?.directLine ?? null, promised: n?.promised ?? null,
      summary: result.outcome,
    });
    const saved = callNotesFor({ phone: target.phone }, 1).find((x) => x.id === id);
    if (saved && (n?.spokeWith || n?.said || n?.reference || n?.promised)) {
      saveFact({
        subject: target.name, predicate: 'call note', object: noteLine(saved), fact_type: 'reference',
        source: 'errand', source_ref: `errand:${row.id}`, sensitive: true,
      });
    }
  } catch (err) {
    console.error(`[errands] could not save call notes for #${row.id}:`, err);
  }
}

/** Earlier calls with this place, for the caller to pick up where things left off. */
export function priorCallNotes(target: ErrandTarget, limit = 4): string[] {
  return callNotesFor({ phone: target.phone, business: target.name }, limit).reverse().map(noteLine);
}

// ── Runner ──────────────────────────────────────────────────────────────────

const inFlight = new Set<number>();

/** What the callee-side AI is told for this attempt: goal, aim, owner notes, and what happened so far. */
function callBrief(row: ErrandRow, env: Envelope): { goal: string; context: string } {
  const target = env.targets[Math.min(row.target_idx, env.targets.length - 1)];
  const earlier = target ? priorCallNotes(target) : [];
  const history = getErrandEvents(row.id, 20)
    .filter((e) => e.type === 'call_result' || e.type === 'callback' || e.type === 'note')
    .reverse()
    .map((e) => `- ${e.detail}`)
    .slice(-6);
  const goal = [
    env.goal,
    env.window ? `Aim for: ${env.window}.` : '',
    env.notes.length ? `Owner's latest instructions: ${env.notes.join(' ')}` : '',
    history.length ? `What has happened so far on this errand:\n${history.join('\n')}` : '',
    earlier.length ? `Earlier calls with ${target.name} (refer to who said what if it helps, e.g. "Pat mentioned on Monday…"):\n${earlier.map((l) => `- ${l}`).join('\n')}` : '',
    preferencesFor(env.goal),
  ].filter(Boolean).join('\n');
  return { goal, context: env.share };
}

/** Advance one errand by at most one step. Safe to call any time. */
export async function processErrand(id: number): Promise<void> {
  if (inFlight.has(id)) return;
  inFlight.add(id);
  try {
    const row = getErrand(id);
    if (!row || row.status !== 'active' || row.call_state) return;
    const env = envelopeOf(row);

    if (deadlinePassed(env)) {
      finish(row, 'failed', `Deadline ${env.deadline} passed without getting it done.`);
      await tellOwner(row, 'failed', `deadline passed without getting it done. Want me to keep trying?`);
      return;
    }
    if (row.calls_made >= env.max_calls) {
      block(row, `Used all ${env.max_calls} calls without finishing.`);
      await tellOwner(row, 'blocked', `${whatHappened(row.id)} Want me to try again tomorrow morning, email them, or drop it?`);
      return;
    }
    if (row.target_idx >= env.targets.length) {
      block(row, 'Tried every approved number.');
      await tellOwner(row, 'blocked', `${whatHappened(row.id)} Give me another number, want me to email them, or drop it?`);
      return;
    }
    if (!errandsEnabled()) return;
    // Phone line down (tunnel off, or the last call's voice never joined): a call would only reach silence. Wait.
    const voiceDownUntil = Number(getMemory('errands', 'voice_down_until') ?? 0);
    if ((!linkUp || voiceDownUntil > Date.now()) && !notifyOverride) { updateErrand(id, { next_check_at: sqlTime(new Date(Date.now() + 5 * 60_000)) }); return; }
    const dialNow = env.reply_mode && row.calls_made === 0;
    if (!dialNow && !inCallingHours()) {
      const at = nextCallingTime();
      updateErrand(id, { next_check_at: sqlTime(at) });
      if (row.calls_made === 0 && !getErrandEvents(id, 50).some((e) => e.type === 'deferred')) {
        addErrandEvent(id, 'deferred', `first call ${fmtWhen(at)}`);
        await progressUpdate(row, `calls go out ${callingHoursText()}, so the first call to ${env.targets[row.target_idx]?.name} is ${fmtWhen(at)}.`, true);
      }
      return;
    }
    // Closed right now: don't call a restaurant at 2pm when it opens at 5.
    const tgt = env.targets[row.target_idx];
    if (tgt?.hours && !isOpenAt(tgt.hours)) {
      const at = nextOpenTime(tgt.hours, new Date(), !dialNow);
      updateErrand(id, { next_check_at: sqlTime(at) });
      if (!getErrandEvents(id, 30).some((e) => e.type === 'closed' && e.detail?.startsWith(`[t${row.target_idx}]`))) {
        addErrandEvent(id, 'closed', `[t${row.target_idx}] ${tgt.name} is closed; calling ${fmtWhen(at)}`);
        await progressUpdate(row, `${tgt.name} is closed right now, so I'll call when they're open: ${fmtWhen(at)}.`, true);
      }
      return;
    }
    // The cap stops a runaway loop (the per-number and per-errand limits are what keep any one business from being pestered).
    if (countErrandCallsToday() >= DAILY_CALL_CAP()) {
      // Try again tomorrow morning; the cap protects against a runaway loop.
      updateErrand(id, { next_check_at: sqlTime(nextCallingTime(new Date(Date.now() + 12 * 3600_000))) });
      return;
    }

    const target = env.targets[row.target_idx];
    const brief = callBrief(row, env);
    const actionId = proposeAction({
      kind: 'call', tool_name: 'place_call',
      summary: `Errand #${id} call to ${target.name} (${fmtPhone(target.phone)})`,
      payload_json: JSON.stringify({ to: target.phone, name: target.name, goal: brief.goal, context: brief.context, errand_id: id }),
      reversible: false, category: 'errand', created_by_group: 'admin', errand_id: id,
    });
    confirmAction(actionId);
    markActionExecuting(actionId);
    updateErrand(id, { call_state: 'dialing', call_started_at: sqlTime(new Date()), calls_made: row.calls_made + 1 });
    addErrandEvent(id, 'dialing', `[t${row.target_idx}] ${target.name} (${fmtPhone(target.phone)}), action #${actionId}`);
    try {
      const sid = await placeErrandCall({
        errandId: id, actionId, to: target.phone, name: target.name,
        goal: brief.goal, context: brief.context, keepTranscript: env.keep_transcript,
      });
      if (sid) addErrandEvent(id, 'twilio', sid);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      markActionFailed(actionId, msg);
      updateErrand(id, { call_state: null, call_started_at: null, next_check_at: sqlTime(new Date(Date.now() + 30 * 60_000)) });
      addErrandEvent(id, 'call_result', `Could not place the call to ${target.name}: ${msg}`);
    }
  } finally {
    inFlight.delete(id);
  }
}

/** Apply a finished (or timed-out) call to its errand and pick the next step. */
export async function applyCallResult(id: number, result: CallResult): Promise<void> {
  const row = getErrand(id);
  if (!row) return;
  if (row.status !== 'active') {
    // Cancelled mid-call: still close the call's audit row and clear the call state.
    const dial = getErrandEvents(id, 50).find((e) => e.type === 'dialing');
    const aid = Number(dial?.detail?.match(/action #(\d+)/)?.[1]);
    if (aid) markActionDone(aid, { outcome: `${result.status}: ${result.outcome}`, actual_cost_cents: 0 });
    updateErrand(id, { call_state: null, call_started_at: null });
    return;
  }
  const env = envelopeOf(row);
  const target = env.targets[row.target_idx];
  // The checker: "done" has to be backed by what was actually said on the call.
  if (result.status === 'done') {
    const b = result.booking;
    const v = await checkDone({
      kind: 'call', goal: row.goal, claim: result.outcome,
      evidence: [b ? `Booking recorded: ${b.title} at ${b.start}${b.confirmation ? ` (conf ${b.confirmation})` : ''}` : '', result.botSaid ? `${getBotName()} said: ${result.botSaid}` : '', result.transcriptTail].filter(Boolean).join('\n'),
    });
    if (!v.ok) result = { ...result, status: 'blocked', outcome: `Not confirmed: ${v.why} (${getBotName()}'s note: ${result.outcome})`, booking: undefined };
  }
  // Dials to this target since the owner last restarted the list (newest first).
  const events = getErrandEvents(id, 200);
  const restart = events.findIndex((e) => e.type === 'note' && e.detail?.includes('starting over'));
  const sinceRestart = restart === -1 ? events : events.slice(0, restart);
  const attemptsHere = sinceRestart.filter((e) => e.type === 'dialing' && e.detail?.startsWith(`[t${row.target_idx}]`)).length
    - sinceRestart.filter((e) => e.type === 'phone_down' && e.detail?.startsWith(`[t${row.target_idx}]`)).length;

  // Close out the audit row for this call attempt.
  const lastDial = events.find((e) => e.type === 'dialing');
  const actionId = Number(lastDial?.detail?.match(/action #(\d+)/)?.[1]);
  if (actionId) markActionDone(actionId, { outcome: `${result.status}: ${result.outcome}`, actual_cost_cents: 0 });

  const line = `${target.name}: ${result.status} — ${result.outcome}${result.followUp ? ` (next: ${result.followUp})` : ''}`;
  const extra = [
    result.menuLog?.length ? `Menu: ${result.menuLog.join('; ')}` : '',
    result.botSaid ? `${getBotName()} said: ${result.botSaid}` : '',
    result.transcriptTail,
  ].filter(Boolean).join('\n');
  addErrandEvent(id, 'call_result', line + (extra ? `\n${extra}` : ''));
  recordCallNote(row, target, result);
  updateErrand(id, { call_state: null, call_started_at: null });
  const fresh = getErrand(id)!;

  // The owner asked for this call and the line ended mid-way after the bot had spoken
  // (often a voicemail cutting off). Say what was said instead of quietly
  // retrying tomorrow; a reply like "try again" resumes it.
  if (env.reply_mode && result.endedWithoutOutcome && result.botSaid) {
    block(fresh, 'The line ended before the call wrapped up.');
    await tellOwner(fresh, 'blocked', `the line ended before I could wrap up (likely their voicemail cutting off). I said: "${result.botSaid.slice(0, 220)}". Say "try again" and I'll call back.`);
    return;
  }

  switch (result.status) {
    case 'done': {
      finish(fresh, 'done', result.outcome);
      const cal = result.booking ? ` ${await addBookingToCalendar(fresh, result.booking, target.name)}` : '';
      await tellOwner(fresh, 'done', `${result.outcome}${whoSaid(result)}${cal}${result.followUp ? ` Your move: ${result.followUp}` : ''}`);
      return;
    }
    case 'blocked': {
      block(fresh, result.followUp || result.outcome);
      await tellOwner(fresh, 'blocked', `${target.name} needs you: ${result.followUp || result.outcome}${whoSaid(result)}`);
      return;
    }
    case 'failed':
    case 'retry_later':
    case 'voicemail': {
      // A definite "can't do it here", or out of tries on this number: move on.
      // A voicemail left on a one-off call is as far as that call can go.
      if (result.status === 'voicemail' && env.reply_mode) {
        finish(fresh, 'done', result.outcome);
        await tellOwner(fresh, 'done', `${result.outcome}${result.followUp ? ` ${result.followUp}` : ''}`);
        return;
      }
      const moveOn = result.status === 'failed' || attemptsHere >= ATTEMPTS_PER_TARGET;
      if (moveOn) updateErrand(id, { target_idx: fresh.target_idx + 1 });
      const gap = moveOn ? 60_000 : env.reply_mode ? 15 * 60_000 : RETRY_GAP_MS();
      updateErrand(id, { next_check_at: sqlTime(new Date(Date.now() + gap)) });
      later(gap + 1000, () => { void processErrand(id); });
      const nextTarget = env.targets[moveOn ? fresh.target_idx + 1 : fresh.target_idx];
      if (nextTarget && fresh.calls_made < env.max_calls) {
        const at = (env.reply_mode && fresh.calls_made === 0) ? new Date(Date.now() + gap) : nextCallingTime(new Date(Date.now() + gap));
        const otherDay = at.toDateString() !== new Date().toDateString() || at.getTime() - Date.now() > 3 * 3600_000;
        const when = at.getTime() - Date.now() < 5 * 60_000 ? 'now' : fmtWhen(at);
        const next = moveOn ? `Trying ${nextTarget.name} next, ${when}.` : `Trying them again ${when}.`;
        const hours = otherDay && !inCallingHours(new Date(Date.now() + gap)) ? ` (calls go out ${callingHoursText()})` : '';
        // Every call result goes to the owner (a few a day at most), so they hear how it's going.
        await progressUpdate(fresh, `${target.name}: ${plainResult(result)}. ${next}${hours}`, true);
      }
      return;
    }
  }
}

// ── Callbacks (a business calls the bot's number back) ──────────────────────

/** How long after an errand finishes a callback about it is still answered. */
const CALLBACK_DAYS = 3;

/**
 * The errand an inbound caller is most likely returning a call about: one whose
 * approved targets include this number and that is open, or finished within
 * the last few days. Null for anyone else.
 */
export function findErrandForCallback(phone: string): { row: ErrandRow; target: ErrandTarget } | null {
  const from = normalizePhone(phone);
  if (from.length !== 10) return null;
  for (const row of getErrandsForCallback(CALLBACK_DAYS)) {
    const target = envelopeOf(row).targets.find((t) => normalizePhone(t.phone) === from);
    if (target) return { row, target };
  }
  return null;
}

/** What the answering AI is told: the errand, what it may share, and the history. */
function callbackMatch(phone: string): CallbackMatch | null {
  const hit = findErrandForCallback(phone);
  if (!hit) return null;
  const env = envelopeOf(hit.row);
  const history = getErrandEvents(hit.row.id, 30)
    .filter((e) => e.type === 'call_result' || e.type === 'callback' || e.type === 'booked')
    .reverse()
    .map((e) => (e.detail ?? '').split('\n')[0])
    .filter(Boolean)
    .slice(-5);
  const status = hit.row.status === 'done' ? `Already marked done: ${hit.row.outcome ?? ''}`
    : hit.row.status === 'failed' ? `Marked as not done: ${hit.row.outcome ?? ''}` : '';
  return {
    errandId: hit.row.id, name: hit.target.name,
    goal: [env.goal, env.window ? `Aim for: ${env.window}.` : '', status].filter(Boolean).join('\n'),
    share: env.share, notes: env.notes, history: [...priorCallNotes(hit.target).map((l) => `Earlier call: ${l}`), ...history], keepTranscript: env.keep_transcript,
  };
}

/**
 * A callback call ended. Logged on the errand and told to the owner as a reply.
 * A "done" callback finishes an errand that wasn't done yet, unless the runner
 * is mid-call on it (then it's only logged and reported).
 */
export async function applyCallbackResult(id: number, caller: string, result: CallResult): Promise<void> {
  const row = getErrand(id);
  if (!row) return;
  const who = caller || 'They';
  addErrandEvent(id, 'callback', `${who} called back: ${result.status} — ${result.outcome}${result.followUp ? ` (next: ${result.followUp})` : ''}`);
  const target = envelopeOf(row).targets.find((t) => t.name === caller);
  if (target) recordCallNote(row, target, result, 'callback');

  let cal = '';
  const finishable = ['active', 'waiting', 'failed'].includes(row.status) && !row.call_state;
  if (result.status === 'done' && finishable) {
    finish(row, 'done', result.outcome);
    if (result.booking) cal = ` ${await addBookingToCalendar(row, result.booking, who)}`;
  }
  const text = `📞 ${who} called back: ${result.outcome}${whoSaid(result)}${cal}${result.followUp ? ` Your move: ${result.followUp}` : ''}`;
  await tellOwner(getErrand(id) ?? row, 'callback', text);
}

/** Calls whose result never arrived: a dial that never connected, or a dropped call. */
async function sweepStuckCalls(): Promise<void> {
  const now = Date.now();
  for (const row of getErrandsInCall()) {
    const started = row.call_started_at ? new Date(`${row.call_started_at}Z`).getTime() : 0;
    const limit = row.call_state === 'dialing' ? DIAL_TIMEOUT_MS : CONNECTED_TIMEOUT_MS();
    if (!started || now - started <= limit) continue;
    if (row.call_state === 'dialing') {
      // Twilio sends no status callback, so ask it what happened to the leg.
      // Their side answered but the assistant's voice never joined = our phone link
      // is down (e.g. the tunnel is off, so the business hears silence).
      const sid = getErrandEvents(row.id, 20).find((e) => e.type === 'twilio')?.detail ?? '';
      const info = sid ? await twilioCallInfo(sid) : null;
      if (info && ['queued', 'ringing', 'in-progress'].includes(info.status) && now - started < 15 * 60_000) continue;
      if (info && info.status === 'completed' && info.duration > 0) { await phoneDown(row); continue; }
      const outcome = info?.status === 'busy' ? 'The line was busy.'
        : info?.status === 'failed' ? "The call didn't go through."
          : 'No answer.';
      void applyCallResult(row.id, { status: 'retry_later', outcome, followUp: '', transcriptTail: '' });
    } else {
      void applyCallResult(row.id, { status: 'retry_later', outcome: 'The call dropped without a result.', followUp: '', transcriptTail: '' });
    }
  }
}

/** A dial that failed on our side: it doesn't use up a call, and the owner hears about the outage once. */
async function phoneDown(row: ErrandRow): Promise<void> {
  const env = envelopeOf(row);
  const target = env.targets[row.target_idx];
  const dial = getErrandEvents(row.id, 50).find((e) => e.type === 'dialing');
  const aid = Number(dial?.detail?.match(/action #(\d+)/)?.[1]);
  if (aid) markActionFailed(aid, 'The phone link was down; the call never connected on our side.');
  updateErrand(row.id, {
    call_state: null, call_started_at: null, calls_made: Math.max(0, row.calls_made - 1),
    next_check_at: sqlTime(new Date(Date.now() + 15 * 60_000)),
  });
  addErrandEvent(row.id, 'phone_down', `[t${row.target_idx}] ${target?.name}: answered, but the assistant's voice never joined (phone link down). Not counted.`);
  // Stop every errand from dialing for an hour: each try is a business hearing silence.
  setMemory('errands', 'voice_down_until', String(Date.now() + 60 * 60_000));
  await phoneLinkAlert(`${target?.name ?? 'a business'} picked up and heard silence`);
}

// ── Phone link health (Tailscale Funnel carries the OpenAI + Twilio webhooks) ──

const TAILSCALE_BIN = env('TAILSCALE_BIN', '/Applications/Tailscale.app/Contents/MacOS/Tailscale');
// Kept in memory (group `errands`) so a restart mid-outage doesn't forget it already
// warned the owner, or dial into the outage while it waits 10 minutes to warn again.
let linkDownSince: number | null = Number(getMemory('errands', 'link_down_since') ?? '') || null;
let linkAlerted = getMemory('errands', 'link_alerted') === '1';
let linkUp = true;
function saveLink(): void {
  setMemory('errands', 'link_down_since', linkDownSince ? String(linkDownSince) : '');
  setMemory('errands', 'link_alerted', linkAlerted ? '1' : '0');
}

async function phoneLinkAlert(detail: string): Promise<void> {
  if (notifyOverride) return;
  linkAlerted = true;
  saveLink();
  const tsUp = await tailscaleRunning();
  const fix = tsUp === false
    ? 'Tailscale is off on this Mac: click its menu-bar icon and Connect.'
    : `Tailscale is on, so OpenAI isn't calling ${getBotName()} back: check the webhook at platform.openai.com → Settings → Webhooks (re-enable it, then Send test event).`;
  await updateOwner('phone-link', `⚠️ ${getBotName()}'s phone line is down, so calls are paused for now (${detail}). ${fix} Calls resume on their own.`, { milestone: true, source: 'errands' });
}

async function tailscaleRunning(): Promise<boolean | null> {
  try {
    const { execFile } = await import('node:child_process');
    const out = await new Promise<string>((resolve, reject) => {
      execFile(TAILSCALE_BIN, ['status', '--json'], { timeout: 10_000 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)));
    });
    return (JSON.parse(out) as { BackendState?: string }).BackendState === 'Running';
  } catch {
    return null; // can't tell; don't alarm
  }
}

/** Every tick: Tailscale down 10+ min → one text; back up → one "back" text. */
async function checkPhoneLink(): Promise<void> {
  if (!isPhoneConfigured() || notifyOverride) return;
  const up = await tailscaleRunning();
  if (up === null) return;
  linkUp = up;
  if (up) {
    if (linkAlerted) await updateOwner('phone-link', `✅ ${getBotName()}'s phone line is back. Paused calls pick up on their own.`, { milestone: true, source: 'errands' });
    if (linkDownSince || linkAlerted) { linkDownSince = null; linkAlerted = false; saveLink(); }
    return;
  }
  if (!linkDownSince) { linkDownSince = Date.now(); saveLink(); }
  if (!linkAlerted && Date.now() - linkDownSince >= 10 * 60_000) await phoneLinkAlert('Tailscale is off on this Mac');
}

async function tick(): Promise<void> {
  try {
    await checkPhoneLink();
    await sweepStuckCalls();
    // Don't dial into a known outage: the call would only reach silence.
    if (linkUp && !linkAlerted) for (const row of getDueErrands()) await processErrand(row.id);
    await silenceCheck();
  } catch (err) {
    console.error('[errands] tick failed:', err);
  }
}

/** An active errand the owner hasn't heard about in a few hours gets one "still on it" line. */
async function silenceCheck(): Promise<void> {
  if (notifyOverride) return;
  for (const row of listErrands({ open: true })) {
    if (row.status !== 'active' || row.call_state) continue;
    const started = Date.parse(`${row.created_at.replace(' ', 'T')}Z`);
    if (!dueForCheckIn(`errand:${row.id}`, started)) continue;
    const so = row.calls_made ? `${whatHappened(row.id)} ` : '';
    await progressUpdate(row, `still on it. ${so}${nextCallLine(row).replace(/ Don't tell.*$/, '')}`, false);
  }
}

/** One line for "what's going on": what the calls ran into so far and when the next one is. */
export function errandStatusLine(row: ErrandRow): string {
  if (row.call_state) return 'on a call right now.';
  const so = row.calls_made ? `${whatHappened(row.id)} ` : '';
  return `${so}${nextCallLine(row).replace(/ Don't tell.*$/, '')}`;
}

export function startErrands(): void {
  setErrandLine(errandStatusLine);
  setOneOffCallStarter((c) => startCallNow({
    goal: c.goal, deadline: null, targets: [{ name: c.name || fmtPhone(c.to), phone: c.to }],
    share: c.share, window: '', max_calls: 2, keep_transcript: c.keepTranscript, notes: [],
  }, c.actionId));
  setErrandCallHooks({
    onConnected: (id) => {
      setMemory('errands', 'voice_down_until', '');
      updateErrand(id, { call_state: 'connected' });
      addErrandEvent(id, 'connected');
    },
    onFinished: (id, result) => { void applyCallResult(id, result); },
    findCallback: callbackMatch,
    onCallback: (id, caller, result) => { void applyCallbackResult(id, caller, result); },
  });
  if (!errandsEnabled()) {
    console.log('[errands] disabled via ERRANDS_ENABLED=false');
    return;
  }
  setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 15_000);
  console.log('[errands] runner started (5-min tick)');
}

// ── Owner-side edits ────────────────────────────────────────────────────────

export function addErrandNote(id: number, note: string): string {
  const row = getErrand(id);
  if (!row) return `Errand #${id} not found.`;
  if (!['active', 'waiting'].includes(row.status)) return `Errand #${id} is ${row.status}.`;
  const env = envelopeOf(row);
  env.notes.push(note.trim());
  const patch: Parameters<typeof updateErrand>[1] = { envelope_json: JSON.stringify(env) };
  addErrandEvent(id, 'note', `Owner: ${note.trim()}`);
  // An answer to a blocked errand resumes it.
  if (row.status === 'waiting') Object.assign(patch, { status: 'active', next_check_at: sqlTime(new Date()) });
  updateErrand(id, patch);
  if (row.status === 'waiting') later(1000, () => { void processErrand(id); });
  return `${row.status === 'waiting' ? `Got it. Errand #${id} is back on.` : `Noted on errand #${id}.`} ${nextCallLine(getErrand(id)!)}`;
}

/** When the next call actually happens, in the owner's time. Tell them this instead of "calling now". */
export function nextCallLine(row: ErrandRow): string {
  if (row.call_state) return 'A call is in progress right now.';
  if (row.status !== 'active') return '';
  const due = row.next_check_at ? new Date(`${row.next_check_at.replace(' ', 'T')}Z`) : new Date();
  const at = nextCallingTime(due.getTime() > Date.now() ? due : new Date());
  return at.getTime() - Date.now() < 6 * 60_000
    ? 'Next call: within a few minutes.'
    : `Next call: ${fmtWhen(at)}${inCallingHours() ? '' : ` (calls go out ${callingHoursText()})`}. Don't tell the owner it's happening now.`;
}

/** Owner allows more calls on a stuck errand, optionally restarting from the first number. */
export function extendErrand(id: number, extraCalls: number, restartTargets: boolean): string {
  const row = getErrand(id);
  if (!row) return `Errand #${id} not found.`;
  if (!['active', 'waiting'].includes(row.status)) return `Errand #${id} is ${row.status}.`;
  const env = envelopeOf(row);
  env.max_calls = Math.min(HARD_MAX_CALLS * 2, row.calls_made + Math.max(1, Math.round(extraCalls)));
  updateErrand(id, {
    envelope_json: JSON.stringify(env), status: 'active', next_check_at: sqlTime(new Date()),
    ...(restartTargets ? { target_idx: 0 } : {}),
  });
  addErrandEvent(id, 'note', `Owner allowed up to ${env.max_calls} calls${restartTargets ? ', starting over from the first number' : ''}.`);
  later(1000, () => { void processErrand(id); });
  return `Errand #${id}: up to ${env.max_calls} calls now.`;
}

export function cancelErrand(id: number): string {
  const row = getErrand(id);
  if (!row) return `Errand #${id} not found.`;
  if (!['active', 'waiting'].includes(row.status)) return `Errand #${id} is already ${row.status}.`;
  updateErrand(id, { status: 'cancelled', next_check_at: null, finished_at: sqlTime(new Date()) });
  addErrandEvent(id, 'cancelled', 'Owner cancelled.');
  return row.call_state ? `Errand #${id} cancelled (a call in progress will finish, but nothing further happens).` : `Errand #${id} cancelled.`;
}

export function describeErrand(row: ErrandRow, withLog = false): string {
  const env = envelopeOf(row);
  const target = env.targets[Math.min(row.target_idx, env.targets.length - 1)];
  const state = row.call_state ? `on a call with ${target.name}`
    : row.status === 'active' ? `${nextCallLine(row).replace(/ Don't tell.*$/, '')} (${target.name})`
      : row.status === 'waiting' ? `waiting on you: ${row.outcome}` : `${row.status}${row.outcome ? `: ${row.outcome}` : ''}`;
  const head = `Errand #${row.id} — ${env.goal} · ${row.calls_made}/${env.max_calls} calls · ${state}`;
  if (!withLog) return head;
  const log = getErrandEvents(row.id, 15).reverse().map((e) => `  ${fmtWhen(e.at)} ${e.type}${e.detail ? `: ${e.detail.split('\n')[0]}` : ''}`);
  const notes = env.targets.flatMap((t) => priorCallNotes(t, 3).map((l) => `  ${t.name}: ${l}`));
  return [head, ...log, ...(notes.length ? ['Call notes (who said what):', ...notes] : [])].join('\n');
}
