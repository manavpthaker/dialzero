// Token -> micro-USD conversion for the LLM meter.
//
// HONESTY NOTE, and the reason this file is configurable rather than hardcoded:
// provider prices change, and a stale hardcoded table silently under-reports
// forever. Worse, a model this table does not recognize would otherwise cost
// $0.00, and a budget that believes it has spent nothing never refuses anything
// -- the meter would fail in the one direction that costs money.
//
// So: unknown models are priced at FALLBACK_*, which is set deliberately HIGH.
// An unpriced model therefore over-reports, which makes the budget refuse
// ambient work sooner rather than later, and `isPriced()` lets the doctor say
// out loud that a real rate is still missing. Fail toward silence, not toward
// spend.
//
// To calibrate: set LLM_PRICES_JSON, then reconcile a day of `llm_usage`
// against the provider console and adjust. Until that reconciliation happens,
// treat every cost number in this system as an estimate.

export interface ModelPrice {
  /** USD per 1M input tokens. */
  input: number;
  /** USD per 1M cached input tokens. Defaults to `input` when omitted. */
  cachedInput?: number;
  /** USD per 1M output tokens (reasoning tokens bill as output). */
  output: number;
}

// Intentionally high so an unrecognized model over-reports rather than reading
// as free. These are NOT real published rates for any specific model.
const FALLBACK: ModelPrice = { input: 15, output: 60 };

/**
 * Operator-supplied rates, e.g.
 *   LLM_PRICES_JSON={"gpt-5.6-terra":{"input":1.25,"cachedInput":0.125,"output":10}}
 * Prefix matching, longest first, so "gpt-5.6-terra-2026-01" picks up the
 * "gpt-5.6-terra" entry without needing its own row.
 */
// Anthropic's published per-million-token rates for the Claude models this repo
// defaults to (cache reads at 10% of input). LLM_PRICES_JSON entries override.
const CLAUDE_PRICES: Record<string, ModelPrice> = {
  'claude-opus-5': { input: 5, cachedInput: 0.5, output: 25 },
  'claude-sonnet-5': { input: 2, cachedInput: 0.2, output: 10 },
  'claude-haiku-4-5': { input: 1, cachedInput: 0.1, output: 5 },
};

function loadPrices(): Record<string, ModelPrice> {
  const raw = process.env.LLM_PRICES_JSON?.trim();
  if (!raw) return { ...CLAUDE_PRICES };
  try {
    const parsed = JSON.parse(raw) as Record<string, ModelPrice>;
    const out: Record<string, ModelPrice> = { ...CLAUDE_PRICES };
    for (const [model, price] of Object.entries(parsed)) {
      if (typeof price?.input === 'number' && typeof price?.output === 'number') {
        out[model.toLowerCase()] = price;
      }
    }
    return out;
  } catch {
    // A malformed price sheet must not take the bot down; it degrades to
    // FALLBACK, which the doctor reports as unpriced.
    console.warn('[llm-pricing] LLM_PRICES_JSON is not valid JSON — using fallback rates');
    return { ...CLAUDE_PRICES };
  }
}

let cache: Record<string, ModelPrice> | null = null;
function prices(): Record<string, ModelPrice> {
  if (cache === null) cache = loadPrices();
  return cache;
}

/** Test seam: re-read LLM_PRICES_JSON after mutating the environment. */
export function resetPriceCache(): void {
  cache = null;
}

function lookup(model: string): ModelPrice | null {
  const table = prices();
  const key = model.toLowerCase();
  if (table[key]) return table[key];
  const prefixes = Object.keys(table).filter((p) => key.startsWith(p));
  if (!prefixes.length) return null;
  prefixes.sort((a, b) => b.length - a.length);
  return table[prefixes[0]];
}

/** Whether this model has a real configured rate (false => FALLBACK estimate). */
export function isPriced(model: string): boolean {
  return lookup(model) !== null;
}

export interface TokenCounts {
  inputTokens: number;
  cachedInputTokens?: number;
  outputTokens: number;
}

/**
 * Micro-USD for one call. Cached input is billed at `cachedInput` and the
 * remainder at `input`, so a cache hit shows up as the saving it actually is.
 * Reasoning tokens are already inside `outputTokens` in the Responses API and
 * must NOT be added again.
 */
export function priceMicros(model: string, t: TokenCounts): number {
  const p = lookup(model) ?? FALLBACK;
  const cached = Math.max(0, t.cachedInputTokens ?? 0);
  const fresh = Math.max(0, t.inputTokens - cached);
  const cachedRate = p.cachedInput ?? p.input;
  const usd =
    (fresh / 1_000_000) * p.input +
    (cached / 1_000_000) * cachedRate +
    (Math.max(0, t.outputTokens) / 1_000_000) * p.output;
  return Math.round(usd * 1_000_000);
}

export function formatUsd(micros: number): string {
  return `$${(micros / 1_000_000).toFixed(4)}`;
}
