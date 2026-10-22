// The call log (call review step 1). Most business calls that went wrong ended
// without the assistant's wrap-up, which threw away whatever the call learned (a
// business offered Friday at 10, 11 or 12; it was logged as a generic "try again
// later"). Now every errand call keeps:
//   - the full timed transcript (30 days, or for good with "keep transcript"),
//   - who ended it, reply delays and talk-over,
//   - a separate review step that reads the transcript and writes down what was
//     learned and an honest verdict, judged on what the other side said
//     (voicemail-only, menu-only, silence and early hang-ups are failures).
// `npm run calls:review` prints it.

import db from './db.js';
import { OPENAI_ROUTER_MODEL, openAIText } from './lib/openai.js';
import { extractFirstJson } from './lib/daemon.js';
import { withLlmContext } from './lib/llm-context.js';
import type { CallTimingStats } from './lib/call-timing.js';
import type { CallResult } from './phone.js';

export type AnsweredBy = 'person' | 'menu' | 'voicemail' | 'recording' | 'nobody';
export type CallVerdict =
  | 'goal_met' | 'progress' | 'voicemail_left' | 'menu_stuck' | 'hung_up'
  | 'no_answer' | 'redirected' | 'closed' | 'other';
const ANSWERED: AnsweredBy[] = ['person', 'menu', 'voicemail', 'recording', 'nobody'];
const VERDICTS: CallVerdict[] = ['goal_met', 'progress', 'voicemail_left', 'menu_stuck', 'hung_up', 'no_answer', 'redirected', 'closed', 'other'];

/** Why the call ended, from our side's view of the line. */
export type EndReason =
  | 'bot_end_call' | 'they_hung_up' | 'line_dropped' | 'dead_air' | 'max_length'
  | 'no_answer' | 'busy' | 'failed';

export interface CallReview {
  answeredBy: AnsweredBy;
  goalMet: boolean;
  verdict: CallVerdict;
  /** One or two plain sentences: what happened. */
  summary: string;
  /** What the other side told us that matters later (times, names, numbers, hours), or ''. */
  learned: string;
  /** What should happen next, or ''. */
  nextStep: string;
}

export interface CallReviewInput {
  goal: string;
  target: string;
  transcript: string;
  menuLog: string[];
  endReason: EndReason;
  /** The assistant's own end_call status and outcome, when it wrapped up. */
  botStatus: string;
  botOutcome: string;
}

let ready = false;
/** Creates the table if it isn't there yet (readers like the scorecard call this first). */
export function ensureCallLog(): void { ensure(); }
function ensure(): void {
  if (ready) return;
  db.exec(`CREATE TABLE IF NOT EXISTS call_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    call_id TEXT, errand_id INTEGER, action_id INTEGER,
    target TEXT, phone TEXT, practice INTEGER NOT NULL DEFAULT 0,
    duration_s REAL, end_reason TEXT,
    bot_status TEXT, answered_by TEXT, verdict TEXT, goal_met INTEGER,
    summary TEXT, learned TEXT, next_step TEXT,
    replies INTEGER, median_reply_ms INTEGER, max_reply_ms INTEGER,
    talk_overs INTEGER, echoes INTEGER, first_words_ms INTEGER,
    menu TEXT, transcript TEXT, keep INTEGER NOT NULL DEFAULT 0,
    conference_sid TEXT, twilio_sid TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.exec('CREATE INDEX IF NOT EXISTS idx_call_log_errand ON call_log(errand_id, created_at)');
  // Whether reply delays were timed from the assistant's voice playing (1) or from
  // when it started composing a reply (0, a little early). See CallTimingStats.audioTimed.
  const cols = db.prepare('PRAGMA table_info(call_log)').all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'audio_timed')) db.exec('ALTER TABLE call_log ADD COLUMN audio_timed INTEGER');
  // What was on the line, in order ("greeting → menu 0:11 → person 0:25").
  if (!cols.some((c) => c.name === 'stages')) db.exec('ALTER TABLE call_log ADD COLUMN stages TEXT');
  ready = true;
}

const KEEP_DAYS = () => Math.max(1, Number(process.env.CALL_LOG_KEEP_DAYS || 30));

export interface CallLogEntry {
  callId: string; errandId?: number; actionId?: number; target: string; phone: string; practice: boolean;
  durationS: number; endReason: EndReason; botStatus: string;
  review: CallReview | null; timing: CallTimingStats; echoes: number;
  menuLog: string[]; transcript: string; keep: boolean;
  conferenceSid?: string; twilioSid?: string;
  /** The call's stages, from src/lib/call-stage.ts. */
  stages?: string;
}

export function recordCall(e: CallLogEntry): number {
  ensure();
  const r = e.review;
  const id = db.prepare(`INSERT INTO call_log
    (call_id, errand_id, action_id, target, phone, practice, duration_s, end_reason, bot_status,
     answered_by, verdict, goal_met, summary, learned, next_step,
     replies, median_reply_ms, max_reply_ms, talk_overs, echoes, first_words_ms,
     menu, transcript, keep, conference_sid, twilio_sid, audio_timed, stages)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    e.callId, e.errandId ?? null, e.actionId ?? null, e.target, e.phone, e.practice ? 1 : 0,
    Math.round(e.durationS * 10) / 10, e.endReason, e.botStatus || null,
    r?.answeredBy ?? null, r?.verdict ?? null, r ? (r.goalMet ? 1 : 0) : null, r?.summary ?? null, r?.learned || null, r?.nextStep || null,
    e.timing.replies.length, e.timing.medianReplyMs, e.timing.maxReplyMs, e.timing.talkOvers, e.echoes, e.timing.firstWordsMs,
    e.menuLog.join('; ') || null, e.transcript || null, e.keep ? 1 : 0, e.conferenceSid ?? null, e.twilioSid ?? null,
    e.timing.audioTimed ? 1 : 0, e.stages ?? null,
  ).lastInsertRowid as number;
  pruneTranscripts();
  return id;
}

