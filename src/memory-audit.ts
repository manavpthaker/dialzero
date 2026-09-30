import { createHash } from 'crypto';
import db, {
  saveFact,
  setFactInactive,
  logHygieneAction,
  setMemory,
  getMemory,
  type Fact,
} from './db.js';
import { extractionComplete, extractFirstJson, type Logger } from './lib/daemon.js';
import { parseBoolEnv, parseNumEnv, parseStrEnv } from './lib/env.js';
import { OPENAI_MODEL } from './lib/openai.js';

// Odysseus Experiment 1: the semantic Memory Audit Loop.
//
// The Monday hygiene pass (hygiene.ts) is the deterministic floor — exact-match
// dedupe, low-confidence demote, stale-commitment expiry. What it can't see is
// that "prefers morning meetings" and "hates afternoon calls" are one preference
// stated two ways, or that three fact rows about a project's pricing should be
// one canonical statement. This pass adds that LLM-judgment layer on top, with
// the same revert guarantee: every mutation is a hygiene_log row, so
// `tsx scripts/hygiene-revert.ts <run_id>` undoes an audit run exactly like a
// hygiene run (14-day window).
//
// Fingerprint gate: before any LLM call, hash the active audited-scope fact
// state; if it matches the last audited fingerprint, skip the LLM entirely.
// A no-op audit costs one SELECT + one hash, which is what makes it safe to
// invoke on every hygiene tick.
//
// Scope: `fact` + `reference` types ONLY. commitment/feedback are append-only
// logs (legit duplicates); preference/decision/metric already supersede on
// write and carry semantics an LLM shouldn't silently merge.
//
// The LLM proposes; this module disposes. Proposals are validated (ids must be
// in the input set, no id in two proposals, confidence spread capped) and then
// applied deterministically in one transaction via the existing saveFact /
// setFactInactive / logHygieneAction machinery.

const AUDIT_ENABLED = parseBoolEnv('MEMORY_AUDIT_ENABLED', false);
const MIN_ROWS = parseNumEnv('MEMORY_AUDIT_MIN_ROWS_PER_SUBJECT', 3);
const MAX_SUBJECTS = parseNumEnv('MEMORY_AUDIT_MAX_SUBJECTS_PER_RUN', 10);
const AUDIT_MODEL = parseStrEnv('MEMORY_AUDIT_MODEL', OPENAI_MODEL);

// Never auto-merge rows whose confidence differs by more than this — a 1.0 fact
// shouldn't silently absorb a 0.5 guess. Such groups are flagged, not applied.
const MAX_CONFIDENCE_SPREAD = 0.3;

const AUDITED_TYPES = ['fact', 'reference'] as const;

const FINGERPRINT_GROUP = 'hygiene';
const FINGERPRINT_KEY = 'audit_fingerprint';
const LAST_RUN_KEY = 'memory_audit_last_run'; // memory group 'system', read by doctor

export interface AuditMerge {
  ids: number[];
  predicate: string;
  canonical_object: string;
  rationale?: string;
}

export interface AuditPrune {
  id: number;
  reason?: string;
}

export interface SubjectAudit {
  subject: string;
  merges: AuditMerge[];
  prunes: AuditPrune[];
  flagged: string[]; // human-readable notes on proposals we refused to apply
}

export interface AuditReport {
  runId: string;
  skipped: 'disabled' | 'fingerprint' | null;
  applied: boolean; // false in dry-run (or when skipped)
  subjectsAudited: number;
  results: SubjectAudit[];
  mutated: number;
}

function activeAuditableRows(): Array<Pick<Fact, 'id' | 'subject' | 'predicate' | 'object' | 'fact_type' | 'confidence' | 'updated_at'>> {
  return db.prepare(
    `SELECT id, subject, predicate, object, fact_type, confidence, updated_at
     FROM facts WHERE active = 1 AND fact_type IN ('fact','reference')
     ORDER BY id`
  ).all() as Array<Pick<Fact, 'id' | 'subject' | 'predicate' | 'object' | 'fact_type' | 'confidence' | 'updated_at'>>;
}

function computeFingerprint(): string {
  const rows = activeAuditableRows();
  const blob = rows
    .map((r) => [r.id, r.subject, r.predicate, r.object, r.fact_type, r.confidence, r.updated_at].join('|'))
    .join('\n');
  return createHash('sha256').update(blob).digest('hex');
}

export function findAuditCandidateSubjects(minRows: number, maxSubjects: number): string[] {
  const rows = db.prepare(
    `SELECT subject, COUNT(*) AS c FROM facts
     WHERE active = 1 AND fact_type IN ('fact','reference')
     GROUP BY subject HAVING c >= ?
     ORDER BY c DESC LIMIT ?`
  ).all(minRows, maxSubjects) as Array<{ subject: string; c: number }>;
  return rows.map((r) => r.subject);
}

function subjectRows(subject: string): Fact[] {
  return db.prepare(
    `SELECT * FROM facts WHERE active = 1 AND fact_type IN ('fact','reference') AND subject = ? ORDER BY id`
  ).all(subject) as Fact[];
}

