import cron from 'node-cron';
import { scheduleCron } from './lib/cron.js';
import { RELATIONSHIP_PULSE_GROUP } from './group-resolver.js';
import { runProactivePulse } from './lib/pulse.js';
import { parseBoolEnv, parseNumEnv, parseStrEnv } from './lib/env.js';
import {
  getDueRelationshipStatuses,
  markRelationshipPlansNudged,
  type RelationshipStatus,
} from './db.js';
import { getTimezone } from './config.js';

const ENABLED = parseBoolEnv('RELATIONSHIP_PULSE_ENABLED', false);
const CRON = parseStrEnv('RELATIONSHIP_PULSE_CRON', '15 11 * * 5');
const MAX = Math.min(Math.max(parseNumEnv('RELATIONSHIP_PULSE_MAX', 5), 1), 10);
const CLEAR_SENTINEL = 'RELATIONSHIP_CLEAR';

export interface RelationshipPulseContext {
  relationships: RelationshipStatus[];
}

function cadenceLabel(days: number): string {
  if (days === 7) return 'weekly';
  if (days === 14) return 'every 2 weeks';
  if (days === 30) return 'monthly';
  if (days === 60) return 'every 2 months';
  if (days === 90) return 'every 3 months';
  return `every ${days} days`;
}

function relationshipLine(status: RelationshipStatus): string {
  const name = status.label && status.label.toLowerCase() !== status.name.toLowerCase()
    ? `${status.label} (${status.name})`
    : status.name;
  const meaningful = status.last_meaningful_at?.slice(0, 10) ?? 'unknown';
  const outreach = status.last_outreach_at?.slice(0, 10) ?? 'none logged';
  const why = status.state === 'baseline_unknown'
    ? 'baseline unknown; do not call this overdue'
    : status.days_overdue
      ? `${status.days_overdue}d overdue`
      : 'due now';
  return `#person:${status.person_id} ${name} — ${cadenceLabel(status.cadence_days)}; meaningful ${meaningful}; outreach ${outreach}; ${why}`;
}

export function gatherRelationshipPulse(asOf?: string | Date): RelationshipPulseContext | null {
  const relationships = getDueRelationshipStatuses({
    as_of: asOf,
    limit: MAX,
    followup_wait_days: 7,
    nudge_cooldown_days: 6,
  });
  return relationships.length > 0 ? { relationships } : null;
}

export function buildRelationshipPulsePrompt(ctx: RelationshipPulseContext): string {
  return `Relationship maintenance pulse. Compose a terse owner-only DM using only the candidates below.

${ctx.relationships.map(relationshipLine).join('\n')}

Rules:
- One line per person, maximum ${MAX} lines. Always include the exact #person:N id.
- A missing baseline means coverage is unknown, not that the owner failed to keep in touch.
- Do not claim these are the latest real-world contacts; the current tracker is manual-first.
- Do not send anything to a contact or imply that a draft was sent.
- End each line with useful reply grammar: "draft #person:N", "texted #person:N, no reply", "caught up #person:N by phone", or "snooze relationship #person:N 7d".
- Reply exactly ${CLEAR_SENTINEL} if none deserves an interruption.`;
}

export async function runRelationshipPulse(): Promise<void> {
  await runProactivePulse<RelationshipPulseContext>({
    name: 'RelationshipPulse',
    enabled: ENABLED,
    group: RELATIONSHIP_PULSE_GROUP,
    clearSentinel: CLEAR_SENTINEL,
    gather: () => gatherRelationshipPulse(),
    buildPrompt: buildRelationshipPulsePrompt,
    // Update cooldowns only after a visible owner DM succeeds, and only for
    // people the composed message actually named.
    onSent: ({ relationships }, response) => {
      const cited = relationships
        .filter((status) => response.includes(`#person:${status.person_id}`))
        .map((status) => status.person_id);
      markRelationshipPlansNudged(cited);
    },
  });
}

export function startRelationshipPulse(): void {
  if (!ENABLED) {
    console.log('[RelationshipPulse] Disabled via RELATIONSHIP_PULSE_ENABLED=false');
    return;
  }
  if (!cron.validate(CRON)) {
    console.error(`[RelationshipPulse] Invalid RELATIONSHIP_PULSE_CRON: ${CRON}`);
    return;
  }
  scheduleCron(
    CRON,
    () => {
      console.log('[RelationshipPulse] Tick');
      runRelationshipPulse().catch((err) => console.error('[RelationshipPulse] Tick failed:', err));
    },
  );
  console.log(`[RelationshipPulse] Registered cron: ${CRON} ${getTimezone()}`);
}
