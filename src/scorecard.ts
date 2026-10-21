// The weekly scorecard: is the assistant actually getting things done?
// Jobs asked for vs finished, calls that reached a person, what the checker
// caught, how often the owner was asked something, their list, and what it all
// cost. Staged into the Sunday morning check-in; `npm run scorecard` prints it.

import { scheduleCron } from './lib/cron.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import dbh, { getMemory, setMemory } from './db.js';
import { stageSection } from './checkins.js';
import { OPENAI_MODEL, openAIText } from './lib/openai.js';
import { extractFirstJson } from './lib/daemon.js';
import { withLlmContext } from './lib/llm-context.js';
import { todayET } from './lib/time-et.js';
import { ensureCallLog } from './call-log.js';
import { getBotName } from './config.js';

const db = dbh as unknown as { prepare: (sql: string) => { get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] } };
const one = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).get(...a) as T;
const all = <T>(sql: string, ...a: unknown[]) => db.prepare(sql).all(...a) as T[];

export interface Scorecard { text: string; numbers: Record<string, number> }

/** Real calls only: not the daily practice call, not owner test calls. */
const REAL_CALL = `r.goal NOT LIKE 'CANARY%' AND r.goal NOT LIKE 'TEST%' AND COALESCE(json_extract(r.envelope_json, '$.silent'), 0) != 1`;

export function callStatusOf(detail: string): string {
  return detail.match(/^[^:]*: (done|retry_later|voicemail|blocked|failed)/)?.[1] ?? 'other';
}

/** A live person spoke. The after-call review says so; older rows are judged by their transcript lines. */
export function personSpoke(detail: string): boolean {
  const by = detail.match(/answered by (\w+)/)?.[1];
  if (by) return by === 'person';
  return /\nThem: /.test(detail) && callStatusOf(detail) !== 'voicemail' && !/\nMenu: /.test(detail);
}

/** The assistant ended the call itself with its wrap-up (end_call), rather than the line ending on it. */
export function botWrappedUp(detail: string): boolean {
  const ended = detail.match(/ended: ([a-z ]+)/)?.[1];
  if (ended) return ended === 'bot end call';
  return !/no one engaged|ended without a recorded outcome|No one picked up|busy/i.test(detail);
}

