// LLM spend guardrail. Deliberately mirrors lib/spend-cap.ts in shape (a small
// pure check the caller consults before doing something expensive) while being a
// completely separate budget: spend-cap.ts governs REAL-WORLD money in whole
// cents against the `actions` ledger. This governs model spend in micro-USD
// against `llm_usage`. Both use startOfTodayET/startOfWeekET so the two budgets
// roll over on the same boundary.
//
// The whole point is `lane` (see lib/llm-context.ts). A single global cap would
// have to choose between being loose enough that a runaway ambient loop is
// affordable, or tight enough that it eventually refuses a reply a human is
// waiting on. Neither is acceptable, so the lane decides:
//
//   interactive -> NEVER refused. The reply is the product.
//   batch       -> refused only when the whole day's budget is gone.
//   ambient     -> refused at its own, smaller sub-cap, first to be cut.

import { parseBoolEnv, parseNumEnv } from './env.js';
import type { LlmLane } from './llm-context.js';
import { formatUsd } from './llm-pricing.js';

// The db import is lazy for the same reason it is in lib/llm-usage.ts: this
// module is consulted from lib/openai.ts, which scripts/onboard.ts imports
// without a database. db.ts CREATES assistant.db at module load, so a static
// import here would make `npm run onboard` conjure an empty database. That also
// makes the public API async, which is fine — every caller is already async.
type DbModule = typeof import('../db.js');
let dbModule: DbModule | null = null;
async function loadDb(): Promise<DbModule | null> {
  if (dbModule) return dbModule;
  try {
    dbModule = await import('../db.js');
    return dbModule;
  } catch {
    return null; // no database in this process — nothing metered, nothing to cap
  }
}

const USD = 1_000_000;

function dailyCap(): number { return Math.round(parseNumEnv('LLM_DAILY_CAP_USD', 8) * USD); }
function weeklyCap(): number { return Math.round(parseNumEnv('LLM_WEEKLY_CAP_USD', 40) * USD); }
function ambientCap(): number { return Math.round(parseNumEnv('LLM_AMBIENT_DAILY_CAP_USD', 4) * USD); }
/** Tighter ambient ceiling while the local model is down and everything is
 *  falling back to a paid provider nobody budgeted for. */
function fallbackCap(): number { return Math.round(parseNumEnv('LLM_FALLBACK_DAILY_CAP_USD', 1) * USD); }

/** false = log-only. Ships true; flip to observe before enforcing on a new box. */
function enforced(): boolean { return parseBoolEnv('LLM_BUDGET_ENFORCED', true); }

export type TokenBudgetCheck =
  | { ok: true; lane: LlmLane; daily_remaining_micros: number; lane_remaining_micros: number }
  | {
    ok: false;
    lane: LlmLane;
    reason: 'daily' | 'weekly' | 'ambient' | 'fallback';
    cap_micros: number;
    used_micros: number;
    message: string;
  };

/** Thrown when a refusable call is over budget. Carries the check for the caller. */
export class LlmBudgetError extends Error {
  readonly check: Extract<TokenBudgetCheck, { ok: false }>;
  constructor(check: Extract<TokenBudgetCheck, { ok: false }>) {
    super(check.message);
    this.name = 'LlmBudgetError';
    this.check = check;
  }
}

export function isLlmBudgetError(err: unknown): err is LlmBudgetError {
  return err instanceof LlmBudgetError;
}

/**
 * Turn a mid-loop budget stop into user-visible text only when a human actually
 * initiated the run. Cron jobs and pulses interpret any non-empty response as
 * content worth sending, so exposing the control-plane error there creates a
 * notification storm after the cap has already done its job.
 */
export function budgetStopResponse(
  systemAuthored: boolean,
  partialResponse: string,
  message: string,
): string {
  if (systemAuthored) return '';
  return partialResponse
    ? `${partialResponse}\n\n(Stopped early — ${message})`
    : `I had to stop before finishing. ${message}`;
}

/**
 * Is this lane allowed to spend right now?
 *
 * `localDown` tightens the ambient ceiling: when the local model is unavailable,
 * extraction work that was supposed to be free is quietly billing a paid
 * provider. That is exactly the runaway this budget exists to stop, so it gets a
 * much smaller allowance rather than the normal ambient one.
 */
