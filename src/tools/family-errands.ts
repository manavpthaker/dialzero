// ask_owner: the Family chat's way to get a phone call, booking or website job
// done. Those run as the owner, so other members' requests go to the owner for
// an OK; the owner's own requests in the Family chat run right away
// (src/family-requests.ts). Registry key `family-errands`, wrapped by
// createFamilyContextBoundTools, and a low-risk-write under the turn manifest:
// the request must be a member's own words. family_request (registry key
// `actions`, owner only) is the owner's yes/no from their DM.

import type { ToolDef, ToolContext } from './index.js';
import { getProfileConfig, getOwner, getBotName, getTimezone } from '../config.js';
import { requestFromFamily, decideFamilyRequest, addGrant, listGrants, revokeGrants, type FamilyRequestKind } from '../family-requests.js';

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
  {
    definition: {
      name: 'family_permission',
      description: `A standing OK, with an end date, for something a family member may have ${getBotName()} do from the Family chat without asking the owner each time. USE WHEN the owner says "Sam can book dinners under $150 this week", "let Sam call the pediatrician whenever they need this month", "stop letting Sam…", or asks what someone can do. action grant: person (first name), kinds (call / booking / website), about (what it covers in a word or two, e.g. "dinner"; empty = anything of those kinds), until (ISO with offset from the date table; default end of next Sunday), max_usd (optional), note (the owner's words). list: what's active. revoke: person or #id. It never covers spending money; ${getBotName()} still stops before any payment.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: { type: 'string', enum: ['grant', 'list', 'revoke'] },
          person: { type: 'string' },
          kinds: { type: 'array', items: { type: 'string', enum: ['call', 'booking', 'website'] } },
          about: { type: 'string' },
          until: { type: 'string' },
          max_usd: { type: 'number' },
          note: { type: 'string', description: 'The owner\'s words, e.g. "Sam can book dinners under $150 this week".' },
        },
        required: ['action'],
      },
    },
    handler: async (input, context) => {
      if (!isOwner(context)) return 'Only the owner can give family permissions.';
      const fmt = (iso: string) => new Date(iso).toLocaleString('en-US', { timeZone: getTimezone(), weekday: 'short', month: 'short', day: 'numeric' });
      if (input.action === 'list') {
        const gs = listGrants();
        return gs.length ? gs.map((g) => `#${g.id} ${g.note} (until ${fmt(g.until)})`).join('\n') : 'No standing OKs right now; every family request comes to you.';
      }
      if (input.action === 'revoke') {
        const n = revokeGrants(String(input.person ?? ''));
        return n ? `Removed ${n}. Those requests come to you again.` : 'Nothing matching to remove.';
      }
      const name = String(input.person ?? '').trim().toLowerCase();
      const member = getProfileConfig().members.find((m) => m.name.toLowerCase().startsWith(name) || m.id === name);
      if (!member) return `I only know family-chat members: ${getProfileConfig().members.map((m) => m.name).join(', ') || 'none'}.`;
      const kinds = (Array.isArray(input.kinds) ? input.kinds : []).filter((k): k is FamilyRequestKind => ['call', 'booking', 'website'].includes(String(k)));
      if (!kinds.length) return 'Which kinds: call, booking, website?';
      let until = Date.parse(String(input.until ?? ''));
      if (!Number.isFinite(until)) {
        const d = new Date(); d.setDate(d.getDate() + ((7 - d.getDay()) % 7 || 7)); d.setHours(23, 59, 0, 0);
        until = d.getTime();
      }
      if (until - Date.now() > 92 * 86400_000) return 'Keep it to three months at most; the owner can renew it.';
      const g = addGrant({
        personId: member.id, personName: member.name.split(' ')[0], kinds, about: String(input.about ?? ''),
        until: new Date(until).toISOString(), maxUsd: typeof input.max_usd === 'number' ? input.max_usd : undefined,
        note: String(input.note ?? '').trim() || `${member.name.split(' ')[0]} can ${kinds.join('/')}${input.about ? ` (${input.about})` : ''}`,
      });
      return `Done: ${g.note}, until ${fmt(g.until)}. Requests like that from them run without asking you; you'll get a one-line heads-up each time.`;
    },
  },
];