export function buildScorecard(days = 7): Scorecard {
  const since = `-${days} days`;
  const n: Record<string, number> = {};

  // Website jobs and bookings (the job tracker), by how they ended.
  const jobs = all<{ kind: string; status: string; c: number }>(
    `SELECT kind, status, COUNT(*) c FROM jobs WHERE kind IN ('web_task','booking') AND title NOT LIKE 'Practice%' AND created_at > datetime('now', ?) GROUP BY kind, status`, since);
  const jobCount = (st?: string) => jobs.filter((j) => !st || j.status === st).reduce((a, j) => a + j.c, 0);
  n.web_started = jobCount(); n.web_done = jobCount('done'); n.web_failed = jobCount('failed');
  n.web_stopped = jobCount('stopped'); n.web_waiting = jobCount('waiting_on_you') + jobCount('working');

  // Calls: every real dial (practice and test calls left out), and three separate
  // numbers per call: a person spoke, the assistant wrapped up, the goal was met.
  // "Reached" used to count only calls the assistant wrapped up itself, so a week
  // could say 0 reached although people answered several calls.
  n.calls = one<{ c: number }>(`SELECT COUNT(*) c FROM errand_events e JOIN errands r ON r.id = e.errand_id WHERE e.type='dialing' AND ${REAL_CALL} AND e.at > datetime('now', ?)`, since).c;
  const results = all<{ detail: string }>(`SELECT e.detail FROM errand_events e JOIN errands r ON r.id = e.errand_id WHERE e.type='call_result' AND ${REAL_CALL} AND e.at > datetime('now', ?)`, since);
  n.calls_done = results.filter((r) => callStatusOf(r.detail) === 'done').length;
  n.calls_reached = results.filter((r) => personSpoke(r.detail)).length;
  n.calls_wrapped = results.filter((r) => botWrappedUp(r.detail)).length;
  ensureCallLog();
  const practice = all<{ transcript: string | null }>(`SELECT transcript FROM call_log WHERE practice = 1 AND target = 'NIST time line' AND created_at > datetime('now', ?)`, since);
  n.practice_calls = practice.length;
  n.practice_clean = practice.filter((p) => !/\] Bot: /.test(p.transcript ?? '')).length;
  const replies = all<{ m: number | null }>(`SELECT median_reply_ms m FROM call_log WHERE practice = 0 AND median_reply_ms IS NOT NULL AND created_at > datetime('now', ?)`, since)
    .map((r) => r.m as number).sort((a, b) => a - b);
  n.reply_median_ms = replies.length ? replies[Math.floor((replies.length - 1) / 2)] : 0;
  // The practice line (src/practice-line.ts): scripted scenes, graded on how the assistant behaved.
  const scenes = all<{ value: string }>(`SELECT value FROM memory WHERE group_id = 'practice' AND key LIKE 'result_%' AND updated_at > datetime('now', ?)`, since)
    .map((r) => { try { return JSON.parse(r.value) as { scene: string; pass: boolean }; } catch { return null; } })
    .filter((g): g is { scene: string; pass: boolean } => !!g);
  n.practice_scenes = scenes.length;
  n.practice_scenes_passed = scenes.filter((g) => g.pass).length;
  const failedScenes = [...new Set(scenes.filter((g) => !g.pass).map((g) => g.scene))];
  n.calls_phone_down = one<{ c: number }>(`SELECT COUNT(*) c FROM errand_events WHERE type='phone_down' AND at > datetime('now', ?)`, since).c;

  // The checker.
  n.checker_caught = one<{ c: number }>(`SELECT COUNT(*) c FROM job_journal WHERE type='check' AND detail LIKE '%not verified%' AND at > datetime('now', ?)`, since).c
    + results.filter((r) => /Not confirmed:/.test(r.detail)).length;

  // How much came back to the owner.
  n.asks = one<{ c: number }>(`SELECT COUNT(*) c FROM job_journal WHERE type='ask' AND at > datetime('now', ?)`, since).c;
  n.texts = one<{ c: number }>(`SELECT COUNT(*) c FROM outbound_log WHERE decision='sent' AND created_at > datetime('now', ?)`, since).c;

  // The owner's list.
  n.tasks_open = one<{ c: number }>(`SELECT COUNT(*) c FROM tasks WHERE status='open'`).c;
  n.tasks_overdue = one<{ c: number }>(`SELECT COUNT(*) c FROM tasks WHERE status='open' AND due_date < date('now')`).c;
  n.tasks_added = one<{ c: number }>(`SELECT COUNT(*) c FROM tasks WHERE created_at > datetime('now', ?)`, since).c;
  n.tasks_done = one<{ c: number }>(`SELECT COUNT(*) c FROM tasks WHERE status='done' AND completed_at > datetime('now', ?)`, since).c;

  // Cost.
  const cost = all<{ caller: string; usd: number }>(
    `SELECT COALESCE(caller,'unknown') caller, SUM(cost_micros)/1e6 usd FROM llm_usage WHERE created_at > datetime('now', ?) GROUP BY caller ORDER BY usd DESC`, since);
  n.cost = Math.round(cost.reduce((a, c) => a + c.usd, 0));
  const top = cost.slice(0, 3).map((c) => `${c.caller.replace(/^agent:/, '')} $${Math.round(c.usd)}`).join(', ');

  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');
  const lines = [
    `Website jobs: ${n.web_done} of ${n.web_started} finished (${pct(n.web_done, n.web_started)}); ${n.web_failed} failed, ${n.web_stopped} stopped, ${n.web_waiting} still open.`,
    `Calls: ${n.calls} dials; a person spoke on ${n.calls_reached}, ${getBotName()} wrapped up ${n.calls_wrapped}, ${n.calls_done} got the job done (${pct(n.calls_done, n.calls)}).${n.calls_phone_down ? ` ${n.calls_phone_down} lost to the phone link being down.` : ''}${n.reply_median_ms ? ` Typical reply delay ${(n.reply_median_ms / 1000).toFixed(1)}s.` : ''}${n.practice_calls ? ` Practice calls: ${getBotName()} stayed quiet on ${n.practice_clean} of ${n.practice_calls}.` : ''}${n.practice_scenes ? ` Practice line: ${n.practice_scenes_passed} of ${n.practice_scenes} scenes passed${failedScenes.length ? ` (failed: ${failedScenes.join(', ')})` : ''}.` : ''}`,
    `Checker: caught ${n.checker_caught} "done" that wasn't.`,
    `Asked you ${n.asks} question${n.asks === 1 ? '' : 's'}; ${n.texts} texts in all.`,
    `Your list: ${n.tasks_open} open (${n.tasks_overdue} overdue); ${n.tasks_added} added, ${n.tasks_done} done this week.`,
    `Cost: $${n.cost} (${top}).`,
  ];
  return { text: lines.join('\n'), numbers: n };
}

// ── The improvement loop: why things failed, and what to fix next ────────────

/** The week's failures in their own words: calls that didn't do the job, website jobs that didn't finish. */
export function failureSamples(days = 7): string[] {
  const since = `-${days} days`;
  const calls = all<{ detail: string }>(
    `SELECT e.detail FROM errand_events e JOIN errands r ON r.id = e.errand_id
     WHERE e.type = 'call_result' AND r.goal NOT LIKE 'CANARY%' AND e.detail NOT LIKE '%: done %' AND e.at > datetime('now', ?) ORDER BY e.id DESC LIMIT 40`, since)
    .map((r) => `CALL: ${r.detail.replace(/\s+/g, ' ').slice(0, 300)}`);
  const web = all<{ title: string; status: string; outcome: string | null; id: number }>(
    `SELECT id, title, status, outcome FROM jobs WHERE kind IN ('web_task','booking','email_thread','watch') AND status IN ('failed','stopped')
     AND title NOT LIKE 'Practice%' AND updated_at > datetime('now', ?) ORDER BY id DESC LIMIT 30`, since)
    .map((j) => {
      const last = all<{ detail: string }>(`SELECT detail FROM job_journal WHERE job_id = ? AND type IN ('run','check','ask') ORDER BY id DESC LIMIT 2`, j.id).map((x) => x.detail).join(' | ');
      return `JOB (${j.status}): ${j.title.slice(0, 100)} → ${(j.outcome ?? '').slice(0, 200)}${last ? ` [last steps: ${last.slice(0, 300)}]` : ''}`;
    });
  return [...calls, ...web];
}