function buildPrompt(subject: string, rows: Fact[]): string {
  const list = rows
    .map((r) => `#${r.id} [${r.fact_type}] (${r.predicate}) conf=${r.confidence.toFixed(2)}: ${r.object}`)
    .join('\n');
  return `You are auditing a personal knowledge base. Below are all active knowledge rows about the subject "${subject}". Each row is (predicate) → object.

Propose consolidations:
- merge: groups of 2+ rows that state the SAME piece of knowledge in different words. Give one canonical predicate + object per group (concise, keeps every load-bearing detail from the sources).
- prune: rows that are redundant with a kept/canonical row, or obviously obsolete.
- Everything you don't list is kept untouched. When unsure, keep — merging distinct facts loses information; a conservative pass is a good pass.

Reply with ONLY this JSON shape (no prose):
{"merge":[{"ids":[1,2],"predicate":"...","canonical_object":"...","rationale":"..."}],"prune":[{"id":3,"reason":"..."}]}
If nothing should change, reply {"merge":[],"prune":[]}.

Rows:
${list}`;
}

interface RawProposal {
  merge?: Array<{ ids?: unknown; predicate?: unknown; canonical_object?: unknown; rationale?: unknown }>;
  prune?: Array<{ id?: unknown; reason?: unknown }>;
}

/** Validate one subject's LLM proposal against its actual rows. Invalid or unsafe
 *  pieces are dropped into `flagged` instead of being applied. */
