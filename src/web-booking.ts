// Errands Phase 3 — online booking (docs/ERRANDS.md).
//
// Books a table / appointment on the web (Resy, OpenTable, or the business's
// own page) through the owner's Chrome via the Assistant Bridge. A bounded
// sub-agent drives the browser with ONLY the booking-scoped browser tools
// (registry key `booking-browser`, tools/web-booking.ts), which refuse to type
// into card/payment fields and stop working once the time box closes.
//
// Two ways in (tools/web-booking.ts#book_online):
//   - the owner asked in their own words → startWebBooking now (no go);
//   - the bot's own idea → propose_action with executor `web_booking`, and
//     runWebBookingAction starts it on "go #action:N".
// Either way the result is a `reply` interrupt, and a done booking lands on the
// calendar. The same actions row is the audit trail (kind 'booking').

import { preferencesFor } from './lib/preferences.js';
import {
  proposeAction, confirmAction, markActionExecuting, markActionDone, markActionFailed,
  type Action,
} from './db.js';
import { isBrowserConnected } from './browser-bridge.js';
import { withBrowserLock } from './lib/browser-lock.js';
import type { createCalendarEventRaw } from './tools/calendar.js';
import { parseNumEnv } from './lib/env.js';
import { todayET } from './lib/time-et.js';
import { tzAbbrev } from './lib/time.js';
import type { GroupConfig } from './group-resolver.js';
import { getBotName, getTimezone } from './config.js';

// ── Payload ─────────────────────────────────────────────────────────────────

export interface BookingPayload {
  what: string;            // "dinner for 4", "oil change"
  where: string;           // site/URL or business name + town
  when: string;            // "Sat 7-8pm"
  party_size?: number;
  share: string;           // details the booking may use, with values
  notes?: string;
  owner_request?: string;  // their words, when they asked for it themselves
}

type Prepared = { payload: Record<string, unknown>; summary: string } | { error: string };

export const FORBIDDEN_SHARE = /\b(card|credit|debit|cvv|cvc|ssn|social security|password|passcode|bank|routing|account number|pin)\b/i;

/** Luhn check on a digit run: a card number, as opposed to a phone number. */
export function looksLikeCardNumber(text: string): boolean {
  for (const m of text.matchAll(/(?:\d[ -]?){13,19}/g)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) continue;
    let sum = 0;
    for (let i = 0; i < digits.length; i++) {
      let d = Number(digits[digits.length - 1 - i]);
      if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
      sum += d;
    }
    if (sum % 10 === 0) return true;
  }
  return false;
}

function isFood(what: string, where: string): boolean {
  return /\b(dinner|lunch|brunch|breakfast|table|restaurant|drinks|resy|opentable|tock|reservation)\b/i.test(`${what} ${where}`);
}

/** Validates a booking and writes the phone-sized summary the owner approves. */
export function prepareWebBooking(p: Record<string, unknown>): Prepared {
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string).trim() : '');
  const what = s('what');
  const where = s('where');
  const when = s('when');
  const share = s('share');
  const notes = s('notes');
  if (!what) return { error: 'needs "what" (e.g. "dinner for 4").' };
  if (!where) return { error: 'needs "where" (the site, URL, or business and town).' };
  if (!when) return { error: 'needs "when" (e.g. "Sat 7-8pm").' };
  if (!share) return { error: 'needs "share": the details the booking may use, with values (at least the name).' };
  if (FORBIDDEN_SHARE.test(share) || looksLikeCardNumber(share) || looksLikeCardNumber(notes)) {
    return { error: 'bookings never use card, bank, ID, or password details. Share only name, phone, email.' };
  }
  let party: number | undefined;
  if (p.party_size != null && p.party_size !== '') {
    party = Math.round(Number(p.party_size));
    if (!Number.isFinite(party) || party < 1 || party > 20) return { error: '"party_size" must be 1-20.' };
  }
  const payload: BookingPayload = { what, where, when, share };
  if (party) payload.party_size = party;
  if (notes) payload.notes = notes;
  if (s('owner_request')) payload.owner_request = s('owner_request');
  const emoji = isFood(what, where) ? '🍽️' : '🗓️';
  const partyText = party && !new RegExp(`\\b${party}\\b`).test(what) ? `, ${party} people` : '';
  const summary = `${emoji} Book ${what} at ${where}, ${when}${partyText}.`;
  return { payload: payload as unknown as Record<string, unknown>, summary };
}

