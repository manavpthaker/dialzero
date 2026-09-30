import { scheduleCron } from './lib/cron.js';
import { BRAIN_PULSE_GROUP } from './group-resolver.js';
import { runProactivePulse } from './lib/pulse.js';
import {
  getStaleCommitments,
  getExpiringFacts,
  getDormantLeads,
  markFactSurfaced,
  markPersonSurfaced,
  type Fact,
  type Person,
} from './db.js';

interface BrainPulseCtx {
  stale: Fact[];
  expiring: Fact[];
  leads: Person[];
}

// Tier 1 Phase 1: Brain Pulse.
//
// A daily 11:00 cron that scans the second brain for proactive
// nudges and DM the user a short summary. Dedup-aware via PULSE_RESURFACE_HOURS
// (mirroring the heartbeat → tasks pattern). Runs as a separate module rather
// than inside scheduler.ts so the "where do scheduled things live" answer
// stays scannable.

function formatCommitmentLine(f: Fact): string {
  const created = (f.created_at ?? '').slice(0, 10);
  return `#fact:${f.id} ${f.subject} ${f.predicate} ${f.object} (open since ${created})`;
}

function formatExpiringLine(f: Fact): string {
  const expires = (f.valid_until ?? '').slice(0, 10);
  return `#fact:${f.id} ${f.subject} ${f.predicate} → ${f.object} (expires ${expires})`;
}

function formatLeadLine(p: Person): string {
  const last = p.last_contact ? p.last_contact.slice(0, 10) : 'never';
  const where = p.company ?? '?';
  return `#person:${p.id} ${p.name} @ ${where} (last contact ${last})`;
}

export async function runBrainPulse(): Promise<void> {
  await runProactivePulse<BrainPulseCtx>({
    name: 'BrainPulse',
    group: BRAIN_PULSE_GROUP,
    clearSentinel: 'PULSE_CLEAR',
    gather: () => {
      const stale = getStaleCommitments();
      const expiring = getExpiringFacts();
      const leads = getDormantLeads();
      if (stale.length + expiring.length + leads.length === 0) return null;
      return { stale, expiring, leads };
    },
    buildPrompt: ({ stale, expiring, leads }) => {
      const sections: string[] = [];
      if (stale.length > 0) {
        sections.push(`Stale commitments (>7d, no completion):\n${stale.map(formatCommitmentLine).join('\n')}`);
      }
      if (expiring.length > 0) {
        sections.push(`Facts expiring soon:\n${expiring.map(formatExpiringLine).join('\n')}`);
      }
      if (leads.length > 0) {
        sections.push(`Dormant leads (60d+ silent):\n${leads.map(formatLeadLine).join('\n')}`);
      }
      return `Brain pulse — proactive surface. Compose a SHORT DM (≤6 lines), one item per line,
each ending with a reply hint. Drop items that feel like noise. Reply 'PULSE_CLEAR' if nothing here
deserves a ping.

${sections.join('\n\n')}

Reply hints: 'done #fact:N', 'extend #fact:N 30d', 'reached out #person:N', 'still open #fact:N'.`;
    },
    // Mark every surfaced row regardless of whether the agent sent or errored.
    // Conservative posture: prevents oscillation if the agent decides one pulse
    // to suppress and the next to surface.
    afterAll: ({ stale, expiring, leads }) => {
      for (const f of [...stale, ...expiring]) markFactSurfaced(f.id);
      for (const p of leads) markPersonSurfaced(p.id);
    },
  });
}

export function startBrainPulse(): void {
  // 8:00 so it lands in the 8:30 morning check-in (it no longer DMs on its own).
  scheduleCron(
    '0 8 * * *',
    () => {
      console.log('[BrainPulse] Tick');
      runBrainPulse().catch((err) => console.error('[BrainPulse] Tick failed:', err));
    },
  );
  console.log('[BrainPulse] Registered cron: 8:00 (feeds the morning check-in)');
}
