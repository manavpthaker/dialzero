import {
  getEmailOpenLoopEvidence,
  listEmailOpenLoops,
  type EmailOpenLoopStatus,
} from '../db.js';
import {
  formatEmailReconciliationResults,
  reconcileEmailItems,
  type EmailItemToReconcile,
} from '../email-reconciliation.js';
import type { ToolDef } from './index.js';
import { isValidEmailMessageId } from '../email/source.js';

const VALID_STATUSES = new Set<EmailOpenLoopStatus>([
  'open',
  'drafted',
  'tasked',
  'responded',
  'scheduled',
  'resolved',
  'uncertain',
]);

function parseItems(value: unknown): EmailItemToReconcile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error('items must contain at least one email message');
  }
  if (value.length > 25) throw new Error('Reconcile at most 25 email items per call');

  return value.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new Error(`items[${index}] must be an object`);
    const item = raw as Record<string, unknown>;
    const messageId = String(item.message_id ?? '').trim();
    if (!isValidEmailMessageId(messageId)) throw new Error(`items[${index}].message_id must be an email message ID from the email tools`);
    const taskId = item.task_id === undefined ? undefined : Number(item.task_id);
    if (taskId !== undefined && (!Number.isInteger(taskId) || taskId <= 0)) {
      throw new Error(`items[${index}].task_id must be a positive integer`);
    }
    const calendarEventId = typeof item.calendar_event_id === 'string'
      ? item.calendar_event_id.trim() || undefined
      : undefined;
    return {
      messageId,
      kind: typeof item.kind === 'string' ? item.kind.trim().slice(0, 80) || undefined : undefined,
      requestedAction: typeof item.requested_action === 'string'
        ? item.requested_action.trim().slice(0, 500) || undefined
        : undefined,
      taskId,
      calendarEventId,
    };
  });
}

export const emailReconciliationTools: ToolDef[] = [
  {
    definition: {
      name: 'reconcile_email_items',
      description:
        'Observe-only check of candidate inbox obligations against their full email thread, matching Sent/Drafts mail across folders, calendar attendee RSVP state, and linked Assistant tasks. ' +
        'Use BEFORE asking about, drafting, tasking, or archiving a possible reply/action item. This writes only Assistant\'s local reconciliation ledger; it NEVER sends or archives mail, creates/changes/RSVPs to events, or closes tasks. ' +
        'A Sent message proves sender-side delivery, not recipient read. An accepted RSVP proves acceptance, not attendance. A local event without the relevant attendee proves no notification.',
      input_schema: {
        type: 'object' as const,
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 25,
            description: 'Inbox candidates to reconcile in one batch.',
            items: {
              type: 'object',
              properties: {
                message_id: { type: 'string', description: 'Exact email message ID from email_list / email_search.' },
                kind: { type: 'string', description: 'Optional obligation category such as reply, bill, meeting, or task.' },
                requested_action: { type: 'string', description: 'Optional concise description of what the message appears to require.' },
                task_id: { type: 'number', description: 'Existing linked Assistant task ID, if already known.' },
                calendar_event_id: { type: 'string', description: 'Existing linked calendar event ID, if already known.' },
              },
              required: ['message_id'],
            },
          },
          lookback_days: {
            type: 'number',
            description: 'Cross-folder email search lookback, 7-365 days. Default 90.',
          },
        },
        required: ['items'],
      },
    },
    handler: async (input, context) => {
      const items = parseItems(input.items);
      const requestedLookback = input.lookback_days === undefined ? 90 : Number(input.lookback_days);
      if (!Number.isFinite(requestedLookback) || requestedLookback < 7 || requestedLookback > 365) {
        throw new Error('lookback_days must be between 7 and 365');
      }
      const results = await reconcileEmailItems({
        items,
        lookbackDays: Math.floor(requestedLookback),
        source: `agent-tool:${context?.groupKey || 'unknown'}`,
      });
      return formatEmailReconciliationResults(results);
    },
  },
  {
    definition: {
      name: 'list_email_open_loops',
      description:
        'Read Assistant\'s observe-only email reconciliation ledger: open, drafted, tasked, responded, scheduled, resolved, or uncertain obligations plus compact evidence. Use for status questions and before claiming an email item is still unanswered.',
      input_schema: {
        type: 'object' as const,
        properties: {
          statuses: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['open', 'drafted', 'tasked', 'responded', 'scheduled', 'resolved', 'uncertain'],
            },
            description: 'Optional statuses to include. Omit for all.',
          },
          limit: { type: 'number', description: 'Maximum rows, 1-100. Default 25.' },
        },
      },
    },
    handler: async (input) => {
      const rawStatuses = input.statuses;
      const statuses = Array.isArray(rawStatuses)
        ? rawStatuses.map((status) => String(status))
        : [];
      if (statuses.some((status) => !VALID_STATUSES.has(status as EmailOpenLoopStatus))) {
        throw new Error('Unsupported email open-loop status');
      }
      const requestedLimit = input.limit === undefined ? 25 : Number(input.limit);
      if (!Number.isFinite(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
        throw new Error('limit must be between 1 and 100');
      }
      const loops = listEmailOpenLoops({
        statuses: statuses as EmailOpenLoopStatus[],
        limit: Math.floor(requestedLimit),
      });
      if (!loops.length) return 'No tracked email open loops.';

      const lines = [
        'EMAIL OPEN LOOPS — OBSERVE MODE',
        'Sent != read; accepted != attended; calendar hold without attendee != notification.',
      ];
      for (const loop of loops) {
        lines.push(
          `- email:${loop.source_message_id} [${loop.status}, ${Math.round(loop.confidence * 100)}%] ${loop.subject}`
          + `${loop.resolution_kind ? ` — ${loop.resolution_kind}` : ''}`
          + `${loop.task_id ? ` — task #${loop.task_id}` : ''}`
          + `${loop.last_checked_at ? ` — checked ${loop.last_checked_at}` : ''}`,
        );
        const evidence = getEmailOpenLoopEvidence(loop.id, 3);
        for (const row of evidence) lines.push(`  Evidence: ${row.summary}`);
      }
      return lines.join('\n');
    },
  },
];