// ── Result parsing ──────────────────────────────────────────────────────────

export interface BookingResult {
  status: 'done' | 'blocked' | 'failed';
  summary: string;
  booking?: { title: string; start: string; end?: string; location?: string; confirmation?: string };
  url?: string;
}

/**
 * The sub-agent's final message must carry one JSON object. Anything we can't
 * read as a valid result is a failure: we never report a booking we can't see.
 */
export function parseBookingResult(text: string): BookingResult {
  const bad = (why: string): BookingResult => ({ status: 'failed', summary: `Couldn't read the booking result (${why}).` });
  if (!text || !text.trim()) return bad('empty reply');
  const candidates: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) candidates.push(m[1]);
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));
  let obj: Record<string, unknown> | null = null;
  for (const c of candidates.reverse()) {
    try {
      const v = JSON.parse(c.trim());
      if (v && typeof v === 'object' && !Array.isArray(v)) { obj = v as Record<string, unknown>; break; }
    } catch { /* try the next one */ }
  }
  if (!obj) return bad('no JSON');
  const status = obj.status;
  if (status !== 'done' && status !== 'blocked' && status !== 'failed') return bad(`status "${String(status)}"`);
  const summary = typeof obj.summary === 'string' && obj.summary.trim() ? obj.summary.trim() : '';
  if (!summary) return bad('no summary');
  const url = typeof obj.url === 'string' ? obj.url : undefined;
  if (status !== 'done') return { status, summary, url };
  const b = obj.booking as Record<string, unknown> | undefined;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  if (!b || !str(b.start) || !toET(String(b.start))) {
    // A "done" with no readable time can't go on the calendar and can't be trusted.
    return { status: 'failed', summary: `Said it booked, but gave no readable time: ${summary}`, url };
  }
  return {
    status: 'done',
    summary,
    url,
    booking: {
      title: str(b.title) ?? summary,
      start: String(b.start).trim(),
      end: str(b.end),
      location: str(b.location),
      confirmation: str(b.confirmation),
    },
  };
}

