import { scheduleCron } from './lib/cron.js';
import { getDefaultRecipient } from './channels/imessage.js';
import { sendInterrupt } from './cos-outbound.js';
import { runAgent } from './agent.js';
import type { GroupConfig } from './group-resolver.js';
import { getPendingTasks, getMemory, setMemory, getOverdueTasks, getSchedulableTasks, markTaskSurfaced, type Task } from './db.js';
import { etHour, isQuietHours, todayET } from './lib/time-et.js';
import { getSystemUser } from './lib/system-user.js';
import { withLlmContext } from './lib/llm-context.js';
import { calendarAlerts, type CalEvent } from './lib/calendar-alerts.js';

const MAX_TASKS_PER_HEARTBEAT = 5;
const TASK_HEARTBEAT_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

function groupConfig(key: string, name: string, tools: string[], contextPath: string): GroupConfig {
  return { key, name, tools, contextPath };
}

function clearOldNotifications() {
  const now = new Date();
  const today = now.toISOString().split('T')[0];
  const lastClear = getMemory('system', 'last_notification_clear');
  if (lastClear !== today) {
    setMemory('system', 'last_notification_clear', today);
  }
}

function formatTaskLine(t: Task): string {
  const priority = t.priority === 'urgent' ? '🔴' : t.priority === 'high' ? '🟠' : '🟡';
  const due = t.due_date ? ` (due ${new Date(t.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })})` : '';
  return `${priority} #${t.id}: ${t.title}${due} → ${t.assignee}`;
}

async function heartbeatCalendarCheck() {
  if (isQuietHours()) return;
  const target = process.env.GROUP_ADMIN || process.env.GROUP_HOME || getDefaultRecipient();
  if (!target) return;
  try {
    // Plain code, no model: time-to-leave for in-person events, and clashes.
    const { listRawEvents } = await import('./tools/calendar.js');
    const now = Date.now();
    const raw = await listRawEvents(new Date(now).toISOString(), new Date(now + 2 * 3_600_000).toISOString());
    const events: CalEvent[] = raw
      .filter((e) => e.start?.dateTime && e.end?.dateTime)
      .map((e) => ({
        id: e.id ?? `${e.summary}-${e.start?.dateTime}`,
        title: e.summary ?? 'Event',
        start: e.start!.dateTime!,
        end: e.end!.dateTime!,
        location: e.location,
        declined: (e.attendees ?? []).some((a) => a.self && a.responseStatus === 'declined'),
        free: e.transparency === 'transparent',
      }));
    for (const alert of calendarAlerts(events, now)) {
      // Subject per event / pair: the arbiter's cooldown keeps it to one text.
      await sendInterrupt({ source: 'heartbeat', subject: alert.subject, kind: 'time-critical', text: alert.text, target });
    }
  } catch (err) {
    console.error('[Heartbeat] Calendar check failed:', err);
  }
}

async function heartbeatPendingAsyncCheck() {
  if (isQuietHours()) return;
  const adminGroupId = process.env.GROUP_ADMIN || getDefaultRecipient();
  if (!adminGroupId) return;

  try {
    const pending = getPendingTasks();
    if (pending.length === 0) return;

    const stale = (pending as Array<{ id: number; created_at: string; prompt: string; group_id: string }>).filter((t) => {
      const created = new Date(t.created_at).getTime();
      return Date.now() - created > 30 * 60 * 1000;
    });

    if (stale.length > 0) {
      const summary = stale
        .map((t) => `- [${t.group_id}] ${t.prompt.slice(0, 80)}...`)
        .join('\n');
      await sendInterrupt({
        source: 'heartbeat',
        // Keyed on WHICH tasks are stuck, not on the count, so the same stuck
        // set does not re-announce itself while a new one still can. This
        // branch previously had no dedup of any kind and re-pinged every 30
        // minutes for as long as a task stayed pending.
        subject: `heartbeat:async-stale:${stale.map((t) => t.id).sort().join(',')}`,
        kind: 'status',
        text: `Heads up — ${stale.length} async task(s) have been pending for 30+ min:\n\n${summary}`,
        target: adminGroupId,
      });
    }
  } catch (err) {
    console.error('[Heartbeat] Pending async check failed:', err);
  }
}

async function heartbeatSyncTasks() {
  try {
    const { reconcile } = await import('./sync/tasks-sync.js');
    const r = await reconcile();
    if (r.pushed || r.pulled || r.conflicts) {
      console.log(`[Heartbeat] Sync: pushed=${r.pushed} pulled=${r.pulled} conflicts=${r.conflicts}`);
    }
  } catch (err) {
    console.error('[Heartbeat] Task sync failed:', err);
  }
}

