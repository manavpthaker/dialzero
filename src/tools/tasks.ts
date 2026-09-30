import { createTask, updateTaskStatus, getOpenTasks, getOverdueTasksAll, getTasksDueSoonAll, getTaskStats, getSchedulableTasks, updateTaskSchedule, clearTaskSchedule, getTaskById, snoozeTask, linkEmailOpenLoopTaskByMessageId, type Task } from '../db.js';
import type { ToolDef, ToolContext } from './index.js';
import { isValidEmailMessageId } from '../email/source.js';
import { getTimezone } from '../config.js';
import { tzAbbrev } from '../lib/time.js';

function fireAndForgetPush(taskId: number) {
  import('../sync/tasks-sync.js')
    .then(async (m) => {
      const t = getTaskById(taskId);
      if (t) await m.pushTaskToGoogle(t);
    })
    .catch((err) => console.error('[sync] push failed:', err));
}

function fireAndForgetComplete(taskId: number, status: string) {
  import('../sync/tasks-sync.js')
    .then(async (m) => {
      const t = getTaskById(taskId);
      if (!t) return;
      if (status === 'cancelled') await m.deleteGoogleTaskMirror(t);
      else await m.markGoogleTaskComplete(t);
    })
    .catch((err) => console.error('[sync] complete failed:', err));
}

function formatTask(t: Task): string {
  const priority = t.priority === 'urgent' ? '🔴' : t.priority === 'high' ? '🟠' : t.priority === 'medium' ? '🟡' : '⚪';
  const due = t.due_date ? ` (due ${new Date(t.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })})` : '';
  const status = t.status === 'in_progress' ? ' [in progress]' : '';
  return `${priority} #${t.id}: ${t.title}${due}${status} → ${t.assignee}`;
}