/** ISO (with or without offset) → local wall-clock date + HH:MM. No offset = already local. */
export function toET(iso: string): { date: string; time: string } | null {
  const local = iso.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/);
  if (local) return { date: local[1], time: `${local[2]}:${local[3]}` };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || !/T\d{2}:\d{2}/.test(iso)) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: getTimezone(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${String(Number(parts.hour) % 24).padStart(2, '0')}:${parts.minute}` };
}

// ── The booking window (read by the booking-browser tools) ──────────────────

let windowUntil = 0;

/** Close the open browser run now (the owner said stop): every scoped browser tool refuses from here. */
export function abortBrowserRun(): void {
  windowUntil = 0;
}

/** True only while a booking run holds the browser and its time box is open. */
export function bookingWindowOpen(now = Date.now()): boolean {
  return now < windowUntil;
}

export const PAYMENT_FIELD = /card|cc-?(num|number|exp|csc)|cvv|cvc|security.?code|expir|payment|billing|iban|routing/i;
const CARD_FIELD = /card|cc-?(num|number|exp|csc)|cvv|cvc|security.?code|expir|iban|routing/i;
export const PAYMENT_CLICK = /\b(pay|purchase|buy now|place order|add (a )?card|save card|add payment|checkout)\b/i;

/**
 * Hard stop under the prompt: the booking browser can't type a card number or
 * into a payment field, and can't click a pay button. Returns why, or null.
 */
export function paymentRefusal(input: Record<string, unknown>): string | null {
  const action = String(input.action ?? '');
  const sel = String(input.selector ?? '');
  const val = String(input.value ?? '');
  const text = String(input.text ?? '');
  if (action === 'upload_file') return 'Refused: bookings never upload files.';
  if ((action === 'fill_input' || action === 'type_editor') && (PAYMENT_FIELD.test(sel) || looksLikeCardNumber(val))) {
    return 'Refused: this is a card/payment field. Bookings never enter payment details. STOP and return status "blocked" saying the site wants a card.';
  }
  if (action === 'real_type' && looksLikeCardNumber(val)) {
    return 'Refused: that looks like a card number. Bookings never enter payment details. STOP and return status "blocked" saying the site wants a card.';
  }
  if (action === 'submit_form' && PAYMENT_FIELD.test(sel)) {
    return 'Refused: payment form. STOP and return status "blocked" saying the site wants a card.';
  }
  // Clicking into a "Billing" or "Payment" settings page is fine (that's where
  // cancel lives for web tasks); clicking a card field or a pay button is not.
  if (action === 'click' && (PAYMENT_CLICK.test(text) || CARD_FIELD.test(sel))) {
    return 'Refused: that button pays or adds a card. STOP and return status "blocked" saying the site wants a card or deposit.';
  }
  return null;
}

// ── Runner ──────────────────────────────────────────────────────────────────

const BROWSER_MAX_TURNS = parseNumEnv('BROWSER_MAX_TURNS', 40);

export const BOOKING_GROUP: GroupConfig = {
  key: 'booking',
  name: 'Web Booking',
  tools: ['booking-browser'],
  contextPath: 'context/booking',
};

export interface BookingDeps {
  isConnected: () => boolean;
  /** Runs the browser sub-agent and returns its final message. */
  runBrowser: (prompt: string) => Promise<string>;
  createEvent: typeof createCalendarEventRaw;
  notify: (text: string, subject: string) => Promise<void>;
  withLock: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
  timeoutMs: number;
}

const defaultDeps: BookingDeps = {
  isConnected: isBrowserConnected,
  runBrowser: async (prompt) => {
    // Dynamic: agent.ts → tools/index.ts → tools/web-booking.ts → here is a cycle.
    const { runAgent } = await import('./agent.js');
    const { getSystemUser } = await import('./lib/system-user.js');
    // Browser jobs take many small steps (snapshot, click, screenshot...).
    // They're work the owner asked for, so they bill like scheduled work with an
    // audience ('batch': only the global daily cap), not the background
    // allowance, even when a job resumes later with no chat context.
    const { withLlmContext } = await import('./lib/llm-context.js');
    return withLlmContext({ caller: 'web-job', lane: 'batch', groupKey: BOOKING_GROUP.key }, () => runAgent(BOOKING_GROUP, getSystemUser(), prompt, undefined, undefined, undefined, undefined, undefined, undefined, { maxTurns: BROWSER_MAX_TURNS }));
  },
  // Dynamic imports keep this module out of the tools/index.ts import cycle.
  createEvent: async (opts) => (await import('./tools/calendar.js')).createCalendarEventRaw(opts),
  notify: async (text, subject) => {
    // The owner asked for it (or said go) and is waiting on the answer.
    const { sendInterrupt } = await import('./cos-outbound.js');
    await sendInterrupt({ source: 'web-booking', subject, kind: 'reply', text });
  },
  withLock: withBrowserLock,
  timeoutMs: parseNumEnv('BOOKING_TIMEOUT_MS', 6 * 60_000),
};

let deps: BookingDeps = defaultDeps;
/** Tests swap in stubs so nothing opens a browser, writes a calendar, or texts. */
export function setBookingDeps(over: Partial<BookingDeps> | null): void {
  deps = over ? { ...defaultDeps, ...over } : defaultDeps;
}
export function bookingDeps(): BookingDeps { return deps; }

export const NOT_CONNECTED = "Chrome isn't connected on the mini, so I can't book online right now. Want me to call them instead?";

export function bookingPrompt(p: BookingPayload): string {
  return `You are booking something online for the owner, in the owner's own Chrome (logged in to Resy, OpenTable, Google, etc.). Today is ${todayET()} (${tzAbbrev()}).

BOOK: ${p.what}
WHERE: ${p.where}
WHEN: ${p.when}${p.party_size ? `\nPARTY SIZE: ${p.party_size}` : ''}
DETAILS YOU MAY ENTER (and nothing else): ${p.share}${p.notes ? `\nNOTES: ${p.notes}` : ''}${(() => { const pr = preferencesFor(`${p.what} ${p.where}`); return pr ? `\n\n${pr}` : ''; })()}

How:
1. If WHERE is a URL, open it. Otherwise find the business's booking page (their site, Resy, or OpenTable; a Google search via browser_navigate is fine). If WHERE is vague ("a good Italian place downtown"), pick one well-reviewed place that has online availability in the window.
2. Find availability inside WHEN. Pick the best slot (closest to the middle of the window). If nothing fits, do NOT book outside the window: stop and report the nearest times you saw.
3. Fill the form using ONLY the details above. Complete the reservation only when no payment is involved.

Hard rules:
- NEVER enter, select, or confirm a card, deposit, prepayment, or any payment. If the site requires a card to hold the booking, a deposit, or prepayment, STOP with status "blocked" and say what it wants.
- If the site asks for anything not in the details above (account creation, a password, a code sent to the owner's phone, a CAPTCHA), STOP with status "blocked" and say what it needs.
- Don't create accounts. Don't book twice. Don't cancel or change any existing booking.
- Be quick: a few pages, not a tour.

Your LAST message must be ONLY this JSON (no other text):
{"status":"done|blocked|failed","summary":"one short line for the owner","booking":{"title":"e.g. Dinner at Mojave Grill (4)","start":"YYYY-MM-DDTHH:MM (local time)","end":"optional","location":"address","confirmation":"code if shown"},"url":"page you ended on"}
Include "booking" only when status is "done" and the site showed a confirmation.`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<typeof TIMEOUT>((resolve) => { timer = setTimeout(() => resolve(TIMEOUT), ms); });
  return Promise.race([p, t]).finally(() => { if (timer) clearTimeout(timer); });
}
const TIMEOUT = Symbol('timeout');

/**
 * One time-boxed browser sub-agent run (shared by bookings and web tasks):
 * takes the browser lock, opens the window the scoped browser tools check,
 * and returns the sub-agent's final message, or null when it ran out of time.
 * Throws on a browser error.
 */
export async function runBrowserSubAgent(
  label: string, prompt: string, timeoutMs: number,
  hooks: { onStart?: () => void; onEnd?: () => void } = {},
): Promise<string | null> {
  const d = deps;
  const out = await d.withLock(label, async () => {
    // Inside the lock: only the run that actually holds the browser is "active".
    windowUntil = Date.now() + timeoutMs;
    hooks.onStart?.();
    try {
      return await withTimeout(d.runBrowser(prompt), timeoutMs);
    } finally {
      windowUntil = 0;
      hooks.onEnd?.();
    }
  });
  return out === TIMEOUT ? null : out;
}

/**
 * One booking attempt for actions row `actionId`: browser lock → time-boxed
 * sub-agent → parse → calendar on done → reply to the owner → finalize the row.
 * Never throws.
 */
export async function runWebBooking(actionId: number, p: BookingPayload): Promise<BookingResult> {
  const d = deps;
  const subject = `booking:${actionId}`;
  const label = `${p.what} at ${p.where}`;
  let result: BookingResult;

  if (!d.isConnected()) {
    result = { status: 'failed', summary: "Chrome isn't connected on the mini." };
  } else {
    try {
      const out = await runBrowserSubAgent(`web-booking #${actionId}`, bookingPrompt(p), d.timeoutMs);
      result = out === null
        ? { status: 'failed', summary: `Ran out of time (${Math.round(d.timeoutMs / 60_000)} min) before it was booked.` }
        : parseBookingResult(out);
    } catch (err) {
      result = { status: 'failed', summary: `Browser error: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  let text: string;
  if (result.status === 'done' && result.booking) {
    const b = result.booking;
    const start = toET(b.start)!;
    const end = b.end ? toET(b.end) : null;
    let calNote = 'Added to your calendar.';
    try {
      await d.createEvent({
        title: b.title,
        date: start.date,
        startTime: start.time,
        endTime: end && end.date === start.date && end.time > start.time ? end.time : undefined,
        description: [
          b.location ? `Where: ${b.location}` : '',
          b.confirmation ? `Confirmation: ${b.confirmation}` : '',
          result.url ? `Booked at: ${result.url}` : '',
          `Booked online by ${getBotName()} (action #${actionId}).`,
        ].filter(Boolean).join('\n'),
        sourceRef: `booking:action:${actionId}`,
      });
    } catch (err) {
      calNote = "Couldn't add it to your calendar, add it yourself.";
      console.error(`[web-booking] calendar insert failed for #${actionId}:`, err);
    }
    const conf = b.confirmation ? ` (conf ${b.confirmation})` : '';
    text = `✅ Booked: ${result.summary}${conf}. ${calNote}`;
    markActionDone(actionId, { outcome: `${result.summary}${conf}`, outcome_url: result.url ?? null, actual_cost_cents: 0 });
  } else {
    const head = result.status === 'blocked' ? `🧾 Couldn't finish booking ${label}` : `⚠️ Booking ${label} didn't go through`;
    text = `${head}: ${result.summary} Nothing was booked or paid. Want me to call them instead?`;
    markActionFailed(actionId, `${result.status}: ${result.summary}`);
  }

  try {
    await d.notify(text, subject);
  } catch (err) {
    console.error(`[web-booking] could not tell the owner about #${actionId}:`, err);
  }
  return result;
}

