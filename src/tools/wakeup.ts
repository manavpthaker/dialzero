// Agent-facing wake-up call tools (src/wakeup.ts). Registered under the
// `actions` key, so they're admin/DM only. They only ever ring the owner, so no
// go-gate: setting one is the owner's own request.

import type { ToolDef } from './index.js';
import { setWakeUpCall, listWakeUps, cancelWakeUpCall } from '../wakeup.js';

export const wakeUpTools: ToolDef[] = [
  {
    definition: {
      name: 'set_wake_up_call',
      description: 'Schedule a phone call that wakes the owner up instead of an alarm; they have to talk to end it. USE WHEN: "wake me up at 6:45 tomorrow", "wake-up call weekdays at 6:30", "call me at 7 to get me up". One-off: pass date (or neither date nor days for the next time that clock time comes around). Recurring: pass days. Times are local time.',
      input_schema: {
        type: 'object' as const,
        properties: {
          time: { type: 'string', description: 'HH:MM, 24h, local time (e.g. "06:45").' },
          date: { type: 'string', description: 'YYYY-MM-DD (local) for a one-off. Omit for recurring or for "next occurrence".' },
          days: { type: 'array', items: { type: 'string' }, description: 'Recurring days, e.g. ["mon","tue","wed","thu","fri"]. "weekdays", "weekends", "daily" also work.' },
          note: { type: 'string', description: 'Optional: something to bring up on the call, e.g. "gym at 7".' },
        },
        required: ['time'],
      },
    },
    handler: async (input) => setWakeUpCall(input),
  },
  {
    definition: {
      name: 'list_wake_up_calls',
      description: 'List the owner\'s active wake-up calls with the next call time and how the last one went. USE WHEN: "what wake-up calls do I have", "am I set for tomorrow".',
      input_schema: { type: 'object' as const, properties: {}, required: [] },
    },
    handler: async () => listWakeUps(),
  },
  {
    definition: {
      name: 'cancel_wake_up_call',
      description: 'Cancel a wake-up call by id (from list_wake_up_calls). USE WHEN: "cancel my wake-up call", "no wake-up tomorrow". If there are several and it is unclear which, list them and ask.',
      input_schema: {
        type: 'object' as const,
        properties: { id: { type: 'number', description: 'Wake-up call id (the N in #N).' } },
        required: ['id'],
      },
    },
    handler: async (input) => cancelWakeUpCall(Number((input as { id: number }).id)),
  },
];
