// get_ride (registered under `web-booking`, admin/DM only): an Uber or Lyft in the
// owner's Chrome. A thin wrapper over do_online, so it gets the website-job
// machinery: run-now on the owner's words, the browser lock, progress texts, and
// pausing for them. It always stops at the price for the owner's yes before
// requesting; it never adds or changes a card.

import type { ToolDef, ToolContext } from './index.js';
import { factsAbout } from '../db.js';
import { getOwner } from '../config.js';
import { webTaskTools } from './web-task.js';

function homeAddress(): string | null {
  try {
    const owner = getOwner();
    const f = factsAbout(owner.name).find((x) => x.predicate === 'home_address')
      ?? factsAbout('owner').find((x) => x.predicate === 'home_address');
    return f?.object ?? null;
  } catch { return null; }
}

export function rideTask(p: { pickup: string; destination: string; when: string; service: string; riders?: number; notes?: string; app: 'uber' | 'lyft' }): string {
  const site = p.app === 'lyft' ? 'lyft.com (the ride page)' : 'm.uber.com';
  return [
    `Get the owner a ride on ${site}${p.app === 'uber' ? ' (if Uber has no cars, say so; don\'t switch apps on your own)' : ''}.`,
    `Pickup: ${p.pickup}. Destination: ${p.destination}. When: ${p.when}.${p.riders ? ` Riders: ${p.riders}.` : ''} Service: ${p.service}.`,
    'Steps: enter the destination, then the pickup; pick the suggestion that matches the full address. For a later time, use the app\'s schedule/reserve option.',
    'Then STOP before requesting and return needs_owner with need "decision" and ask exactly like: "UberX from home to the airport, Terminal B, $34, car 4 min away (arrive ~5:40). Request it?" (price, pickup, destination, wait or pickup time).',
    'Only after THE OWNER ANSWERED yes: press Request (or Reserve). If a card, payment or verification prompt appears, stop and return needs_owner (the owner does it). Never add, choose or change a payment method.',
    'After requesting, read the screen and finish with done: driver name, car, plate, and ETA in the summary. If the owner said no, finish with done and "Didn\'t request."',
    p.notes ? `Also: ${p.notes}` : '',
  ].filter(Boolean).join('\n');
}

export const rideTools: ToolDef[] = [
  {
    definition: {
      name: 'get_ride',
      description: 'Order an Uber (or Lyft) for the owner in their Chrome. USE WHEN they say "get me an Uber to…", "I need a car to the airport at 5", "pick me up". It sets up the ride, texts them the price and wait first, and only requests on their yes; then texts driver, car, plate and ETA. owner_request = their exact words. pickup defaults to their home address; destination as specific as they said (look up the address if they named a place). when: "now" or a time ("today 5:00am" with the date from the date table).',
      input_schema: {
        type: 'object' as const,
        properties: {
          owner_request: { type: 'string', description: 'The owner\'s exact words asking for the ride.' },
          destination: { type: 'string' },
          pickup: { type: 'string', description: 'Omit for home.' },
          when: { type: 'string', description: '"now" or a specific time.' },
          service: { type: 'string', description: 'e.g. UberX, Comfort, XL. Default: the cheapest standard car.' },
          riders: { type: 'number' },
          app: { type: 'string', enum: ['uber', 'lyft'] },
          notes: { type: 'string' },
        },
        required: ['destination'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      const destination = String(input.destination ?? '').trim();
      if (!destination) return 'Where to?';
      const pickup = String(input.pickup ?? '').trim() || homeAddress();
      if (!pickup) return 'Where should the car pick them up? Ask the owner once.';
      const app = input.app === 'lyft' ? 'lyft' : 'uber';
      return webTaskTools[0].handler({
        ...(typeof input.owner_request === 'string' ? { owner_request: input.owner_request } : {}),
        task: rideTask({
          pickup, destination, app,
          when: String(input.when ?? '').trim() || 'now',
          service: String(input.service ?? '').trim() || 'the cheapest standard car',
          riders: typeof input.riders === 'number' ? input.riders : undefined,
          notes: typeof input.notes === 'string' ? input.notes : undefined,
        }),
        site: app === 'lyft' ? 'https://www.lyft.com' : 'https://m.uber.com',
        notes: 'Stop at the price for the owner\'s yes before requesting. Never add or change a payment method.',
      }, context);
    },
  },
];
