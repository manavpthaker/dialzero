import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolDef } from './index.js';
import { upsertPerson, findPersonByEmail, isPlaceholderPersonName } from '../db.js';

const exec = promisify(execFile);
const SPARK_BIN = process.env.SPARK_BIN || '/usr/local/bin/spark';

// "First Last <email@domain>": a real display name right before the address.
const NAMED_SENDER_RE = /"?([A-Z][\w'.-]+(?:\s+[A-Z][\w'.-]+){1,3})"?\s*<([\w.+-]+@[\w.-]+\.[a-z]{2,})>/g;

// Filter out clearly-automated addresses so the people graph stays human-scale.
export function isLikelyAutomated(email: string): boolean {
  const local = email.split('@')[0]?.toLowerCase() || '';
  if (/^(no-?reply|donotreply|do-not-reply|notifications?|notify|mailer-daemon|postmaster|bounce|info|alerts?|hello|team)$/.test(local)) return true;
  if (/^(noreply|no-reply|notifications?|alerts?|mailer-daemon|postmaster|bounce|hello|info)[._-]/.test(local)) return true;
  if (local.includes('+bounce') || local.includes('+noreply')) return true;
  return false;
}

// Side effect: when Spark output shows "First Last <email>" for someone already in the
// people graph under a stand-in name (their email), give them the real name.
// Reading email never creates people or logs interactions: that fills the graph with
// nameless inbox addresses and blank "email" interactions that crowd real texts and
// calls out of People Context. Contacts, calendar, iMessage and calls create people;
// reading mail only improves names. Never lets a graph write break an email read.
function ingestSendersFromText(text: string): void {
  try {
    const seen = new Set<string>();
    let m: RegExpExecArray | null;
    NAMED_SENDER_RE.lastIndex = 0;
    while ((m = NAMED_SENDER_RE.exec(text)) !== null) {
      const name = m[1].trim();
      const email = m[2].toLowerCase();
      if (seen.has(email)) continue;
      seen.add(email);
      const person = findPersonByEmail(email);
      if (person && isPlaceholderPersonName(person.name)) upsertPerson({ emails: [email], name });
    }
  } catch { /* never let graph writes break email reads */ }
}

/**
 * Low-level Spark CLI invocation, exported for background daemons
 * (inbox-signal-daemon) that need clean output without the people-graph
 * side-effect that the agent-facing handlers below carry via
 * ingestSendersFromText. Same exec wrapper and error handling as `spark`.
 */
export async function sparkRaw(args: string[]): Promise<string> {
  return spark(args);
}

async function spark(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await exec(SPARK_BIN, args, { maxBuffer: 10 * 1024 * 1024 });
    const out = (stdout || '').trim();
    return out || (stderr || '').trim() || '(no output)';
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: string };
    const detail = (e.stderr || e.stdout || e.message || 'unknown error').trim();
    if (detail.includes('Spark Desktop') || detail.toLowerCase().includes('connect')) {
      return `Spark error: ${detail}\n\nIs Spark Desktop running on the Mac mini? assistant's spark tools talk to Spark Desktop via IPC.`;
    }
    return `Spark error: ${detail}`;
  }
}

