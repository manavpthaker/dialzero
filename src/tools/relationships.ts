import { randomUUID } from 'crypto';
import type { ToolDef } from './index.js';
import {
  getPersonById,
  getRelationshipPlan,
  listRelationshipStatuses,
  recordSharedRelationshipEvent,
  upsertRelationshipPlan,
  type RelationshipDirection,
  type RelationshipStatus,
} from '../db.js';

function cadenceLabel(days: number): string {
  if (days === 7) return 'weekly';
  if (days === 14) return 'every 2 weeks';
  if (days === 30) return 'monthly';
  if (days === 60) return 'every 2 months';
  if (days === 90) return 'every 3 months';
  return `every ${days} days`;
}

function displayName(status: RelationshipStatus): string {
  if (!status.label || status.label.toLowerCase() === status.name.toLowerCase()) return status.name;
  return `${status.label} (${status.name})`;
}

function shortDate(value: string | null): string {
  return value ? value.slice(0, 10) : 'unknown';
}

function statusLine(status: RelationshipStatus): string {
  const clocks = `meaningful ${shortDate(status.last_meaningful_at)} · outreach ${shortDate(status.last_outreach_at)}`;
  let state: string;
  switch (status.state) {
    case 'baseline_unknown': state = 'baseline unknown—confirm the next real contact'; break;
    case 'waiting_for_reply': state = 'recent outreach, waiting for a reply'; break;
    case 'upcoming': state = `next due ${shortDate(status.next_due_at)}`; break;
    case 'due': state = status.days_overdue
      ? `${status.days_overdue}d overdue`
      : 'due now'; break;
    case 'snoozed': state = `snoozed until ${shortDate(status.snoozed_until)}`; break;
    default: state = status.state;
  }
  return `#person:${status.person_id} ${displayName(status)} — ${cadenceLabel(status.cadence_days)} · ${clocks} · ${state}`;
}

