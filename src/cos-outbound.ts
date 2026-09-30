import { createHash } from 'crypto';
import {
  getMemory, setMemory, deleteMemory, getRecentMemory,
  logOutbound, lastSentForSubject, countSentSince, findDuplicateSince, subjectHistorySince,
} from './db.js';
import { sendMessage, getDefaultRecipient } from './channels/imessage.js';
import { toPlainText } from './lib/plaintext.js';
import { isQuietHours, startOfTodayET } from './lib/time-et.js';
import { toSqliteDate } from './lib/dates.js';
import { parseNumEnv, parseStrEnv } from './lib/env.js';

// ============================================================
// CoS OUTBOUND — the one place anything unprompted reaches the
// owner, and the decision about whether it should.
//
// The two lanes were here from the start; the arbitration was
// not. sendInterrupt() used to be three lines that always sent,
// so "the Chief-of-Staff owns what gets through" described an
// intention rather than a mechanism: ~61 code paths could text
// them, each deciding at compile time that its own news was
// urgent, none able to see what the others had already said.
// That is why the whole proactive layer ended up switched off.
//
//   sendInterrupt() — declare (source, subject, kind); the
//     arbiter decides send / hold / defer and logs every
//     attempt either way.
//   stageAmbient()  — the batch lane, drained into the next
//     brief window. Now the DEFAULT destination for anything
//     that does not clear the bar, rather than a lane with one
//     producer.
//
// Backed by the `memory` table (group 'cos-ambient') so a
// separate daemon process can stage and the main agent process
// can drain — cross-process via the shared DB.
// ============================================================

const AMBIENT_GROUP = 'cos-ambient';
const AMBIENT_PREFIX = 'pending:';

/**
 * What kind of claim on attention this makes. Callers DECLARE; the arbiter
 * DECIDES. A caller asserting its own urgency is exactly the failure mode this
 * replaces.
 */
export type InterruptKind =
  /** Acting later is materially worse: time to leave, meeting prep, payment failure. */
  | 'time-critical'
  /** Blocked on the owner choosing something. */
  | 'decision'
  /** A human is waiting on the owner — a reply, an inbound message. */
  | 'reply'
  /** "The machine did a thing": run reports, tallies, digests. */
  | 'status'
  /** An idea, a resurfaced fact, a relationship reminder. */
  | 'nudge';

export type InterruptHoldReason =
  | 'quiet-hours'
  | 'daily-budget'
  | 'subject-cooldown'
  | 'cross-source-duplicate'
  | 'already-delivered-today'
  | 'no-recipient'
  | 'send-failed'
  /** kind 'status' is never texted; the ledger row is the whole delivery. */
  | 'status-log-only'
  /** kind 'decision' / 'nudge' waits for the next check-in (src/checkins.ts). */
  | 'checkin-only';

export interface InterruptRequest {
  /** Stable module identity: 'heartbeat', 'meeting-daemon', 'pulse:brain'. */
  source: string;
  /**
   * Stable identity of the THING, not of this message. Two sources reporting
   * the same underlying event MUST produce the same key, or the cross-source
   * rules cannot see the collision. Namespaced:
   *   'meeting:<event_id>:prep'   'task:1043:overdue'
   *   'brief:morning:2026-09-02'  'outreach:reply:<slug>'
   */
  subject: string;
  kind: InterruptKind;
  text: string;
  /** iMessage target. Defaults to getDefaultRecipient(). */
  target?: string;
  /**
   * Escape hatch for lanes the arbiter must never hold. Every use needs a
   * comment justifying it. Bypassed sends are still fully logged — that is the
   * difference between this and the old sentinel, which stopped things with no
   * record that a stop had happened.
   */
  bypass?: 'outreach' | 'operator-alarm' | 'wake-up';
  /** Raise (never lower) the per-kind minimum spacing for this subject. */
  cooldownMinutes?: number;
}

export type InterruptDecision =
  | { sent: true; id: number; wouldHold?: InterruptHoldReason }
  | { sent: false; id: number; decision: 'held' | 'deferred'; reason: InterruptHoldReason };

