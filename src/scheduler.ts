import { scheduleCron } from './lib/cron.js';
import { getDefaultRecipient } from './channels/imessage.js';
import { runAgent } from './agent.js';
import type { GroupConfig } from './group-resolver.js';
import { REFLECTION_GROUP } from './group-resolver.js';
import { getSystemUser } from './lib/system-user.js';
import { parseNumEnv } from './lib/env.js';
import {
  getMessagesSinceForGroups, getMemory, setMemory, deleteMemory, factsAbout,
  getOverdueTasks, getTasksDueSoon, getTasksNeedingDecision, markTaskSurfaced, markTaskRetired,
  type MessageRow, type Task,
  logOutbound,
} from './db.js';
import { runHealthCheck, formatAlivePing } from './doctor.js';
import { collectAmbientItems, clearAmbient, sendInterrupt } from './cos-outbound.js';
import { stageSection } from './checkins.js';
import { resolveEmailSourceKind } from './email/source.js';
import {
  buildEmailReconciliationPromptContext,
  reconcileTrackedEmailLoops,
} from './email-reconciliation.js';
import { getProfileConfig, getTimezone } from './config.js';

// Nightly reflection may turn conversation text into global facts and a private
// morning brief. Only owner-private live namespaces can enter that pipeline.
// Shared `home` and `family` are intentionally absent; future groups default
// excluded until somebody explicitly classifies them private here.
export const PRIVATE_REFLECTION_GROUPS = [
  'admin',
  'work',
  'health',
] as const;

// YYYY-MM-DD in the local timezone. en-CA's date format happens to be ISO.
function todayDateET(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: getTimezone() });
}
function tomorrowDateET(): string {
  const t = new Date();
  t.setDate(t.getDate() + 1);
  return t.toLocaleDateString('en-CA', { timeZone: getTimezone() });
}
function nextSundayIso(): string {
  const now = new Date();
  const day = now.getUTCDay();
  const daysUntil = day === 0 ? 7 : 7 - day;
  const target = new Date(now.getTime() + daysUntil * 86400000);
  target.setUTCHours(0, 0, 0, 0);
  return target.toISOString();
}
function daysFromNowIso(n: number): string {
  return new Date(Date.now() + n * 86400000).toISOString();
}

function groupConfig(key: string, name: string, tools: string[], contextPath: string): GroupConfig {
  return { key, name, tools, contextPath };
}

function briefTaskLine(t: Task): string {
  const due = t.due_date
    ? ` (due ${new Date(t.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })})`
    : '';
  return `#${t.id} ${t.title}${due}`;
}

// Builds the once-daily task pass for the morning brief (organic reminders).
// Routine overdue + due-today are listed for the agent to weave in contextually;
// "needs a decision" items (surfaced enough times to cross the retire threshold)
// get one pointed question, then are retired out of rotation until touched.
// Returns the prompt text plus the rows to mark afterward (mirrors the heartbeat:
// we mark what we handed the agent, whether or not it cites every line).
function buildMorningTaskContext(): { text: string; surfaced: Task[]; retired: Task[] } {
  const overdue = getOverdueTasks();
  const dueToday = getTasksDueSoon(24);
  const needsDecision = getTasksNeedingDecision();

  if (overdue.length === 0 && dueToday.length === 0 && needsDecision.length === 0) {
    return { text: '', surfaced: [], retired: [] };
  }

  const sections: string[] = ['\n\nTASK SIGNALS (weave these into the brief naturally — do not just paste the list):'];
  if (overdue.length > 0) {
    sections.push(`Overdue:\n${overdue.map(briefTaskLine).join('\n')}`);
  }
  if (dueToday.length > 0) {
    sections.push(`Due today:\n${dueToday.map(briefTaskLine).join('\n')}`);
  }
  if (overdue.length > 0 || dueToday.length > 0) {
    sections.push('Lead with the ONE that actually matters today; mention the rest briefly. Offer to calendar-block or reschedule rather than just restating them.');
  }
  if (needsDecision.length > 0) {
    sections.push(
      `NEEDS A DECISION (these have been raised several times and keep slipping — stop reminding, ask once):\n${needsDecision.map(briefTaskLine).join('\n')}\n` +
      `For each, ask one short, direct question: kill it or commit to a day? No guilt, no lecture — just the choice. Tell me you\'ll stop bringing it up until I decide.`,
    );
  }

  return {
    text: sections.join('\n\n'),
    surfaced: [...overdue, ...dueToday],
    retired: needsDecision,
  };
}