// Organic reminders: the 30-min heartbeat is the INTERRUPT channel, so it only
// surfaces tasks that genuinely earn an interruption — 24h+ critical overdue.
// Routine overdue / due-soon moved to the once-daily morning brief (06:30), and
// the resurface spacing now decays per task (see getOverdueTasks in db.ts), so
// even critical items space themselves out instead of pinging every pulse.
async function heartbeatTaskCheck() {
  if (isQuietHours()) return; // a 24h-overdue task can wait until 07:00
  const adminGroupId = process.env.GROUP_ADMIN || getDefaultRecipient();
  if (!adminGroupId) return;

  try {
    const lastRun = getMemory('system', 'task_heartbeat_last_run');
    if (lastRun && Date.now() - new Date(lastRun).getTime() < TASK_HEARTBEAT_COOLDOWN_MS) return;

    // getOverdueTasks already applies snooze/retire/decay filtering, so this is
    // only the subset eligible to surface right now.
    const critical = getOverdueTasks().filter((t) => {
      if (!t.due_date) return false;
      const hoursOverdue = (Date.now() - new Date(t.due_date).getTime()) / (1000 * 60 * 60);
      return hoursOverdue > 24;
    });

    if (critical.length === 0) return; // routine tasks are the morning brief's job

    const surfaced = critical.slice(0, MAX_TASKS_PER_HEARTBEAT);

    const moreNote = critical.length > surfaced.length
      ? `\n\n(+${critical.length - surfaced.length} more — full list in the dashboard.)`
      : '';
    const hint = '\n\nReply with #<id> + an action: "snooze #N 3 days", "cancel #N", "done #N".';
    const decision = await sendInterrupt({
      source: 'heartbeat',
      subject: `task:${surfaced.map((t) => t.id).sort().join(',')}:overdue-24h`,
      kind: 'decision',
      text: `⚠️ ${surfaced.length} task(s) overdue by 24+ hours — need attention NOW:\n${surfaced.map(formatTaskLine).join('\n')}${moreNote}${hint}`,
      target: adminGroupId,
    });

    // Both of these advance state that assumes the owner SAW the message, so they have
    // to wait for a real send. markTaskSurfaced used to run before the send,
    // which burned a slot on the escalating backoff ladder even when the send
    // failed -- the task then went quiet for longer without the owner ever hearing
    // about it. Same for the cooldown stamp.
    if (decision.sent) {
      for (const t of surfaced) markTaskSurfaced(t.id);
      setMemory('system', 'task_heartbeat_last_run', new Date().toISOString());
    }
  } catch (err) {
    console.error('[Heartbeat] Task check failed:', err);
  }
}

async function heartbeatScheduleOpportunity() {
  // Run only once a day around 10am local time — running every 30 min competes with focused work.
  const h = etHour();
  if (h !== 10) return;
  const adminGroupId = process.env.GROUP_ADMIN || getDefaultRecipient();
  if (!adminGroupId) return;

  const lastRun = getMemory('system', 'schedule_opportunity_last_run');
  if (lastRun && lastRun.startsWith(todayET())) return;

  try {
    // Only suggest if there are unscheduled tasks
    const schedulable = getSchedulableTasks('owner');
    if (schedulable.length === 0) return;

    const user = getSystemUser();
    const group = groupConfig('admin', 'Admin', ['calendar', 'tasks', 'memory'], 'context/admin');

    const response = await withLlmContext(
      { caller: 'heartbeat:schedule-gap', lane: 'ambient', groupKey: group.key },
      () => runAgent(group, user,
      `Quick schedule check — look at my calendar for the next 3 hours. If there's a gap of 30+ minutes with no events, and I have unscheduled tasks, suggest ONE task I could work on in that gap. Use get_schedulable_tasks to find the best match.

If there are no meaningful gaps, respond with exactly "SCHEDULE_CLEAR" and nothing else.
Keep the suggestion to 2 sentences max.`
      ),
    );

    // Kept as a cheap pre-filter even though the arbiter also dedups: this one
    // guards a runAgent call, which the arbiter cannot -- by the time it sees
    // the message the model has already been paid for.
    setMemory('system', 'schedule_opportunity_last_run', new Date().toISOString());
    if (response && !response.includes('SCHEDULE_CLEAR')) {
      await sendInterrupt({
        source: 'heartbeat',
        subject: `heartbeat:schedule-gap:${todayET()}`,
        kind: 'nudge',
        text: response,
        target: adminGroupId,
      });
    }
  } catch (err) {
    console.error('[Heartbeat] Schedule opportunity check failed:', err);
  }
}

export function startHeartbeat() {
  scheduleCron('0,30 * * * *', async () => {
    console.log('[Heartbeat] Pulse...');
    clearOldNotifications();

    // Sync runs FIRST so all other checks see the post-sync state (fixes "completed on phone but heartbeat still nags").
    await heartbeatSyncTasks();

    await Promise.allSettled([
      heartbeatCalendarCheck(),
      heartbeatPendingAsyncCheck(),
      heartbeatTaskCheck(),
      heartbeatScheduleOpportunity(),
    ]);

    console.log('[Heartbeat] Complete.');
  });

  console.log('[Heartbeat] Started — pulsing every 30 minutes');
}
