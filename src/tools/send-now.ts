// send_now: text or email someone RIGHT NOW because the owner asked for it
// themselves ("tell Priya I'm running 10 late"). Their message is the approval, so
// there's no "go #action:N". Same idea as call_now (tools/errands.ts).
//
// Everything past the owner check reuses the gated path: the same preparers
// resolve the recipient (so "which Priya?" comes back as a question), the send
// is recorded as an auto-confirmed `actions` row for audit, and the same
// executors do the sending. Messages that are the bot's own idea still go
// through propose_action.

import type { ToolDef, ToolContext } from './index.js';
import {
  proposeAction, confirmAction, markActionExecuting, markActionDone, markActionFailed,
  getAction, getPersonById, listRecentActions,
} from '../db.js';
import { checkActionsEnabled } from '../lib/spend-cap.js';
import { ownerAsked } from '../lib/owner-request.js';
import { prepareSendEmail, prepareSendIMessage, runSendEmail, runSendIMessage } from './outbound-send.js';

export const SEND_WORDS = /\b(te?xt|texting|tell|message|msg|e-?mail|reply|respond|send|ask|shoot)\b|\blet\b[^.?!]{1,40}\bknow\b/i;

/** True when `quote` is the owner's own words asking to text/email/tell someone. */
export function ownerAskedToSend(quote: string, context?: ToolContext): boolean {
  return ownerAsked(quote, context, SEND_WORDS);
}

type Executor = typeof runSendIMessage;
let senders: { imessage: Executor; email: Executor } = { imessage: runSendIMessage, email: runSendEmail };

/** Tests only: swap the real senders for stubs so nothing goes out. */
export function setSendNowSenders(s: { imessage: Executor; email: Executor }): void {
  senders = s;
}

const DUP_WINDOW_MS = 10 * 60_000;

// A model that retries a tool call must not send the same message twice.
function recentDuplicate(toolName: string, payloadJson: string): boolean {
  const cutoff = Date.now() - DUP_WINDOW_MS;
  return listRecentActions(20).some((a) =>
    a.tool_name === toolName && a.status === 'done' && a.payload_json === payloadJson
    && a.executed_at != null && new Date(`${a.executed_at.replace(' ', 'T')}Z`).getTime() >= cutoff);
}

function short(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

export const sendNowTools: ToolDef[] = [
  {
    definition: {
      name: 'send_now',
      description: `Text or email someone RIGHT NOW because the owner asked for it themselves ("tell Priya I'm running 10 late", "email the landlord about the leak", "reply to Sam that Thursday works"). No "go" needed: their message is the approval. Write the message as the owner, in their voice, not as an assistant. Reply with the one line this returns.
Requirements, or it refuses:
- owner_request: their exact words asking for the message, copied from their message (this message or one in the last 30 minutes).
- A recipient: "person" (a name in people), "person_id", or "to" (a phone/email for imessage; email addresses for email). If it comes back asking which person or which number, ask them that one question.
Use propose_action with send_imessage / send_email instead when the message is YOUR idea, not their request.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          owner_request: { type: 'string', description: "The owner's exact words asking for the message." },
          channel: { type: 'string', enum: ['imessage', 'email'], description: 'imessage for a text, email for an email.' },
          person: { type: 'string', description: 'Recipient name as it appears in people.' },
          person_id: { type: 'number', description: 'Recipient person id (use after an ambiguity question).' },
          to: { type: 'string', description: 'Phone number or email (imessage), or comma-separated email addresses (email).' },
          text: { type: 'string', description: 'imessage: the exact text to send.' },
          subject: { type: 'string', description: 'email: subject line.' },
          body: { type: 'string', description: 'email: plain-text body.' },
          cc: { type: 'string', description: 'email: optional comma-separated cc addresses.' },
          in_reply_to: { type: 'string', description: 'email: the RFC Message-ID header when replying.' },
        },
        required: ['owner_request', 'channel'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      const i = input as Record<string, unknown> & { owner_request?: string; channel?: string };
      const enabled = checkActionsEnabled();
      if (!enabled.ok) return enabled.reason!;
      const channel = i.channel === 'email' ? 'email' : i.channel === 'imessage' ? 'imessage' : null;
      if (!channel) return 'Not sent: channel must be "imessage" or "email".';
      if (!ownerAskedToSend(String(i.owner_request ?? ''), context)) {
        return `Not sent: I can only skip the "go" step when owner_request is the owner's exact words asking to text or email someone. Use propose_action with ${channel === 'email' ? 'send_email' : 'send_imessage'} instead.`;
      }

      const { owner_request: _q, channel: _c, ...fields } = i;
      const toolName = channel === 'email' ? 'send_email' : 'send_imessage';
      const prepared = channel === 'email' ? prepareSendEmail(fields) : prepareSendIMessage(fields);
      if ('error' in prepared) return `Not sent: ${prepared.error}`;

      const payloadJson = JSON.stringify(prepared.payload);
      if (recentDuplicate(toolName, payloadJson)) return 'Already sent that exact message in the last 10 minutes; not sending it again.';

      const id = proposeAction({
        kind: 'message',
        tool_name: toolName,
        summary: prepared.summary,
        payload_json: payloadJson,
        estimated_cost_cents: null,
        reversible: false,
        category: 'owner_request',
        created_by_group: context?.groupKey || 'admin',
      });
      confirmAction(id);
      markActionExecuting(id);
      const p = prepared.payload;
      const who = String(p.name ?? '') || (p.person_id ? getPersonById(Number(p.person_id))?.name : '') || (Array.isArray(p.to) ? p.to.join(', ') : String(p.to ?? ''));
      try {
        const result = await senders[channel](getAction(id)!);
        markActionDone(id, result);
        return channel === 'email'
          ? `Emailed ${who}, subject "${short(String(p.subject ?? ''), 80)}". [action #${id}]`
          : `Sent to ${who}: "${short(String(p.text ?? ''))}" [action #${id}]`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        markActionFailed(id, msg);
        return `Couldn't send to ${who}: ${msg}`;
      }
    },
  },
];
