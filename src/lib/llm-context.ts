import { AsyncLocalStorage } from 'async_hooks';

// Ambient attribution for LLM calls.
//
// The meter (lib/llm-usage.ts) lives at the HTTP boundary in lib/openai.ts, which
// knows the model and the token counts but has no idea *who* asked. Threading a
// `caller` argument through every call site would miss the calls that matter
// most: the ones a tool handler makes from inside runAgent's turn loop, several
// frames below anything that could pass an argument. AsyncLocalStorage covers
// those for free -- wrap once at the entry point, and every model call the entry
// point transitively causes is attributed.
//
// CAVEAT, and the reason the wrappers go where they do: ALS context does not
// cross a setInterval/setTimeout scheduled OUTSIDE the run(). Wrapping a
// `setInterval` registration attributes nothing; the wrapper must go INSIDE the
// tick callback. Same for cron: wrap the body, not cron.schedule().

/**
 * Why the call is being made, which decides whether it can be refused.
 *
 * - `interactive` — a human is waiting on this reply. NEVER refusable: failing
 *   it because a background loop exhausted the budget makes the bot look broken
 *   and surfaces a raw provider error in the chat.
 * - `batch` — scheduled work with a human audience (the morning brief, the
 *   nightly reflection). Refusable only at the global daily cap.
 * - `ambient` — a loop nobody asked for. First to be cut, and the only lane the
 *   ambient sub-cap applies to.
 */
export type LlmLane = 'interactive' | 'batch' | 'ambient';

export interface LlmCallContext {
  /** Stable module identity: 'agent:admin', 'pulse:brain', 'daemon:imessage', 'router'. */
  caller: string;
  lane: LlmLane;
  groupKey?: string;
}

const store = new AsyncLocalStorage<LlmCallContext>();

/** Run `fn` with this attribution attached to every LLM call it transitively makes. */
export function withLlmContext<T>(ctx: LlmCallContext, fn: () => T): T {
  return store.run(ctx, fn);
}

/**
 * Attribution for the call in flight.
 *
 * Unattributed calls default to `ambient`, i.e. the REFUSABLE lane. This is
 * deliberate: a new code path that forgets to declare itself should be visible
 * in the meter as 'unknown' and should be subject to the budget, not exempt from
 * it. Failing open here would make the cap trivially bypassable by omission.
 */
export function currentLlmContext(): LlmCallContext {
  return store.getStore() ?? { caller: 'unknown', lane: 'ambient' };
}
