import type { ToolDef } from './index.js';
import { upsertPerson, addInteraction } from '../db.js';
import { isLikelyAutomated } from './spark.js';
import {
  EMAIL_NOT_CONNECTED,
  formatEmailMessage,
  getEmailSource,
  type EmailMessage,
  type EmailSource,
} from '../email/source.js';

// Provider-neutral email tools (registry key `email`). Backed by whichever
// EmailSource is configured: Gmail by default, Spark when EMAIL_SOURCE=spark.
// Drafts only; nothing here sends mail (sending rides the actions gate).

function senderName(from: string): string | null {
  const name = from.replace(/<[^>]*>/g, '').replace(/"/g, '').trim();
  return name && !name.includes('@') ? name : null;
}

// Side effect: known senders flow into the people graph, same as the Spark
// tools did. Never lets a graph write break an email read.
function ingestSenders(messages: EmailMessage[]): void {
  try {
    const seen = new Set<string>();
    for (const m of messages) {
      const email = m.fromEmail;
      if (!email || seen.has(email) || m.type === 'Sent' || m.type === 'Draft') continue;
      seen.add(email);
      if (isLikelyAutomated(email)) continue;
      const personId = upsertPerson({ name: senderName(m.from) || email, emails: [email] });
      addInteraction({
        person_id: personId,
        channel: 'email',
        ref: `email:${m.id}`,
        occurred_at: m.date && !Number.isNaN(Date.parse(m.date)) ? m.date : new Date().toISOString(),
      });
    }
  } catch { /* never let graph writes break email reads */ }
}

async function withSource(run: (source: EmailSource) => Promise<string>): Promise<string> {
  const source = await getEmailSource();
  if (!source) return EMAIL_NOT_CONNECTED;
  try {
    return await run(source);
  } catch (err) {
    return `Email error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function formatList(messages: EmailMessage[], body = false): string {
  if (!messages.length) return 'No emails found.';
  return `${messages.length} email(s):\n\n${messages.map((m) => formatEmailMessage(m, { body, maxBody: 1500 })).join('\n\n---\n\n')}`;
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  return typeof v === 'string' && v.trim() ? v.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

function clampLimit(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 100) : fallback;
}

export const emailTools: ToolDef[] = [
  {
    definition: {
      name: 'email_list',
      description: 'List recent emails in a folder (default: inbox) with an optional Gmail-style filter. Returns id, thread, date, from, to, subject and a snippet. USE WHEN: the user asks what is in their inbox, "emails from X", or you need message IDs before reading, archiving or replying.',
      input_schema: {
        type: 'object' as const,
        properties: {
          folder: { type: 'string', description: 'Folder or label: "inbox" (default), "sent", "drafts", "archive", "all", or a label name.' },
          query: { type: 'string', description: 'Gmail-style filter, e.g. "from:alice@co.com is:unread", "has:attachment".' },
          newer_than: { type: 'string', description: 'Age window like "2d", "7d", "1m".' },
          limit: { type: 'number', description: 'Max results (default 20, max 100).' },
        },
        required: [],
      },
    },
    handler: async (input) => withSource(async (source) => {
      const messages = await source.listRecent({
        folder: typeof input.folder === 'string' ? input.folder : undefined,
        query: typeof input.query === 'string' ? input.query : undefined,
        newerThan: typeof input.newer_than === 'string' ? input.newer_than : undefined,
        limit: clampLimit(input.limit, 20),
      });
      ingestSenders(messages);
      return formatList(messages);
    }),
  },
  {
    definition: {
      name: 'email_search',
      description: 'Search all email (every folder) with a Gmail-style query; returns matching messages with their bodies. USE WHEN: the user asks about an email topic ("anything from Stripe about the invoice?", "what did Sarah say about Tuesday?").',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Keywords and/or Gmail operators, e.g. "invoice from:stripe.com".' },
          newer_than: { type: 'string', description: 'Optional age window like "30d".' },
          limit: { type: 'number', description: 'Max results (default 10, max 100).' },
        },
        required: ['query'],
      },
    },
    handler: async (input) => withSource(async (source) => {
      const query = String(input.query ?? '').trim();
      if (!query) return 'email_search needs a "query".';
      const messages = await source.search(query, {
        newerThan: typeof input.newer_than === 'string' ? input.newer_than : undefined,
        limit: clampLimit(input.limit, 10),
      });
      ingestSenders(messages);
      return formatList(messages, true);
    }),
  },
  {
    definition: {
      name: 'email_read_thread',
      description: 'Read the full conversation containing a message: every message with headers and plain-text body. USE WHEN: you need the full content of an email found via email_list or email_search.',
      input_schema: {
        type: 'object' as const,
        properties: {
          message_id: { type: 'string', description: 'Message ID from email_list or email_search.' },
        },
        required: ['message_id'],
      },
    },
    handler: async (input) => withSource(async (source) => {
      const id = String(input.message_id ?? '').trim();
      if (!source.isValidMessageId(id)) return `"${id}" is not a valid message ID. Use an ID from email_list or email_search.`;
      const thread = await source.readThread(id);
      ingestSenders(thread.messages);
      const blocks = thread.messages.map((m) => formatEmailMessage(m, { body: true, maxBody: 6000 }));
      return `Thread: ${thread.title || '(no subject)'} (${thread.messages.length} message(s))\n\n${blocks.join('\n\n---\n\n')}`;
    }),
  },
  {
    definition: {
      name: 'email_archive',
      description: 'Archive one or more emails (removes them from the inbox; nothing is deleted). Pass every ID in one call when triaging. USE WHEN: the user says "archive that", or during inbox triage for mail that clearly needs no action.',
      input_schema: {
        type: 'object' as const,
        properties: {
          message_ids: { type: 'array', items: { type: 'string' }, description: 'Message IDs to archive.' },
        },
        required: ['message_ids'],
      },
    },
    handler: async (input) => withSource(async (source) => {
      const ids = strList(input.message_ids);
      if (!ids.length) return 'email_archive needs at least one message ID.';
      const bad = ids.filter((id) => !source.isValidMessageId(id));
      if (bad.length) return `Not valid message IDs: ${bad.join(', ')}.`;
      await source.archive(ids);
      return `Archived ${ids.length} email(s).`;
    }),
  },
  {
    definition: {
      name: 'email_draft',
      description: 'Save an email draft for the user to review and send themselves. Never sends. For a reply, pass reply_to_message_id; recipient and subject default to the original. USE WHEN: "draft a reply to X", "write an email to Y", or proposing a response during inbox triage.',
      input_schema: {
        type: 'object' as const,
        properties: {
          to: { type: 'array', items: { type: 'string' }, description: 'Recipient email addresses (optional for replies).' },
          cc: { type: 'array', items: { type: 'string' }, description: 'CC addresses.' },
          subject: { type: 'string', description: 'Subject line (optional for replies).' },
          body: { type: 'string', description: 'Plain-text body.' },
          reply_to_message_id: { type: 'string', description: 'Message ID being replied to, so the draft lands in the same thread.' },
        },
        required: ['body'],
      },
    },
    handler: async (input) => withSource(async (source) => {
      const body = typeof input.body === 'string' ? input.body.trim() : '';
      if (!body) return 'email_draft needs a "body".';
      const replyTo = typeof input.reply_to_message_id === 'string' ? input.reply_to_message_id.trim() : '';
      if (replyTo && !source.isValidMessageId(replyTo)) return `"${replyTo}" is not a valid message ID.`;
      const to = strList(input.to);
      if (!replyTo && !to.length) return 'email_draft needs "to" for a new email, or "reply_to_message_id" for a reply.';
      const res = await source.createDraft({
        to,
        cc: strList(input.cc),
        subject: typeof input.subject === 'string' ? input.subject : undefined,
        body,
        inReplyTo: replyTo || undefined,
      });
      return res.detail || `Draft saved${res.id ? ` (${res.id})` : ''}. It is waiting in your mail for you to review and send.`;
    }),
  },
];
