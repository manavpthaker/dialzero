import { scheduleCron } from './lib/cron.js';
import { sendMessage, getDefaultRecipient } from './channels/imessage.js';
import { runAgent } from './agent.js';
import { BRAIN_PULSE_GROUP } from './group-resolver.js';
import { isQuietHours } from './lib/time-et.js';
import { getSystemUser } from './lib/system-user.js';
import { parseNumEnv, parseBoolEnv } from './lib/env.js';
import {
  findDuplicateFacts,
  findContradictions,
  findLowConfidenceFacts,
  findExpiredCommitments,
  findStaleNeverSurfacedCommitments,
  logHygieneAction,
  setFactInactive,
  type Fact,
  type DuplicateFactGroup,
  type ContradictionGroup,
} from './db.js';
import db from './db.js';
import { runMemoryAudit, formatAuditReport } from './memory-audit.js';

// Tier 1 Phase 2: Memory Hygiene Loop.
//
// Runs Monday 07:30. Applies safe mutations inside a single SQLite
// transaction; every mutation writes a hygiene_log row with before/after JSON
// so `tsx scripts/hygiene-revert.ts <run_id>` can undo a pass cleanly.
//
// Safety posture: dedupe + expire + demote are mutations. Contradictions and
// stale-never-surfaced commitments are flag-only — they show up in the DM but
// hygiene never mutates them. If a 3-month-old commitment was never pinged,
// it might still be live; that's a human judgment call.

const HYGIENE_CONFIDENCE_THRESHOLD = parseNumEnv('HYGIENE_CONFIDENCE_THRESHOLD', 0.4);
const HYGIENE_DEMOTE_MIN_AGE_DAYS = parseNumEnv('HYGIENE_DEMOTE_MIN_AGE_DAYS', 30);
const HYGIENE_STALE_COMMITMENT_DAYS = parseNumEnv('HYGIENE_STALE_COMMITMENT_DAYS', 90);
const HYGIENE_MIN_SURFACE_BEFORE_EXPIRE = parseNumEnv('HYGIENE_MIN_SURFACE_BEFORE_EXPIRE', 3);

export interface HygieneReport {
  runId: string;
  applied: boolean;
  plan: {
    dupes: DuplicateFactGroup[];
    contras: ContradictionGroup[];
    lowConf: Fact[];
    expirable: Fact[];
    staleFlag: Fact[];
  };
  mutated: number;
}

function snapshot(f: Fact): Partial<Fact> {
  return {
    active: f.active,
    completed_at: f.completed_at,
    superseded_at: f.superseded_at,
    confidence: f.confidence,
  };
}