export const sparkTools: ToolDef[] = [
  {
    definition: {
      name: 'list_emails',
      description: 'List emails in a folder with optional Gmail-style filter. USE WHEN: user asks to see their inbox, "show me emails from X", "what\'s in my archive", or you need to find specific message IDs before acting on them.',
      input_schema: {
        type: 'object' as const,
        properties: {
          folder: { type: 'string', description: 'Folder identifier. Examples: "Inbox" (default), "Archive", "user@example.com:Sent", or quoted team name. Run list_email_folders if unsure.' },
          filter: { type: 'string', description: 'Gmail-style filter. Examples: "from:alice@co.com is:unread", "category:newsletter newer_than:7d", "is:unread has:attachment", "category:priority".' },
          page_size: { type: 'number', description: 'Results per page (default 20, max 100)' },
          page: { type: 'number', description: 'Page number (default 1)' },
          new_senders: { type: 'boolean', description: 'Show only emails from new (GateKeeper-filtered) senders' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const { folder, filter, page_size, page, new_senders } = input as {
        folder?: string; filter?: string; page_size?: number; page?: number; new_senders?: boolean;
      };
      const args: string[] = ['emails'];
      if (folder) args.push(folder);
      if (filter) args.push('--filter', filter);
      if (page_size) args.push('--page-size', String(page_size));
      if (page) args.push('--page', String(page));
      if (new_senders) args.push('--new-senders');
      const output = await spark(args);
      ingestSendersFromText(output);
      return output;
    },
  },
  {
    definition: {
      name: 'search_emails',
      description: 'Hybrid semantic + keyword search across all email. Returns full bodies of up to 20 results sorted by relevance. USE WHEN: user asks about an email topic ("anything from Stripe about the invoice?", "what did Sarah say about Tuesday?"), or needs content from a thread they vaguely remember.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'What to search for (topic, keyword, phrase)' },
          filter: { type: 'string', description: 'Optional Gmail-style filter to narrow results (e.g., "from:alice@co.com newer_than:30d")' },
          in_scope: { type: 'string', description: 'Optional scope: account, team, folder, or shared inbox (e.g., "user@example.com" or "user@example.com:Archive"). Searches all folders if omitted.' },
        },
        required: ['query'],
      },
    },
    handler: async (input) => {
      const { query, filter, in_scope } = input as { query: string; filter?: string; in_scope?: string };
      const args: string[] = ['search', query];
      if (filter) args.push('--filter', filter);
      if (in_scope) args.push('--in', in_scope);
      const output = await spark(args);
      ingestSendersFromText(output);
      return output;
    },
  },
  {
    definition: {
      name: 'read_email_thread',
      description: 'Read the full conversation of an email thread — all messages, headers, plain-text bodies, and attachment info. USE WHEN: user wants full content of an email, or you need details after finding a thread via list_emails/search_emails.',
      input_schema: {
        type: 'object' as const,
        properties: {
          message_id: { type: 'string', description: 'Message ID from list_emails or search_emails output' },
          download_attachments: { type: 'boolean', description: 'Also fetch attachments via IMAP (default false)' },
        },
        required: ['message_id'],
      },
    },
    handler: async (input) => {
      const { message_id, download_attachments } = input as { message_id: string; download_attachments?: boolean };
      const args = ['thread'];
      if (download_attachments) args.push('--download-attachments');
      args.push(message_id);
      const output = await spark(args);
      ingestSendersFromText(output);
      return output;
    },
  },
  {
    definition: {
      name: 'list_email_folders',
      description: 'List folders/labels with message counts. Use to discover valid folder identifiers before passing them to list_emails or email_action (move/label).',
      input_schema: {
        type: 'object' as const,
        properties: {
          account: { type: 'string', description: 'Optional account email to scope to one account' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const { account } = input as { account?: string };
      const args = ['folders'];
      if (account) args.push(account);
      return spark(args);
    },
  },
  {
    definition: {
      name: 'draft_email',
      description: 'Create or edit an email draft (new, reply, forward, or edit existing). Draft is saved in Spark for the user to review and send. USE WHEN: user says "draft a reply to X", "compose an email to Y", "forward this to Z", or you\'re proposing a response for review.',
      input_schema: {
        type: 'object' as const,
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses' },
          cc: { type: 'array', items: { type: 'string' }, description: 'CC addresses' },
          bcc: { type: 'array', items: { type: 'string' }, description: 'BCC addresses' },
          subject: { type: 'string', description: 'Subject line' },
          body: { type: 'string', description: 'Body in markdown (will be converted to HTML). Required for new drafts.' },
          reply_to: { type: 'string', description: 'Message ID to reply to' },
          forward: { type: 'string', description: 'Message ID to forward' },
          edit: { type: 'string', description: 'Message ID of an existing draft to update' },
          account: { type: 'string', description: 'Account email to send from (optional, defaults to thread\'s account)' },
          attach: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const { to, cc, bcc, subject, body, reply_to, forward, edit, account, attach } = input as {
        to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; body?: string;
        reply_to?: string; forward?: string; edit?: string; account?: string; attach?: string[];
      };
      const args = ['draft'];
      for (const t of to || []) args.push('--to', t);
      for (const c of cc || []) args.push('--cc', c);
      for (const b of bcc || []) args.push('--bcc', b);
      if (subject) args.push('--subject', subject);
      if (body) args.push('--body', body);
      if (reply_to) args.push('--reply-to', reply_to);
      if (forward) args.push('--forward', forward);
      if (edit) args.push('--edit', edit);
      if (account) args.push('--account', account);
      for (const a of attach || []) args.push('--attach', a);
      return spark(args);
    },
  },
  {
    definition: {
      name: 'email_action',
      description: 'Perform an action on one or more emails. USE WHEN: user says "archive that", "snooze X until tomorrow", "move these to label Y", "mark as read", "unsubscribe from X", or you\'re triaging. Pass multiple message IDs to act in bulk.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            description: 'Action name',
            enum: [
              'pin', 'unpin', 'mute', 'unmute', 'snooze', 'unsnooze',
              'changeReminder', 'clearReminder', 'setAside',
              'archive', 'moveToInbox', 'moveToTrash', 'moveToFolder',
              'attachLabel', 'detachLabel',
              'markAsDone', 'markAsUndone', 'markAsSeen', 'markAsUnseen',
              'markAsSpam', 'markThreadAsPriority', 'unmarkThreadAsPriority',
              'unsubscribe',
              'changeCategoryPersonal', 'changeCategoryNotification', 'changeCategoryNewsletters',
            ],
          },
          message_ids: { type: 'array', items: { type: 'string' }, description: 'One or more message IDs to act on' },
          date: { type: 'string', description: 'Required for snooze and changeReminder. Formats: yyyy-MM-dd, dd/MM/yyyy, yyyy-MM-ddTHH:mm' },
          folder: { type: 'string', description: 'Required for moveToFolder, attachLabel, detachLabel. Qualified name like "user@example.com:Archive" — use list_email_folders to find valid identifiers.' },
        },
        required: ['action', 'message_ids'],
      },
    },
    handler: async (input) => {
      const { action, message_ids, date, folder } = input as {
        action: string; message_ids: string[]; date?: string; folder?: string;
      };
      const args = ['action', action, ...message_ids];
      if (date) args.push('--date', date);
      if (folder) args.push('--folder', folder);
      return spark(args);
    },
  },
  {
    definition: {
      name: 'list_calendar_events',
      description: 'List calendar events across ALL Spark-connected accounts (work + personal unified). USE WHEN: user asks "what\'s on my calendar", "what do I have today/tomorrow/this week", or you\'re building a daily/weekly brief. Prefer this over the Google Calendar list_events tool because it sees every account, not just primary.',
      input_schema: {
        type: 'object' as const,
        properties: {
          range: { type: 'string', description: 'Preset range', enum: ['today', 'tomorrow', 'week'] },
          start: { type: 'string', description: 'Custom start date (yyyy-MM-dd or yyyy-MM-ddTHH:mm). Use with end. Overrides range.' },
          end: { type: 'string', description: 'Custom end date (yyyy-MM-dd or yyyy-MM-ddTHH:mm). Use with start.' },
          in_scope: { type: 'string', description: 'Optional: scope to one account ("user@example.com") or calendar ("user@example.com:Work"). Omit for all.' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const { range, start, end, in_scope } = input as { range?: string; start?: string; end?: string; in_scope?: string };
      const args = ['events'];
      if (start && end) {
        args.push('--start', start, '--end', end);
      } else if (range === 'tomorrow') {
        args.push('--tomorrow');
      } else if (range === 'week') {
        args.push('--week');
      }
      // 'today' is the default with no flags
      if (in_scope) args.push('--in', in_scope);
      return spark(args);
    },
  },
  {
    definition: {
      name: 'find_availability',
      description: 'Find free time slots within working hours (08:00–20:00, weekdays). Without attendees, shows YOUR availability across all calendars. With attendees, computes MUTUAL free windows. USE WHEN: user says "when am I free", "find a time alice and I are both free", "what does Tuesday look like".',
      input_schema: {
        type: 'object' as const,
        properties: {
          range: { type: 'string', description: 'Preset range', enum: ['today', 'tomorrow', 'week'] },
          start: { type: 'string', description: 'Custom start date (yyyy-MM-dd or yyyy-MM-ddTHH:mm)' },
          end: { type: 'string', description: 'Custom end date (yyyy-MM-dd or yyyy-MM-ddTHH:mm)' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to compute mutual availability with. Omit for just my schedule.' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const { range, start, end, attendees } = input as {
        range?: string; start?: string; end?: string; attendees?: string[];
      };
      const args = ['availability'];
      if (start && end) {
        args.push('--start', start, '--end', end);
      } else if (range === 'tomorrow') {
        args.push('--tomorrow');
      } else if (range === 'week') {
        args.push('--week');
      }
      if (attendees && attendees.length) args.push('--attendees', attendees.join(','));
      return spark(args);
    },
  },
  {
    definition: {
      name: 'contact_email_action',
      description: 'Perform an action on one or more email contacts (block, accept, change category, enable auto-summary, etc.). USE WHEN: user says "block this sender", "always treat X as priority", "stop categorizing Y as newsletter", or you\'re tuning rules during triage.',
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            description: 'Contact action name',
            enum: [
              'changeCategoryPersonal', 'changeCategoryNotification', 'changeCategoryNewsletters',
              'groupEmailsFromContact', 'groupEmailsFromContactAndShowInInbox', 'ungroupEmailsFromContact',
              'markContactAsImportant', 'unmarkContactAsImportant',
              'markContactAsPrimary', 'unmarkContactAsPrimary',
              'acceptContact', 'blockContact', 'acceptDomain', 'blockDomain',
              'enableAutosummaryForContact', 'disableAutosummaryForContact',
            ],
          },
          emails: { type: 'array', items: { type: 'string' }, description: 'One or more contact email addresses' },
        },
        required: ['action', 'emails'],
      },
    },
    handler: async (input) => {
      const { action, emails } = input as { action: string; emails: string[] };
      return spark(['contact-action', action, ...emails]);
    },
  },
];
