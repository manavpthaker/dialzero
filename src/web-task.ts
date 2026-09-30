// Web tasks: anything the owner wants done on a website that isn't a booking
// (cancel a subscription, export data, change a setting, start a return), done
// in the owner's own Chrome through the browser bridge. Same machinery as online
// booking (src/web-booking.ts): the browser lock, a time-boxed sub-agent whose
// only tools are the scoped `booking-browser` tools (own tab, no payment
// fields, no uploads), and a `reply` interrupt with the result.
//
// Website work goes here, never through computer_use: desktop control is only
// for things outside Chrome.
//
// Two ways in (tools/web-task.ts#do_online):
//   - the owner asked in their own words → startWebTask now (no go);
//   - the bot's own idea → propose_action with executor `web_task`, and
//     runWebTaskAction starts it on "go #action:N".

import {
  proposeAction, confirmAction, markActionExecuting, markActionDone, markActionFailed,
  getAction, listRecentActions, getMemory, setMemory, deleteMemory,
  type Action,
} from './db.js';
import { parseNumEnv } from './lib/env.js';
import { todayET } from './lib/time-et.js';
import { tzAbbrev } from './lib/time.js';
import { getBotName } from './config.js';
import { bookingDeps, runBrowserSubAgent, FORBIDDEN_SHARE, looksLikeCardNumber } from './web-booking.js';

export interface WebTaskPayload {
  task: string;            // "cancel my PLAUD subscription, after exporting all recordings as audio"
  site: string;            // URL or the service name
  share?: string;          // details the task may enter, with values
  notes?: string;
  owner_request?: string;  // their words, when they asked for it themselves
}

type Prepared = { payload: Record<string, unknown>; summary: string } | { error: string };

// Each browser run is time-boxed; a long job (exporting dozens of recordings)
// takes several runs. The job keeps going, run after run, until it's done, it
// needs the owner (blocked), or it runs out of tries.
const TIMEOUT_MS = () => parseNumEnv('WEB_TASK_TIMEOUT_MS', 30 * 60_000);
const MAX_RUNS = () => parseNumEnv('WEB_TASK_MAX_RUNS', 20);
const RETRY_GAP_MS = () => parseNumEnv('WEB_TASK_RETRY_GAP_MS', 3 * 60_000);
const TICK_MS = 5 * 60_000;
const STATE_GROUP = 'web-task';

export const WEB_TASK_NOT_CONNECTED = "Chrome isn't connected on the mini, so I can't do that online right now.";

/** Validates a web task and writes the phone-sized summary the owner approves. */
export function prepareWebTask(p: Record<string, unknown>): Prepared {
  const s = (k: string) => (typeof p[k] === 'string' ? (p[k] as string).trim() : '');
  const task = s('task');
  const site = s('site');
  const share = s('share');
  const notes = s('notes');
  if (!task) return { error: 'needs "task" (what to get done, e.g. "cancel my PLAUD subscription").' };
  if (!site) return { error: 'needs "site" (the URL or the service name).' };
  if ((share && FORBIDDEN_SHARE.test(share)) || looksLikeCardNumber(share) || looksLikeCardNumber(notes)) {
    return { error: 'web tasks never use card, bank, ID, or password details. Logins come from their signed-in Chrome.' };
  }
  const payload: WebTaskPayload = { task, site };
  if (share) payload.share = share;
  if (notes) payload.notes = notes;
  if (s('owner_request')) payload.owner_request = s('owner_request');
  const named = task.toLowerCase().includes(site.toLowerCase()) || /^https?:/.test(site) ? task : `${task} (${site})`;
  const summary = `${named.charAt(0).toUpperCase()}${named.slice(1).replace(/[.\s]+$/, '')}.`;
  return { payload: payload as unknown as Record<string, unknown>, summary };
}

export interface WebTaskResult {
  status: 'done' | 'blocked' | 'failed' | 'in_progress';
  summary: string;
  confirmation?: string;
  url?: string;
}

/** The sub-agent's last message must be one JSON object; anything else is a failure. */
export function parseWebTaskResult(text: string): WebTaskResult {
  const bad = (why: string): WebTaskResult => ({ status: 'failed', summary: `Couldn't read the result (${why}).` });
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
  if (status !== 'done' && status !== 'blocked' && status !== 'failed' && status !== 'in_progress') return bad(`status "${String(status)}"`);
  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
  if (!summary) return bad('no summary');
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return { status, summary, confirmation: str(obj.confirmation), url: str(obj.url) };
}

