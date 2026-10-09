// Wake-up calls. The owner asks by text ("wake me up at 6:45 tomorrow",
// "wake-up call weekdays at 6:30") and the bot phones the owner instead of an alarm.
// They have to talk to end it: the call only counts once they have given real
// spoken answers and the call model confirms they're awake (phone.ts, confirm_awake).
//
//   due ──dial──▶ calling ──answered──▶ connected ──▶ awake        → done for the day
//                    │                       │
//                    └── no answer / hung up without confirming ──▶ retry in 5 min
//                                                                  (3 tries, then one text)
//
// Wake-up calls ignore quiet hours and the daily ring cap: the owner set them. Started
// from index.ts outside the AUTOMATIONS_OFF gate; kill switch WAKEUP_CALLS_ENABLED.

import { callOwnerWakeUp, isPhoneConfigured, setWakeCallHooks, type WakeCallInfo } from './phone.js';
import { sendInterrupt } from './cos-outbound.js';
import {
  createWakeUpCall, getWakeUpCall, listWakeUpCalls, updateWakeUpCall, type WakeUpCallRow,
} from './db.js';
import { getTimezone } from './config.js';
import { localOffset } from './lib/time.js';

const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => { const n = Number(env(k)); return Number.isFinite(n) && n > 0 ? n : d; };

const maxAttempts = () => Math.round(num('WAKEUP_MAX_ATTEMPTS', 7));
const retryMs = () => num('WAKEUP_RETRY_MIN', 3) * 60_000;
/** How late a wake-up may still fire (e.g. the bot was restarting at 6:45). */
const graceMs = () => num('WAKEUP_GRACE_MIN', 60) * 60_000;
/** Twilio rings ~30s; a dial that never connects after this is a no-answer. */
const ANSWER_TIMEOUT_MS = 2 * 60_000;
/** A connected call with no result after this is treated as ended without confirming. */
const connectedTimeoutMs = () => (num('WAKEUP_MAX_CALL_MIN', 5) + 2) * 60_000;
const TICK_MS = 30_000;

export const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

export function wakeUpCallsEnabled(): boolean {
  return env('WAKEUP_CALLS_ENABLED', 'true') !== 'false';
}

// ── Injectable edges (tests stub these) ──────────────────────────────────────

export interface WakeUpDeps {
  dial: (w: WakeCallInfo) => Promise<void>;
  notify: (row: WakeUpCallRow, text: string) => Promise<void>;
  firstEvent: (now: Date) => Promise<string | undefined>;
}

const defaultDeps: WakeUpDeps = {
  dial: callOwnerWakeUp,
  notify: async (row, text) => {
    await sendInterrupt({
      source: 'wakeup', subject: `wakeup:${row.id}:${row.cycle_date}`, kind: 'time-critical', text,
      // The owner set this alarm; a failed wake-up usually lands before 07:00, which
      // quiet hours would otherwise drop. Still logged like every send.
      bypass: 'wake-up',
    });
  },
  firstEvent: firstCalendarItem,
};
let deps: WakeUpDeps = defaultDeps;
export function setWakeUpDeps(d: Partial<WakeUpDeps>): void { deps = { ...deps, ...d }; }

// ── Local clock ────────────────────────────────────────────────────────────────

/** Local calendar date, HH:MM, and weekday key for an instant. */
export function etParts(at: Date): { ymd: string; hhmm: string; day: typeof DAY_KEYS[number] } {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: getTimezone(), year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
  }).formatToParts(at);
  const g = (t: string) => f.find((p) => p.type === t)?.value ?? '';
  const hour = g('hour') === '24' ? '00' : g('hour');
  return { ymd: `${g('year')}-${g('month')}-${g('day')}`, hhmm: `${hour}:${g('minute')}`, day: g('weekday').toLowerCase().slice(0, 3) as typeof DAY_KEYS[number] };
}

/** The UTC instant of HH:MM local time on a local date, DST-correct. */
export function etInstant(ymd: string, hhmm: string): Date {
  // Every offset the zone uses around this date; a fall-back repeat matches
  // twice and the earlier instant wins.
  const noon = new Date(`${ymd}T12:00:00Z`).getTime();
  const offsets = [...new Set([-1, 0, 1].map((d) => localOffset(new Date(noon + d * 86_400_000))))];
  const matches = offsets
    .map((off) => new Date(`${ymd}T${hhmm}:00${off}`))
    .filter((d) => { const p = etParts(d); return p.ymd === ymd && p.hhmm === hhmm; })
    .sort((a, b) => a.getTime() - b.getTime());
  if (matches.length) return matches[0];
  // A time skipped by the spring-forward jump: read it with the offset in
  // force the day before (standard time).
  return new Date(`${ymd}T${hhmm}:00${localOffset(new Date(noon - 86_400_000))}`);
}

