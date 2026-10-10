// Web tasks: anything the owner wants done on a website that isn't a booking
// (cancel a subscription, export data, change a setting, start a return), done
// in their own Chrome through the browser bridge. Same machinery as online
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

import { getBotName } from './config.js';
import { tzAbbrev } from './lib/time.js';
import {
  proposeAction, confirmAction, markActionExecuting, markActionDone, markActionFailed,
  getAction, getExecutingActions, getMemory, setMemory, deleteMemory,
  type Action,
} from './db.js';
import { parseNumEnv } from './lib/env.js';
import { todayET } from './lib/time-et.js';
import { bookingDeps, runBrowserSubAgent, abortBrowserRun, FORBIDDEN_SHARE, looksLikeCardNumber } from './web-booking.js';
import { updateOwner, cleanUpdate, isInfraError } from './lib/job-updates.js';
import { needsHands, showJobTab, withTakeover } from './lib/takeover.js';
import { jobCheckIns, openJob, setJobProgress, waitOnOwner, finishJob, takeAnswer, registerJobKind, journal, type WaitNeed } from './jobs.js';
import { getJob, getJobByRef, patchJob, markActionStopped } from './db.js';
import { preferencesFor } from './lib/preferences.js';
import { checkDone } from './lib/verify.js';
import { siteRulePrompt } from './lib/site-rules.js';

export interface WebTaskPayload {
  task: string;            // "cancel my PLAUD subscription, after exporting all recordings as audio"
  site: string;            // URL or the service name
  share?: string;          // details the task may enter, with values
  notes?: string;
  files?: string[];        // absolute paths they gave for upload (checked by checkUploadPaths)
  practice?: boolean;      // a test run: no texts, never waits on the owner, no follow-up watches
  owner_request?: string;  // their words, when they asked for it themselves
}

type Prepared = { payload: Record<string, unknown>; summary: string } | { error: string };

// Late-bound so web-task.ts doesn't import the browser tool module at load.
let uploadCheck: (files: string[]) => string | null = () => null;
void import('./tools/browser.js').then((m) => { uploadCheck = m.checkUploadPaths; }).catch(() => {});

// Each browser run is time-boxed; a long job (exporting dozens of recordings)
// takes several runs. The job keeps going, run after run, until it's done, it
// needs the owner (blocked), or it runs out of tries.
const TIMEOUT_MS = () => parseNumEnv('WEB_TASK_TIMEOUT_MS', 30 * 60_000);
const MAX_RUNS = () => parseNumEnv('WEB_TASK_MAX_RUNS', 20);
const RETRY_GAP_MS = () => parseNumEnv('WEB_TASK_RETRY_GAP_MS', 3 * 60_000);
const TICK_MS = 5 * 60_000;
const CHROME_WAIT_TRIES = 20;
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
  if (Array.isArray(p.files) && p.files.length) {
    const files = p.files.map(String);
    const bad = uploadCheck(files);
    if (bad) return { error: `files: ${bad}` };
    payload.files = files;
  }
  if (share) payload.share = share;
  if (notes) payload.notes = notes;
  if (s('owner_request')) payload.owner_request = s('owner_request');
  const named = task.toLowerCase().includes(site.toLowerCase()) || /^https?:/.test(site) ? task : `${task} (${site})`;
  const summary = `${named.charAt(0).toUpperCase()}${named.slice(1).replace(/[.\s]+$/, '')}.`;
  return { payload: payload as unknown as Record<string, unknown>, summary };
}

export interface WebTaskResult {
  status: 'done' | 'blocked' | 'failed' | 'in_progress' | 'needs_owner';
  summary: string;
  need?: WaitNeed;
  ask?: string;
  ends_on?: string;      // YYYY-MM-DD, when access ends after a cancellation
  next_charge?: string;  // YYYY-MM-DD, the billing date that should no longer charge
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
  if (status !== 'done' && status !== 'blocked' && status !== 'failed' && status !== 'in_progress' && status !== 'needs_owner') return bad(`status "${String(status)}"`);
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const summary = str(obj.summary) ?? (status === 'needs_owner' ? str(obj.ask) ?? '' : '');
  if (!summary) return bad('no summary');
  const out: WebTaskResult = { status, summary, confirmation: str(obj.confirmation), url: str(obj.url) };
  const day = (v: unknown) => { const t = str(v); return t && /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : undefined; };
  out.ends_on = day(obj.ends_on);
  out.next_charge = day(obj.next_charge);
  if (status === 'needs_owner') {
    const need = String(obj.need ?? '');
    out.need = (['login', 'code', 'link', 'decision', 'info'].includes(need) ? need : guessNeed(summary)) as WaitNeed;
    out.ask = str(obj.ask) ?? summary;
  }
  return out;
}