/**
 * observe = compute and log the verdict, then send anyway.
 * enforce = act on it.
 *
 * Defaults to observe so a bad deploy can never silence the bot, and so the
 * cooldowns and budget can be tuned from a real log rather than from intuition.
 */
function mode(): 'observe' | 'enforce' {
  return parseStrEnv('COS_ARBITER_MODE', 'enforce') === 'observe' ? 'observe' : 'enforce';
}

function dailyBudget(): number { return parseNumEnv('COS_DAILY_INTERRUPT_BUDGET', 3); }
/** A "you are 40 minutes away" must not be dropped by an arithmetic ceiling. */
function budgetOverdraft(): number { return parseNumEnv('COS_INTERRUPT_BUDGET_OVERDRAFT', 2); }

/** Minimum spacing before the same subject may interrupt again. */
const KIND_COOLDOWN_MINUTES: Record<InterruptKind, number> = {
  'time-critical': 60,
  decision: 360,
  reply: 0, // never suppress a human waiting on the owner
  status: 720,
  nudge: 1440,
};

/** More urgent kinds may override a less urgent one already delivered today. */
const KIND_URGENCY: Record<InterruptKind, number> = {
  'time-critical': 5,
  decision: 4,
  reply: 3,
  status: 2,
  nudge: 1,
};

/**
 * Normalize before hashing so two sources describing one event collide.
 * Deliberately boring: a clever normalizer produces false matches, and a false
 * match is a silently lost message.
 */
function bodyHash(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '') // emoji
    .replace(/\d{1,4}([:/-]\d{1,4})+/g, '')                   // timestamp-ish runs
    .replace(/[^a-z0-9\s]/g, '')                              // punctuation
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha1').update(normalized).digest('hex');
}

/**
 * toSqliteDate is typed nullable because it accepts strings that may not parse.
 * Every call here passes a real Date, which cannot fail — this narrows that
 * without scattering non-null assertions through the arbitration logic.
 */
function sqliteTime(d: Date): string {
  return toSqliteDate(d) ?? new Date(0).toISOString().slice(0, 19).replace('T', ' ');
}

function minutesAgoIso(minutes: number): string {
  return sqliteTime(new Date(Date.now() - minutes * 60_000));
}

interface Verdict {
  hold: boolean;
  reason?: InterruptHoldReason;
  /** true = drop it; false = demote to the batch lane. */
  drop?: boolean;
}

/**
 * The arbitration, cheapest and most absolute first, so a message quiet hours
 * already killed never runs a dedup query.
 */
