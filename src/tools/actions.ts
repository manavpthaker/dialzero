// Tier 2 Phase 1 — Actions layer: propose → confirm → execute, gated.
//
// The agent only ever sees these four tools. The actual executors (browser
// reorder, and later bookings / calls) live in EXECUTORS and run INSIDE
// confirm_action — they are deliberately NOT registered as agent-callable
// tools, so there is no path to "just run it" that bypasses the confirm gate.
//
// Routing grammar (taught in context/admin/CLAUDE.md, same #namespace:N family
// as tasks / facts / people):
//   go #action:N            → confirm_action({id:N})
//   edit #action:N <change> → confirm_action({id:N, edits:{...}})
//   cancel #action:N        → cancel_action({id:N})

import { proposalText } from '../lib/proposal-text.js';
import type { ToolDef, ToolContext } from './index.js';
import {
  proposeAction, confirmAction, cancelAction, getAction, listPendingActions,
  updateActionProposal, markActionExecuting, markActionDone, markActionFailed,
  type Action,
} from '../db.js';
import { checkActionsEnabled, checkSpendCap } from '../lib/spend-cap.js';
import { runBrowserReorder } from './browser-reorder.js';
import { runComputerUseAction, approveComputerUseTask } from './computer-use.js';
import { prepareSendEmail, prepareSendIMessage, runSendEmail, runSendIMessage } from './outbound-send.js';
import { callOwner, isPhoneConfigured, preparePlaceCall, runPlaceCall } from '../phone.js';
import { prepareErrand, runErrandAction } from '../errands.js';
import { prepareWebBooking, runWebBookingAction } from '../web-booking.js';
import { prepareWebTask, runWebTaskAction } from '../web-task.js';
import { runEmailErrandAction } from './followups.js';

type ExecutorResult = { outcome: string; outcome_url?: string; actual_cost_cents: number };
type Executor = (action: Action) => Promise<ExecutorResult>;

// Executors run INSIDE confirm_action and are deliberately NOT agent-callable
// tools — that's what makes the gate unskippable. computer_use stages its
// destructive desktop actions (click/type/key_press/scroll) here (always $0).
// computer_use_task is the task-level approval: confirming it opens a time-boxed
// window in which the agent's subsequent click/type/scroll run inline (one
// approval for a whole multi-step desktop task instead of one per action).
const EXECUTORS: Record<string, Executor> = {
  browser_reorder: runBrowserReorder,
  computer_use: runComputerUseAction,
  computer_use_task: async (action: Action) => {
    approveComputerUseTask(action.created_by_group);
    return { outcome: 'Desktop task approved — carry out the planned steps now (your click/type/scroll run without further approval for a few minutes; call end_task when done).', actual_cost_cents: 0 };
  },
  // Texting / emailing another person as the owner. Always $0, never reversible.
  send_imessage: runSendIMessage,
  send_email: runSendEmail,
  // Phone call to a business or person with a stated goal (src/phone.ts). The
  // outcome arrives later by text, when the call ends.
  place_call: (a) => runPlaceCall(a),
  // An errand (src/errands.ts): one approval starts a runner that calls only the
  // approved targets until the goal is done. Staged by start_errand.
  errand: runErrandAction,
  // Online booking through the owner's Chrome (src/web-booking.ts). Starts a
  // time-boxed browser run; the result arrives later as a reply. Never pays.
  web_booking: runWebBookingAction,
  // A website task in Chrome (src/web-task.ts): cancel, export, change a setting.
  web_task: runWebTaskAction,
  // Email a company and see it through (src/followups.ts).
  email_errand: (a) => runEmailErrandAction(a),
};