function addDays(ymd: string, n: number): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function weekdayOf(ymd: string): typeof DAY_KEYS[number] {
  return DAY_KEYS[new Date(`${ymd}T12:00:00Z`).getUTCDay()];
}

function matchesDate(row: WakeUpCallRow, ymd: string): boolean {
  if (row.date) return row.date === ymd;
  return (row.days ?? '').split(',').includes(weekdayOf(ymd));
}

/**
 * The local morning this call should be working right now, or null: its time has
 * passed within the grace window, and that morning isn't already handled.
 */
export function dueDate(row: WakeUpCallRow, now: Date): string | null {
  if (row.status !== 'active') return null;
  const today = etParts(now).ymd;
  for (const d of [today, addDays(today, -1)]) {
    if (!matchesDate(row, d) || d === row.last_done_date || d === row.cycle_date) continue;
    const t = etInstant(d, row.time).getTime();
    if (t <= now.getTime() && now.getTime() - t < graceMs()) return d;
  }
  return null;
}

/** Next wake instant still ahead (for listing and confirmations), or null. */
export function nextOccurrence(row: WakeUpCallRow, now: Date): Date | null {
  if (row.status !== 'active') return null;
  const today = etParts(now).ymd;
  for (let i = 0; i < 8; i++) {
    const d = addDays(today, i);
    if (!matchesDate(row, d) || d === row.last_done_date) continue;
    const t = etInstant(d, row.time);
    if (t.getTime() > now.getTime()) return t;
  }
  return null;
}

function fmtTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function fmtWhen(at: Date): string {
  const day = at.toLocaleDateString('en-US', { timeZone: getTimezone(), weekday: 'short', month: 'short', day: 'numeric' });
  return `${fmtTime(etParts(at).hhmm)} ${day}`;
}

function fmtDays(days: string): string {
  const set = days.split(',');
  if (set.length === 7) return 'every day';
  if (set.length === 5 && ['mon', 'tue', 'wed', 'thu', 'fri'].every((d) => set.includes(d))) return 'weekdays';
  if (set.length === 2 && set.includes('sat') && set.includes('sun')) return 'weekends';
  return set.join(', ');
}

// ── Owner-facing operations (tools/wakeup.ts) ───────────────────────────────

/** "6:45", "06:45", "6:45am", "18:30" → "HH:MM" (24h), or null. */
export function parseTime(raw: string): string | null {
  const m = raw.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  const ap = m[3]?.[0];
  if (ap) {
    if (h < 1 || h > 12) return null;
    if (ap === 'a' && h === 12) h = 0;
    if (ap === 'p' && h !== 12) h += 12;
  }
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** ["mon","fri"], "weekdays", "daily", "mon-fri" → canonical 'sun,mon,...' order, or null. */
export function parseDays(raw: unknown): string | null {
  const items = (Array.isArray(raw) ? raw.map(String) : String(raw ?? '').split(/[,\s]+/))
    .map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!items.length) return null;
  const out = new Set<string>();
  for (const it of items) {
    if (['daily', 'everyday', 'every day', 'all'].includes(it)) DAY_KEYS.forEach((d) => out.add(d));
    else if (['weekdays', 'weekday'].includes(it) || it === 'mon-fri') ['mon', 'tue', 'wed', 'thu', 'fri'].forEach((d) => out.add(d));
    else if (['weekends', 'weekend'].includes(it)) ['sat', 'sun'].forEach((d) => out.add(d));
    else {
      const k = it.slice(0, 3);
      if (!(DAY_KEYS as readonly string[]).includes(k)) return null;
      out.add(k);
    }
  }
  return DAY_KEYS.filter((d) => out.has(d)).join(',');
}