function arbitrate(req: InterruptRequest, hasTarget: boolean, quietHours: boolean): Verdict {
  if (!hasTarget) return { hold: true, reason: 'no-recipient', drop: true };

  // The owner's rule (2026-09-29): only "act now" and "a person is waiting"
  // may interrupt. Machine status is never texted, not even on a bypass lane;
  // everything else rides the two daily check-ins, which compress it into one
  // short message.
  if (req.kind === 'status') return { hold: true, reason: 'status-log-only', drop: true };

  // Bypass lanes are exempt from the remaining rules but NOT from the ledger.
  if (req.bypass) return { hold: false };

  if (req.kind === 'decision' || req.kind === 'nudge') return { hold: true, reason: 'checkin-only' };

  // Quiet hours moved INSIDE. It used to be re-decided by every producer:
  // four modules got it right and everything else silently did not, which is
  // how the 21:00 health check-in ended up firing exactly at the boundary. It
  // is a property of the recipient, not of the producer.
  if (quietHours) {
    // A "leave now" held at 21:30 for a 22:00 event is worthless at 07:00 and
    // actively confusing, so time-critical is dropped rather than deferred.
    return { hold: true, reason: 'quiet-hours', drop: req.kind === 'time-critical' };
  }

  // A human waiting on the owner is never rate-limited: not by cooldown, not by the
  // daily budget, and not by the deferral check above. Two prospect replies in
  // a row are two people waiting, not one repeated notification.
  const cooldown = req.kind === 'reply'
    ? 0
    : Math.max(KIND_COOLDOWN_MINUTES[req.kind], req.cooldownMinutes ?? 0);
  if (cooldown > 0) {
    const last = lastSentForSubject(req.subject, minutesAgoIso(cooldown));
    if (last) return { hold: true, reason: 'subject-cooldown' };
  }

  const today = sqliteTime(startOfTodayET());

  // The case subject-cooldown genuinely cannot catch: this subject is ALREADY
  // sitting in the batch lane waiting for the next brief. Cooldown only looks
  // at what was sent, so without this the same item can be queued repeatedly
  // and then arrive in the brief three times.
  //
  // Scoped to deferrals on purpose. An earlier version also held anything of
  // equal-or-lower urgency already sent today, which sounded right but was
  // almost entirely shadowed by subject-cooldown -- both key on subject, and
  // for low-urgency kinds the cooldown window is longer than the day. Keeping
  // it would have been near-dead code carrying a comment that claimed
  // otherwise.
  if (req.kind !== 'reply') {
    const history = subjectHistorySince(req.subject, today);
    if (history.some((h) => h.decision === 'deferred')) {
      return { hold: true, reason: 'already-delivered-today', drop: true };
    }
  }

  const dup = findDuplicateSince(bodyHash(req.text), minutesAgoIso(360), req.source);
  if (dup) return { hold: true, reason: 'cross-source-duplicate', drop: true };

  // A prospect replying is the business: it neither consumes the budget nor is
  // refused by it.
  if (req.kind !== 'reply') {
    const used = countSentSince(today, ['reply']);
    const ceiling = dailyBudget() + (req.kind === 'time-critical' ? budgetOverdraft() : 0);
    if (used >= ceiling) return { hold: true, reason: 'daily-budget' };
  }

  return { hold: false };
}

/**
 * Interrupt lane. Never throws: a failure here must not take down the daemon
 * that was merely trying to say something. Always returns a decision and always
 * writes a row.
 *
 * Callers MUST branch on `decision.sent` before recording that the thing was
 * delivered — marking a task surfaced, stamping prep_sent, consuming a
 * relationship cadence. Doing that unconditionally burns state for a message
 * nobody received.
 */
export interface OutboundDeps {
  sendMessage: (to: string, text: string) => Promise<void>;
  getDefaultRecipient: () => string | null | undefined;
  /** Injectable so the rules can be tested at a deterministic hour. */
  isQuietHours: () => boolean;
}

// Injectable so the arbitration rules can be tested without an iMessage
// channel. Same dependency-injection shape family-scheduler.ts uses; ESM
// exports are read-only, so a test cannot stub the channel any other way.
const defaultDeps: OutboundDeps = { sendMessage, getDefaultRecipient, isQuietHours };

