import { getDefaultRecipient } from '../channels/imessage.js';
import { sendInterrupt } from '../cos-outbound.js';
import { runAgent } from '../agent.js';
import { isQuietHours, todayET } from './time-et.js';
import { getSystemUser } from './system-user.js';
import { withLlmContext } from './llm-context.js';
import type { GroupConfig } from '../group-resolver.js';

// Shared harness for the proactive pulses (brain-pulse, idea-pulse,
// content-flywheel). Each previously reimplemented the same shape with subtle
// drift: enabled gate → quiet-hours bail → gather rows → bail-if-empty →
// resolve recipient → build prompt → runAgent → send unless a clear-sentinel →
// post-send/always hooks. This centralizes that flow; callers supply only the
// parts that differ.

export interface PulseSpec<G> {
  /** Log prefix, e.g. 'BrainPulse'. */
  name: string;
  /** Per-run enable flag (already parsed). Omit for always-on pulses. */
  enabled?: boolean;
  /** Synthetic group the agent runs as. */
  group: GroupConfig;
  /**
   * Gather context for this run. Return `null` to skip silently (e.g. nothing
   * to surface). The returned value is threaded into the later callbacks.
   */
  gather: () => G | null;
  /** Build the agent prompt from the gathered context. */
  buildPrompt: (ctx: G) => string;
  /** If the agent's response contains this token, suppress the DM. */
  clearSentinel: string;
  /** Runs only after a DM was actually sent (e.g. dedup bookkeeping). */
  onSent?: (ctx: G, response: string) => void;
  /**
   * Runs after the agent attempt regardless of send/error (but only when
   * `gather` returned non-null and a recipient existed) — e.g. mark-surfaced.
   */
  afterAll?: (ctx: G) => void;
}

export async function runProactivePulse<G>(spec: PulseSpec<G>): Promise<void> {
  const { name, enabled = true, group, gather, buildPrompt, clearSentinel, onSent, afterAll } = spec;

  if (!enabled) return;
  if (isQuietHours()) return;

  const ctx = gather();
  if (ctx === null || ctx === undefined) return;

  const target = getDefaultRecipient();
  if (!target) {
    console.log(`[${name}] No DM recipient configured; skipping.`);
    return;
  }

  try {
    // Attribute every model call this pulse makes (the agent turn loop and any
    // tool-invoked call beneath it) to the ambient lane, so the meter can show
    // what the proactive layer costs and the budget can refuse it first.
    const response = await withLlmContext(
      { caller: `pulse:${name}`, lane: 'ambient', groupKey: group.key },
      () => runAgent(group, getSystemUser(), buildPrompt(ctx)),
    );
    if (response && !response.includes(clearSentinel)) {
      const decision = await sendInterrupt({
        source: `pulse:${name}`,
        // One subject per pulse per day. A pulse is a digest of whatever was
        // due, so re-running it the same day is the same claim on attention
        // even when the wording differs.
        subject: `pulse:${name}:${todayET()}`,
        kind: 'nudge',
        text: response,
        target,
      });
      // MUST be conditional. onSent is where a pulse consumes state it cannot
      // get back -- relationship-pulse marks people nudged, which burns their
      // cadence. Running it for a message the arbiter held would silently spend
      // someone's contact window on a DM that was never delivered.
      // Held for the next check-in counts as delivered: the check-in carries
      // it. Without this the same items would re-queue every day.
      const headedToCheckin = !decision.sent && decision.decision === 'deferred' && decision.reason === 'checkin-only';
      if (decision.sent || headedToCheckin) onSent?.(ctx, response);
    }
  } catch (err) {
    console.error(`[${name}] runAgent failed:`, err);
  } finally {
    afterAll?.(ctx);
  }
}