export function setWakeUpCall(input: { time?: unknown; date?: unknown; days?: unknown; note?: unknown }, now = new Date()): string {
  const time = parseTime(String(input.time ?? ''));
  if (!time) return 'Wake-up call needs a time like "06:45" (local time).';
  const note = String(input.note ?? '').trim().slice(0, 200) || null;
  const hasDays = Array.isArray(input.days) ? input.days.length > 0 : !!String(input.days ?? '').trim();
  let date: string | null = null;
  let days: string | null = null;
  if (hasDays) {
    days = parseDays(input.days);
    if (!days) return 'days must be day names like ["mon","tue"], or "weekdays" / "weekends" / "daily".';
  } else if (String(input.date ?? '').trim()) {
    date = String(input.date).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return 'date must be YYYY-MM-DD.';
    if (etInstant(date, time).getTime() <= now.getTime()) return `${fmtTime(time)} on ${date} has already passed.`;
  } else {
    // No date or days: the next time that clock time comes around.
    const today = etParts(now).ymd;
    date = etInstant(today, time).getTime() > now.getTime() ? today : addDays(today, 1);
  }
  // A recurring call set after today's time must not fire right away for today.
  const today = etParts(now).ymd;
  const skipToday = days && etInstant(today, time).getTime() <= now.getTime() ? today : null;
  const id = createWakeUpCall({ time, date, days, note, last_done_date: skipToday });
  const row = getWakeUpCall(id)!;
  const next = nextOccurrence(row, now);
  const what = days ? `${fmtTime(time)} ${fmtDays(days)}` : `${fmtTime(time)}`;
  const lines = [`⏰ Wake-up call #${id} set: ${what}${note ? ` ("${note}")` : ''}. First call ${next ? fmtWhen(next) : 'soon'}. You'll have to talk to me to end it.`];
  if (!isPhoneConfigured()) lines.push('(Phone calling is not set up on this machine, so it will not ring until it is.)');
  if (!wakeUpCallsEnabled()) lines.push('(Wake-up calls are switched off: WAKEUP_CALLS_ENABLED=false.)');
  return lines.join('\n');
}

export function describeWakeUpCall(row: WakeUpCallRow, now = new Date()): string {
  const what = row.days ? `${fmtTime(row.time)} ${fmtDays(row.days)}` : `${fmtTime(row.time)} on ${row.date}`;
  const next = nextOccurrence(row, now);
  const state = row.status !== 'active' ? row.status
    : row.cycle_date ? `calling now (attempt ${row.attempts_today}/${maxAttempts()})`
      : next ? `next ${fmtWhen(next)}` : 'no upcoming call';
  const last = row.last_result ? ` · last: ${row.last_result}` : '';
  return `#${row.id} ${what}${row.note ? ` ("${row.note}")` : ''} · ${state}${last}`;
}

export function listWakeUps(now = new Date()): string {
  const rows = listWakeUpCalls({ active: true });
  if (!rows.length) return 'No wake-up calls set.';
  return rows.map((r) => describeWakeUpCall(r, now)).join('\n');
}

export function cancelWakeUpCall(id: number): string {
  const row = getWakeUpCall(id);
  if (!row) return `Wake-up call #${id} not found.`;
  if (row.status !== 'active') return `Wake-up call #${id} is already ${row.status}.`;
  updateWakeUpCall(id, { status: 'cancelled', cycle_date: null, call_state: null, next_attempt_at: null });
  return `Wake-up call #${id} cancelled.`;
}

// ── Runner ──────────────────────────────────────────────────────────────────

async function firstCalendarItem(now: Date): Promise<string | undefined> {
  try {
    const { listRawEvents } = await import('./tools/calendar.js');
    const end = etInstant(etParts(now).ymd, '23:59');
    const events = await Promise.race([
      listRawEvents(now.toISOString(), end.toISOString()),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000)),
    ]);
    const timed = events.find((e) => e.start?.dateTime && new Date(e.start.dateTime).getTime() >= now.getTime());
    if (timed?.summary) return `${timed.summary} at ${fmtTime(etParts(new Date(timed.start!.dateTime!)).hhmm)}`;
    const allDay = events.find((e) => e.start?.date && e.summary);
    return allDay ? `${allDay.summary} (all day)` : undefined;
  } catch {
    return undefined; // optional: the call works without it
  }
}

/** Close the morning: awake, or out of tries. */
function closeCycle(row: WakeUpCallRow, result: string): void {
  updateWakeUpCall(row.id, {
    cycle_date: null, call_state: null, next_attempt_at: null, last_result: result,
    last_done_date: row.cycle_date,
    ...(row.date ? { status: 'done' } : {}),
  });
}

/**
 * Record how an attempt went. `attempt` must match the current one, so a result
 * that arrives after the watchdog already gave up on that attempt is ignored.
 */