export function startScheduler() {
  const user = getSystemUser();

  // ============================================================
  // DAILY WORKFLOWS
  // ============================================================

  const personalTarget = getDefaultRecipient();

  // Daily inbox-zero pass → personal DM (8:00 AM). Not a summary — it
  // PROCESSES every email to a disposition so the inbox empties each morning.
  if (personalTarget) {
    scheduleCron('45 7 * * *', async () => {
      console.log('[Scheduler] Daily inbox-zero pass');
      try {
        const group = groupConfig('home', 'Home', ['email', 'memory', 'tasks', 'email-reconciliation', 'people'], 'context/personal');
        const emailPrefs = factsAbout('email', 20).map((f) => `- ${f.predicate}: ${f.object}`).join('\n');
        try {
          await reconcileTrackedEmailLoops({ limit: 25, source: 'inbox-zero-preflight' });
        } catch (err) {
          console.error('[Scheduler] Inbox reconciliation preflight failed:', err);
        }
        const reconciliationContext = buildEmailReconciliationPromptContext();
        const partnerLabel = getProfileConfig().members.map((m) => m.name).join(' or ') || 'household members';
        const response = await runAgent(group, user,
          `Run my INBOX-ZERO pass on my email. The goal is an empty inbox: process every email in the inbox to exactly ONE disposition. Do NOT just summarize.

My disposition rules:
${emailPrefs || `- draft replies for review; never auto-send. When unsure, ask. Never archive bills or anything from ${partnerLabel}.`}

${reconciliationContext}

How to process each email:
0. RECONCILE FIRST: use email_list on the inbox and email_read_thread for context. Before drafting, tasking, archiving, or asking about every possible reply/action item, call reconcile_email_items with all candidate message IDs in batches. It checks the full thread plus matching Sent/Drafts, calendar RSVP state, and linked tasks. If it returns RESPONDED, SCHEDULED, or RESOLVED with high confidence, do not ask the stale question or create duplicate work. Because this is observe mode, leave that email untouched and report it under RECONCILED (observe only). UNCERTAIN stays in the inbox and must be asked about.
1. ARCHIVE (email_archive — batch the IDs in one call where you can): only when you are CONFIDENT it needs no action — newsletters, promotional, notifications, automated receipts/confirmations. When in doubt, do NOT archive.
2. DRAFT A REPLY (email_draft with reply_to_message_id): anything that needs a response. Write the draft in my voice; it saves as a draft in my mail for me to review and send. Never send.
3. TASK-IFY + ARCHIVE (create_task with a due_date and source_message_id set to the exact message ID, then archive the email): an obligation that isn't a quick reply — a deadline, a form to fill, something to act on later. The task carries it forward (it gets time-blocked); the email leaves the inbox.
4. FLAG + ASK (leave it in the inbox): bills/payments, anything from ${partnerLabel}, genuine judgment calls, and ANYTHING you're unsure how to handle. Do not guess — surface it with a one-line question.

Evidence boundaries: Sent proves sender-side delivery, not recipient read. Accepted proves RSVP, not attendance. A calendar event without the relevant attendee proves only a local hold, not that the person was told. The reconciliation observer itself must NEVER archive/send mail, create/change/RSVP to events, or close tasks.

While reading, capture durable facts (save_fact, source='email') and note_about_person for new roles/companies — but only real durable facts, not transient noise.

End with a short plaintext report (no markdown): how many archived, how many drafts are waiting in my mail to send, what became tasks, what was RECONCILED (observe only), and then a numbered list of the FLAGGED items each with a one-line "what I'd do / what I need from you" question. Lead with anything urgent (a bill due, a payment failure).`
        );
        stageSection('scheduler:daily-inbox-zero-pass', `daily-inbox-zero-pass:${todayDateET()}`, response);
        // Liveness stamp (same convention as the daemon *_last_tick keys) so the
        // doctor can flag a silently-dead inbox-zero instead of it just... not arriving.
        setMemory('system', 'inbox_zero_last_run', new Date().toISOString());
      } catch (err) {
        console.error('[Scheduler] Inbox-zero pass failed:', err);
      }
    });
  }

  // Daily calendar prep → personal DM (6:30 AM).
  // Also delivers the nightly reflection's morning brief, if one is staged.
  if (personalTarget) {
    scheduleCron('30 6 * * *', async () => {
      console.log('[Scheduler] Daily calendar prep');
      try {
        const briefKey = `morning_brief_${todayDateET()}`;
        const reflectionBrief = getMemory('reflection', briefKey);

        // Spark's unified calendar view only exists for Spark users; everyone
        // else reads Google Calendar through the calendar tools.
        const sparkCalendar = resolveEmailSourceKind() === 'spark';
        const group = groupConfig('home', 'Home', [...(sparkCalendar ? ['spark'] : []), 'calendar', 'tasks', 'memory'], 'context/personal');
        const briefPrefix = reflectionBrief
          ? `Last night's reflection produced this morning brief. Surface it verbatim at the top of your response under a header "Morning Brief", then continue with the calendar overview below:\n\n"""\n${reflectionBrief}\n"""\n\n`
          : '';

        // Organic reminders: the morning brief is the once-daily home for routine
        // task surfacing (the 30-min heartbeat only does critical 24h+ overdue now).
        const taskCtx = buildMorningTaskContext();

        // Time-block planner: the owner's scheduling preferences (working hours, focus
        // windows, posture) live as correctable `scheduling` facts. Inject them so
        // the planner respects the real rhythm; corrections feed the next plan.
        const schedPrefs = factsAbout('scheduling', 20)
          .map((f) => `- ${f.predicate}: ${f.object}`)
          .join('\n');
        const planBlock = schedPrefs
          ? `\n\nThen PROPOSE a time-blocked plan for today. My scheduling preferences:\n${schedPrefs}\n\nCall get_schedulable_tasks to get my unscheduled tasks (they carry duration_minutes, focus_level, priority, due_date). There may be many — schedule only a REALISTIC day's worth, highest-priority and due-soon first; don't try to fit everything. When duration_minutes is missing, estimate it (a payment fix ~5m, a deep build 60-120m). Within my working hours and around the events already on my calendar, lay out concrete time blocks: deep-work and admin in the protected morning window, calls/meetings only after the no-calls cutoff, honoring durations and due dates. Batch several quick tasks into one short admin block, and slot the quickest into the margins (including before the day starts) rather than letting them eat a focus block. Respect the meeting-light day preference when it applies. Present the plan as a simple time-ordered list (e.g. "9:15 send the X email (10m)", "9:30-11 deep work: Y"). Do NOT place anything on my calendar — this is a proposal. End with: reply "block it" to place these, or tell me what to change.`
          : '';

        // Ambient inbox items the EA auto-filed since yesterday (deliveries, bills,
        // registrations) batch here instead of pinging all day — they belong in
        // "here's your day". Collect now; clear only after the brief ships.
        // Ambient one-liners now drain in the check-in (src/checkins.ts), not here.
        const ambientItems: ReturnType<typeof collectAmbientItems> = [];
        const ambient = ambientItems.length ? ambientItems.map((i) => i.line).join('\n') : null;
        const ambientBlock = ambient
          ? `\n\nI auto-filed these from your email since yesterday — weave in the ones that matter for today (a delivery arriving, a bill/payment due, something now on your calendar); skip the rest:\n${ambient}`
          : '';

        const response = await runAgent(group, user,
          briefPrefix +
          "Give me today's calendar overview. " +
          (sparkCalendar
            ? 'Use list_calendar_events (spark) so you see ALL my accounts unified (work + personal), not just primary. '
            : 'Use list_events for today. ') +
          "Cover: events, any conflicts, what I should prep for, and who I'm meeting with so I can prep." +
          taskCtx.text +
          planBlock +
          ambientBlock
        );
        stageSection('scheduler:daily-calendar-prep', `daily-calendar-prep:${todayDateET()}`, response);
        if (ambient) clearAmbient();

        // Record what the brief actually carried, one row per distinct subject.
        // This is what lets the arbiter's "already delivered today" rule see
        // items that reached the owner via the brief rather than as an interrupt --
        // otherwise the 10:00 heartbeat happily re-raises something they read at
        // 06:30, which is precisely the cross-lane repetition a per-source
        // cooldown cannot catch.
        try {
          const seen = new Set<string>();
          for (const item of ambientItems) {
            const subject = item.subject ?? `ambient:${item.source}`;
            if (seen.has(subject)) continue;
            seen.add(subject);
            logOutbound({
              source: 'brief:morning', subject, kind: 'status',
              target: personalTarget, decision: 'sent', reason: null, would_hold: 0,
              bypass: null, mode: 'delivered-in-brief',
              text_preview: item.line.slice(0, 400),
              text_hash: '', char_count: item.line.length,
            });
          }
        } catch (err) {
          console.error('[Scheduler] brief outbound_log write failed:', err);
        }

        // Mark what we handed the agent so the decay ladder advances; retire the
        // decision items so they leave the rotation until touched.
        for (const t of taskCtx.surfaced) markTaskSurfaced(t.id);
        for (const t of taskCtx.retired) { markTaskSurfaced(t.id); markTaskRetired(t.id); }

        // Clear the brief after delivery so a missed reflection tomorrow doesn't surface stale content.
        if (reflectionBrief) deleteMemory('reflection', briefKey);
        // Liveness stamp — see inbox_zero_last_run above.
        setMemory('system', 'calendar_prep_last_run', new Date().toISOString());
      } catch (err) {
        console.error('[Scheduler] Calendar prep failed:', err);
      }
    });
  }

  // (Removed: 3x weekday meeting-prep cron — heartbeat covers this every 30 min with finer granularity.)
  // (Removed: 3pm logistics ping — overlapped with 8am calendar prep and 6pm evening wrap.)

  const adminTarget = process.env.GROUP_ADMIN || getDefaultRecipient();

  // Evening wrap-up → Admin group (6:00 PM weekdays)
  if (adminTarget) {
    scheduleCron('30 17 * * 1-5', async () => {
      console.log('[Scheduler] Evening wrap-up');
      try {
        const group = groupConfig('admin', 'Admin', ['calendar', 'github', 'memory'], 'context/admin');
        const response = await runAgent(group, user,
          `Evening wrap-up. Give me a quick end-of-day summary:

1. Tomorrow's calendar preview — any early meetings I should prep for tonight?
2. Any pending tasks or follow-ups I should be aware of? Check memory for assigned human tasks.
3. Quick wins: anything small I could knock out tonight to start tomorrow clean?

Keep it concise — I'm winding down.`
        );
        stageSection('scheduler:evening-wrap-up', `evening-wrap-up:${todayDateET()}`, response);
      } catch (err) {
        console.error('[Scheduler] Evening wrap-up failed:', err);
      }
    });
  }

  // ============================================================
  // WEEKLY WORKFLOWS
  // ============================================================

  // Weekly household overview → personal DM (Sunday 9:00 AM)
  if (personalTarget) {
    scheduleCron('0 9 * * 0', async () => {
      console.log('[Scheduler] Weekly household overview');
      try {
        const group = groupConfig('home', 'Home', ['calendar', 'tasks', 'household', 'memory'], 'context/personal');
        const response = await runAgent(group, user,
          "Give me the weekly household overview: upcoming tasks, events for the week, any household inventory notes, and any pending human tasks. Flag any scheduling conflicts for the week ahead."
        );
        stageSection('scheduler:weekly-household-overview', `weekly-household-overview:${todayDateET()}`, response);
      } catch (err) {
        console.error('[Scheduler] Household overview failed:', err);
      }
    });
  }

  // Weekly GitHub commit summary → Admin (Friday 5:00 PM)
  if (adminTarget) {
    scheduleCron('0 17 * * 5', async () => {
      console.log('[Scheduler] Weekly git summary');
      try {
        const group = groupConfig('admin', 'Admin', ['github', 'memory'], 'context/admin');
        const repos = process.env.ASSISTANT_ALLOWED_REPOS || 'assistant';
        const response = await runAgent(group, user,
          `Give me a commit summary for the past week across these repos: ${repos}. Use git_commit_summary for each. Save a memory checkpoint with the highlights.`
        );
        stageSection('scheduler:weekly-git-summary', `weekly-git-summary:${todayDateET()}`, response);
      } catch (err) {
        console.error('[Scheduler] Git summary failed:', err);
      }
    });
  }

  // Weekly work/project brief → Work group (Monday 9:00 AM)
  const workTarget = process.env.GROUP_WORK || getDefaultRecipient();
  if (workTarget) {
    scheduleCron('0 9 * * 1', async () => {
      console.log('[Scheduler] Weekly work brief');
      try {
        const group = groupConfig('work', 'Work', ['github', 'memory'], 'context/work');
        const response = await runAgent(group, user,
          "Give me a weekly work/project brief: recent commits to my active repos, any context updates, and check memory for any product decisions or notes from last week."
        );
        stageSection('scheduler:weekly-work-brief', `weekly-work-brief:${todayDateET()}`, response);
      } catch (err) {
        console.error('[Scheduler] Work brief failed:', err);
      }
    });
  }

  // Weekly task scheduling → Admin (Sunday 8:00 PM)
  if (adminTarget) {
    scheduleCron('0 20 * * 0', async () => {
      console.log('[Scheduler] Weekly task scheduling');
      try {
        const group = groupConfig('admin', 'Admin', ['calendar', 'tasks', 'memory'], 'context/admin');
        const response = await runAgent(group, user,
          `Plan my week — schedule all open unscheduled tasks for Monday through Friday.
Follow the task-scheduling skill. Present the proposed schedule and save it to memory as "weekly_schedule_proposal" so I can review it Monday morning.`
        );
        stageSection('scheduler:weekly-task-scheduling', `weekly-task-scheduling:${todayDateET()}`, response);
      } catch (err) {
        console.error('[Scheduler] Weekly task scheduling failed:', err);
      }
    });
  }

  // Evening health check-in → Health group (9:00 PM). Casual, brief.
  const healthTarget = process.env.GROUP_HEALTH;
  if (healthTarget) {
    scheduleCron('0 21 * * *', async () => {
      console.log('[Scheduler] Health evening check-in');
      try {
        const group = groupConfig('health', 'Health', ['memory', 'tasks', 'people'], 'context/health');
        const response = await runAgent(group, user,
          "Evening health check-in. Ask casually about today's workout, meals, and energy/mood. Keep it brief — one or two questions, no lecture. If recent memory shows a streak or pattern, lead with that."
        );
        stageSection('scheduler:health-evening-check-in', `health-evening-check-in:${todayDateET()}`, response);
      } catch (err) {
        console.error('[Scheduler] Health check-in failed:', err);
      }
    });
  }

  // Daily health check (9:00 AM) → personal DM ONLY when something needs
  // attention. A healthy day stays silent; a stale daemon / missed backup /
  // unseeded facts still surfaces the same day. Tradeoff: silence no longer
  // proves the bot is alive — the dashboard and daemon liveness stamps do that.
  if (personalTarget) {
    scheduleCron('0 9 * * *', async () => {
      console.log('[Scheduler] Daily health check');
      try {
        const report = runHealthCheck();
        if (report.healthy) {
          console.log('[Scheduler] Health OK — staying silent');
          return;
        }
        await sendInterrupt({ source: 'scheduler:health-check', subject: `health:${todayDateET()}`, kind: 'status', text: formatAlivePing(report) });
      } catch (err) {
        console.error('[Scheduler] Health check failed:', err);
      }
    });
  }

  // ============================================================
  // NIGHTLY REFLECTION (the cross-domain pass)
  // ============================================================

  // Runs silently at 22:00. Reads everything new since the last reflection,
  // extracts durable facts, and stages a morning brief keyed to tomorrow's date.
  // The 06:30 calendar prep above reads that key and prepends the brief.
  scheduleCron('0 22 * * *', async () => {
    console.log('[Scheduler] Nightly reflection');
    try {
      const lastRun = getMemory('reflection', 'last_reflection_at')
        || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const messages = getMessagesSinceForGroups(lastRun, PRIVATE_REFLECTION_GROUPS);

      // Cap per-group input volume — 24h × N groups × MAX_TURNS thinking is heavy.
      const PER_GROUP_CAP = 50;
      const PER_MESSAGE_CHAR_CAP = 500;
      const byGroup = new Map<string, MessageRow[]>();
      for (const m of messages) {
        const arr = byGroup.get(m.group_id) ?? [];
        arr.push(m);
        byGroup.set(m.group_id, arr);
      }

      const sections: string[] = [];
      for (const [gKey, msgs] of byGroup) {
        const recent = msgs.length > PER_GROUP_CAP ? msgs.slice(-PER_GROUP_CAP) : msgs;
        const omitted = msgs.length - recent.length;
        sections.push(`\n## ${gKey} (${recent.length}/${msgs.length} messages${omitted > 0 ? `, oldest ${omitted} trimmed` : ''})`);
        for (const m of recent) {
          const content = m.content.length > PER_MESSAGE_CHAR_CAP
            ? `${m.content.slice(0, PER_MESSAGE_CHAR_CAP)}…`
            : m.content;
          sections.push(`[${m.created_at}] ${m.role}: ${content}`);
        }
      }

      const targetDate = tomorrowDateET();
      const activityBlock = sections.length === 0
        ? '(no activity since last reflection)'
        : sections.join('\n');

      // The morning brief is staged to a memory key (consumed by the 06:30
      // calendar prep) AND saved as a durable reflection fact. The memory key
      // gets deleted after delivery; the fact persists for 30 days so the
      // Saturday content drafter has substrate to pull from. The 30-day TTL
      // keeps stale briefs from polluting Relevant-Knowledge retrieval.
      const reflectionFactExpiresAt = new Date(Date.now() + 30 * 86400 * 1000)
        .toISOString()
        .slice(0, 19)
        .replace('T', ' ');

      const prompt = `Nightly reflection — see context/reflection/CLAUDE.md for instructions.

Today is ${todayDateET()}. The morning brief you produce should be saved to memory key 'morning_brief_${targetDate}' (tomorrow's local date) so the 06:30 calendar prep tomorrow can prepend it. Use the remember tool with that exact key.

Goals (recap):
1. save_fact for durable facts in the activity below (commitments, decisions, metrics, new people).
2. Surface 1–3 non-obvious cross-domain connections.
3. remember(key='morning_brief_${targetDate}', value=<brief, ≤600 chars>).
4. ALSO save the same brief as a durable fact (for the Saturday content drafter):
   save_fact({
     subject: 'self',
     predicate: 'reflection_brief_${targetDate}',
     object: <same brief text>,
     fact_type: 'fact',
     source: 'reflection',
     valid_until: '${reflectionFactExpiresAt}'
   })
   The 30-day TTL means it survives the 06:30 memory-key delete but ages out
   of FTS retrieval, so old briefs don't pollute future queries.

If activity is empty or trivially low-signal, save a short brief that says so — don't fabricate connections.

--- Activity since ${lastRun} ---
${activityBlock.slice(0, 50000)}`;

      await runAgent(REFLECTION_GROUP, user, prompt);

      setMemory('reflection', 'last_reflection_at', new Date().toISOString());
    } catch (err) {
      console.error('[Scheduler] Reflection failed:', err);
    }
  });

  console.log('[Scheduler] All cron jobs registered (daily + weekly + nightly reflection)');
}