const REVIEW_RULES = `You review a personal assistant bot's failed work from the last week, to decide what its developer fixes next.
Group the failures by ROOT CAUSE (not by business). For the top 3 causes, by how many failures they explain:
- cause: plain words, specific ("calls drop ~3s after pickup because the bot's voice joins late", not "call issues")
- count: how many of the failures it explains
- examples: 1-2 short quotes from the failures
- fix: the concrete change to the bot that would fix it (code/prompt/config level), or "owner action: …" if only the owner can fix it
Also one line "owner_only": failures that are fine (the owner stopped them, the site truly needs a person).
Reply JSON only: {"causes":[{"cause":"","count":0,"examples":[""],"fix":""}],"owner_only":""}`;

export interface Review { causes: Array<{ cause: string; count: number; examples: string[]; fix: string }>; owner_only: string }

export async function reviewFailures(samples: string[]): Promise<Review | null> {
  if (!samples.length) return { causes: [], owner_only: '' };
  const raw = await withLlmContext({ caller: 'scorecard:review', lane: 'batch' }, () => openAIText({
    model: process.env.SCORECARD_MODEL || OPENAI_MODEL, system: REVIEW_RULES,
    prompt: `FAILURES (${samples.length}):\n${samples.join('\n')}`, maxOutputTokens: 2000, reasoningEffort: 'medium',
  }));
  const json = extractFirstJson(raw, '{', '}');
  return json ? JSON.parse(json) as Review : null;
}

/** Numbers vs last week's: "+3", "-2", "" when there's no previous week. */
function deltas(now: Record<string, number>): Record<string, string> {
  let prev: Record<string, number> = {};
  try { prev = JSON.parse(getMemory('scorecard', 'last_numbers') ?? '{}'); } catch { /* first week */ }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(now)) if (k in prev) { const d = v - prev[k]; out[k] = d === 0 ? '' : d > 0 ? ` (+${d})` : ` (${d})`; }
  return out;
}

export const REPORT_DIR = process.env.SCORECARD_DIR || join(homedir(), 'assistant-scorecards');

/** The full weekly report: numbers with week-over-week change, top failure causes with fixes. Saved for the fix session. */
export async function weeklyReport(): Promise<string> {
  const card = buildScorecard();
  const d = deltas(card.numbers);
  const n = card.numbers;
  const trend = [
    `Website jobs finished: ${n.web_done}/${n.web_started}${d.web_done ?? ''}`,
    `Calls that did the job: ${n.calls_done}/${n.calls}${d.calls_done ?? ''}`,
    `Checker catches: ${n.checker_caught}${d.checker_caught ?? ''}`,
    `Tasks added/done: ${n.tasks_added}${d.tasks_added ?? ''} / ${n.tasks_done}${d.tasks_done ?? ''}`,
    `Cost: $${n.cost}${d.cost ? d.cost.replace(/([+-]?\d+)/, '$$$1') : ''}`,
  ].join('\n');
  let review: Review | null = null;
  try { review = await reviewFailures(failureSamples()); } catch (err) { console.error('[scorecard] review failed:', err); }
  const causes = review?.causes?.length
    ? review.causes.map((c, i) => `${i + 1}. ${c.cause} (${c.count}). Fix: ${c.fix}${c.examples?.length ? `\n   e.g. ${c.examples.slice(0, 2).join(' / ')}` : ''}`).join('\n')
    : 'No failures to group this week.';
  const report = `How ${getBotName()} did this week:\n${card.text}\n\nVs last week:\n${trend}\n\nTop reasons things failed:\n${causes}${review?.owner_only ? `\n\nFine as is: ${review.owner_only}` : ''}`;
  setMemory('scorecard', 'last_numbers', JSON.stringify(n));
  setMemory('scorecard', 'last_report', report);
  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(join(REPORT_DIR, `${todayET()}.md`), `# ${getBotName()} scorecard ${todayET()}\n\n${report}\n\n## Raw numbers\n\n\`\`\`json\n${JSON.stringify({ numbers: n, review }, null, 2)}\n\`\`\`\n`);
  } catch (err) { console.error('[scorecard] could not save the report:', err); }
  return report;
}

export function startScorecard(): void {
  if (process.env.SCORECARD_ENABLED === 'false') return;
  const expr = process.env.SCORECARD_CRON || '45 6 * * 0'; // before Sunday's morning check-in
  scheduleCron(expr, () => {
    weeklyReport()
      .then((report) => stageSection('scorecard', 'scorecard:weekly', report))
      .catch((err) => console.error('[scorecard] failed:', err));
  });
  console.log(`[scorecard] weekly: "${expr}" (local time)`);
}