/**
 * Owner-asked path: log an auto-confirmed actions row (kind 'booking') and run
 * the booking in the background. Returns the row id and the run's promise.
 */
export function startWebBooking(payload: BookingPayload, summary: string, group: string): { id: number; done: Promise<BookingResult> } {
  const id = proposeAction({
    kind: 'booking', tool_name: 'web_booking', summary,
    payload_json: JSON.stringify(payload), estimated_cost_cents: null, reversible: false,
    category: 'booking', created_by_group: group,
  });
  confirmAction(id);
  markActionExecuting(id);
  return { id, done: runWebBooking(id, payload) };
}

let lastRun: Promise<BookingResult> | null = null;
/** Tests await the run started by the most recent `go`. */
export function lastBookingRun(): Promise<BookingResult> | null { return lastRun; }

/**
 * The `web_booking` executor (runs inside confirm_action on "go #action:N").
 * Starts the run a moment later so confirm_action's own "done" write lands
 * first; runWebBooking then overwrites the row with the real outcome.
 */
export async function runWebBookingAction(action: Action): Promise<{ outcome: string; actual_cost_cents: number }> {
  if (!deps.isConnected()) throw new Error(`human_handoff_needed: ${NOT_CONNECTED}`);
  const payload = JSON.parse(action.payload_json) as BookingPayload;
  lastRun = new Promise<BookingResult>((resolve) => {
    setTimeout(() => { void runWebBooking(action.id, payload).then(resolve); }, 300);
  });
  return { outcome: `Booking ${payload.what} at ${payload.where} now in Chrome. I'll text you when it's done.`, actual_cost_cents: 0 };
}