function validateProposal(raw: RawProposal, rows: Fact[]): SubjectAudit {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const used = new Set<number>();
  const out: SubjectAudit = { subject: rows[0]?.subject ?? '', merges: [], prunes: [], flagged: [] };

  for (const m of raw.merge ?? []) {
    const ids = Array.isArray(m.ids) ? m.ids.filter((n): n is number => typeof n === 'number') : [];
    const predicate = typeof m.predicate === 'string' ? m.predicate.trim() : '';
    const object = typeof m.canonical_object === 'string' ? m.canonical_object.trim() : '';
    if (ids.length < 2 || !predicate || !object) {
      out.flagged.push(`merge dropped (malformed): ids=[${ids.join(',')}]`);
      continue;
    }
    if (ids.some((id) => !byId.has(id) || used.has(id))) {
      out.flagged.push(`merge dropped (unknown or reused id): ids=[${ids.join(',')}]`);
      continue;
    }
    const confs = ids.map((id) => byId.get(id)!.confidence);
    if (Math.max(...confs) - Math.min(...confs) > MAX_CONFIDENCE_SPREAD) {
      out.flagged.push(`merge flagged, not applied (confidence spread > ${MAX_CONFIDENCE_SPREAD}): ids=[${ids.join(',')}]`);
      continue;
    }
    ids.forEach((id) => used.add(id));
    out.merges.push({
      ids,
      predicate,
      canonical_object: object,
      rationale: typeof m.rationale === 'string' ? m.rationale : undefined,
    });
  }

  for (const p of raw.prune ?? []) {
    const id = typeof p.id === 'number' ? p.id : NaN;
    if (!byId.has(id) || used.has(id)) {
      out.flagged.push(`prune dropped (unknown or reused id): ${String(p.id)}`);
      continue;
    }
    used.add(id);
    out.prunes.push({ id, reason: typeof p.reason === 'string' ? p.reason : undefined });
  }

  return out;
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
  return 'audit_' + new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

/** Apply validated proposals in one transaction. Returns mutation count. */
function applyAudits(runId: string, audits: SubjectAudit[]): number {
  let mutated = 0;
  const tx = db.transaction(() => {
    for (const audit of audits) {
      for (const m of audit.merges) {
        const sources = m.ids
          .map((id) => db.prepare('SELECT * FROM facts WHERE id = ?').get(id) as Fact | undefined)
          .filter((f): f is Fact => f !== undefined && f.active === 1);
        if (sources.length !== m.ids.length) continue; // state moved under us — skip
        // Canonical row inherits the strongest confidence, any person link, and
        // stays a 'reference' only when every source was one.
        const factType = sources.every((s) => s.fact_type === 'reference') ? 'reference' : 'fact';
        const personId = sources.find((s) => s.person_id !== null)?.person_id ?? null;
        const canonicalId = saveFact({
          subject: audit.subject,
          predicate: m.predicate,
          object: m.canonical_object,
          fact_type: factType,
          source: 'memory-audit',
          confidence: Math.max(...sources.map((s) => s.confidence)),
          person_id: personId,
          mode: 'append',
        });
        // before={active:0} means revert deactivates the canonical row — the
        // "this row didn't exist before the merge" state.
        logHygieneAction({
          runId,
          action: 'merge_create',
          factId: canonicalId,
          before: { active: 0, completed_at: null, superseded_at: null },
          after: { active: 1, sources: m.ids },
          rationale: m.rationale || `canonical of #${m.ids.join(', #')}`,
        });
        mutated++;
        for (const src of sources) {
          const before = snapshot(src);
          setFactInactive(src.id);
          logHygieneAction({
            runId,
            action: 'merge',
            factId: src.id,
            before,
            after: { ...before, active: 0 },
            rationale: `merged into #${canonicalId} (${m.rationale || audit.subject})`,
          });
          mutated++;
        }
      }
      for (const p of audit.prunes) {
        const row = db.prepare('SELECT * FROM facts WHERE id = ?').get(p.id) as Fact | undefined;
        if (!row || row.active !== 1) continue;
        const before = snapshot(row);
        setFactInactive(row.id);
        logHygieneAction({
          runId,
          action: 'audit_prune',
          factId: row.id,
          before,
          after: { ...before, active: 0 },
          rationale: p.reason || 'redundant/obsolete per memory audit',
        });
        mutated++;
      }
    }
  });
  tx();
  return mutated;
}

/**
 * Run the semantic audit. Fingerprint-gated: with no fact writes since the last
 * run this returns without any LLM call. `dryRun` prints proposals and writes
 * nothing (no mutations, no fingerprint/stamp update). `force` bypasses the
 * fingerprint gate (not the enabled flag).
 */
export async function runMemoryAudit(opts: { dryRun?: boolean; force?: boolean; log?: Logger } = {}): Promise<AuditReport> {
  const { dryRun = false, force = false } = opts;
  const log = opts.log ?? ((m: string) => console.log(`[MemoryAudit] ${m}`));
  const runId = generateRunId();

  if (!AUDIT_ENABLED) {
    return { runId, skipped: 'disabled', applied: false, subjectsAudited: 0, results: [], mutated: 0 };
  }

  const fingerprint = computeFingerprint();
  if (!force && fingerprint === getMemory(FINGERPRINT_GROUP, FINGERPRINT_KEY)) {
    log('fingerprint unchanged — skipping LLM audit');
    if (!dryRun) setMemory('system', LAST_RUN_KEY, new Date().toISOString());
    return { runId, skipped: 'fingerprint', applied: false, subjectsAudited: 0, results: [], mutated: 0 };
  }

  const subjects = findAuditCandidateSubjects(MIN_ROWS, MAX_SUBJECTS);
  log(`${subjects.length} subject(s) with ≥${MIN_ROWS} auditable rows (cap ${MAX_SUBJECTS})`);

  const results: SubjectAudit[] = [];
  for (const subject of subjects) {
    const rows = subjectRows(subject);
    if (rows.length < MIN_ROWS) continue;
    try {
      const text = await extractionComplete({
        prompt: buildPrompt(subject, rows),
        maxTokens: 1500,
        openaiModel: AUDIT_MODEL,
        log,
        caller: 'memory-audit',
      });
      const json = extractFirstJson(text, '{', '}');
      if (!json) {
        log(`"${subject}": no JSON in model reply — skipping subject`);
        continue;
      }
      const audit = validateProposal(JSON.parse(json) as RawProposal, rows);
      if (audit.merges.length || audit.prunes.length || audit.flagged.length) results.push(audit);
    } catch (err) {
      log(`"${subject}": audit failed (${err instanceof Error ? err.message : err}) — skipping subject`);
    }
  }

  if (dryRun) {
    return { runId, skipped: null, applied: false, subjectsAudited: subjects.length, results, mutated: 0 };
  }

  const mutated = applyAudits(runId, results);
  // Store the post-apply state's fingerprint so the next run gates on it.
  setMemory(FINGERPRINT_GROUP, FINGERPRINT_KEY, computeFingerprint());
  setMemory('system', LAST_RUN_KEY, new Date().toISOString());
  return { runId, skipped: null, applied: true, subjectsAudited: subjects.length, results, mutated };
}

export function formatAuditReport(r: AuditReport): string {
  if (r.skipped === 'disabled') return 'Memory audit: disabled (MEMORY_AUDIT_ENABLED=false).';
  if (r.skipped === 'fingerprint') return 'Memory audit: no fact changes since last run — skipped (fingerprint gate).';
  const lines: string[] = [
    `Memory audit ${r.runId}${r.applied ? '' : ' (dry run)'} — ${r.subjectsAudited} subject(s), ${r.mutated} mutation(s).`,
  ];
  for (const s of r.results) {
    for (const m of s.merges) {
      lines.push(`• ${s.subject}: merge #${m.ids.join(', #')} → "(${m.predicate}) ${m.canonical_object}"`);
    }
    for (const p of s.prunes) lines.push(`• ${s.subject}: prune #${p.id}${p.reason ? ` (${p.reason})` : ''}`);
    for (const f of s.flagged) lines.push(`• ${s.subject}: ⚠ ${f}`);
  }
  if (r.results.length === 0) lines.push('Nothing to consolidate.');
  if (r.applied && r.mutated > 0) lines.push(`To undo: 'tsx scripts/hygiene-revert.ts ${r.runId}' (within 14 days).`);
  return lines.join('\n');
}