export function webTaskPrompt(p: WebTaskPayload, progress: string[] = []): string {
  const sofar = progress.length
    ? `\n\nEARLIER RUNS OF THIS SAME TASK (pick up where they left off; check the page, don't redo finished items):\n${progress.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
    : '';
  return `You are doing a task on a website for the owner, in their own Chrome. They're signed in to most sites, and a password manager may fill saved logins. Today is ${todayET()} (${tzAbbrev()}).

TASK: ${p.task}
SITE: ${p.site}${p.share ? `\nDETAILS YOU MAY ENTER (and nothing else): ${p.share}` : ''}${p.notes ? `\nNOTES: ${p.notes}` : ''}${sofar}

You are ${getBotName()}, their assistant: get it done. The site won't make it obvious; figure it out.

How:
1. If SITE is a URL, open it. Otherwise go to the service's own site (a search via browser_navigate is fine) and find the account or settings page.
2. Do the task in the order it's written. If an earlier step (like an export) can't be done or confirmed on the page, STOP before any later step that can't be undone (like cancelling), with status "blocked".
3. Downloads go to the Mac's Downloads folder; clicking a site's download or export button is fine.
4. Long jobs (many items one at a time): work steadily, and after roughly 20 items stop with status "in_progress", saying exactly what's done and what's left. You'll be started again to continue.

When something doesn't work, try another way before giving up. In order:
- Use snapshot to see what's actually clickable, then click by index. Rows in a list, "..." menus, and icons often only show in snapshot.
- Scroll: long lists load more as you scroll. Look for a select-all checkbox, a bulk "Export" or "Download" in a toolbar, a "..." menu on each item, and account/settings pages (often "Data", "Privacy", "Export", "Download my data").
- Look it up: web_search "how to <task> on <site>" and follow the help-center steps.
- Check your work: check_downloads shows what landed in Downloads.
- If one method is too slow for everything (e.g. hundreds of items one at a time), still make steady progress with it and return "in_progress".

Status rules:
- "blocked" ONLY when it needs the owner: a login or code they must enter, a payment, a decision only they can make, or a company that will only do it by phone or with a person. Say exactly what they need to do.
- Anything else you couldn't do yet (can't find the button, a click did nothing, the page is confusing) is "failed" with what you tried and what to try next. You'll be started again with that note, so the next run tries something different.

Hard rules:
- Logins: if a login page is filled in, click sign in. If it stays empty, or asks for a password, a code, or a CAPTCHA, STOP with status "blocked" and say which site needs them to log in. Never type or guess a password or code.
- NEVER pay, enter a card, or click a pay/upgrade button.
- When cancelling: decline every offer to stay (discounts, free months, pausing, downgrading) unless NOTES says to take it. Keep going to the final cancel confirmation. If the only way to cancel is a phone call or chat with a person, STOP with status "blocked" and say so.
- Never delete the account or its data unless TASK says to, in those words. Never change a password or email.
- Don't create accounts. Don't do anything the task didn't ask for.