export async function sendInterrupt(
  req: InterruptRequest,
  deps: OutboundDeps = defaultDeps,
): Promise<InterruptDecision> {
  const arbiterMode = mode();
  const to = req.target ?? deps.getDefaultRecipient();
  const plain = toPlainText(req.text);

  let verdict: Verdict;
  try {
    verdict = arbitrate(req, Boolean(to), deps.isQuietHours());
  } catch (err) {
    // A broken arbiter must fail OPEN. Silence is the failure mode this whole
    // layer exists to prevent, and inbox-signal-daemon still carries a direct
    // sendMessage fallback that would defeat the gate entirely if we threw.
    console.error('[cos-outbound] arbiter threw; sending anyway:', err);
    verdict = { hold: false };
  }

  const base = {
    source: req.source,
    subject: req.subject,
    kind: req.kind,
    target: to ?? null,
    bypass: req.bypass ?? null,
    mode: arbiterMode,
    text_preview: plain.slice(0, 400),
    text_hash: bodyHash(req.text),
    char_count: plain.length,
  };

  // No recipient is terminal in both modes — there is nowhere to send.
  if (!to) {
    const id = safeLog({ ...base, decision: 'held', reason: 'no-recipient', would_hold: 0 });
    return { sent: false, id, decision: 'held', reason: 'no-recipient' };
  }

  if (verdict.hold && arbiterMode === 'enforce') {
    // Defer-don't-drop is the default. A dropped message is unfalsifiable from
    // their side; a deferred one shows up in the next brief where they can see the
    // noise and tune the source. The exceptions are cases where deferring would
    // deliver something already stale or already said.
    if (!verdict.drop) {
      // stageAmbient touches the memory table, so it can throw. sendInterrupt
      // promises never to throw -- a daemon must not die because the batch lane
      // hiccuped. Losing the deferral is bad; taking down the caller is worse.
      try {
        // Check-in-bound messages keep their full text: the check-in composer
        // decides what survives, not a 200-char cut here.
        stageAmbient(req.source, oneLine(plain), {
          subject: req.subject,
          detail: verdict.reason === 'checkin-only' ? plain : undefined,
        });
      } catch (err) {
        console.error('[cos-outbound] failed to stage deferred message:', err);
      }
      const id = safeLog({ ...base, decision: 'deferred', reason: verdict.reason ?? null, would_hold: 0 });
      return { sent: false, id, decision: 'deferred', reason: verdict.reason! };
    }
    const id = safeLog({ ...base, decision: 'held', reason: verdict.reason ?? null, would_hold: 0 });
    return { sent: false, id, decision: 'held', reason: verdict.reason! };
  }

  const shaped = shapeInterrupt(plain);
  try {
    await deps.sendMessage(to, shaped);
  } catch (err) {
    const id = safeLog({ ...base, decision: 'failed', reason: 'send-failed', would_hold: 0 });
    console.error('[cos-outbound] send failed:', err);
    return { sent: false, id, decision: 'held', reason: 'send-failed' };
  }

  // Time-critical interrupts can also ring the phone (opt-in). Loaded lazily:
  // phone.ts pulls in the agent, which would make this module a cycle.
  if (req.kind === 'time-critical' && process.env.PHONE_RING_ON_CRITICAL === 'true') {
    import('./phone.js')
      .then((m) => m.callOwner(shaped))
      .catch((err) => console.error('[cos-outbound] ring failed:', err));
  }

  // Observe mode: the verdict is recorded as a counterfactual, but `decision`
  // still says 'sent', because it was.
  const id = safeLog({
    ...base,
    decision: 'sent',
    reason: verdict.hold ? verdict.reason ?? null : null,
    would_hold: verdict.hold ? 1 : 0,
  });
  return verdict.hold
    ? { sent: true, id, wouldHold: verdict.reason }
    : { sent: true, id };
}

function safeLog(row: Parameters<typeof logOutbound>[0]): number {
  try {
    return logOutbound(row);
  } catch (err) {
    console.error('[cos-outbound] failed to write outbound_log:', err);
    return -1;
  }
}

/** Collapse agent prose to something that belongs in a batched brief. */
function oneLine(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > 200 ? `${collapsed.slice(0, 197)}...` : collapsed;
}

export interface AmbientItem {
  source: string;
  line: string;
  at: string;
  subject?: string;
  /** Full text for the check-in composer, when the one-liner would lose content. */
  detail?: string;
}

/**
 * Ambient lane: stage a one-line update for the next brief.
 *
 * Items are objects rather than bare strings so the brief that delivers them
 * can write one outbound_log row per drained subject — which is what lets the
 * "already delivered today" rule see things that arrived via the brief rather
 * than as an interrupt.
 */
