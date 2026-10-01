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
  toDialable, isFictionalNumber, placeErrandCall, setErrandCallHooks, setOneOffCallStarter, isPhoneConfigured,
  type CallResult, type CallBooking, type CallbackMatch,
} from './phone.js';
import { sendInterrupt, stageAmbient } from './cos-outbound.js';
import { createCalendarEventRaw } from './tools/calendar.js';
import { normalizePhone } from './lib/phone.js';
import { todayET } from './lib/time-et.js';
import { localOffset } from './lib/time.js';
import { getBotName, getOwner, getTimezone } from './config.js';
import {
  createErrand, getErrand, updateErrand, getDueErrands, getErrandsInCall, getErrandsForCallback, addErrandEvent,
  getErrandEvents, countErrandCallsToday, proposeAction, confirmAction, markActionExecuting,
  markActionDone, markActionFailed, findPersonByPhone, type Action, type ErrandRow,
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

export interface ErrandTarget { name: string; phone: string }
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
    if (!targets.some((x) => x.phone === dial)) targets.push({ name, phone: dial });
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
    : `${headline} Errand #${row.id} (${env.goal}): ${text}`;
  try {
    if (env.reply_mode) {
      // The owner asked for this call and is waiting on the answer.
      await sendInterrupt({ source: 'errands', subject, kind: 'reply', text: body });
    } else if (deadlineSoon(env)) {
      await sendInterrupt({ source: 'errands', subject, kind: 'time-critical', text: body });
    } else if (kind === 'blocked') {
      await sendInterrupt({ source: 'errands', subject, kind: 'decision', text: body });
    } else {
      stageAmbient('errands', body, { subject, detail: body });
    }
  } catch (err) {
    console.error(`[errands] could not notify about #${row.id}:`, err);
  }
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

function block(row: ErrandRow, reason: string): void {
  updateErrand(row.id, { status: 'waiting', outcome: reason, call_state: null, call_started_at: null, next_check_at: null });
  addErrandEvent(row.id, 'blocked', reason);
}

// ── Runner ──────────────────────────────────────────────────────────────────

const inFlight = new Set<number>();

/** What the callee-side AI is told for this attempt: goal, aim, owner notes, and what happened so far. */
function callBrief(row: ErrandRow, env: Envelope): { goal: string; context: string } {
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
      await tellOwner(row, 'blocked', `used all ${env.max_calls} calls without finishing. Allow more calls, add another place, or drop it?`);
      return;
    }
    if (row.target_idx >= env.targets.length) {
      block(row, 'Tried every approved number.');
      await tellOwner(row, 'blocked', 'tried every approved number without finishing. Give me another place to call, or drop it?');
      return;
    }
    if (!errandsEnabled()) return;
    const dialNow = env.reply_mode && row.calls_made === 0;
    if (!dialNow && !inCallingHours()) {
      updateErrand(id, { next_check_at: sqlTime(nextCallingTime()) });
      return;
    }
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
      await placeErrandCall({
        errandId: id, actionId, to: target.phone, name: target.name,
        goal: brief.goal, context: brief.context, keepTranscript: env.keep_transcript,
      });
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
  // Dials to this target since the owner last restarted the list (newest first).
  const events = getErrandEvents(id, 200);
  const restart = events.findIndex((e) => e.type === 'note' && e.detail?.includes('starting over'));
  const attemptsHere = (restart === -1 ? events : events.slice(0, restart))
    .filter((e) => e.type === 'dialing' && e.detail?.startsWith(`[t${row.target_idx}]`)).length;

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
      await tellOwner(fresh, 'done', `${result.outcome}${cal}${result.followUp ? ` Your move: ${result.followUp}` : ''}`);
      return;
    }
    case 'blocked': {
      block(fresh, result.followUp || result.outcome);
      await tellOwner(fresh, 'blocked', `${target.name} needs you: ${result.followUp || result.outcome}`);
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
    share: env.share, notes: env.notes, history, keepTranscript: env.keep_transcript,
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

  let cal = '';
  const finishable = ['active', 'waiting', 'failed'].includes(row.status) && !row.call_state;
  if (result.status === 'done' && finishable) {
    finish(row, 'done', result.outcome);
    if (result.booking) cal = ` ${await addBookingToCalendar(row, result.booking, who)}`;
  }
  const text = `📞 ${who} called back: ${result.outcome}${cal}${result.followUp ? ` Your move: ${result.followUp}` : ''}`;
  await tellOwner(getErrand(id) ?? row, 'callback', text);
}

/** Calls whose result never arrived: a dial that never connected, or a dropped call. */
function sweepStuckCalls(): void {
  const now = Date.now();
  for (const row of getErrandsInCall()) {
    const started = row.call_started_at ? new Date(`${row.call_started_at}Z`).getTime() : 0;
    const limit = row.call_state === 'dialing' ? DIAL_TIMEOUT_MS : CONNECTED_TIMEOUT_MS();
    if (started && now - started > limit) {
      const outcome = row.call_state === 'dialing' ? 'No answer.' : 'The call dropped without a result.';
      void applyCallResult(row.id, { status: 'retry_later', outcome, followUp: '', transcriptTail: '' });
    }
  }
}

async function tick(): Promise<void> {
  try {
    sweepStuckCalls();
    for (const row of getDueErrands()) await processErrand(row.id);
  } catch (err) {
    console.error('[errands] tick failed:', err);
  }
}

export function startErrands(): void {
  setOneOffCallStarter((c) => startCallNow({
    goal: c.goal, deadline: null, targets: [{ name: c.name || fmtPhone(c.to), phone: c.to }],
    share: c.share, window: '', max_calls: 2, keep_transcript: c.keepTranscript, notes: [],
  }, c.actionId));
  setErrandCallHooks({
    onConnected: (id) => {
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
  return row.status === 'waiting' ? `Got it. Errand #${id} is back on.` : `Noted on errand #${id}.`;
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
    : row.status === 'active' ? `next try ${row.next_check_at ? `after ${row.next_check_at} UTC` : 'soon'} (${target.name})`
      : row.status === 'waiting' ? `waiting on you: ${row.outcome}` : `${row.status}${row.outcome ? `: ${row.outcome}` : ''}`;
  const head = `Errand #${row.id} — ${env.goal} · ${row.calls_made}/${env.max_calls} calls · ${state}`;
  if (!withLog) return head;
  const log = getErrandEvents(row.id, 15).reverse().map((e) => `  ${e.at} ${e.type}${e.detail ? `: ${e.detail.split('\n')[0]}` : ''}`);
  return [head, ...log].join('\n');
}