function prefsFor(...parts: string[]): string {
  const prefs = preferencesFor(parts.join(' '));
  return prefs ? `\n\n${prefs}\n` : '';
}

/** What a "blocked on the owner" summary is asking for. */
export function guessNeed(text: string): WaitNeed {
  if (/\b(magic link|sign[- ]?in link|login link|emailed (you )?a link|sent (you )?a link|link to sign)\b/i.test(text)) return 'link';
  if (/\b(code|2fa|two-factor|verification|one-time|otp)\b/i.test(text)) return 'code';
  if (/\b(log ?in|sign ?in|password|logged out|session)\b/i.test(text)) return 'login';
  if (/\b(decide|choice|which|approve|approval|confirm)\b/i.test(text)) return 'decision';
  return 'info';
}

export function webTaskPrompt(p: WebTaskPayload, progress: string[] = [], extra = ''): string {
  const sofar = progress.length
    ? `\n\nEARLIER RUNS OF THIS SAME TASK (pick up where they left off; check the page, don't redo finished items):\n${progress.map((x, i) => `${i + 1}. ${x}`).join('\n')}`
    : '';
  return `You are doing a task on a website for the owner, in their own Chrome. They're signed in to most sites, and a password manager may fill saved logins. Today is ${todayET()} (${tzAbbrev()}).

TASK: ${p.task}${prefsFor(p.task, p.site)}${(() => { const r = siteRulePrompt(p.site); return r ? `\n${r}` : ''; })()}
SITE: ${p.site}${p.files?.length ? `\nFILES YOU MAY UPLOAD (set_files, these paths only): ${p.files.join(', ')}` : ''}${p.share ? `\nDETAILS YOU MAY ENTER (and nothing else): ${p.share}` : ''}${p.notes ? `\nNOTES: ${p.notes}` : ''}${sofar}${extra ? `\n\n${extra}` : ''}

You are ${getBotName()}, their assistant: get it done. The site won't make it obvious; figure it out.

How:
1. If SITE is a URL, open it. Otherwise go to the service's own site (a search via browser_navigate is fine) and find the account or settings page.
2. Do the task in the order it's written. If an earlier step (like an export) can't be done or confirmed on the page, STOP before any later step that can't be undone (like cancelling), with status "blocked".
3. Downloads go to the Mac's Downloads folder; clicking a site's download or export button is fine.
4. Long jobs (many items one at a time): work steadily, and after roughly 20 items stop with status "in_progress", saying exactly what's done and what's left. You'll be started again to continue.

When something doesn't work, try another way before giving up. In order:
- Use snapshot to see what's actually clickable, then click by index. Rows in a list, "..." menus, and icons often only show in snapshot (it includes embedded frames and popups).
- If the page still doesn't make sense (a step you can't read, a popup with no text), take a screenshot and look, then click_at the right spot. Never ask the owner what's on the screen: look.
- If a click or typing does nothing (some pages ignore scripted input), use real_click / real_type / real_key: real mouse and keyboard input.
- Uploads: use set_files (the file picker never opens). If a Chrome or macOS window appears that the page tools can't reach (a file dialog that opened anyway, a permission prompt, a save dialog, "Open this app?"), use desktop: screenshot, then click/type/key_press in that window only, then go back to the browser tools.
- Scroll: long lists load more as you scroll. Look for a select-all checkbox, a bulk "Export" or "Download" in a toolbar, a "..." menu on each item, and account/settings pages (often "Data", "Privacy", "Export", "Download my data").
- Look it up: web_search "how to <task> on <site>" and follow the help-center steps.
- Check your work: check_downloads shows what landed in Downloads.
- If one method is too slow for everything (e.g. hundreds of items one at a time), still make steady progress with it and return "in_progress".

Status rules:
- "needs_owner" when only they can unblock it, and the job will wait for their answer (don't navigate away from the page you're on):
  - need "code": the site sent them a code (text or email). Click "send code" first if there's a button for it. They'll text it to you and you'll be started again here with it.
  - need "link": the site emailed them a sign-in link. You'll be started again with it ready to open.
  - need "login": a login page their password manager didn't fill. They'll log in on the Mac and tell you.
  - need "decision": a choice only they can make (which plan, keep or delete). Put the options in "ask".
  - "ask" is the one short question they'll see, e.g. "Plaud sent you a code. What is it?" or "Plaud wants you to log in on the Mac. Tell me when you're in."
- "blocked" ONLY for what they can't answer by text: a payment, or a company that will only do it by phone or with a person.
- Anything else you couldn't do yet (can't find the button, a click did nothing, the page is confusing) is "failed" with what you tried and what to try next. You'll be started again with that note, so the next run tries something different.

Hard rules:
- Billing often moves to another site or a pop-up (Stripe, Shopify, Paddle, Chargebee): follow it. When a click opens a new window you're told, and your tools switch to it.
- On any login page, try fill_login FIRST (their saved 1Password login). Never type an email or username yourself while fill_login might have one.
- If a site offers to email/text a code or link instead of a password, choose the password option ("Use password instead", "Sign in with password") when fill_login has a login for the site.
- Never click "forgot password", "forgot username/number", "reset", or "recover" links: they email or text the owner and change nothing for you. If fill_login can't sign in, return needs_owner login.
- Email sign-ins with no saved login (a page that asks only for an email, then sends a code or a sign-in link, like Stripe's or Shopify's): enter THEIR EMAIL FOR THIS SITE (or one from DETAILS or an answer), click send, then return needs_owner with need "code" or "link". Both are fetched from their email automatically. If you don't know which email, return needs_owner info asking "Which email do you use for <site>?".
- Logins: if a login page is filled in, click sign in. If it's empty, take a snapshot and call fill_login (their saved login for this site, from 1Password), then click sign in. A page asking only for the email is a login page: fill_login with username_index, continue, then fill_login with password_index. Never stop at an email or password field without trying fill_login first. Only if fill_login says there's no login for this site, return needs_owner login (say they can add it to the assistant's 1Password vault).
- An authenticator-app code (not texted or emailed): fill_2fa_code with the code field's index. A code: return needs_owner code, then type it ONLY with enter_owner_code once you have it. Never type or guess a password or code yourself. A CAPTCHA: needs_owner login.
- NEVER pay, enter a card, or click a pay/upgrade button.
- When cancelling: decline every offer to stay (discounts, free months, pausing, downgrading) unless NOTES says to take it. An offer to stay is never a reason to stop or ask, whatever TASK says. Keep going to the final cancel confirmation. If the only way to cancel is a phone call or chat with a person, STOP with status "blocked" and say so.
- Never delete the account or its data unless TASK says to, in those words. Never change a password or email.
- Don't create accounts. Don't do anything the task didn't ask for.

Your LAST message must be ONLY this JSON (no other text):
{"status":"done|in_progress|needs_owner|blocked|failed","need":"code|link|login|decision (needs_owner only)","ask":"their one question (needs_owner only)","summary":"one or two short lines for the owner: what happened, and when it ends if it's a cancellation (for in_progress: what's done and what's left)","confirmation":"confirmation number or email mentioned, if shown","ends_on":"YYYY-MM-DD access ends, if a cancellation page shows it","next_charge":"YYYY-MM-DD the next billing date that should now not charge, if shown","url":"page you ended on"}
Use "done" only when the page showed the task finished (e.g. "Your subscription has been cancelled").`;
}

