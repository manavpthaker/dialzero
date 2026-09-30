// Tier 2 Phase 1 — Actions layer guardrails: kill switch + spend caps.
//
// Mirrors the deny-by-shape posture of path-utils / web#assertSafeUrl: a small
// pure check that the tool layer calls before doing anything irreversible. Both
// propose_action AND confirm_action call these — budget consumed between propose
// and confirm by *other* actions must re-fail the confirm.

import { getDailyActionSpendCents, getWeeklyActionSpendCents } from '../db.js';
import { parseBoolEnv, parseNumEnv } from './env.js';

const DAILY_CAP_CENTS = Math.round(parseNumEnv('ACTIONS_DAILY_CAP_USD', 100) * 100);
const WEEKLY_CAP_CENTS = Math.round(parseNumEnv('ACTIONS_WEEKLY_CAP_USD', 400) * 100);

// Default ON — matches the legacy-friendly posture elsewhere (browser bridge is
// default-open). Set ACTIONS_ENABLED=false to hard-disable the whole layer.
export function checkActionsEnabled(): { ok: boolean; reason?: string } {
  if (parseBoolEnv('ACTIONS_ENABLED', true)) return { ok: true };
  return { ok: false, reason: 'Actions are globally disabled (ACTIONS_ENABLED=false). No action can be proposed or executed.' };
}

export type SpendCheck =
  | { ok: true; daily_remaining_cents: number; weekly_remaining_cents: number }
  | { ok: false; reason: 'daily' | 'weekly'; cap_cents: number; used_cents: number; message: string };

function fmtUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// $0 / unpriced actions skip the cap but still propose+confirm. A positive
// estimate is checked against BOTH the daily and weekly remaining budget.
export function checkSpendCap(estimatedCents: number | null | undefined): SpendCheck {
  const est = estimatedCents ?? 0;
  const dailyUsed = getDailyActionSpendCents();
  const weeklyUsed = getWeeklyActionSpendCents();
  const dailyRemaining = DAILY_CAP_CENTS - dailyUsed;
  const weeklyRemaining = WEEKLY_CAP_CENTS - weeklyUsed;

  if (est > dailyRemaining) {
    return {
      ok: false,
      reason: 'daily',
      cap_cents: DAILY_CAP_CENTS,
      used_cents: dailyUsed,
      message: `Daily action spend cap exceeded: this action (${fmtUsd(est)}) would push today's total past the ${fmtUsd(DAILY_CAP_CENTS)} cap (already spent ${fmtUsd(dailyUsed)}, ${fmtUsd(Math.max(0, dailyRemaining))} left). Raise ACTIONS_DAILY_CAP_USD or wait until tomorrow.`,
    };
  }
  if (est > weeklyRemaining) {
    return {
      ok: false,
      reason: 'weekly',
      cap_cents: WEEKLY_CAP_CENTS,
      used_cents: weeklyUsed,
      message: `Weekly action spend cap exceeded: this action (${fmtUsd(est)}) would push this week's total past the ${fmtUsd(WEEKLY_CAP_CENTS)} cap (already spent ${fmtUsd(weeklyUsed)}, ${fmtUsd(Math.max(0, weeklyRemaining))} left). Raise ACTIONS_WEEKLY_CAP_USD or wait until next week.`,
    };
  }
  return { ok: true, daily_remaining_cents: dailyRemaining, weekly_remaining_cents: weeklyRemaining };
}

// Exposed for the dashboard gauges.
export function spendCaps(): { dailyCapCents: number; weeklyCapCents: number } {
  return { dailyCapCents: DAILY_CAP_CENTS, weeklyCapCents: WEEKLY_CAP_CENTS };
}