export async function checkTokenBudget(lane: LlmLane, opts: { localDown?: boolean } = {}): Promise<TokenBudgetCheck> {
  // The reply a human is waiting on is never refused. Checked first and
  // unconditionally, before any database work, so no future edit can make it
  // conditional and no DB hiccup can turn it into a refusal.
  if (lane === 'interactive') {
    return { ok: true, lane, daily_remaining_micros: Infinity, lane_remaining_micros: Infinity };
  }

  const db = await loadDb();
  // No database means no meter, so there is nothing to enforce against. Failing
  // open here is correct: the alternative is refusing work in a process that
  // provably has not spent anything.
  if (!db) return { ok: true, lane, daily_remaining_micros: Infinity, lane_remaining_micros: Infinity };

  const { getDailyLlmSpendMicros, getWeeklyLlmSpendMicros } = db;
  const dailyUsed = getDailyLlmSpendMicros();
  const weeklyUsed = getWeeklyLlmSpendMicros();
  const dailyRemaining = dailyCap() - dailyUsed;
  const weeklyRemaining = weeklyCap() - weeklyUsed;

  if (dailyRemaining <= 0) {
    return {
      ok: false, lane, reason: 'daily', cap_micros: dailyCap(), used_micros: dailyUsed,
      message: `Daily LLM budget spent: ${formatUsd(dailyUsed)} of ${formatUsd(dailyCap())}. `
        + `${lane} work is paused until tomorrow. Raise LLM_DAILY_CAP_USD to change that.`,
    };
  }
  if (weeklyRemaining <= 0) {
    return {
      ok: false, lane, reason: 'weekly', cap_micros: weeklyCap(), used_micros: weeklyUsed,
      message: `Weekly LLM budget spent: ${formatUsd(weeklyUsed)} of ${formatUsd(weeklyCap())}. `
        + `${lane} work is paused until next week. Raise LLM_WEEKLY_CAP_USD to change that.`,
    };
  }

  // Scheduled work with a human audience (the morning brief, the nightly
  // reflection) survives on the global budget alone -- a runaway ambient loop
  // must not be able to eat the brief, which is why ambient has its own sub-cap
  // below and batch does not.
  if (lane === 'batch') {
    return { ok: true, lane, daily_remaining_micros: dailyRemaining, lane_remaining_micros: dailyRemaining };
  }

  const ambientUsed = db.getDailyLlmSpendMicros('ambient');
  const cap = opts.localDown ? fallbackCap() : ambientCap();
  const remaining = cap - ambientUsed;
  if (remaining <= 0) {
    return {
      ok: false,
      lane,
      reason: opts.localDown ? 'fallback' : 'ambient',
      cap_micros: cap,
      used_micros: ambientUsed,
      message: opts.localDown
        ? `Local model is down, so background work is billing a paid provider. `
          + `That fallback budget is spent (${formatUsd(ambientUsed)} of ${formatUsd(cap)}). `
          + `Background work is paused until the local model is back or LLM_FALLBACK_DAILY_CAP_USD is raised.`
        : `Background LLM budget spent: ${formatUsd(ambientUsed)} of ${formatUsd(cap)} today. `
          + `Background work is paused; replies and scheduled briefs are unaffected. `
          + `Raise LLM_AMBIENT_DAILY_CAP_USD to change that.`,
    };
  }
  return { ok: true, lane, daily_remaining_micros: dailyRemaining, lane_remaining_micros: remaining };
}

/**
 * Throwing form for the unskippable gate inside the HTTP boundary.
 *
 * With LLM_BUDGET_ENFORCED=false the breach is recorded and logged but the call
 * proceeds -- the observe mode you want on a box whose prices have not been
 * reconciled yet, since an over-estimating meter would otherwise pause real work.
 */
export async function assertWithinBudget(lane: LlmLane, opts: { localDown?: boolean } = {}): Promise<void> {
  const check = await checkTokenBudget(lane, opts);
  if (check.ok) return;
  markBudgetBreach(check);
  if (!enforced()) {
    console.warn(`[token-budget] (observe mode, not enforcing) ${check.message}`);
    return;
  }
  throw new LlmBudgetError(check);
}

/**
 * Record that a cap was hit, for the doctor.
 *
 * Deliberately does NOT message anyone: this module is imported by the HTTP
 * boundary that the notifier itself uses, so calling out from here would be
 * circular. The 09:00 health ping is the right carrier for "the bot stopped
 * doing background work because it ran out of budget".
 */
function markBudgetBreach(check: Extract<TokenBudgetCheck, { ok: false }>): void {
  void (async () => {
    try {
      const { setMemory } = await import('../db.js');
      setMemory('system', 'llm_budget_breached_at', JSON.stringify({
        at: new Date().toISOString(),
        lane: check.lane,
        reason: check.reason,
        used_micros: check.used_micros,
        cap_micros: check.cap_micros,
      }));
    } catch { /* a breach stamp must never break the call path */ }
  })();
}

/** Exposed for the dashboard gauges and the doctor. */
export function tokenBudgetCaps(): {
  dailyCapMicros: number; weeklyCapMicros: number; ambientCapMicros: number;
  fallbackCapMicros: number; enforced: boolean;
} {
  return {
    dailyCapMicros: dailyCap(),
    weeklyCapMicros: weeklyCap(),
    ambientCapMicros: ambientCap(),
    fallbackCapMicros: fallbackCap(),
    enforced: enforced(),
  };
}