interface RunState { runs: number; progress: string[]; nextAt: number; email?: string | null; lastAskAt?: number; infraWaits?: number }

function loadState(id: number): RunState {
  try {
    const raw = getMemory(STATE_GROUP, `task_${id}`);
    if (raw) return JSON.parse(raw) as RunState;
  } catch { /* fresh state */ }
  return { runs: 0, progress: [], nextAt: 0 };
}
function saveState(id: number, st: RunState): void { setMemory(STATE_GROUP, `task_${id}`, JSON.stringify(st)); }

const running = new Set<number>();
/** The owner's mid-job changes, waiting for the run loop's next pass. */
const pendingChanges = new Map<number, string[]>();

// What only the owner can do: log in, pay, decide, or talk to a person.
const OWNER_NEEDED = /\b(log ?in|sign ?in|password|passcode|verification code|one-time code|2fa|two-factor|captcha|card|payment|pay\b|deposit|billing info|phone|call (them|us|support)|by phone|live chat|chat with|speak (to|with)|agent|representative|their (decision|choice|approval)|decide|which one|verify (your|their) identity|identity)\b/i;
export function needsOwner(summary: string): boolean { return OWNER_NEEDED.test(summary); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const INFRA_MAX_WAITS = 24;
const INFRA_WAIT_MS = () => parseNumEnv('WEB_TASK_INFRA_WAIT_MS', 10 * 60_000);
/** The owner's question, with what got done first when the run says more than the question ("the request was submitted"). */
function askWithProgress(r: WebTaskResult): string {
  const ask = r.ask ?? r.summary;
  if (!r.ask || !r.summary || r.summary === r.ask) return ask;
  const said = new Set(r.ask.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3));
  const extra = r.summary.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && !said.has(w));
  return extra.length >= 3 ? `${r.summary}\n${r.ask}` : ask;
}
/** A short name for the job in the owner's texts. */
function jobName(p: WebTaskPayload): string {
  const t = p.task.replace(/\s+/g, ' ').trim();
  return t.length > 60 ? `${t.slice(0, 57).replace(/\s+\S*$/, '')}…` : t;
}

