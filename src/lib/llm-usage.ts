import { currentLlmContext } from './llm-context.js';
import { priceMicros, isPriced } from './llm-pricing.js';
import type { LlmUsageRow } from '../db.js';

// The meter's write path. Sits at the HTTP boundary (lib/openai.ts,
// lib/local-llm.ts) so every model call in the process is counted exactly once.
//
// WHY THE DB IMPORT IS LAZY -- this is load-bearing, not style:
// src/db.ts opens (and CREATES) assistant.db at module load. lib/openai.ts is
// imported by scripts/onboard.ts, which deliberately does NOT import db, because
// onboarding runs before there is a database and must not conjure one as a side
// effect of being loaded. A static `import { ... } from '../db.js'` here would
// put db.ts into openai.ts's module graph and make `npm run onboard` create an
// empty assistant.db on startup. The dynamic import defers that to the first
// actual model call, which by definition only happens in a configured process.
// The `import type` above is erased at compile time and is safe.

type DbModule = typeof import('../db.js');
let dbModule: DbModule | null = null;
let loading: Promise<DbModule> | null = null;

export interface UsageRecord {
  provider: 'openai' | 'anthropic' | 'local';
  model: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  latencyMs?: number;
  ok?: boolean;
  errorKind?: string | null;
  attempt?: number;
  /** Override the ambient attribution (rarely needed). */
  caller?: string;
}

function toRow(u: UsageRecord): LlmUsageRow {
  const ctx = currentLlmContext();
  const inputTokens = u.inputTokens ?? 0;
  const outputTokens = u.outputTokens ?? 0;
  return {
    caller: u.caller ?? ctx.caller,
    lane: ctx.lane,
    provider: u.provider,
    model: u.model,
    group_id: ctx.groupKey ?? null,
    input_tokens: inputTokens,
    cached_input_tokens: u.cachedInputTokens ?? 0,
    output_tokens: outputTokens,
    reasoning_tokens: u.reasoningTokens ?? 0,
    // Local inference is free at the margin, so it is metered for volume and
    // latency but never priced. Only OpenAI calls move the budget.
    cost_micros: u.provider === 'local'
      ? 0
      : priceMicros(u.model, {
        inputTokens,
        cachedInputTokens: u.cachedInputTokens,
        outputTokens,
      }),
    latency_ms: u.latencyMs ?? null,
    ok: u.ok !== false,
    error_kind: u.errorKind ?? null,
    attempt: u.attempt ?? 1,
  };
}

/**
 * Record one model call. Never throws and never rejects: telemetry must not be
 * able to break the call it is measuring. After the first call the db module is
 * resolved and the write is effectively synchronous.
 */
export function recordLlmUsage(u: UsageRecord): void {
  let row: LlmUsageRow;
  try {
    row = toRow(u);
  } catch {
    return; // pricing/attribution blew up; drop the row rather than the call
  }

  if (dbModule) {
    try { dbModule.recordLlmUsageRow(row); } catch { /* never break the caller */ }
    return;
  }

  void (async () => {
    try {
      loading ??= import('../db.js');
      dbModule = await loading;
      dbModule.recordLlmUsageRow(row);
    } catch {
      /* no database in this process (e.g. onboarding) — nothing to meter */
    }
  })();
}

/** True when every OpenAI model seen today has a configured rate. */
export function modelsArePriced(models: string[]): { unpriced: string[] } {
  return { unpriced: models.filter((m) => !isPriced(m)) };
}
