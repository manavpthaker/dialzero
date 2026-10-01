// watch_for and email_errand (under `actions`, admin/DM only). Logic: src/followups.ts.

import type { ToolDef, ToolContext } from './index.js';
import { getOwner } from '../config.js';
import { proposeAction, getAction } from '../db.js';
import { checkActionsEnabled } from '../lib/spend-cap.js';
import { ownerAsked } from '../lib/owner-request.js';
import { proposalText } from '../lib/proposal-text.js';
import { FORBIDDEN_SHARE, looksLikeCardNumber } from '../web-booking.js';
import { openWatch, startEmailThread } from '../followups.js';

const EMAIL_WORDS = /\b(email|e-mail|write|contact|reach out|message|ask|tell|complain|request|dispute|refund|cancel)\b/i;
const isOwner = (c?: ToolContext) => !!c?.userId && c.userId === getOwner().id;

export const followupTools: ToolDef[] = [
  {
    definition: {
      name: 'watch_for',
      description: 'Keep an eye on something for the owner until it happens: "make sure they refund me", "tell me if Comcast emails back", "make sure the cancellation sticks". It checks their email (and transactions for charges/refunds) every few hours and only texts them if there\'s a problem or it runs out of time; good news goes in the next check-in. Reply in one line ("I\'ll keep an eye on it.").',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Plain words for their list, e.g. "Make sure Comcast refunds the $40."' },
          what: { type: 'string', description: 'What must be true, specific enough to check: who, what, roughly when.' },
          days: { type: 'number', description: 'How long to keep watching (default 7).' },
        },
        required: ['title', 'what'],
      },
    },
    handler: async (input, context) => {
      if (!isOwner(context)) return 'Only the owner can set this up.';
      openWatch(String(input.title), String(input.what), { untilDays: Number(input.days) || 7, firstCheckInHours: 1 });
      return 'Watching. Tell them in one short line.';
    },
  },
  {
    definition: {
      name: 'email_errand',
      description: `Email a company or office for the owner and see it through: sends from their Gmail as them, watches for their reply, answers simple follow-up questions within the goal, sends one polite follow-up after 3 business days of silence, then offers a call. USE WHEN they want something done by email ("email Plaud support to cancel", "email the landlord about the deposit"), or as a fallback when a website or call route didn't work. For a one-off message to a person, use send_now instead.
- owner_request: their exact words asking for it. With it, it sends now. Omit when it's your idea; then it's a proposal they say go to.
- body: the first email, written as them, short and specific, with only details in "share".
Reply with one short line.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          owner_request: { type: 'string', description: "Their exact words asking for this. Omit if it's your idea." },
          goal: { type: 'string', description: 'What the email must get done, e.g. "cancel my Plaud subscription and confirm no further charges".' },
          to: { type: 'string', description: 'Their email address (look it up with web_search if needed; prefer the official support address).' },
          subject: { type: 'string' },
          body: { type: 'string', description: 'The first email, as them, plain text.' },
          share: { type: 'string', description: 'Details you may give them later if asked (name, account email, order number). Never card, bank, ID or passwords.' },
        },
        required: ['goal', 'to', 'subject', 'body'],
      },
    },
    handler: async (input, context) => {
      const enabled = checkActionsEnabled();
      if (!enabled.ok) return enabled.reason!;
      const s = (k: string) => String(input[k] ?? '').trim();
      const p = { goal: s('goal'), to: s('to'), subject: s('subject'), body: s('body'), share: s('share') };
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(p.to)) return 'Not sent: "to" must be one email address.';
      if ((p.share && FORBIDDEN_SHARE.test(p.share)) || looksLikeCardNumber(`${p.share} ${p.body}`)) return 'Not sent: never share card, bank, ID or password details by email.';
      const quote = s('owner_request');
      if (quote && isOwner(context) && ownerAsked(quote, context, EMAIL_WORDS)) {
        try {
          await startEmailThread(p);
        } catch (err) {
          return `Couldn't send: ${err instanceof Error ? err.message : String(err)}. Tell them in one line.`;
        }
        return `Sent, and watching for their reply. Tell them in one line, e.g. "Emailed ${p.to}. I'll follow up until they answer."`;
      }
      const id = proposeAction({
        kind: 'email_errand', tool_name: 'email_errand', summary: `Email ${p.to} to ${p.goal}.`,
        payload_json: JSON.stringify(p), estimated_cost_cents: null, reversible: false,
        category: 'email_errand', created_by_group: context?.groupKey || 'admin',
      });
      return proposalText(id, getAction(id)!.summary);
    },
  },
];

/** The `email_errand` executor (on their go). */
export async function runEmailErrandAction(action: { payload_json: string }): Promise<{ outcome: string; actual_cost_cents: number }> {
  const p = JSON.parse(action.payload_json) as { goal: string; to: string; subject: string; body: string; share: string };
  await startEmailThread(p);
  return { outcome: `Emailed ${p.to}. I'll follow up until they answer.`, actual_cost_cents: 0 };
}
