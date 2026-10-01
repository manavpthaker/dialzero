// book_online (registered under `actions`, admin/DM only) and the
// booking-scoped browser tools the booking sub-agent gets (registry key
// `booking-browser`, never given to a chat group). Logic: src/web-booking.ts.

import { proposalText } from '../lib/proposal-text.js';
import type { ToolDef, ToolContext } from './index.js';
import { proposeAction, getAction } from '../db.js';
import { checkActionsEnabled } from '../lib/spend-cap.js';
import { ownerAskedForBooking } from '../lib/owner-request.js';
import { browserTools } from './browser.js';
import {
  prepareWebBooking, startWebBooking, bookingDeps, bookingWindowOpen, paymentRefusal,
  NOT_CONNECTED, PAYMENT_CLICK, PAYMENT_FIELD, type BookingPayload,
} from '../web-booking.js';

function dmFormat(id: number, summary: string): string {
  return proposalText(id, summary);
}

export const webBookingTools: ToolDef[] = [
  {
    definition: {
      name: 'book_online',
      description: `Book a table or appointment ONLINE (Resy, OpenTable, or the business's own booking page) through the owner's Chrome, where they're logged in. USE WHEN they want a reservation or appointment made ("book a table for 4 at a good Italian place downtown Saturday 7pm", "book an oil change at the quick-lube shop on Main St Thursday afternoon").
- owner_request: their exact words asking for the booking, copied from their message (this one or one in the last 30 minutes). With it, the booking runs now, no "go". Omit it when the booking is YOUR idea; then it's staged as #action:N for their "go".
- where: a URL, or the business + town. For a vague ask ("a good Italian place"), you may pass the description; the booker picks one with online availability.
- share: only what the booking needs, with values (e.g. "Name: Alex Rivera; cell 212-555-2368; email alex@example.com"). Never card, bank, ID, or passwords.
It never pays: if the site wants a card or deposit it stops and asks. The result comes back by text and a booking goes on the calendar. If Chrome isn't connected or the site won't cooperate, offer to call instead (call_now).
After calling this, tell the owner the returned line (for a proposal, DM the exact text returned).`,
      input_schema: {
        type: 'object' as const,
        properties: {
          owner_request: { type: 'string', description: "The owner's exact words asking for the booking. Omit if it's your idea." },
          what: { type: 'string', description: 'What to book, e.g. "dinner for 4" or "oil change for the 2019 Honda Civic".' },
          where: { type: 'string', description: 'Booking URL, or business name + town, e.g. "Main Street Auto, Springfield".' },
          when: { type: 'string', description: 'The acceptable window with a real date, e.g. "Sat Oct 3, 7-8pm".' },
          party_size: { type: 'number', description: 'Number of people, for a table.' },
          share: { type: 'string', description: 'Exactly what the booking may use, with values.' },
          notes: { type: 'string', description: 'Anything else for the booking, e.g. "outdoor if possible". Optional.' },
        },
        required: ['what', 'where', 'when', 'share'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      const enabled = checkActionsEnabled();
      if (!enabled.ok) return enabled.reason!;
      const prepared = prepareWebBooking(input);
      if ('error' in prepared) return `Not booked: ${prepared.error}`;
      if (!bookingDeps().isConnected()) return `Not booked: ${NOT_CONNECTED} (Tell the owner that in one line; if they say yes, use call_now.)`;
      const group = context?.groupKey || 'admin';
      const quote = String(input.owner_request ?? '').trim();
      const payload = prepared.payload as unknown as BookingPayload;
      if (quote && ownerAskedForBooking(quote, context)) {
        const { id, done } = startWebBooking(payload, prepared.summary, group);
        void done;
        return `Booking now [action #${id}]. Tell the owner in one short line, e.g. "${prepared.summary.split(' ')[0]} On it, booking ${payload.what} at ${payload.where}. I'll text you when it's done."`;
      }
      const id = proposeAction({
        kind: 'booking', tool_name: 'web_booking', summary: prepared.summary,
        payload_json: JSON.stringify(prepared.payload), estimated_cost_cents: null,
        reversible: false, category: 'booking', created_by_group: group,
      });
      const note = quote ? '(owner_request didn\'t match their recent messages, so this needs their "go".)\n' : '';
      return note + dmFormat(id, getAction(id)!.summary);
    },
  },
];

// The booking sub-agent's only tools: the normal browser tools, but usable only
// while a booking run holds the browser, pinned to their own tab, and unable to
// touch a payment field.
const BOOKING_BROWSER_NAMES = new Set(['browser_action', 'browser_navigate']);
export const bookingBrowserTools: ToolDef[] = browserTools
  .filter((t) => BOOKING_BROWSER_NAMES.has(t.definition.name))
  .map((t) => ({
    definition: t.definition,
    handler: async (input: Record<string, unknown>, context?: ToolContext) => {
      if (!bookingWindowOpen()) return 'Refused: the booking window is closed. Stop and return your JSON result now.';
      const refusal = paymentRefusal(input);
      if (refusal) return refusal;
      // Clicks carry the pay-button rule into Chrome, where the real element's
      // label is checked (a click by snapshot index has no text to check here).
      const guarded = input.action === 'click' || input.action === 'click_at' || input.action === 'real_click'
        ? { ...input, guard: PAYMENT_CLICK.source }
        : input.action === 'real_type' ? { ...input, fieldGuard: PAYMENT_FIELD.source } : input;
      return t.handler(guarded, { ...(context ?? { groupKey: 'booking' }), groupKey: 'booking' });
    },
  }));