Your LAST message must be ONLY this JSON (no other text):
{"status":"done|in_progress|blocked|failed","summary":"one or two short lines for the owner: what happened, and when it ends if it's a cancellation (for in_progress: what's done and what's left)","confirmation":"confirmation number or email mentioned, if shown","url":"page you ended on"}
Use "done" only when the page showed the task finished (e.g. "Your subscription has been cancelled").`;
}

interface RunState { runs: number; progress: string[]; nextAt: number }

function loadState(id: number): RunState {
  try {
    const raw = getMemory(STATE_GROUP, `task_${id}`);
    if (raw) return JSON.parse(raw) as RunState;
  } catch { /* fresh state */ }
  return { runs: 0, progress: [], nextAt: 0 };
}
function saveState(id: number, st: RunState): void { setMemory(STATE_GROUP, `task_${id}`, JSON.stringify(st)); }

const running = new Set<number>();

// What only the owner can do: log in, pay, decide, or talk to a person.
const OWNER_NEEDED = /\b(log ?in|sign ?in|password|passcode|verification code|one-time code|2fa|two-factor|captcha|card|payment|pay\b|deposit|billing info|phone|call (them|us|support)|by phone|live chat|chat with|speak (to|with)|agent|representative|(his|her|their|the owner's) (decision|choice|approval)|decide|which one|verify (your|his) identity|identity)\b/i;
export function needsOwner(summary: string): boolean { return OWNER_NEEDED.test(summary); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Works one web task to the end: run after run in the browser until it's done,
 * blocked on the owner, or out of tries. Progress survives restarts (memory
 * group `web-task`), and the tick resumes a job the process dropped. Only the
 * end result is texted. Never throws.
 */
export async function runWebTask(actionId: number, p: WebTaskPayload): Promise<WebTaskResult> {
  if (running.has(actionId)) return { status: 'in_progress', summary: 'already running' };
  running.add(actionId);
  const d = bookingDeps();
  markActionExecuting(actionId);
  const st = loadState(actionId);
  let result: WebTaskResult = { status: 'failed', summary: 'Never started.' };
  try {
    while (st.runs < MAX_RUNS()) {
      if (getAction(actionId)?.status === 'cancelled') return { status: 'failed', summary: 'cancelled' };
      st.runs++;
      saveState(actionId, st);
      if (!d.isConnected()) {
        result = { status: 'failed', summary: "Chrome wasn't connected on the mini." };
      } else {
        try {
          const timeoutMs = TIMEOUT_MS();
          const out = await runBrowserSubAgent(`web-task #${actionId}`, webTaskPrompt(p, st.progress), timeoutMs);
          result = out === null
            ? { status: 'in_progress', summary: `A run hit the ${Math.round(timeoutMs / 60_000)}-min limit; check the page for what's done.` }
            : parseWebTaskResult(out);
        } catch (err) {
          result = { status: 'failed', summary: `Browser error: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      // "Blocked" means the owner has to do something. The sub-agent sometimes says
      // blocked when it just couldn't find the way; that's a retry, not a stop.
      if (result.status === 'blocked' && !needsOwner(result.summary)) {
        result = { ...result, status: 'failed', summary: `${result.summary} (Not actually blocked on the owner: try a different way.)` };
      }
      if (result.status === 'done' || result.status === 'blocked') break;
      st.progress = [...st.progress, `Run ${st.runs} (${result.status === 'in_progress' ? 'progress' : "didn't work"}): ${result.summary}`].slice(-10);
      // Real progress continues right away; a failure waits a few minutes first.
      st.nextAt = Date.now() + (result.status === 'in_progress' ? 0 : RETRY_GAP_MS());
      saveState(actionId, st);
      if (st.runs < MAX_RUNS() && result.status !== 'in_progress') await sleep(RETRY_GAP_MS());
    }
  } finally {
    running.delete(actionId);
  }

  let text: string;
  if (result.status === 'done') {
    const conf = result.confirmation ? ` (${result.confirmation})` : '';
    text = `✅ ${result.summary}${conf}`;
    markActionDone(actionId, { outcome: `${result.summary}${conf}`, outcome_url: result.url ?? null, actual_cost_cents: 0 });
  } else if (result.status === 'blocked') {
    text = `Stuck on ${p.site}: ${result.summary}`;
    markActionFailed(actionId, `blocked: ${result.summary}`);
  } else {
    const last = (st.progress.at(-1) ?? result.summary).replace(/^Run \d+ \([^)]*\): /, '');
    text = `Couldn't finish on ${p.site} after ${st.runs} tries. Last: ${last}`;
    markActionFailed(actionId, `gave up: ${last}`);
  }
  deleteMemory(STATE_GROUP, `task_${actionId}`);
  try {
    await d.notify(text, `web-task:${actionId}`);
  } catch (err) {
    console.error(`[web-task] could not tell the owner about #${actionId}:`, err);
  }
  return result;
}

/** Picks back up any web task the process dropped (a restart mid-job). */
export function resumeWebTasks(now = Date.now()): number {
  let resumed = 0;
  for (const a of listRecentActions(100)) {
    if (a.kind !== 'web_task' || a.status !== 'executing' || running.has(a.id)) continue;
    if (loadState(a.id).nextAt > now) continue;
    void runWebTask(a.id, JSON.parse(a.payload_json) as WebTaskPayload);
    resumed++;
  }
  return resumed;
}

export function startWebTaskRunner(): void {
  setTimeout(() => { resumeWebTasks(); }, 20_000);
  setInterval(() => { resumeWebTasks(); }, TICK_MS);
}

/** Owner-asked path: an auto-confirmed actions row (kind 'web_task'), run in the background. */
export function startWebTask(payload: WebTaskPayload, summary: string, group: string): { id: number; done: Promise<WebTaskResult> } {
  const id = proposeAction({
    kind: 'web_task', tool_name: 'web_task', summary,
    payload_json: JSON.stringify(payload), estimated_cost_cents: null, reversible: false,
    category: 'web_task', created_by_group: group,
  });
  confirmAction(id);
  return { id, done: runWebTask(id, payload) };
}

let lastRun: Promise<WebTaskResult> | null = null;
/** Tests await the run started by the most recent `go`. */
export function lastWebTaskRun(): Promise<WebTaskResult> | null { return lastRun; }

/** The `web_task` executor (inside confirm_action on "go #action:N"). */
export async function runWebTaskAction(action: Action): Promise<{ outcome: string; actual_cost_cents: number }> {
  if (!bookingDeps().isConnected()) throw new Error(`human_handoff_needed: ${WEB_TASK_NOT_CONNECTED}`);
  const payload = JSON.parse(action.payload_json) as WebTaskPayload;
  lastRun = new Promise<WebTaskResult>((resolve) => {
    setTimeout(() => { void runWebTask(action.id, payload).then(resolve); }, 300);
  });
  return { outcome: "On it. I'll text you when it's done.", actual_cost_cents: 0 };
}