export async function recordAttempt(id: number, attempt: number, outcome: 'awake' | string, now = new Date(), retryAfterMs?: number): Promise<void> {
  const row = getWakeUpCall(id);
  if (!row || row.status !== 'active' || !row.cycle_date || !row.call_state || row.attempts_today !== attempt) return;
  if (outcome === 'awake') {
    closeCycle(row, `awake (${row.cycle_date}, attempt ${attempt})`);
    console.log(`[wakeup] #${id}: owner is awake (attempt ${attempt})`);
    return;
  }
  if (attempt >= maxAttempts()) {
    closeCycle(row, `gave up (${row.cycle_date}): ${outcome}`);
    console.warn(`[wakeup] #${id}: gave up after ${attempt} attempts (${outcome})`);
    try {
      await deps.notify(row, `⏰ Couldn't wake you — ${attempt} calls unanswered.`);
    } catch (err) {
      console.error('[wakeup] notify failed:', err);
    }
    return;
  }
  updateWakeUpCall(id, {
    call_state: null, last_result: `${outcome} (attempt ${attempt})`,
    next_attempt_at: new Date(now.getTime() + (retryAfterMs ?? retryMs())).toISOString(),
  });
  console.log(`[wakeup] #${id}: ${outcome}; retrying in ${Math.round((retryAfterMs ?? retryMs()) / 1000)}s`);
}

async function attemptCall(row: WakeUpCallRow, now: Date): Promise<void> {
  const attempt = row.attempts_today + 1;
  updateWakeUpCall(row.id, { attempts_today: attempt, last_attempt_at: now.toISOString(), call_state: 'calling', next_attempt_at: null });
  const firstEvent = await deps.firstEvent(now).catch(() => undefined);
  const info: WakeCallInfo = {
    id: row.id, attempt, timeLabel: fmtTime(etParts(now).hhmm),
    ...(row.note ? { note: row.note } : {}), ...(firstEvent ? { firstEvent } : {}),
  };
  try {
    console.log(`[wakeup] #${row.id}: calling (attempt ${attempt}/${maxAttempts()})`);
    await deps.dial(info);
  } catch (err) {
    await recordAttempt(row.id, attempt, `dial failed: ${err instanceof Error ? err.message : String(err)}`, now);
  }
}

/** One pass over every active wake-up call. Exported for tests. */
export async function tick(now = new Date()): Promise<void> {
  for (const r of listWakeUpCalls({ active: true })) {
    try {
      let row = r;
      if (row.call_state) {
        // Watchdog: Twilio sends no status callback, so silence means no answer.
        const since = now.getTime() - Date.parse(row.last_attempt_at ?? '');
        if (row.call_state === 'calling' && since > ANSWER_TIMEOUT_MS) await recordAttempt(row.id, row.attempts_today, 'no answer', now);
        else if (row.call_state === 'connected' && since > connectedTimeoutMs()) await recordAttempt(row.id, row.attempts_today, 'call ended without confirming', now);
        continue;
      }
      if (!row.cycle_date) {
        // A one-off whose moment passed while the bot was down.
        if (row.date && etInstant(row.date, row.time).getTime() + graceMs() <= now.getTime()) {
          updateWakeUpCall(row.id, { status: 'missed', last_result: 'missed (bot was not running)' });
          continue;
        }
        const d = dueDate(row, now);
        if (!d) continue;
        updateWakeUpCall(row.id, { cycle_date: d, attempts_today: 0, next_attempt_at: now.toISOString(), last_result: null });
        row = getWakeUpCall(row.id)!;
      }
      if (row.next_attempt_at && Date.parse(row.next_attempt_at) <= now.getTime()) await attemptCall(row, now);
    } catch (err) {
      console.error(`[wakeup] #${r.id} tick failed:`, err);
    }
  }
}

/** Phone-side hooks: exported so tests can drive them without a real call. */
export const wakeCallHooks = {
  onConnected: (id: number, attempt: number) => {
    const row = getWakeUpCall(id);
    if (row && row.call_state === 'calling' && row.attempts_today === attempt) updateWakeUpCall(id, { call_state: 'connected' });
  },
  onFinished: (id: number, attempt: number, r: { awake: boolean; answers: number; glitch?: boolean }) => {
    // The assistant's voice never joined (OpenAI lost the call): ring again in 30s, not 3 min of waiting.
    if (r.glitch) { void recordAttempt(id, attempt, "the assistant's voice didn't join the call", new Date(), 30_000); return; }
    void recordAttempt(id, attempt, r.awake ? 'awake' : `hung up without confirming (${r.answers} real answers)`);
  },
};

export function startWakeUpCalls(): void {
  setWakeCallHooks(wakeCallHooks);
  if (!wakeUpCallsEnabled()) {
    console.log('[wakeup] disabled via WAKEUP_CALLS_ENABLED=false');
    return;
  }
  setInterval(() => { void tick(); }, TICK_MS);
  setTimeout(() => { void tick(); }, 5_000);
  console.log('[wakeup] runner started (30s tick)');
}
