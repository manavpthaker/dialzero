// research: deep, personalized web research (src/research.ts). In the owner's
// chats it uses what the assistant knows about them; in the Family chat, Family
// memory only.

import type { ToolDef } from './index.js';
import { research, type ResearchKind } from '../research.js';

export const researchTools: ToolDef[] = [
  {
    definition: {
      name: 'research',
      description: `Deep, personalized research for open-ended asks: things to do ("what can we do with the kids Saturday morning", "rainy day ideas"), travel ("help plan a long weekend in the mountains in October", "where should we go for spring break"), where to eat, camps and classes, gifts, finding a service. It plans several searches, checks hours/ages/prices/booking for the dates, and writes options with why each fits this family, plus a best plan. Takes 30-90 seconds. Use web_search instead for a single quick fact (a phone number, today's hours). Pass what you know from the conversation in when/where/who/budget/constraints.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          question: { type: 'string', description: 'The request in full, as they asked it plus anything from the conversation.' },
          kind: { type: 'string', enum: ['activities', 'travel', 'food', 'shopping', 'services', 'other'] },
          when: { type: 'string', description: 'Dates/times, e.g. "Saturday Oct 10, 9am-1pm" or "Oct 16-19".' },
          where: { type: 'string', description: 'Area or destination, if known. Omit to use where they are or home.' },
          who: { type: 'string', description: 'Who is going, e.g. "Alex and Sam (4)".' },
          budget: { type: 'string' },
          constraints: { type: 'string', description: 'Anything else: indoor only, no long drives, back by nap, etc.' },
        },
        required: ['question'],
      },
    },
    handler: async (input, context) => {
      const q = String(input.question ?? '').trim();
      if (!q) return 'What should I research?';
      const s = (k: string) => (typeof input[k] === 'string' && (input[k] as string).trim() ? (input[k] as string).trim() : undefined);
      const kind = s('kind') as ResearchKind | undefined;
      const family = context?.groupKey === 'family';
      const answer = await research(
        { question: q, kind, when: s('when'), where: s('where'), who: s('who'), budget: s('budget'), constraints: s('constraints') },
        { family },
      );
      if (family) {
        return `${answer}\n\n(Reply in the Family chat with the best plan and the top 3-4 picks with their key detail, under 900 characters. Offer the rest if they want more.)`;
      }
      return answer.length > 900
        ? `${answer}\n\n(Reply by text with the best plan and the top 3-4 picks with their key detail; offer the full list if they want it.)`
        : answer;
    },
  },
];
