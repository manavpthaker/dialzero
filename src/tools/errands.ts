// Agent-facing errand tools (docs/ERRANDS.md). Registered under the `actions`
// key, so they're admin/DM only, like the rest of the go-gate. The errand
// itself only starts from confirm_action ("go #action:N") via the `errand`
// executor in actions.ts; start_errand just stages the proposal.

import type { ToolDef, ToolContext } from './index.js';
import { proposeAction, getAction, getErrand, listErrands } from '../db.js';
import { ownerAskedForCall } from '../lib/owner-request.js';
import { toDialable, isFictionalNumber, isPhoneConfigured } from '../phone.js';
import { checkActionsEnabled } from '../lib/spend-cap.js';
import { prepareErrand, addErrandNote, extendErrand, cancelErrand, describeErrand, errandsEnabled, startCallNow } from '../errands.js';

// Mirrors errands.ts MAX_TARGETS. Not imported: tool descriptions are built at
// module load, and errands.ts -> phone.ts -> ... -> tools/index.ts is a cycle,
// so the imported binding can still be uninitialized here.
const MAX_TARGETS = 3;

function dmFormat(id: number, summary: string): string {
  return `#${id} ${summary}\n↩ go #action:${id} · cancel · or say what to change`;
}

// The check lives in lib/owner-request.ts (shared with book_online); kept
// exported here for existing callers and tests.
export { ownerAskedForCall };