export const taskTools: ToolDef[] = [
  {
    definition: {
      name: 'create_task',
      description: 'Create a tracked task for a human or for assistant. Tasks assigned to a human (owner/partner) automatically sync to Google Tasks on the iPhone. USE WHEN: user says "remind me to", "I need to", "don\'t let me forget", "follow up on", or describes any action they\'ll do later.',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Short, clear task title' },
          description: { type: 'string', description: 'Details about what needs to happen (optional)' },
          assignee: { type: 'string', description: 'Who should do this', enum: ['owner', 'partner', 'assistant'] },
          priority: { type: 'string', description: 'Priority level', enum: ['low', 'medium', 'high', 'urgent'] },
          due_date: { type: 'string', description: 'When this should be done (ISO date, e.g., "2026-04-25T17:00:00")' },
          duration_minutes: { type: 'number', description: 'Estimated duration in minutes (e.g., 30, 60, 90)' },
          focus_level: { type: 'string', description: 'Focus level needed', enum: ['deep', 'normal', 'light'] },
          splittable: { type: 'boolean', description: 'Can this task be split across multiple time blocks? (default: true)' },
          source_message_id: { type: 'string', description: 'Email message ID (from the email tools) when this task carries an email obligation. Pass the exact ID so later replies and completion reconcile against the same open loop.' },
        },
        required: ['title'],
      },
    },
    handler: async (input, context) => {
      const { title, description, assignee, priority, due_date, duration_minutes, focus_level, splittable, source_message_id } = input as {
        title: string; description?: string; assignee?: string; priority?: string; due_date?: string;
        duration_minutes?: number; focus_level?: string; splittable?: boolean; source_message_id?: string;
      };
      if (source_message_id && !isValidEmailMessageId(source_message_id)) {
        throw new Error(`Invalid email source_message_id: ${source_message_id}`);
      }
      const id = createTask({
        title,
        description,
        group_id: context?.groupKey || 'admin',
        assignee: assignee || 'owner',
        priority: priority || 'medium',
        due_date,
        source: 'agent',
        source_ref: source_message_id ? `email:${source_message_id}` : undefined,
        duration_minutes,
        focus_level,
        splittable,
      });
      if (source_message_id) linkEmailOpenLoopTaskByMessageId(source_message_id, id);
      fireAndForgetPush(id);
      const dueStr = due_date ? ` — due ${new Date(due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : '';
      const durStr = duration_minutes ? ` (${duration_minutes} min)` : '';
      return `Task #${id} created: "${title}" → ${assignee || 'owner'}${dueStr}${durStr}`;
    },
  },
  {
    definition: {
      name: 'list_tasks',
      description: 'List open tasks. Can filter by group, assignee, or show overdue only. USE WHEN: user asks "what\'s on my list", "what do I need to do", "any overdue tasks", or you need to check existing work before creating a new task.',
      input_schema: {
        type: 'object' as const,
        properties: {
          group: { type: 'string', description: 'Filter by group (e.g., "home", "work")' },
          assignee: { type: 'string', description: 'Filter by assignee', enum: ['owner', 'partner', 'assistant'] },
          overdue_only: { type: 'boolean', description: 'Only show overdue tasks' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const { group, assignee, overdue_only } = input as { group?: string; assignee?: string; overdue_only?: boolean };

      const tasks = overdue_only ? getOverdueTasksAll() : getOpenTasks(group, assignee);
      if (tasks.length === 0) return overdue_only ? 'No overdue tasks.' : 'No open tasks.';

      return tasks.map(formatTask).join('\n');
    },
  },
  {
    definition: {
      name: 'update_task',
      description: 'Update a task\'s status, priority, or notes.',
      input_schema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task ID number' },
          status: { type: 'string', description: 'New status', enum: ['open', 'in_progress', 'done', 'cancelled'] },
          notes: { type: 'string', description: 'Additional notes to append' },
        },
        required: ['task_id'],
      },
    },
    handler: async (input) => {
      const { task_id, status, notes } = input as { task_id: number; status?: string; notes?: string };
      if (status) {
        updateTaskStatus(task_id, status, notes);
        if (status === 'done' || status === 'cancelled') fireAndForgetComplete(task_id, status);
        else fireAndForgetPush(task_id);
        return `Task #${task_id} → ${status}${notes ? ` (${notes})` : ''}`;
      }
      if (notes) {
        updateTaskStatus(task_id, 'open', notes);
        fireAndForgetPush(task_id);
        return `Task #${task_id} notes updated.`;
      }
      return 'No changes specified.';
    },
  },
  {
    definition: {
      name: 'complete_task',
      description: 'Mark a task as done. Syncs to Google Tasks. USE WHEN: user says "I did X", "done with X", "finished X", "knocked out X", "took care of X".',
      input_schema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task ID number' },
          notes: { type: 'string', description: 'Completion notes (optional)' },
        },
        required: ['task_id'],
      },
    },
    handler: async (input) => {
      const { task_id, notes } = input as { task_id: number; notes?: string };
      updateTaskStatus(task_id, 'done', notes);
      fireAndForgetComplete(task_id, 'done');
      return `Task #${task_id} completed.`;
    },
  },
  {
    definition: {
      name: 'cancel_task',
      description: 'Mark a task as cancelled — keeps it in history but stops all reminders. USE WHEN: user says "cancel", "skip this one", "not doing it", "drop X", or otherwise abandons a task. Distinct from complete_task: cancel = won\'t do; complete = done.',
      input_schema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task ID number' },
          reason: { type: 'string', description: 'Why it was cancelled (optional, stored in notes)' },
        },
        required: ['task_id'],
      },
    },
    handler: async (input) => {
      const { task_id, reason } = input as { task_id: number; reason?: string };
      const t = getTaskById(task_id);
      if (!t) return `Task #${task_id} not found.`;
      updateTaskStatus(task_id, 'cancelled', reason);
      fireAndForgetComplete(task_id, 'cancelled');
      return `Task #${task_id} cancelled${reason ? ` — ${reason}` : ''}.`;
    },
  },
  {
    definition: {
      name: 'snooze_task',
      description: 'Suppress reminders for a task until a given time, WITHOUT moving its due date. USE WHEN: user says "remind me later", "snooze that for 3 days", "not now, remind me Friday", or otherwise wants the nag to stop without saying the task itself has slipped. If the user actually wants the deadline to move, use update_task instead.',
      input_schema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task ID number' },
          until: { type: 'string', description: 'ISO timestamp until which reminders are suppressed (e.g., "2026-06-05T09:00:00" with the local UTC offset). Compute this yourself from the user\'s natural-language phrase ("3 days from now" → take now + 3 days). If the user says "tomorrow", default to 9am local time tomorrow.' },
        },
        required: ['task_id', 'until'],
      },
    },
    handler: async (input) => {
      const { task_id, until } = input as { task_id: number; until: string };
      const t = getTaskById(task_id);
      if (!t) return `Task #${task_id} not found.`;
      const parsed = new Date(until);
      if (Number.isNaN(parsed.getTime())) return `Could not parse "until" as a date: "${until}". Pass an ISO timestamp.`;
      snoozeTask(task_id, parsed.toISOString());
      const friendly = parsed.toLocaleString('en-US', { timeZone: getTimezone(), weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return `Task #${task_id} snoozed until ${friendly} ${tzAbbrev()}. Due date unchanged.`;
    },
  },
  {
    definition: {
      name: 'get_task_summary',
      description: 'Get a summary of task stats — open, done this week, overdue. Use for daily digests and weekly reviews.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    handler: async () => {
      const stats = getTaskStats();
      const overdue = getOverdueTasksAll();
      const dueSoon = getTasksDueSoonAll(24);

      let summary = `Tasks: ${stats.open} open, ${stats.done} completed this week, ${stats.overdue} overdue`;
      if (overdue.length > 0) {
        summary += '\n\nOverdue:\n' + overdue.map(formatTask).join('\n');
      }
      if (dueSoon.length > 0) {
        summary += '\n\nDue in 24h:\n' + dueSoon.map(formatTask).join('\n');
      }
      return summary;
    },
  },
  {
    definition: {
      name: 'get_schedulable_tasks',
      description: 'Get open tasks that are NOT yet scheduled on the calendar. Use this to find tasks that need time blocks.',
      input_schema: {
        type: 'object' as const,
        properties: {
          assignee: { type: 'string', description: 'Filter by assignee', enum: ['owner', 'partner', 'assistant'] },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const tasks = getSchedulableTasks(input.assignee as string | undefined);
      if (tasks.length === 0) return 'All tasks are scheduled or none are open.';

      return tasks.map((t) => {
        const priority = t.priority === 'urgent' ? '🔴' : t.priority === 'high' ? '🟠' : t.priority === 'medium' ? '🟡' : '⚪';
        const dur = t.duration_minutes ? `${t.duration_minutes} min` : 'no estimate';
        const focus = t.focus_level || 'normal';
        const split = t.splittable ? 'splittable' : 'no-split';
        const due = t.due_date ? ` due ${new Date(t.due_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : '';
        return `${priority} #${t.id}: ${t.title} (${dur}, ${focus} focus, ${split})${due}`;
      }).join('\n');
    },
  },
  {
    definition: {
      name: 'link_task_to_event',
      description: 'Link a task to a Google Calendar event after scheduling it as a time block.',
      input_schema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task ID' },
          calendar_event_id: { type: 'string', description: 'Google Calendar event ID from create_event output' },
        },
        required: ['task_id', 'calendar_event_id'],
      },
    },
    handler: async (input) => {
      updateTaskSchedule(input.task_id as number, input.calendar_event_id as string);
      return `Task #${input.task_id} linked to calendar event ${input.calendar_event_id}`;
    },
  },
  {
    definition: {
      name: 'unlink_task_from_event',
      description: 'Remove the calendar link from a task (for rescheduling). Does NOT delete the calendar event — use delete_event separately.',
      input_schema: {
        type: 'object' as const,
        properties: {
          task_id: { type: 'number', description: 'Task ID' },
        },
        required: ['task_id'],
      },
    },
    handler: async (input) => {
      clearTaskSchedule(input.task_id as number);
      return `Task #${input.task_id} unlinked from calendar.`;
    },
  },
];