export function stageAmbient(source: string, line: string, opts: { subject?: string; detail?: string } = {}): void {
  const key = `${AMBIENT_PREFIX}${source}`;
  let items: AmbientItem[] = [];
  const existing = getMemory(AMBIENT_GROUP, key);
  if (existing) items = parseAmbient(existing);
  // One entry per subject: a producer re-checking every 30 minutes restages the
  // same thing, and the check-in should carry its latest wording once.
  if (opts.subject) items = items.filter((i) => i.subject !== opts.subject);
  items.push({
    source, line: oneLine(line), at: new Date().toISOString(), subject: opts.subject,
    ...(opts.detail && opts.detail.length > 200 ? { detail: opts.detail.slice(0, 4000) } : {}),
  });
  setMemory(AMBIENT_GROUP, key, JSON.stringify(items));
}

/** Tolerates rows staged by the pre-object version (bare strings). */
function parseAmbient(raw: string): AmbientItem[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [{ source: 'unknown', line: raw, at: '' }];
    return parsed.map((item) => (typeof item === 'string'
      ? { source: 'unknown', line: item, at: '' }
      : item as AmbientItem));
  } catch {
    return raw ? [{ source: 'unknown', line: raw, at: '' }] : [];
  }
}

/** Collect all staged ambient lines (does NOT clear — clear after a successful send). */
export function collectAmbient(): string | null {
  const items = collectAmbientItems();
  return items.length ? items.map((i) => i.line).join('\n') : null;
}

/** Structured form, for the brief that needs to log what it delivered. */
export function collectAmbientItems(): AmbientItem[] {
  const entries = getRecentMemory(AMBIENT_GROUP, { prefix: AMBIENT_PREFIX, limit: 50 });
  const out: AmbientItem[] = [];
  for (const e of entries) out.push(...parseAmbient(e.value));
  return out;
}

/** Drop all staged ambient items. Call after the brief that delivered them ships. */
export function clearAmbient(): void {
  const entries = getRecentMemory(AMBIENT_GROUP, { prefix: AMBIENT_PREFIX, limit: 50 });
  for (const e of entries) deleteMemory(AMBIENT_GROUP, e.key);
}

/** Exposed for the dashboard and the doctor. */
export function arbiterConfig(): { mode: 'observe' | 'enforce'; dailyBudget: number; overdraft: number } {
  return { mode: mode(), dailyBudget: dailyBudget(), overdraft: budgetOverdraft() };
}

// ── Shape + "more" ───────────────────────────────────────────────────────────

const DETAILS_GROUP = 'cos-checkin';
const DETAILS_KEY = 'last_details';
/** An interrupt is read in a notification banner; anything longer is trimmed and kept for "more". */
export const INTERRUPT_MAX_CHARS = 320;

/** Cut at a line boundary under max, ending with the reply hint (kept, or "more"). */
export function trimToLines(text: string, max: number): string {
  const lines = text.split('\n');
  const hint = lines.length > 1 && /^↩/.test(lines[lines.length - 1]) ? lines.pop()! : '↩ "more"';
  const out: string[] = [];
  let len = hint.length + 2;
  for (const line of lines) {
    if (len + line.length + 1 > max) {
      // A single overlong first line still needs to say something.
      if (!out.length) out.push(`${line.slice(0, Math.max(0, max - len - 1)).trimEnd()}…`);
      break;
    }
    out.push(line);
    len += line.length + 1;
  }
  return `${out.join('\n').trimEnd()}\n\n${hint}`;
}

export function shapeInterrupt(plain: string): string {
  if (plain.length <= INTERRUPT_MAX_CHARS) return plain;
  try { saveDetails(plain); } catch (err) { console.error('[cos-outbound] failed to save details:', err); }
  return trimToLines(plain, INTERRUPT_MAX_CHARS);
}

/** The full text behind the last check-in or trimmed interrupt, for "more". */
export function saveDetails(text: string): void {
  setMemory(DETAILS_GROUP, DETAILS_KEY, JSON.stringify({ at: new Date().toISOString(), text: text.slice(0, 12000) }));
}

/** Details from the last 18h, or null. */
export function getRecentDetails(): string | null {
  const raw = getMemory(DETAILS_GROUP, DETAILS_KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { at: string; text: string };
    return Date.now() - new Date(d.at).getTime() < 18 * 3600_000 ? d.text : null;
  } catch {
    return null;
  }
}
