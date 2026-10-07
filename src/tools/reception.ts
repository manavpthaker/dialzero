// The owner's controls for the assistant answering its own phone number
// (src/reception.ts). Registered under `errands` (the phone module; admin/DM only).

import type { ToolDef, ToolContext } from './index.js';
import { getBotName, getOwner, getTimezone } from '../config.js';
import { getReceptionMode, setReceptionMode, updateAlwaysRing, inCallQuietHours, type ReceptionMode } from '../reception.js';

const isOwner = (c?: ToolContext) => !!c?.userId && c.userId === getOwner().id;

function untilLabel(ms: number | null): string {
  if (!ms) return '';
  return ` until ${new Date(ms).toLocaleString('en-US', { timeZone: getTimezone(), weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

function quietLabel(): string {
  const [a, b] = (process.env.RECEPTION_QUIET || '19-8').split('-').map(Number);
  const h = (n: number) => `${n % 12 || 12}${n < 12 ? 'am' : 'pm'}`;
  return `${h(a)}–${h(b)}`;
}

export const receptionTools: ToolDef[] = [
  {
    definition: {
      name: 'call_screening',
      description: `How the assistant handles calls to its own phone number (it answers, asks who's calling, then rings the owner or takes a message). USE WHEN the owner says "send my calls straight through today", "messages only until 3", "back to normal", "always ring Sam", "stop ringing for X", or asks how calls are being handled. Modes: normal (contacts get put through, others leave a message), through (everyone gets put through), messages (nobody rings the owner). Quiet hours (RECEPTION_QUIET, default 7pm–8am): only always-ring people ring the owner; others leave a message. Give "until" as an ISO time with offset from the date table, or omit for no end.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          mode: { type: 'string', enum: ['normal', 'through', 'messages'] },
          until: { type: 'string', description: 'When the mode ends, ISO 8601 with offset. Omit = until the owner changes it.' },
          always_ring_add: { type: 'array', items: { type: 'string' }, description: 'Names or numbers who always ring the owner, even at night.' },
          always_ring_remove: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    handler: async (input, context) => {
      if (!isOwner(context)) return 'Only the owner can change call screening.';
      const p = input as { mode?: ReceptionMode; until?: string; always_ring_add?: string[]; always_ring_remove?: string[] };
      const lines: string[] = [];
      if (p.mode) {
        const until = p.until ? Date.parse(p.until) : NaN;
        setReceptionMode(p.mode, Number.isFinite(until) ? until : null);
      }
      if (p.always_ring_add?.length || p.always_ring_remove?.length) {
        const r = updateAlwaysRing(p.always_ring_add ?? [], p.always_ring_remove ?? []);
        if (r.added.length) lines.push(`Always rings you now: ${r.added.join(', ')}.`);
        if (r.removed.length) lines.push(`No longer always-ring: ${r.removed.join(', ')}.`);
        if (r.unknown.length) lines.push(`Couldn't find a number for: ${r.unknown.join(', ')}.`);
      }
      const m = getReceptionMode();
      const how = m.mode === 'through' ? 'everyone gets put through' : m.mode === 'messages' ? `nobody rings you; ${getBotName()} takes messages` : 'contacts get put through, everyone else leaves a message';
      lines.push(`Calls to ${getBotName()}: ${how}${untilLabel(m.until)}. Quiet hours ${quietLabel()}: messages only except always-ring people${inCallQuietHours() ? ' (in effect now)' : ''}.`);
      return lines.join('\n');
    },
  },
];