// One question per job per 15 minutes: a newer one still updates the job (the owner
// sees it in whats_going_on and the check-in), it just isn't texted again.
// One job once sent 5 texts in 20 minutes.
const ASK_GAP_MS = 15 * 60_000;
function askAllowed(st: RunState): boolean {
  return !st.lastAskAt || Date.now() - st.lastAskAt >= ASK_GAP_MS;
}

const wordsOf = (t: string) => new Set(t.toLowerCase().replace(/^run \d+ \([^)]*\): /, '').split(/[^a-z]+/).filter((w) => w.length >= 4));
/** The last three runs failed for what reads like the same reason. */
export function sameWall(progress: string[]): boolean {
  const fails = progress.filter((x) => /\(didn't work\)/.test(x)).slice(-3);
  if (fails.length < 3 || !progress.slice(-3).every((x) => /\(didn't work\)/.test(x))) return false;
  const sets = fails.map(wordsOf);
  const sim = (a: Set<string>, b: Set<string>) => { const inter = [...a].filter((w) => b.has(w)).length; return inter / Math.max(1, Math.min(a.size, b.size)); };
  return sim(sets[0], sets[1]) >= 0.5 && sim(sets[1], sets[2]) >= 0.5;
}

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
  const ref = `action:${actionId}`;
  let job = getJobByRef(ref);
  if (job?.status === 'waiting_on_you') { running.delete(actionId); return { status: 'needs_owner', summary: job.ask ?? 'waiting on the owner' }; }
  const jobId = job && ['working', 'waiting_on_you'].includes(job.status) ? job.id : openJob('web_task', getAction(actionId)?.summary ?? p.task, ref);
  markActionExecuting(actionId);
  const st = loadState(actionId);
  let result: WebTaskResult = { status: 'failed', summary: 'Never started.' };
  try {
    while (st.runs < MAX_RUNS()) {
      if (getAction(actionId)?.status === 'cancelled') return { status: 'failed', summary: 'cancelled' };
      // No Chrome: wait for it (chrome-health reopens it and alerts) without
      // spending one of the job's runs, up to about an hour.
      let waited = 0;
      while (!d.isConnected() && waited < CHROME_WAIT_TRIES) {
        if (getAction(actionId)?.status === 'cancelled') return { status: 'failed', summary: 'cancelled' };
        waited++;
        await sleep(RETRY_GAP_MS());
      }
      const changes = pendingChanges.get(actionId);
      if (changes?.length) {
        pendingChanges.delete(actionId);
        st.progress = [...st.progress, ...changes.map((c) => `OWNER CHANGED THE PLAN (follow this over anything above): ${c}`)].slice(-10);
      }
      st.runs++;
      saveState(actionId, st);
      if (!d.isConnected()) {
        result = { status: 'failed', summary: "Chrome on the mini wasn't connected for about an hour." };
      } else {
        try {
          const timeoutMs = TIMEOUT_MS();
          // Their answer to the last question goes into this run once; a texted
          // code never does (enter_owner_code types it from the job).
          job = getJob(jobId);
          const answered = takeAnswer(jobId);
          if (st.email === undefined) {
            st.email = await emailLookup(brandsFor(p.site, null)).catch(() => null);
            saveState(actionId, st);
          }
          // Already sitting on a sign-in page 1Password has a login for?
          // Say so up front: runs that saw "Sign in" kept quitting even
          // after being sent back with "use fill_login".
          const startUrl = await pageUrlReader().catch(() => null);
          const onLogin = !!startUrl && /\/(ap\/)?(sign-?in|log-?in|login|auth|account\/login|session)/i.test(startUrl);
          const savedHere = onLogin ? await loginLookup(new URL(startUrl!).hostname).catch(() => null) : null;
          const extra = [
            savedHere ? `YOU ARE ON A SIGN-IN PAGE AND 1PASSWORD HAS THEIR ${savedHere} LOGIN FOR IT. First step: snapshot, then fill_login (username_index on an email page, then password_index on the next page), then continue the task. Signing in this way is expected and allowed, even for read-only tasks.` : '',
            st.email ? `THEIR EMAIL FOR THIS SITE, only if fill_login says there's no saved login (the address it emails them at): ${st.email}` : '',
            answered
              ? `THE OWNER ANSWERED your question "${answered.ask}": ${answered.answer}\nContinue from where you are.`
              : job?.waiting_for === 'code' && job.answer
                ? `THE OWNER SENT THE CODE. At the code field, call enter_owner_code with that field's selector, then continue.`
                : job?.waiting_for === 'link' && job.answer
                  ? `THE SIGN-IN LINK ARRIVED. Call open_sign_in_link (no arguments); it opens in your tab. Then continue.`
                  : '',
          ].filter(Boolean).join('\n');
          // Marked active only while this run holds the browser (several jobs
          // can queue for it; marking before the lock let one job's ending
          // clear another's sign-in tools mid-run).
          const mine = { actionId, jobId, codeHost: job?.code_host ?? null };
          const out = await runBrowserSubAgent(`web-task #${actionId}`, webTaskPrompt(p, st.progress, extra), timeoutMs, {
            onStart: () => { activeRun = mine; fillLoginTried = false; },
            onEnd: () => { if (activeRun === mine) activeRun = null; clearDesktop(); },
          });
          if (job?.waiting_for) patchJob(jobId, { waiting_for: null, ask: null, answer: null });
          result = out === null
            ? { status: 'in_progress', summary: `A run hit the ${Math.round(timeoutMs / 60_000)}-min limit; check the page for what's done.` }
            : parseWebTaskResult(out);
          // A run that ran out of steps before writing its JSON isn't a wall:
          // carry on from the page it's on, with whatever it said last.
          if (result.status === 'failed' && /^Couldn't read the result/.test(result.summary)) {
            const said = (out ?? '').replace(/\s+/g, ' ').trim().slice(0, 1200);
            result = { status: 'in_progress', summary: `Ran out of steps mid-way; continue from the current page.${said ? ` It last said: ${said}` : ''}` };
          }
        } catch (err) {
          result = { status: 'failed', summary: `Browser error: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      journal(jobId, 'run', `Run ${st.runs}: ${result.status}: ${result.summary}${result.url ? ` (${result.url})` : ''}`);
      // Stopped while that run was going: end quietly (they already know).
      if (getAction(actionId)?.status === 'cancelled') return { status: 'failed', summary: 'stopped' };
      // The assistant's own plumbing failed (AI credit ran out, rate limit, outage),
      // not the website: not a wall, not the owner's decision. Say so once in plain
      // words, wait without using up a try, and pick back up on its own.
      if (result.status === 'failed' && isInfraError(result.summary) && (st.infraWaits ?? 0) < INFRA_MAX_WAITS) {
        st.infraWaits = (st.infraWaits ?? 0) + 1;
        st.runs = Math.max(0, st.runs - 1);
        saveState(actionId, st);
        const credit = /insufficient_quota|credit_balance|no credits remaining/i.test(result.summary);
        if (st.infraWaits === 1 && !p.practice) {
          await updateOwner(`web-task:${actionId}`, credit
            ? `⏸ ${jobName(p)}: paused. ${getBotName()}'s AI account is out of credit (check billing with your AI provider). I'll pick it back up on my own once it works.`
            : `⏸ ${jobName(p)}: paused, ${getBotName()}'s AI service is having trouble. I'll retry on my own.`, { milestone: true, source: 'web-task', send: (subj, t) => d.notify(t, subj) });
        }
        await sleep(INFRA_WAIT_MS());
        continue;
      }
      if (st.infraWaits && result.status !== 'failed') { st.infraWaits = 0; saveState(actionId, st); }
      // "Blocked" means they have to do something. A login or code they can sort by
      // text is a wait, not a stop; and the sub-agent sometimes says blocked
      // when it just couldn't find the way, which is a retry.
      if (result.status === 'blocked' && /\b(code|2fa|two-factor|verification|log ?in|sign ?in|password|captcha)\b/i.test(result.summary)) {
        result = { ...result, status: 'needs_owner', need: guessNeed(result.summary), ask: result.summary };
      } else if (result.status === 'blocked' && !needsOwner(result.summary)) {
        result = { ...result, status: 'failed', summary: `${result.summary} (Not actually blocked on the owner: try a different way.)` };
      }
      // "Log in for me" while 1Password has this site's login and the run
      // never tried it (seen on a large retailer's site): not the owner's problem yet. Send it back.
      if (result.status === 'needs_owner' && result.need === 'login' && !fillLoginTried) {
        const pageHost = await hostReader().catch(() => null);
        const saved = pageHost ? await loginLookup(pageHost) : null;
        if (saved) {
          result = { ...result, status: 'failed', summary: `Stopped at a login without trying fill_login, but 1Password has a ${saved} login for this site. Go to the sign-in page, snapshot, and call fill_login.` };
        }
      }
      if (result.status === 'needs_owner') {
        const need = result.need ?? 'info';
        const host = need === 'code' ? await hostReader().catch(() => null) : null;
        // A code the site emailed them (or that their phone forwarded): fetch it
        // and keep going without asking. It's typed by enter_owner_code, so it
        // still never reaches the model, and only on this same site.
        if (need === 'code' || need === 'link') {
          const pageHost = host ?? await hostReader().catch(() => null);
          const brands = brandsFor(p.site, pageHost);
          const askedAt = Date.now() - 3 * 60_000; // the run may have clicked "send" a bit ago
          const found = await codeLookup(brands, askedAt).catch(() => null);
          if (found) {
            const isLink = 'link' in found && !!found.link;
            patchJob(jobId, { status: 'working', waiting_for: isLink ? 'link' : 'code', code_host: pageHost, answer: isLink ? (found as { link: string }).link : (found as { code: string }).code, answered_at: new Date().toISOString() });
            st.progress = [...st.progress, `Run ${st.runs} (progress): got the sign-in ${isLink ? 'link' : 'code'} from ${'source' in found && found.source === 'text' ? 'their phone' : 'their email'}; ${isLink ? 'open it' : 'enter it'} and continue.`].slice(-10);
            st.runs = Math.max(0, st.runs - 1);
            saveState(actionId, st);
            continue;
          }
        }
        if (p.practice) {
          // A practice run never waits on the owner: record what it needed and stop.
          result = { ...result, status: 'blocked', summary: `Practice run needed the owner (${need}): ${result.ask ?? result.summary}` };
          break;
        }
        waitOnOwner(jobId, need, result.ask ?? result.summary, host);
        st.progress = [...st.progress, `Run ${st.runs} (paused for the owner): ${result.summary}`].slice(-10);
        st.runs = Math.max(0, st.runs - 1); // waiting on them doesn't use up a try
        saveState(actionId, st);
        // A step only the owner's hands can do (a login, a "prove you're human" box):
        // bring the tab forward and send the take-over link with the question.
        const hands = need === 'login' || needsHands(`${result.ask ?? ''} ${result.summary}`);
        if (hands && !p.practice) await showJobTab();
        const pageHost = hands ? (host ?? await hostReader().catch(() => null)) : null;
        const askText = hands ? withTakeover(cleanUpdate(askWithProgress(result)), pageHost, { id: jobId, label: result.ask ?? result.summary }) : cleanUpdate(askWithProgress(result));
        if (askAllowed(st)) try { await d.notify(askText, `web-task:${actionId}:ask`); st.lastAskAt = Date.now(); saveState(actionId, st); } catch (err) { console.error('[web-task] could not ask the owner:', err); }
        return result;
      }
      if (result.status === 'done' && !p.practice) {
        // The checker: the final page has to show it happened before the owner hears "done".
        const page = await pageTextReader().catch(() => '');
        // No page to read (tab gone, bridge hiccup): nothing to check against, so the
        // run's own word stands rather than looping on a job that may be finished.
        const v = !page.trim() ? { ok: true, why: 'page unreadable; not checked' } : await checkDone({
          kind: 'website', goal: p.task, claim: `${result.summary}${result.confirmation ? ` (confirmation: ${result.confirmation})` : ''}`,
          evidence: `Final page (${result.url ?? 'url unknown'}):\n${page || '(could not read the page)'}`,
        });
        journal(jobId, 'check', v.ok ? `Verified: ${v.why}` : `NOT verified: ${v.why}`);
        if (!v.ok) {
          st.progress = [...st.progress, `Run ${st.runs} (said done, but the checker says not yet: ${v.why}): ${result.summary}`].slice(-10);
          saveState(actionId, st);
          result = { ...result, status: 'failed', summary: `Not confirmed yet: ${v.why}` };
          if (st.runs < MAX_RUNS()) continue;
          break;
        }
      }
      if (result.status === 'done' || result.status === 'blocked') break;
      if (result.status === 'in_progress') {
        setJobProgress(jobId, result.summary);
        if (!p.practice && !/^(Ran out of steps|A run hit the)/.test(result.summary)) await updateOwner(`web-task:${actionId}`, `🌐 ${jobName(p)}: ${result.summary}`, { source: 'web-task', send: (subj, t) => d.notify(t, subj) });
      }
      st.progress = [...st.progress, `Run ${st.runs} (${result.status === 'in_progress' ? 'progress' : "didn't work"}): ${result.summary}`].slice(-10);
      // The same wall three runs in a row: more runs won't change it. Stop
      // and ask them, with the routes left (email them, do it themselves, skip it).
      if (result.status === 'failed' && sameWall(st.progress) && p.practice) {
        result = { ...result, status: 'blocked', summary: `Practice run hit the same wall 3 times: ${result.summary}` };
        break;
      }
      if (result.status === 'failed' && sameWall(st.progress)) {
        const ask = cleanUpdate(`${p.site.replace(/^https?:\/\//, '').replace(/\/.*$/, '')} keeps hitting the same wall: ${result.summary.replace(/\s*\(Not actually blocked[^)]*\)/, '')} Want me to email their support instead, or skip this part?`);
        waitOnOwner(jobId, 'decision', ask);
        saveState(actionId, st);
        if (askAllowed(st)) try { await d.notify(ask, `web-task:${actionId}:ask`); st.lastAskAt = Date.now(); saveState(actionId, st); } catch (err) { console.error('[web-task] could not ask the owner:', err); }
        return { ...result, status: 'needs_owner', need: 'decision', ask };
      }
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
    finishJob(jobId, 'done', `${result.summary}${conf}`);
    if (!p.practice) for (const hook of afterDone) { try { hook(jobId, p, result); } catch (err) { console.error('[web-task] after-done hook failed:', err); } }
  } else if (result.status === 'blocked') {
    text = `Stuck on ${p.site}: ${result.summary}`;
    markActionFailed(actionId, `blocked: ${result.summary}`);
    finishJob(jobId, 'failed', result.summary);
  } else {
    const last = (st.progress.at(-1) ?? result.summary).replace(/^Run \d+ \([^)]*\): /, '');
    text = `Couldn't finish on ${p.site} after ${st.runs} tries. Last: ${last}`;
    markActionFailed(actionId, `gave up: ${last}`);
    finishJob(jobId, 'failed', last);
  }
  deleteMemory(STATE_GROUP, `task_${actionId}`);
  if (p.practice) { console.log(`[web-task] practice #${actionId}: ${text}`); return result; }
  try {
    await d.notify(cleanUpdate(text), `web-task:${actionId}`);
  } catch (err) {
    console.error(`[web-task] could not tell the owner about #${actionId}:`, err);
  }
  return result;
}

/** Picks back up any web task the process dropped (a restart mid-job). */
export function resumeWebTasks(now = Date.now()): number {
  let resumed = 0;
  for (const a of getExecutingActions('web_task')) {
    if (running.has(a.id)) continue;
    if (getJobByRef(`action:${a.id}`)?.status === 'waiting_on_you') continue;
    if (loadState(a.id).nextAt > now) continue;
    void runWebTask(a.id, JSON.parse(a.payload_json) as WebTaskPayload);
    resumed++;
  }
  return resumed;
}

// ── Tracker hooks, the running job, and the page's host ────────────────────

let activeRun: { actionId: number; jobId: number; codeHost: string | null } | null = null;
let fillLoginTried = false;
/** fill_login calls this, so a run that gives up at a login without trying it can be sent back. */
export function noteFillLoginTried(): void { fillLoginTried = true; }
let clearDesktop: () => void = () => {};
void import('./tools/computer-use.js').then((m) => { clearDesktop = () => m.clearComputerUseTask('web-task-desktop'); }).catch(() => {});
/** The job whose browser run is open right now (read by enter_owner_code). */
export function activeWebTaskRun(): { actionId: number; jobId: number; codeHost: string | null } | null { return activeRun; }

/** Runs after a job finishes well (follow-up watches hook in here). */
const afterDone: Array<(jobId: number, p: WebTaskPayload, r: WebTaskResult) => void> = [];
export function onWebTaskDone(fn: (jobId: number, p: WebTaskPayload, r: WebTaskResult) => void): void { afterDone.push(fn); }

/** Names a code email or text from this site would carry ("plaud", "shopify"). */
export function brandsFor(site: string, host: string | null): string[] {
  const core = (h: string) => h.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^(www|web|app|account|accounts|login|auth|shop)\./, '').split('.')[0];
  const out = new Set<string>();
  if (/^https?:|\./.test(site)) out.add(core(site)); else out.add(site.trim().split(/\s+/)[0].toLowerCase());
  if (host) out.add(core(host));
  return [...out].filter((b) => b && b.length >= 3);
}

type SignIn = { code: string; source?: 'email' | 'text' } | { link: string; source?: 'email' };
let codeLookup: (brands: string[], sinceMs: number) => Promise<SignIn | null> = async (brands, sinceMs) => {
  const hit = await (await import('./lib/code-finder.js')).findFreshSignIn(brands, sinceMs);
  if (hit?.code) return { code: hit.code.code, source: hit.code.source };
  if (hit?.link) return { link: hit.link.link, source: 'email' };
  return null;
};
let loginLookup: (host: string) => Promise<string | null> = async (host) => {
  const op = await import('./lib/onepassword.js');
  if (!op.onePasswordReady()) return null;
  const m = await op.findLoginFor(host);
  return 'error' in m ? null : m.title;
};
/** Tests swap in a fake 1Password lookup. */
export function setWebTaskLoginLookup(fn: typeof loginLookup | null): void { if (fn) loginLookup = fn; }

let emailLookup: (brands: string[]) => Promise<string | null> = async (brands) => (await import('./lib/code-finder.js')).findAccountEmail(brands);
/** Tests swap in a fake account-email lookup. */
export function setWebTaskEmailLookup(fn: typeof emailLookup | null): void {
  if (fn) emailLookup = fn;
}
/** Tests swap in a fake code lookup. */
export function setWebTaskCodeLookup(fn: typeof codeLookup | null): void {
  if (fn) codeLookup = fn;
}

let pageUrlReader: () => Promise<string | null> = async () => {
  const { browserTools } = await import('./tools/browser.js');
  const out = String(await browserTools[0].handler({ action: 'get_current_url' }, { groupKey: 'booking' }));
  try { return (JSON.parse(out) as { url?: string }).url ?? null; } catch { return null; }
};
/** Tests swap in a fake current page. */
export function setWebTaskPageUrlReader(fn: (() => Promise<string | null>) | null): void { if (fn) pageUrlReader = fn; }

let hostReader: () => Promise<string | null> = async () => {
  const { browserTools } = await import('./tools/browser.js');
  const out = String(await browserTools[0].handler({ action: 'get_current_url' }, { groupKey: 'booking' }));
  try { return new URL((JSON.parse(out) as { url?: string }).url ?? '').hostname; } catch { return null; }
};
/** The job tab's visible text, for the checker. */
let pageTextReader: () => Promise<string> = async () => {
  const { quietCommandInGroupTab } = await import('./tools/browser.js');
  const r = await quietCommandInGroupTab('booking', 'extract_text', { selector: 'body' });
  return String((r as { text?: unknown }).text ?? JSON.stringify(r)).slice(0, 8000);
};
export function setWebTaskPageTextReader(fn: (() => Promise<string>) | null): void { if (fn) pageTextReader = fn; }
/** Tests swap in a fake page host. */
export function setWebTaskHostReader(fn: (() => Promise<string | null>) | null): void {
  if (fn) hostReader = fn;
}

registerJobKind('web_task', {
  resume: (job) => {
    const actionId = Number(job.ref?.split(':')[1]);
    const a = getAction(actionId);
    if (!a || a.status !== 'executing') return;
    void runWebTask(actionId, JSON.parse(a.payload_json) as WebTaskPayload);
  },
  change: (job, change) => {
    const actionId = Number(job.ref?.split(':')[1]);
    const a = getAction(actionId);
    if (!a || a.status !== 'executing') return `"${job.title}" isn't running anymore; start it again with the change.`;
    // Picked up by the run loop before its next run (a running loop holds its
    // own copy of the state, so writing it here would be overwritten).
    pendingChanges.set(actionId, [...(pendingChanges.get(actionId) ?? []), change]);
    if (!running.has(actionId)) {
      const st = loadState(actionId);
      st.nextAt = 0;
      saveState(actionId, st);
    }
    // Mid-run: close this run's window so the next one starts now with the change.
    if (activeRun?.actionId === actionId) {
      abortBrowserRun();
    } else {
      if (job.status === 'waiting_on_you') patchJob(job.id, { status: 'working', waiting_for: null, ask: null, answer: null });
      if (!running.has(actionId)) void runWebTask(actionId, JSON.parse(a.payload_json) as WebTaskPayload);
    }
    return `Got it. "${job.title.replace(/\.$/, '')}" picks up your change on its next step (a few minutes at most): ${change}`;
  },
  stop: (job) => {
    const actionId = Number(job.ref?.split(':')[1]);
    markActionStopped(actionId, 'stopped by the owner');
    // Close the browser window now: every browser tool refuses, the run ends.
    if (activeRun?.actionId === actionId) abortBrowserRun();
    deleteMemory(STATE_GROUP, `task_${actionId}`);
    finishJob(job.id, 'stopped', 'Stopped by the owner.');
    return `Stopped: ${job.title.replace(/\.$/, '')}. Nothing more will happen there.`;
  },
});

export function startWebTaskRunner(): void {
  setTimeout(() => { resumeWebTasks(); }, 20_000);
  setInterval(() => { resumeWebTasks(); void jobCheckIns().catch((err) => console.error('[jobs] check-ins failed:', err)); }, TICK_MS);
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
