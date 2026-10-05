// ask_owner: the Family chat's way to get a phone call, booking or website job
// done. Those run as the owner, so other members' requests go to the owner for
// an OK; the owner's own requests in the Family chat run right away
// (src/family-requests.ts). Registry key `family-errands`, wrapped by
// createFamilyContextBoundTools, and a low-risk-write under the turn manifest:
// the request must be a member's own words. family_request (registry key
// `actions`, owner only) is the owner's yes/no from their DM.

import type { ToolDef, ToolContext } from './index.js';
import { getProfileConfig, getOwner } from '../config.js';
import { requestFromFamily, decideFamilyRequest, type FamilyRequestKind } from '../family-requests.js';

export const familyErrandTools: ToolDef[] = [
  {
    definition: {
      name: 'ask_owner',
      description: 'Get a phone call, booking or website job done for the family: "call the pizza place and ask the wait for 4 at 7", "book a table at the diner Saturday at 6", "cancel the streaming trial", "put the groceries list on Instacart" (kind website; it fills the cart, the owner checks out). If the owner asked, it starts now; if another member asked, the owner gets a text to OK it. The result is posted back here. Use it instead of saying you can\'t make calls. request = the person\'s exact words; what = a short plain summary.',
      input_schema: {
        type: 'object' as const,
        properties: {
          kind: { type: 'string', enum: ['call', 'booking', 'website'] },
          request: { type: 'string', description: "The person's exact words asking for it." },
          what: { type: 'string', description: 'Short plain summary, e.g. "call the pizza place about the wait for 4 at 7pm".' },
        },
        required: ['kind', 'request', 'what'],
      },
    },
    handler: async (input, context) => {
      const kind = String(input.kind) as FamilyRequestKind;
      if (!['call', 'booking', 'website'].includes(kind)) return 'kind must be call, booking or website.';
      const words = String(input.request ?? '').trim();
      const what = String(input.what ?? '').trim();
      if (!words || !what) return 'Need the exact request and a short summary.';
      if (context?.currentMessage && !context.currentMessage.includes(words)) {
        return 'request must be copied exactly from the current message.';
      }
      const profile = getProfileConfig();
      const user = [profile.owner, ...profile.members].find((u) => u.id === context?.userId);
      if (!user) return 'Only family members can ask for this.';
      return requestFromFamily({ requesterId: user.id, requesterName: user.name.split(' ')[0], kind, words, what });
    },
  },
];

const isOwner = (c?: ToolContext) => !!c?.userId && c.userId === getOwner().id;

export const familyRequestOwnerTools: ToolDef[] = [
  {
    definition: {
      name: 'family_request',
      description: 'The owner\'s OK on a call, booking or website job someone asked for in the Family chat (listed under "Family chat is waiting on your OK"). action "approve" when they say go / yes / do it, "decline" for no. id is the #code; omit if only one is waiting. After approving, do exactly what the result says (run it with call_now / book_online / do_online using the member\'s exact words as owner_request).',
      input_schema: { type: 'object' as const, properties: { action: { type: 'string', enum: ['approve', 'decline'] }, id: { type: 'string' } }, required: ['action'] },
    },
    handler: async (input, context) => {
      if (!isOwner(context)) return 'Only the owner can approve family requests.';
      return decideFamilyRequest(typeof input.id === 'string' && input.id ? input.id.replace(/^#/, '') : undefined, input.action === 'decline' ? 'decline' : 'approve');
    },
  },
];