/** Transcripts older than CALL_LOG_KEEP_DAYS are cleared unless the owner asked to keep them. The numbers stay. */
export function pruneTranscripts(days = KEEP_DAYS()): number {
  ensure();
  return db.prepare(`UPDATE call_log SET transcript = NULL
    WHERE keep = 0 AND transcript IS NOT NULL AND created_at < datetime('now', ?)`).run(`-${days} days`).changes as number;
}

export interface CallLogRow {
  id: number; call_id: string; errand_id: number | null; target: string; phone: string; practice: number;
  duration_s: number; end_reason: string; bot_status: string | null; answered_by: string | null;
  verdict: string | null; goal_met: number | null; summary: string | null; learned: string | null; next_step: string | null;
  replies: number; median_reply_ms: number | null; max_reply_ms: number | null; talk_overs: number; echoes: number;
  first_words_ms: number | null; menu: string | null; transcript: string | null; conference_sid: string | null;
  twilio_sid: string | null; created_at: string;
  audio_timed?: number | null;
  stages?: string | null;
}

export function listCalls(opts: { days?: number; includePractice?: boolean; errandId?: number } = {}): CallLogRow[] {
  ensure();
  const where = [`created_at > datetime('now', ?)`];
  const args: unknown[] = [`-${opts.days ?? 7} days`];
  if (!opts.includePractice) where.push('practice = 0');
  if (opts.errandId) { where.push('errand_id = ?'); args.push(opts.errandId); }
  return db.prepare(`SELECT * FROM call_log WHERE ${where.join(' AND ')} ORDER BY id DESC`).all(...args) as CallLogRow[];
}

/** The newest call on an errand (the canary reads it to see whether the assistant kept quiet). */
export function lastCallFor(errandId: number): CallLogRow | null {
  return listCalls({ days: 3650, includePractice: true, errandId })[0] ?? null;
}

// ── The review step ─────────────────────────────────────────────────────────

const REVIEW_RULES = `You review a phone call an AI assistant ("Bot") made to a business for its boss. Read the transcript and report what really happened, judged on what the OTHER side said, not on what the assistant claimed.
answered_by: "person" if a live human spoke (not a recording); "menu" if only an automated phone menu; "voicemail" if a voicemail greeting or beep; "recording" for other recorded messages (closed message, hours, hold message); "nobody" if nothing was heard.
verdict: "goal_met" only if the other side clearly did or confirmed the goal; "progress" if a person gave something useful toward it (times offered, a price, a name, a callback promise) but it wasn't finished; "voicemail_left" if the assistant left a message after a beep; "menu_stuck" if it never got past a phone menu; "hung_up" if they ended the call early or right after the assistant spoke; "redirected" if told to use a website, email or another number; "closed" if a recording said they're closed; "no_answer" if nobody engaged; else "other". Voicemail only, a menu only, silence or an early hang-up are never goal_met.
learned: everything said by the other side that matters later, attributed and specific: dates/times offered, prices, names and roles, reference numbers, other phone numbers (including emergency lines in a greeting), hours, instructions. Empty string if nothing.
next_step: the one thing that should happen next, for the boss or the assistant, in plain words. Empty string if nothing.
summary: one or two short plain sentences.
Reply with JSON only: {"answered_by": "...", "verdict": "...", "goal_met": true|false, "summary": "...", "learned": "...", "next_step": "..."}`;

type Reviewer = (i: CallReviewInput) => Promise<CallReview | null>;