export const errandTools: ToolDef[] = [
  {
    definition: {
      name: 'start_errand',
      description: `Stage an errand: a goal the bot works on by itself over hours or days, calling businesses on the owner's behalf until it's done. The owner approves the whole plan ONCE ("go #action:N"); after that the bot calls ONLY the listed targets, shares ONLY what "share" lists, retries and falls back to backups, and reports in the check-in. USE WHEN the owner wants something done that takes calling around or following up ("get the car's oil changed this week", "find out if the pharmacy has my refill"). For a single call the owner asked for themselves, use call_now. For a reservation or appointment that can be made online, use book_online first.
BEFORE calling this, research: use web_search / fetch_url to find 1-${MAX_TARGETS} real businesses with their phone numbers (first choice, then backups), check their hours, and check the owner's calendar for a workable time. Never invent a number. Only call businesses; a person's number needs their OK to get a call from the assistant (pass personal_ok only if the owner confirms that).
"share" must list the actual details the caller may give out, with values (e.g. "Name: Alex Rivera; cell 212-555-2368; car: 2019 Honda Civic"). Allowed by default: name, cell, email, home address, car details — include only what this errand needs. Never card, bank, SSN, passwords.
After calling this, DM the owner the exact text returned.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          goal: { type: 'string', description: 'What must get done, in plain words, e.g. "Book an oil change for the 2019 Honda Civic".' },
          targets: {
            type: 'array',
            description: `1-${MAX_TARGETS} businesses to call, in order (first choice, then backups).`,
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, phone: { type: 'string', description: 'US phone number as found (any format).' } },
              required: ['name', 'phone'],
            },
          },
          share: { type: 'string', description: 'Exactly what the caller may tell them, with values.' },
          window: { type: 'string', description: 'What to aim for, e.g. "Wed or Thu after 3pm" or "Saturday 7-8pm". Optional.' },
          deadline: { type: 'string', description: 'YYYY-MM-DD (local) by which it must be done. Optional.' },
          max_calls: { type: 'number', description: 'Max calls in total (default 4, max 8).' },
          keep_transcript: { type: 'boolean', description: 'True only if the owner asked to keep word-for-word call records. Default false (outcome only).' },
          personal_ok: { type: 'boolean', description: 'True only when a target is a person (not a business) and the owner confirmed they are OK getting a call from the assistant.' },
        },
        required: ['goal', 'targets', 'share'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      const enabled = checkActionsEnabled();
      if (!enabled.ok) return enabled.reason!;
      if (!errandsEnabled()) return 'Errands are switched off (ERRANDS_ENABLED=false).';
      if (!isPhoneConfigured()) return 'Phone calling is not set up on this machine, so errands cannot run.';
      const prepared = prepareErrand(input);
      if ('error' in prepared) return `Not proposed: ${prepared.error}`;
      const id = proposeAction({
        kind: 'errand', tool_name: 'errand',
        summary: prepared.summary,
        payload_json: JSON.stringify(prepared.payload),
        estimated_cost_cents: null, reversible: false, category: 'errand',
        created_by_group: context?.groupKey || 'admin',
      });
      return dmFormat(id, getAction(id)!.summary);
    },
  },
  {
    definition: {
      name: 'call_now',
      description: `Place a phone call RIGHT NOW because the owner asked for it themselves ("call the town public works office and leave a message", "call the dentist and move my cleaning"). No "go" needed: their message is the approval. Say in one short line that you're calling; the result comes back to them by text when the call ends (or if no one picks up).
Requirements, or it refuses:
- owner_request: their exact words asking for the call, copied from their message (this message or one in the last 30 minutes).
- A REAL number. Get it from what they said or their contacts (find_person); otherwise LOOK IT UP YOURSELF with web_search (try 2-3 phrasings, prefer the official site, fetch_url it if needed) and pass the page in number_source. Pick the department that handles their issue, not a main switchboard, when the site lists one. Never guess or invent a number, and only ask them after your searches come up empty.
- Businesses only. Calling a person needs their OK to get a call from the assistant.
- share: only what the call needs, with values (e.g. "Address 12 Oak St; cell 212-555-2368").
Use start_errand instead when it will take calling around or several tries over days, and propose_action with place_call when the call is YOUR idea, not their request.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          owner_request: { type: 'string', description: "The owner's exact words asking for the call." },
          name: { type: 'string', description: 'Who is being called, e.g. "Springfield Public Works".' },
          phone: { type: 'string', description: 'Their real phone number.' },
          number_source: { type: 'string', description: 'Where the number came from: "owner", "contacts", or the URL you found it on.' },
          goal: { type: 'string', description: 'What the call must get done, in one sentence.' },
          share: { type: 'string', description: 'Exactly what the caller may tell them, with values.' },
          keep_transcript: { type: 'boolean', description: 'True only if the owner asked to keep a word-for-word record.' },
        },
        required: ['owner_request', 'name', 'phone', 'number_source', 'goal'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      const i = input as { owner_request: string; name: string; phone: string; number_source: string; goal: string; share?: string; keep_transcript?: boolean };
      const enabled = checkActionsEnabled();
      if (!enabled.ok) return enabled.reason!;
      if (!errandsEnabled() || !isPhoneConfigured()) return 'Phone calling is not set up on this machine.';
      if (!ownerAskedForCall(String(i.owner_request ?? ''), context)) {
        return 'Not calling: I can only skip the "go" step when owner_request is the owner\'s exact words asking for a call. Use propose_action with place_call instead.';
      }
      const src = String(i.number_source ?? '').trim();
      if (!src) return 'Not calling: say where the number came from (number_source).';
      const dial = toDialable(String(i.phone ?? ''));
      if (!dial) return `Not calling: "${i.phone}" is not a US number the bot can call.`;
      if (isFictionalNumber(dial)) return `Not calling: ${i.phone} is a made-up 555-01xx number. Look up the real number or ask the owner for it.`;
      const prepared = prepareErrand({
        goal: i.goal, targets: [{ name: i.name, phone: dial }], share: i.share ?? '', max_calls: 2,
        keep_transcript: i.keep_transcript === true,
      });
      if ('error' in prepared) return `Not calling: ${prepared.error}`;
      const id = startCallNow(prepared.payload as unknown as Parameters<typeof startCallNow>[0], null);
      const d = dial.slice(-10);
      return `Calling ${i.name} (${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}) now [errand #${id}]. Tell the owner in one short line, e.g. "📞 Calling ${i.name} now, I'll text you what they say."${i.keep_transcript ? '' : ' Not keeping a transcript.'}`;
    },
  },
  {
    definition: {
      name: 'list_errands',
      description: 'Show errands and where each one stands. USE WHEN the owner asks about errands ("how\'s the oil change going", "errands", "errand 7"). Pass id for one errand with its recent log.',
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'number', description: 'One errand, with its log.' },
          include_finished: { type: 'boolean', description: 'Also show recently finished/cancelled errands.' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const { id, include_finished } = input as { id?: number; include_finished?: boolean };
      if (id) {
        const row = getErrand(id);
        return row ? describeErrand(row, true) : `Errand #${id} not found.`;
      }
      const rows = listErrands({ open: !include_finished, limit: 10 });
      return rows.length ? rows.map((r) => describeErrand(r)).join('\n') : 'No open errands.';
    },
  },
  {
    definition: {
      name: 'update_errand',
      description: 'Give a running or stuck errand new instructions from the owner, or allow more calls. USE WHEN the owner answers an errand question or changes it ("errand 7: Thursday works too", "tell them the car is a 2019", "try 3 more times"). A note that answers a blocked errand restarts it. This can NOT add a new number to call or new details to share beyond what was approved — for that, cancel and start a new errand.',
      input_schema: {
        type: 'object' as const,
        properties: {
          id: { type: 'number', description: 'Errand id.' },
          note: { type: 'string', description: 'The owner\'s instruction, in their words.' },
          more_calls: { type: 'number', description: 'Allow this many more calls.' },
          start_over: { type: 'boolean', description: 'With more_calls: go back to the first number on the list.' },
        },
        required: ['id'],
      },
    },
    handler: async (input) => {
      const { id, note, more_calls, start_over } = input as { id: number; note?: string; more_calls?: number; start_over?: boolean };
      const out: string[] = [];
      if (note?.trim()) out.push(addErrandNote(id, note));
      if (more_calls && more_calls > 0) out.push(extendErrand(id, more_calls, !!start_over));
      return out.length ? out.join('\n') : 'Nothing to change: pass a note or more_calls.';
    },
  },
  {
    definition: {
      name: 'cancel_errand',
      description: 'Stop an errand. USE WHEN the owner says to drop or cancel it ("cancel errand 7", "forget the oil change"). For an errand still awaiting approval, use cancel_action on its #action:N instead.',
      input_schema: {
        type: 'object' as const,
        properties: { id: { type: 'number', description: 'Errand id.' } },
        required: ['id'],
      },
    },
    handler: async (input) => cancelErrand(Number((input as { id: number }).id)),
  },
];