function generateRunId(): string {
  return 'hygiene_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

export async function runHygiene(opts: { dryRun?: boolean } = {}): Promise<HygieneReport> {
  const { dryRun = false } = opts;
  const runId = generateRunId();

  const dupes = findDuplicateFacts();
  const contras = findContradictions();
  const lowConf = findLowConfidenceFacts(HYGIENE_CONFIDENCE_THRESHOLD, HYGIENE_DEMOTE_MIN_AGE_DAYS);
  const expirable = findExpiredCommitments(HYGIENE_STALE_COMMITMENT_DAYS, HYGIENE_MIN_SURFACE_BEFORE_EXPIRE);
  const staleFlag = findStaleNeverSurfacedCommitments(HYGIENE_STALE_COMMITMENT_DAYS);

  const plan = { dupes, contras, lowConf, expirable, staleFlag };
  if (dryRun) return { runId, applied: false, plan, mutated: 0 };

  let mutated = 0;
  const tx = db.transaction(() => {
    // Dedupe: keep highest confidence then newest; deactivate the rest.
    for (const grp of dupes) {
      if (grp.ids.length < 2) continue;
      const rows = grp.ids
        .map((id) =>
          db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as Fact | undefined,
        )
        .filter((f): f is Fact => f !== undefined);
      rows.sort((a, b) => {
        if (b.confidence !== a.confidence) return b.confidence - a.confidence;
        return b.updated_at.localeCompare(a.updated_at);
      });
      const [keep, ...losers] = rows;
      for (const loser of losers) {
        const before = snapshot(loser);
        setFactInactive(loser.id);
        const after = { ...before, active: 0 };
        logHygieneAction({
          runId,
          action: 'dedupe',
          factId: loser.id,
          before,
          after,
          rationale: `duplicate of #${keep.id} (subject=${grp.subject}, predicate=${grp.predicate}, object=${grp.object})`,
        });
        mutated++;
      }
    }

    // Expire commitments that brain-pulse already surfaced enough times.
    for (const f of expirable) {
      const before = snapshot(f);
      setFactInactive(f.id, true); // also sets completed_at
      const after = { ...before, active: 0, completed_at: 'NOW' };
      logHygieneAction({
        runId,
        action: 'expire_commitment',
        factId: f.id,
        before,
        after,
        rationale: `commitment aged ${HYGIENE_STALE_COMMITMENT_DAYS}+ days, surfaced ${f.surface_count ?? 0}× with no resolution`,
      });
      mutated++;
    }

    // Demote low-confidence stale facts.
    for (const f of lowConf) {
      const before = snapshot(f);
      setFactInactive(f.id);
      const after = { ...before, active: 0 };
      logHygieneAction({
        runId,
        action: 'demote',
        factId: f.id,
        before,
        after,
        rationale: `confidence ${f.confidence.toFixed(2)} < ${HYGIENE_CONFIDENCE_THRESHOLD}, age >${HYGIENE_DEMOTE_MIN_AGE_DAYS}d`,
      });
      mutated++;
    }

    // Flag-only: contradictions (should never happen via saveFact).
    for (const grp of contras) {
      logHygieneAction({
        runId,
        action: 'flag_contradiction',
        factId: grp.ids[0] ?? null,
        before: { ids: grp.ids },
        after: null,
        rationale: `multiple active rows on supersede-type (subject=${grp.subject}, predicate=${grp.predicate}): #${grp.ids.join(', #')}`,
      });
    }

    // Flag-only: old commitments brain-pulse has never seen.
    for (const f of staleFlag) {
      logHygieneAction({
        runId,
        action: 'flag_stale',
        factId: f.id,
        before: snapshot(f),
        after: null,
        rationale: `commitment aged ${HYGIENE_STALE_COMMITMENT_DAYS}+ days but never surfaced — human review`,
      });
    }
  });
  tx();

  return { runId, applied: true, plan, mutated };
}

function formatReport(report: HygieneReport): string {
  const { plan, runId, mutated } = report;
  const lines: string[] = [`Hygiene pass ${runId} — ${mutated} mutation(s).`];
  if (plan.dupes.length > 0) lines.push(`• ${plan.dupes.length} duplicate group(s) deduped`);
  if (plan.expirable.length > 0) lines.push(`• ${plan.expirable.length} stale commitment(s) expired`);
  if (plan.lowConf.length > 0) lines.push(`• ${plan.lowConf.length} low-confidence fact(s) demoted`);
  if (plan.contras.length > 0) lines.push(`• ${plan.contras.length} contradiction(s) flagged for review`);
  if (plan.staleFlag.length > 0) lines.push(`• ${plan.staleFlag.length} never-surfaced stale commitment(s) flagged`);
  if (lines.length === 1) lines.push('Nothing to clean up.');
  if (mutated > 0) lines.push(`To undo: 'revert hygiene ${runId}' (within 14 days).`);
  return lines.join('\n');
}

export function startHygieneLoop(): void {
  if (!parseBoolEnv('HYGIENE_ENABLED', false)) {
    console.log('[Hygiene] HYGIENE_ENABLED=false — skipping registration.');
    return;
  }
  scheduleCron(
    '30 7 * * 1', // Monday 07:30
    () => {
      console.log('[Hygiene] Tick');
      runHygiene()
        .then(async (report) => {
          // Odysseus Experiment 1: the semantic audit rides the same cron,
          // AFTER the deterministic pass commits. Fingerprint-gated, so on a
          // week with no fact writes this is one SELECT + one hash, no LLM.
          let auditSummary = '';
          try {
            const audit = await runMemoryAudit();
            if (!audit.skipped) auditSummary = formatAuditReport(audit);
          } catch (err) {
            console.error('[Hygiene] memory audit failed:', err);
          }

          if (isQuietHours()) {
            console.log('[Hygiene] Quiet hours — skipping DM.');
            return;
          }
          const target = getDefaultRecipient();
          if (!target) {
            console.log('[Hygiene] No DM recipient configured; report:', report);
            return;
          }
          const summary = formatReport(report) + (auditSummary ? `\n\n${auditSummary}` : '');
          try {
            // Pass through the agent so it can soften tone if needed, but the
            // body is mostly fixed. Use the brain-pulse group (same terse
            // system-initiated voice as the brain pulse).
            const response = await runAgent(
              BRAIN_PULSE_GROUP,
              getSystemUser(),
              `Hygiene summary — relay verbatim, no preamble, no embellishment:\n\n${summary}`,
            );
            await sendMessage(target, response || summary);
          } catch (err) {
            console.error('[Hygiene] DM via runAgent failed; sending raw summary:', err);
            await sendMessage(target, summary);
          }
        })
        .catch((err) => console.error('[Hygiene] runHygiene failed:', err));
    },
  );
  console.log('[Hygiene] Registered cron: Mon 07:30');
}
