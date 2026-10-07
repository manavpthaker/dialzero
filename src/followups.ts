// Follow-through after "done", and emailing a company until it answers.
//
// Two job kinds share one 15-minute runner:
//   - watch: "make sure X happens" (a cancellation confirmation arrives, no new
//     charge after the renewal date, a refund lands). A bounded read-only agent
//     checks; ok closes it with one line in the next check-in, a problem texts
//     the owner a decision, not-yet checks again later until its deadline.
//   - email_thread: an email sent as the owner to a company, watched until
//     they answer. The agent reads the reply and decides: done, answer them
//     (within the original goal and the details they allowed), or ask them. No
//     reply after 3 business days → one polite follow-up; after that, offer a
//     call.
//
// Both are jobs (src/jobs.ts), so they show in whats_going_on and check-ins,
// can be stopped, and can wait on the owner.

import { tzAbbrev } from './lib/time.js';
import {
  getDueJobs, patchJob, proposeAction, confirmAction, markActionExecuting, markActionDone, markActionFailed,
  getAction, type JobRow,
} from './db.js';
import { openJob, finishJob, waitOnOwner, takeAnswer, registerJobKind } from './jobs.js';
import { todayET } from './lib/time-et.js';
import { onWebTaskDone } from './web-task.js';
import { preferencesFor } from './lib/preferences.js';
import type { GroupConfig } from './group-resolver.js';

const TICK_MS = 15 * 60_000;
const HOUR = 3_600_000;
const MAX_REPLIES = 3;

/** Read-only email, finance and web search; nothing that sends, archives or pays. */
export const FOLLOWUP_GROUP: GroupConfig = {
  key: 'followup',
  name: 'Follow-ups',
  tools: ['followup-tools'],
  contextPath: 'context/followup',
};

export interface WatchSpec {
  what: string;          // plain words: what must be true
  until: string;         // ISO: give up (and tell them) after this
  every_hours: number;
}

export interface EmailThreadSpec {
  goal: string;
  to: string;
  subject: string;
  share: string;
  last_sent_at: string;  // ISO
  followups: number;
  replies: number;
}

// ── Deps (stubbed in tests) ──────────────────────────────────────────────────

export interface FollowupDeps {
  runCheck: (prompt: string) => Promise<string>;
  sendEmail: (p: { to: string; subject: string; body: string }) => Promise<void>;
  notify: (text: string, subject: string, kind: 'reply' | 'decision') => Promise<void>;
  ambient: (line: string, subject: string) => void;
  now: () => number;
}

const defaultDeps: FollowupDeps = {
  runCheck: async (prompt) => {
    const { runAgent } = await import('./agent.js');
    const { getSystemUser } = await import('./lib/system-user.js');
    return runAgent(FOLLOWUP_GROUP, getSystemUser(), prompt);
  },
  sendEmail: async ({ to, subject, body }) => {
    const { runSendEmail } = await import('./tools/outbound-send.js');
    const id = proposeAction({
      kind: 'message', tool_name: 'send_email', summary: `Email ${to}: ${subject}`,
      payload_json: JSON.stringify({ to: [to], subject, body }), estimated_cost_cents: null, reversible: false,
      category: 'email_errand', created_by_group: 'admin',
    });
    confirmAction(id);
    markActionExecuting(id);
    try {
      const r = await runSendEmail(getAction(id)!);
      markActionDone(id, { outcome: r.outcome, outcome_url: null, actual_cost_cents: 0 });
    } catch (err) {
      markActionFailed(id, err instanceof Error ? err.message : String(err));
      throw err;
    }
  },
  notify: async (text, subject, kind) => {
    const { sendInterrupt } = await import('./cos-outbound.js');
    await sendInterrupt({ source: 'followups', subject, kind, text });
  },
  ambient: (line, subject) => {
    void import('./cos-outbound.js').then(({ stageAmbient }) => stageAmbient('followups', line, { subject }));
  },
  now: () => Date.now(),
};
let deps = defaultDeps;
export function setFollowupDeps(over: Partial<FollowupDeps> | null): void { deps = over ? { ...defaultDeps, ...over } : defaultDeps; }

const iso = (ms: number) => new Date(ms).toISOString();

// ── Creating them ────────────────────────────────────────────────────────────

/** "Make sure X happens": checked every few hours until `until`. */
export function openWatch(title: string, what: string, opts: { firstCheckInHours?: number; untilDays?: number; everyHours?: number; parentId?: number } = {}): number {
  const now = deps.now();
  const spec: WatchSpec = { what, until: iso(now + (opts.untilDays ?? 7) * 24 * HOUR), every_hours: opts.everyHours ?? 12 };
  return openJob('watch', title, undefined, { status: 'watching', next_check_at: iso(now + (opts.firstCheckInHours ?? 1) * HOUR), check_spec: spec, parent_id: opts.parentId });
}