// Executors whose payload is validated and whose summary is written here, not by
// the agent, so the owner always confirms the real recipient and full text.
// Re-run on every edit so an edited message is shown again before it can go.
type Preparer = (payload: Record<string, unknown>) => { payload: Record<string, unknown>; summary: string } | { error: string };
const PREPARERS: Record<string, Preparer> = {
  send_imessage: prepareSendIMessage,
  send_email: prepareSendEmail,
  place_call: (p) => preparePlaceCall(p),
  errand: (p) => prepareErrand(p),
  web_booking: (p) => prepareWebBooking(p),
  web_task: (p) => prepareWebTask(p),
};

function usd(cents: number | null | undefined): string {
  if (cents == null) return 'free';
  return `$${(cents / 100).toFixed(2)}`;
}

// The exact string the agent should DM the user. Keep the reply hints verbatim.
function dmFormat(a: Action): string {
  // Short enough to read on a phone. Cost and refundability only matter when
  // money moves; texts, emails, and calls are free and never undoable.
  const cost = a.estimated_cost_cents != null
    ? ` (about ${usd(a.estimated_cost_cents)}${a.reversible ? ', refundable' : ', not refundable'})`
    : '';
  return proposalText(a.id, a.summary, cost);
}

export const actionTools: ToolDef[] = [
  {
    definition: {
      name: 'propose_action',
      description: `Propose a real-world action that spends money or commits to a person (an order, booking, reschedule, or a text/email sent in the owner's name) — DO NOT execute it. This stages the action behind a confirmation gate; the user must reply "go #action:N" before anything runs. USE WHEN: the user asks you to order/reorder/buy something, book or reschedule, or otherwise take an action with a cost or an outside commitment. A text or email the owner explicitly asked for ("tell Priya I'm running late", "email the landlord about the leak") is send_now, not this; use send_imessage / send_email here only for a message that is your idea. Likewise a phone call they explicitly asked for ("call the dentist and move my cleaning") is call_now; use place_call here only for a call that is your suggestion. Write the message in the owner's voice, as the owner (not as an assistant). After calling this, DM the user the exact dm_format string returned. NEVER try to place the order yourself with the browser tool — propose it.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          kind: { type: 'string', description: 'Category of action', enum: ['reorder', 'booking', 'call', 'computer_use', 'message'] },
          tool_name: { type: 'string', description: 'Executor that will run this on confirm. "browser_reorder" places an order; "computer_use" runs a gated desktop input (click/type/key_press/scroll); "send_imessage" texts someone as the owner; "send_email" emails someone as the owner from their Gmail; "place_call" phones a business or person and works toward a goal, texting the owner the outcome after; "web_booking" books a table/appointment online in Chrome (book_online normally stages it for you); "web_task" does any other website task in Chrome, like cancelling a subscription (do_online normally stages it for you). The computer_use tool normally stages those for you.', enum: ['browser_reorder', 'computer_use', 'send_imessage', 'send_email', 'place_call', 'web_booking', 'web_task'] },
          summary: { type: 'string', description: 'One-line human-readable description, e.g. "Reorder paper towels from Amazon" or "Book a 7pm table for 4 at Joe\'s Pizza"' },
          payload: { type: 'object', description: 'Executor args, frozen at propose time. For browser_reorder: {store, item_url, quantity, max_price_cents, optional selectors}. For send_imessage: {text, and either to (phone or email) or person (a name in people) or person_id}. For send_email: {subject, body (plain text), cc?, in_reply_to? (the RFC Message-ID header when replying), and either to (array of emails) or person or person_id}. For place_call: {goal (what the call must get done, e.g. "book a table for 4 Sat 7pm"), context? (details the caller may share, e.g. name for the booking), keep_transcript? (true only if the owner asked to keep a word-for-word record; default false = outcome only; "keep transcript" in an edit sets it true), and either to (phone number) or person or person_id}. For web_booking: {what, where, when, party_size?, share, notes?}. For web_task: {task, site, share?, notes?}. For send_imessage, send_email, place_call and web_booking the summary is written for you from the payload.' },
          estimated_cost_cents: { type: 'number', description: 'Best estimate of total cost in cents (e.g. 2418 for $24.18). Omit for a free action. The executor aborts if the live total drifts >5% from this.' },
          reversible: { type: 'boolean', description: 'Whether the action can be undone (a refundable order = true; a non-refundable booking = false). Default false.' },
          category: { type: 'string', description: 'Optional free-text category (reserved for future per-category limits).' },
        },
        required: ['kind', 'tool_name', 'summary', 'payload'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      const { kind, tool_name, summary, payload, estimated_cost_cents, reversible, category } = input as {
        kind: string; tool_name: string; summary: string; payload: Record<string, unknown>;
        estimated_cost_cents?: number; reversible?: boolean; category?: string;
      };

      const enabled = checkActionsEnabled();
      if (!enabled.ok) return enabled.reason!;

      if (!EXECUTORS[tool_name]) {
        return `Unknown executor "${tool_name}". Supported in this version: ${Object.keys(EXECUTORS).join(', ')}.`;
      }

      let finalPayload = payload ?? {};
      let finalSummary = summary;
      let finalReversible = !!reversible;
      const prepare = PREPARERS[tool_name];
      if (prepare) {
        const prepared = prepare(finalPayload);
        if ('error' in prepared) return `Not proposed: ${prepared.error}`;
        finalPayload = prepared.payload;
        finalSummary = prepared.summary;
        finalReversible = false;
      }

      const estCents = estimated_cost_cents ?? null;
      const cap = checkSpendCap(estCents);
      if (!cap.ok) return cap.message;

      const id = proposeAction({
        kind,
        tool_name,
        summary: finalSummary,
        payload_json: JSON.stringify(finalPayload),
        estimated_cost_cents: estCents,
        reversible: finalReversible,
        category: category ?? null,
        created_by_group: context?.groupKey || 'admin',
      });
      const row = getAction(id)!;
      return dmFormat(row);
    },
  },
  {
    definition: {
      name: 'confirm_action',
      description: `Confirm a pending action so it executes — this is the "go #action:N" path. Re-checks the kill switch and spend cap, then runs the executor and reports the outcome. To EDIT a pending proposal instead of running it (the "edit #action:N" path), pass "edits" (and optionally a new summary / estimated_cost_cents); the action stays pending and a fresh proposal is returned for the user to confirm.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'number', description: 'Action id (the N in #action:N)' },
          edits: { type: 'object', description: 'Optional partial payload to merge into the frozen payload (e.g. {quantity: 2}). If present, the action is re-proposed, NOT executed.' },
          summary: { type: 'string', description: 'Optional new summary (only used alongside edits / a re-estimate).' },
          estimated_cost_cents: { type: 'number', description: 'Optional new cost estimate in cents (use when an edit changes the price).' },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      const { id, edits, summary, estimated_cost_cents } = input as {
        id: number; edits?: Record<string, unknown>; summary?: string; estimated_cost_cents?: number;
      };

      const enabled = checkActionsEnabled();
      if (!enabled.ok) return enabled.reason!;

      const row = getAction(id);
      if (!row) return `Action #${id} not found.`;
      if (row.status !== 'proposed') {
        return `Action #${id} is "${row.status}", not pending — nothing to confirm. (Propose a new one if you want to run it again.)`;
      }

      const isEdit = edits !== undefined || summary !== undefined || estimated_cost_cents !== undefined;
      if (isEdit) {
        let merged: Record<string, unknown> = { ...JSON.parse(row.payload_json), ...(edits ?? {}) };
        let newSummary = summary ?? row.summary;
        const prepare = PREPARERS[row.tool_name];
        if (prepare) {
          // A new recipient replaces the resolved one rather than mixing with it.
          if (edits && ('to' in edits || 'person' in edits || 'person_id' in edits)) {
            if (!('to' in edits)) delete merged.to;
            if (!('person_id' in edits)) delete merged.person_id;
          }
          const prepared = prepare(merged);
          if ('error' in prepared) return `Edit not applied: ${prepared.error}`;
          merged = prepared.payload;
          newSummary = prepared.summary;
        }
        const newEst = estimated_cost_cents !== undefined ? estimated_cost_cents : row.estimated_cost_cents;
        const cap = checkSpendCap(newEst);
        if (!cap.ok) return cap.message;
        updateActionProposal(id, {
          payload_json: JSON.stringify(merged),
          summary: newSummary,
          estimated_cost_cents: newEst,
        });
        return dmFormat(getAction(id)!);
      }

      // Execute path. Re-check the cap — other actions may have spent budget
      // between propose and now.
      const cap = checkSpendCap(row.estimated_cost_cents);
      if (!cap.ok) return cap.message;

      const executor = EXECUTORS[row.tool_name];
      if (!executor) {
        markActionFailed(id, `no executor for ${row.tool_name}`);
        return `Action #${id} failed: no executor registered for "${row.tool_name}".`;
      }

      confirmAction(id);
      markActionExecuting(id);
      try {
        const result = await executor(getAction(id)!);
        markActionDone(id, result);
        const link = result.outcome_url ? `\n${result.outcome_url}` : '';
        return `✅ Action #${id} done — ${result.outcome} (charged ${usd(result.actual_cost_cents)}).${link}`;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        markActionFailed(id, msg);
        if (msg.startsWith('human_handoff_needed')) {
          return `⚠️ Action #${id} needs you: ${msg.replace('human_handoff_needed:', '').trim()} Nothing was charged.`;
        }
        if (msg.startsWith('price_drift')) {
          return `⚠️ Action #${id} aborted — ${msg.replace('price_drift:', '').trim()} Re-propose at the current price if you still want it.`;
        }
        return `❌ Action #${id} failed: ${msg}. Nothing was charged.`;
      }
    },
  },
  {
    definition: {
      name: 'cancel_action',
      description: 'Drop a pending action — the "cancel #action:N" path. Only works while the action is still pending (proposed). USE WHEN: the user declines a proposed action.',
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'number', description: 'Action id (the N in #action:N)' },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      const { id } = input as { id: number };
      const row = getAction(id);
      if (!row) return `Action #${id} not found.`;
      const cancelled = cancelAction(id);
      if (!cancelled) return `Action #${id} is "${row.status}", not pending — can't cancel.`;
      return `Action #${id} cancelled.`;
    },
  },
  {
    definition: {
      name: 'list_pending_actions',
      description: 'List actions awaiting confirmation. USE WHEN: the user asks "what\'s pending", "any actions waiting", or you need to check before proposing a duplicate.',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
    handler: async () => {
      const pending = listPendingActions();
      if (pending.length === 0) return 'No pending actions.';
      return pending.map((a) => `#action:${a.id}: ${a.summary} (${usd(a.estimated_cost_cents)}${a.reversible ? ', reversible' : ''}) — proposed ${a.proposed_at}`).join('\n');
    },
  },
  {
    definition: {
      name: 'call_me',
      description: 'Ring the owner\'s own phone now and talk live (the full assistant, same thread as iMessage). Only ever calls the owner, so no confirmation gate. USE WHEN: the owner asks you to call them ("call me", "ring me", "give me a call about X"). Not for calling anyone else — that is propose_action with place_call.',
      input_schema: {
        type: 'object' as const,
        properties: {
          reason: { type: 'string', description: 'Optional: what the call is about, so you can open with it.' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      if (!isPhoneConfigured()) return 'Phone calling is not set up on this machine.';
      const reason = String((input as { reason?: string }).reason ?? '').trim() || 'The owner asked you to call them.';
      try {
        const ok = await callOwner(reason);
        return ok
          ? 'Calling the owner now. Reply with one short line (e.g. "Calling you now").'
          : 'Could not ring: it is quiet hours or the daily ring cap is used up.';
      } catch (err) {
        return `Call failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];