const defaultReviewer: Reviewer = async (i) => {
  // Isolated test runs never call a model unless they stub one in.
  if (process.env.ASSISTANT_DB_PATH && !process.env.CALL_REVIEW_LIVE) return null;
  const raw = await withLlmContext({ caller: 'call-review', lane: 'batch' }, () => openAIText({
    model: process.env.CALL_REVIEW_MODEL || OPENAI_ROUTER_MODEL,
    system: REVIEW_RULES,
    prompt: [
      `GOAL: ${i.goal}`,
      `CALLED: ${i.target}`,
      i.menuLog.length ? `KEYS PRESSED: ${i.menuLog.join('; ')}` : '',
      `HOW IT ENDED: ${i.endReason.replace(/_/g, ' ')}`,
      i.botStatus ? `ASSISTANT'S OWN REPORT: ${i.botStatus}: ${i.botOutcome}` : "ASSISTANT'S OWN REPORT: none (the line ended before it wrapped up)",
      `TRANSCRIPT:\n${i.transcript.slice(-12_000)}`,
    ].filter(Boolean).join('\n\n'),
    maxOutputTokens: 500,
  }));
  return parseReview(raw);
};

export function parseReview(raw: string): CallReview | null {
  const json = extractFirstJson(raw, '{', '}');
  if (!json) return null;
  const p = JSON.parse(json) as Record<string, unknown>;
  const s = (v: unknown, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const answeredBy = ANSWERED.includes(p.answered_by as AnsweredBy) ? p.answered_by as AnsweredBy : 'nobody';
  const verdict = VERDICTS.includes(p.verdict as CallVerdict) ? p.verdict as CallVerdict : 'other';
  return {
    answeredBy, verdict, goalMet: p.goal_met === true && verdict === 'goal_met',
    summary: s(p.summary), learned: s(p.learned), nextStep: s(p.next_step, 300),
  };
}

let reviewer: Reviewer = defaultReviewer;
/** Tests swap in a stub. */
export function setCallReviewer(fn: Reviewer | null): void { reviewer = fn ?? defaultReviewer; }

/** Never throws and never holds a call up for long: a review that fails or times out is just missing. */
export async function reviewCall(i: CallReviewInput, timeoutMs = 25_000): Promise<CallReview | null> {
  // Nothing was heard and the assistant said nothing: no model needed.
  if (!i.transcript.trim()) {
    return { answeredBy: 'nobody', goalMet: false, verdict: 'no_answer', summary: 'Nothing was heard on the line.', learned: '', nextStep: '' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reviewer(i),
      new Promise<null>((r) => { timer = setTimeout(() => { console.warn('[call-log] review timed out'); r(null); }, timeoutMs); }),
    ]);
  } catch (err) {
    console.warn('[call-log] review failed:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fold the review into the call's result. The assistant's own wrap-up stands when
 * it gave one; the review only adds what it left out. When the line ended before
 * its wrap-up, the review is the only record: a person who gave something useful
 * makes it a question for the owner, instead of a blind redial of a place that
 * already answered.
 */
export function applyReview(result: CallResult, review: CallReview | null): CallResult {
  if (!review) return result;
  const out: CallResult = { ...result, review };
  if (result.endedWithoutOutcome) {
    // They confirmed it and said goodbye before the assistant's wrap-up landed (booked,
    // "bye now", hung up). Done, if the checker agrees with the transcript.
    if (review.answeredBy === 'person' && review.goalMet) {
      out.status = 'done';
      out.outcome = review.summary;
    } else if (review.verdict === 'hung_up' && review.answeredBy === 'person') {
      // They hung up on the intro ("Hello?", the AI intro, click): not a question for
      // the owner. Move on to the next place; the review's notes still go in the log.
      out.status = 'failed';
      out.outcome = review.summary || 'They hung up right after the intro.';
    } else if (review.answeredBy === 'person' && (review.verdict === 'progress' || review.verdict === 'goal_met' || review.learned)) {
      out.status = 'blocked';
      out.outcome = `The line ended before I wrapped up. ${review.summary}`.trim();
      out.followUp = review.nextStep || 'Tell me whether to call them back.';
    } else if (review.verdict === 'voicemail_left') {
      out.status = 'voicemail';
      out.outcome = review.summary;
    } else if (review.summary) {
      out.outcome = review.summary;
    }
  }
  if (review.learned) {
    const notes = out.notes ?? {};
    if (!notes.said) out.notes = { ...notes, said: review.learned };
    // A voicemail greeting or a "call back" can carry the one detail the owner
    // needs now (an emergency line in a greeting, say).
    if (!out.followUp && out.status !== 'done') out.followUp = review.learned;
  }
  return out;
}

/** The review line that goes into the errand log (and that the scorecard reads). */
export function reviewLine(review: CallReview | null, endReason: EndReason, timing: CallTimingStats): string {
  const parts = [
    review ? `Review: ${review.verdict.replace(/_/g, ' ')}; answered by ${review.answeredBy}` : 'Review: none',
    `ended: ${endReason.replace(/_/g, ' ')}`,
    timing.medianReplyMs !== null ? `reply ${(timing.medianReplyMs / 1000).toFixed(1)}s median, ${((timing.maxReplyMs ?? 0) / 1000).toFixed(1)}s max${timing.audioTimed ? '' : ' (to composing, not voice)'}` : '',
    timing.talkOvers ? `talked over ${timing.talkOvers}x` : '',
  ];
  return parts.filter(Boolean).join('; ');
}