/** Send the first email and watch the thread. Returns the job id. */
export async function startEmailThread(p: { goal: string; to: string; subject: string; body: string; share: string }): Promise<number> {
  await deps.sendEmail({ to: p.to, subject: p.subject, body: p.body });
  const now = deps.now();
  const spec: EmailThreadSpec = { goal: p.goal, to: p.to, subject: p.subject, share: p.share, last_sent_at: iso(now), followups: 0, replies: 0 };
  const title = `${p.goal.charAt(0).toUpperCase()}${p.goal.slice(1).replace(/\.$/, '')} (emailed ${p.to}).`;
  const id = openJob('email_thread', title, undefined, { status: 'working', next_check_at: iso(now + 2 * HOUR), check_spec: spec });
  patchJob(id, { progress: 'Sent, waiting for their reply.' });
  return id;
}

// ── Checking them ────────────────────────────────────────────────────────────

function parseJson(text: string): Record<string, unknown> | null {
  const cands: string[] = [];
  for (const m of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) cands.push(m[1]);
  const a = text.indexOf('{'); const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) cands.push(text.slice(a, b + 1));
  for (const c of cands.reverse()) {
    try { const v = JSON.parse(c); if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>; } catch { /* next */ }
  }
  return null;
}
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');

/** Weekdays between two times (for "no reply after 3 business days"). */
export function businessDaysBetween(fromMs: number, toMs: number): number {
  let n = 0;
  const d = new Date(fromMs);
  d.setUTCHours(12, 0, 0, 0);
  while (d.getTime() + 24 * HOUR <= toMs) {
    d.setTime(d.getTime() + 24 * HOUR);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

function watchPrompt(job: JobRow, spec: WatchSpec): string {
  return `You are checking on something for the owner. Today is ${todayET()} (${tzAbbrev()}). Read only: never send, archive, pay or change anything.

CHECK: ${spec.what}
(This was set up after: ${job.title})

Use the email search/read tools and, for charges, the transaction tools. Search a few ways (sender name, domain, subject words).

Your LAST message must be ONLY this JSON:
{"status":"ok|problem|not_yet","summary":"one short plain line for the owner"}
- ok: it checked out (e.g. "Plaud confirmed the cancellation by email.").
- problem: something's wrong they should act on (e.g. "Plaud charged you $9.99 on Oct 30 after cancelling."). Say what you'd do about it.
- not_yet: nothing to see yet; you'll check again later.`;
}

function threadPrompt(job: JobRow, spec: EmailThreadSpec, answer: { ask: string; answer: string } | null): string {
  return `You are watching an email thread for the owner. Today is ${todayET()} (${tzAbbrev()}). Read only: you never send anything yourself.

GOAL of their email: ${spec.goal}
SENT TO: ${spec.to}   SUBJECT: ${spec.subject}
LAST EMAIL FROM HIM: ${spec.last_sent_at}
DETAILS THEY ALLOWED SHARING: ${spec.share || '(only their name)'}${(() => { const pr = preferencesFor(spec.goal); return pr ? `\n${pr}` : ''; })()}${answer ? `\nHE ANSWERED your question "${answer.ask}": ${answer.answer}` : ''}

Look for a reply from ${spec.to} (or that company's domain) after the last email from them: search by sender and by subject words, then read the thread.

Your LAST message must be ONLY this JSON:
{"status":"done|reply|needs_owner|none","summary":"one short plain line for the owner","reply_body":"for reply: the email to send back, as them, plain text","ask":"for needs_owner: their one short question","followup_body":"for none: a short polite follow-up, as them, in case it's needed"}
- done: the goal is met or they gave a final answer (summary says what).
- reply: they asked for something you can answer from GOAL and DETAILS (or their answer above). Never share anything beyond those, never agree to pay or to a new charge.
- needs_owner: they need something only they can give or decide.
- none: no reply yet.`;
}

async function checkWatch(job: JobRow, d: FollowupDeps): Promise<void> {
  const spec = JSON.parse(job.check_spec ?? '{}') as WatchSpec;
  const now = d.now();
  const r = parseJson(await d.runCheck(watchPrompt(job, spec))) ?? { status: 'not_yet', summary: '' };
  const summary = str(r.summary);
  if (r.status === 'ok') {
    finishJob(job.id, 'done', summary || 'Checked out.');
    d.ambient(`✅ ${summary || job.title}`, `watch:${job.id}`);
  } else if (r.status === 'problem') {
    finishJob(job.id, 'failed', summary);
    await d.notify(`⚠️ ${summary}`, `watch:${job.id}`, 'decision');
  } else if (now >= Date.parse(spec.until)) {
    const line = `Still nothing on: ${spec.what}`;
    finishJob(job.id, 'failed', line);
    await d.notify(`⚠️ ${line}. Want me to look into it?`, `watch:${job.id}`, 'decision');
  } else {
    patchJob(job.id, { next_check_at: iso(now + spec.every_hours * HOUR) });
  }
}

async function checkThread(job: JobRow, d: FollowupDeps): Promise<void> {
  const spec = JSON.parse(job.check_spec ?? '{}') as EmailThreadSpec;
  const now = d.now();
  const answer = takeAnswer(job.id);
  const r = parseJson(await d.runCheck(threadPrompt(job, spec, answer))) ?? { status: 'none' };
  const summary = str(r.summary);
  const save = (patch: Partial<EmailThreadSpec>, next: number, progress?: string) =>
    patchJob(job.id, { check_spec: JSON.stringify({ ...spec, ...patch }), next_check_at: iso(next), ...(progress ? { progress } : {}) });

  if (r.status === 'done') {
    finishJob(job.id, 'done', summary);
    await d.notify(`✅ ${summary}`, `email-thread:${job.id}`, 'reply');
  } else if (r.status === 'reply' && str(r.reply_body) && spec.replies < MAX_REPLIES) {
    await d.sendEmail({ to: spec.to, subject: /^re:/i.test(spec.subject) ? spec.subject : `Re: ${spec.subject}`, body: str(r.reply_body) });
    save({ replies: spec.replies + 1, last_sent_at: iso(now) }, now + 2 * HOUR, `They replied; answered them: ${summary}`);
    await d.notify(`✉️ ${job.title}: ${spec.to} replied. ${summary} I answered within what you OK'd and I'm watching for their next reply.`, `email-thread:${job.id}`, 'reply');
  } else if (r.status === 'needs_owner' || (r.status === 'reply' && spec.replies >= MAX_REPLIES)) {
    const ask = str(r.ask) || summary || `${spec.to} replied and needs you.`;
    waitOnOwner(job.id, 'decision', ask);
    await d.notify(ask, `email-thread:${job.id}`, 'reply');
  } else {
    const quietDays = businessDaysBetween(Date.parse(spec.last_sent_at), now);
    if (quietDays >= 3 && spec.followups === 0 && str(r.followup_body)) {
      await d.sendEmail({ to: spec.to, subject: /^re:/i.test(spec.subject) ? spec.subject : `Re: ${spec.subject}`, body: str(r.followup_body) });
      save({ followups: 1, last_sent_at: iso(now) }, now + 4 * HOUR, 'No reply in 3 business days; sent a follow-up.');
      await d.notify(`✉️ ${job.title}: no reply from ${spec.to} in 3 business days, so I sent one follow-up. If they stay quiet I'll ask whether to call.`, `email-thread:${job.id}`, 'reply');
    } else if (quietDays >= 3 && spec.followups >= 1) {
      const ask = `No reply from ${spec.to} after two emails. Want me to call them instead?`;
      waitOnOwner(job.id, 'decision', ask);
      await d.notify(ask, `email-thread:${job.id}`, 'reply');
    } else {
      save({}, now + 2 * HOUR);
    }
  }
}

let ticking = false;
/** One pass over due watches and threads. Never throws. */
export async function followupTick(): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  const d = deps;
  let n = 0;
  try {
    for (const job of getDueJobs(iso(d.now()))) {
      if (job.kind !== 'watch' && job.kind !== 'email_thread') continue;
      n++;
      try {
        if (job.kind === 'watch') await checkWatch(job, d);
        else await checkThread(job, d);
      } catch (err) {
        console.error(`[followups] check failed for job ${job.id}:`, err);
        patchJob(job.id, { next_check_at: iso(d.now() + HOUR) });
      }
    }
  } finally {
    ticking = false;
  }
  return n;
}

registerJobKind('email_thread', {
  // Their answer goes into the next check right away.
  resume: (job) => { patchJob(job.id, { next_check_at: iso(deps.now()) }); setTimeout(() => { void followupTick(); }, 200); },
});

// After a cancellation goes through: make sure it sticks. A confirmation email
// within a few days, and no new charge after the renewal date.
onWebTaskDone((jobId, p, r) => {
  if (!/\bcancel/i.test(p.task)) return;
  const site = (() => { try { return new URL(p.site).hostname.replace(/^www\./, '').replace(/^web\./, ''); } catch { return p.site; } })();
  openWatch(`Make sure the ${site} cancellation is confirmed by email.`, `An email from ${site} (or that company) confirming the cancellation, sent after it was cancelled today.`, { firstCheckInHours: 2, untilDays: 3, everyHours: 12, parentId: jobId });
  const charge = r.next_charge ?? r.ends_on;
  if (charge) {
    const due = Date.parse(`${charge}T12:00:00Z`) + 2 * 24 * HOUR;
    const hours = Math.max(1, Math.round((due - deps.now()) / HOUR));
    openWatch(`Make sure ${site} doesn't charge again after ${charge}.`, `No new charge from ${site} (or that company) on or after ${charge} in their transactions. A charge is a problem: say the amount and date and offer to dispute it.`, { firstCheckInHours: hours, untilDays: Math.ceil(hours / 24) + 3, everyHours: 24, parentId: jobId });
  }
});

export function startFollowups(): void {
  setTimeout(() => { void followupTick(); }, 60_000);
  setInterval(() => { void followupTick(); }, TICK_MS);
}