export const relationshipTools: ToolDef[] = [
  {
    definition: {
      name: 'list_relationship_status',
      description: 'Read the owner-private relationship-maintenance ledger. Shows the separate last outreach attempt and last meaningful-contact clocks. USE WHEN: the owner asks who is due, what relationship communication is being tracked, or for the status of a priority person. A missing baseline is unknown—not proof that the owner neglected someone.',
      input_schema: {
        type: 'object' as const,
        properties: {
          person_id: { type: 'number', description: 'Optional canonical #person:N id.' },
          scope: { type: 'string', enum: ['due', 'upcoming', 'all'], description: 'Which states to return (default all).' },
          limit: { type: 'number', description: 'Maximum rows (default 20).' },
        },
      },
    },
    handler: async (input) => {
      const { person_id, scope, limit } = input as {
        person_id?: number;
        scope?: 'due' | 'upcoming' | 'all';
        limit?: number;
      };
      let statuses = listRelationshipStatuses({
        person_id,
        include_inactive: scope === 'all',
      });
      if (scope === 'due') {
        statuses = statuses.filter((s) => ['due', 'baseline_unknown', 'waiting_for_reply'].includes(s.state));
      } else if (scope === 'upcoming') {
        statuses = statuses.filter((s) => s.state === 'upcoming');
      }
      statuses = statuses.slice(0, Math.min(Math.max(limit ?? 20, 1), 50));
      if (statuses.length === 0) return 'No relationship plans match that status.';
      return [
        'Relationship cadence (separate outreach and meaningful-contact clocks):',
        ...statuses.map(statusLine),
        '',
        'Current source coverage is manual-first; this Mac does not currently see the owner’s broader live personal-message stream.',
      ].join('\n');
    },
  },
  {
    definition: {
      name: 'set_relationship_cadence',
      description: 'Create or update an owner-private relationship plan by canonical person id. USE WHEN: the owner sets a cadence, pauses/resumes/removes a person, changes a label/channel, or snoozes a relationship nudge. Never resolve a duplicate name implicitly; call find_person and use the confirmed #person:N id.',
      input_schema: {
        type: 'object' as const,
        properties: {
          person_id: { type: 'number', description: 'Canonical #person:N id.' },
          cadence_days: { type: 'number', description: 'Whole days between meaningful contacts. Required for a new plan.' },
          label: { type: 'string', description: 'Optional display label such as Mom or Dad.' },
          preferred_channel: { type: 'string', description: 'Optional preference such as call, text, video, or in_person.' },
          status: { type: 'string', enum: ['active', 'paused', 'removed'], description: 'Plan status.' },
          snoozed_until: { type: 'string', description: 'Optional ISO date/time for a temporary nudge snooze.' },
          clear_snooze: { type: 'boolean', description: 'Set true to clear an existing snooze.' },
        },
        required: ['person_id'],
      },
    },
    handler: async (input) => {
      const values = input as {
        person_id: number;
        cadence_days?: number;
        label?: string;
        preferred_channel?: string;
        status?: 'active' | 'paused' | 'removed';
        snoozed_until?: string;
        clear_snooze?: boolean;
      };
      if (!getPersonById(values.person_id)) return `No person on file with id ${values.person_id}.`;
      const plan = upsertRelationshipPlan({
        person_id: values.person_id,
        cadence_days: values.cadence_days,
        label: values.label,
        preferred_channel: values.preferred_channel,
        status: values.status,
        snoozed_until: values.clear_snooze ? null : values.snoozed_until,
        source_ref: getRelationshipPlan(values.person_id)?.source_ref ?? 'owner-confirmed',
      });
      const status = listRelationshipStatuses({ person_id: plan.person_id, include_inactive: true })[0];
      return status ? `Saved: ${statusLine(status)}` : `Saved relationship plan for #person:${plan.person_id}.`;
    },
  },
  {
    definition: {
      name: 'log_relationship_contact',
      description: 'Record an actual relationship outcome without conflating an unanswered attempt with meaningful contact. USE WHEN: the owner says they texted/called with no answer, or confirms they really talked, video-called, met, had lunch, or visited. Shared contact counts for multiple people only when the owner explicitly confirms every named person meaningfully participated.',
      input_schema: {
        type: 'object' as const,
        properties: {
          person_ids: { type: 'array', items: { type: 'number' }, description: 'One or more canonical #person:N ids explicitly involved.' },
          outcome: { type: 'string', enum: ['attempted_no_contact', 'meaningful_contact'], description: 'Whether this was only an attempt or a real connection.' },
          initiator: { type: 'string', enum: ['owner', 'other', 'mutual', 'unknown'], description: 'Who initiated; do not guess if unstated.' },
          channel: { type: 'string', enum: ['call', 'text', 'video', 'in_person', 'email', 'other'], description: 'Communication channel.' },
          occurred_at: { type: 'string', description: 'Optional ISO date/time; defaults to now.' },
          summary: { type: 'string', description: 'Optional short factual note; do not store private message content.' },
          shared_participation_confirmed: { type: 'boolean', description: 'Required true for a meaningful shared call/visit with multiple people.' },
        },
        required: ['person_ids', 'outcome', 'initiator', 'channel'],
      },
    },
    handler: async (input) => {
      const values = input as {
        person_ids: number[];
        outcome: 'attempted_no_contact' | 'meaningful_contact';
        initiator: 'owner' | 'other' | 'mutual' | 'unknown';
        channel: 'call' | 'text' | 'video' | 'in_person' | 'email' | 'other';
        occurred_at?: string;
        summary?: string;
        shared_participation_confirmed?: boolean;
      };
      const personIds = Array.from(new Set(values.person_ids ?? []));
      if (personIds.length === 0) return 'Need at least one explicit #person:N id.';
      if (values.outcome === 'meaningful_contact' && personIds.length > 1 && !values.shared_participation_confirmed) {
        return 'I need explicit confirmation that every named person meaningfully participated before crediting a shared contact.';
      }
      if (values.outcome === 'attempted_no_contact' && !['owner', 'mutual'].includes(values.initiator)) {
        return 'An outreach attempt only counts when the owner initiated it.';
      }

      const people = personIds.map((id) => getPersonById(id));
      const missing = personIds.filter((_, idx) => !people[idx]);
      if (missing.length > 0) return `No person on file for: ${missing.map((id) => `#person:${id}`).join(', ')}.`;
      const unplanned = personIds.filter((id) => !getRelationshipPlan(id));
      if (unplanned.length > 0) {
        return `No relationship cadence exists for: ${unplanned.map((id) => `#person:${id}`).join(', ')}. Set the cadence first.`;
      }

      const ownerInitiated = values.initiator === 'owner' || values.initiator === 'mutual';
      const meaningful = values.outcome === 'meaningful_contact';
      const direction: RelationshipDirection = values.initiator === 'owner'
        ? 'outgoing'
        : values.initiator === 'other'
          ? 'incoming'
          : values.initiator === 'mutual'
            ? 'two_way'
            : 'unknown';
      const sourceRef = `manual:${randomUUID()}`;
      recordSharedRelationshipEvent(personIds, {
        occurred_at: values.occurred_at,
        channel: values.channel,
        direction,
        counts_as_outreach: ownerInitiated,
        counts_as_meaningful: meaningful,
        source: 'manual',
        source_ref: sourceRef,
        confidence: 1,
        summary: values.summary,
      });

      const names = people.map((p) => p!.name).join(', ');
      const result = meaningful ? 'meaningful contact' : 'outreach attempt only';
      return `Logged ${result} with ${names}. No contact message was sent.`;
    },
  },
];
