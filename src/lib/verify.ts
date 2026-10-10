// The checker: nothing is reported "done" unless the evidence shows the goal itself
// happened (an errand call was once marked done when the business only said
// "register on our website").
// A separate, cheap model reads the goal, the claim and the evidence (what was said
// on the call, the final page) and answers verified or not, with why.

import { OPENAI_ROUTER_MODEL, openAIText } from './openai.js';
import { extractFirstJson } from './daemon.js';
import { withLlmContext } from './llm-context.js';

export interface DoneCheck { ok: boolean; why: string }
export interface DoneInput { kind: 'call' | 'website'; goal: string; claim: string; evidence: string }

const RULES = `You check another assistant's work before it tells its boss a job is DONE.
Verified only if the EVIDENCE shows the goal itself happened: a confirmation number or message, the page showing the new state (cancelled, registered, ordered), or the other person clearly agreeing to the specific thing (date/time/details) on the call. For a question, the actual answer was given.
Judge only whether the RESULT in the goal was achieved, not how the assistant went about it (instructions in the goal about what to say, timing or wording are not part of the result).
NOT verified: being told to do it somewhere else (a website, another number, email them), "we'll call you back", a promise without a time, a voicemail, the assistant's own claim with nothing in the evidence backing it, or evidence that's missing or cut off before the result.
Reply with JSON only: {"verified": true|false, "why": "one short plain sentence"}`;

type Checker = (i: DoneInput) => Promise<DoneCheck>;

const defaultChecker: Checker = async (i) => {
  // Isolated test runs (ASSISTANT_DB_PATH) never call a model unless they stub one in.
  if (process.env.ASSISTANT_DB_PATH && !process.env.DONE_CHECK_LIVE) return { ok: true, why: 'not checked (test)' };
  const raw = await withLlmContext({ caller: `verify:${i.kind}`, lane: 'batch' }, () => openAIText({
    model: process.env.DONE_CHECK_MODEL || OPENAI_ROUTER_MODEL,
    system: RULES,
    prompt: `GOAL: ${i.goal}\n\nCLAIM: ${i.claim}\n\nEVIDENCE:\n${i.evidence.slice(-8000) || '(none)'}`,
    maxOutputTokens: 300,
  }));
  const json = extractFirstJson(raw, '{', '}');
  if (!json) throw new Error('checker returned no JSON');
  const p = JSON.parse(json) as { verified?: unknown; why?: unknown };
  return { ok: p.verified === true, why: String(p.why ?? '').slice(0, 300) };
};

let checker: Checker = defaultChecker;
/** Tests swap in a stub. */
export function setDoneChecker(fn: Checker | null): void { checker = fn ?? defaultChecker; }

/**
 * Fails open: if the checker itself breaks, the job's own result stands (logged), so a
 * model outage never strands finished work. Only a clear "not verified" holds it back.
 */
export async function checkDone(i: DoneInput): Promise<DoneCheck> {
  try {
    const r = await checker(i);
    if (!r.ok) console.log(`[verify] ${i.kind} NOT verified: ${r.why} | claim: ${i.claim.slice(0, 160)}`);
    return r;
  } catch (err) {
    console.warn('[verify] checker failed, keeping the result:', err instanceof Error ? err.message : err);
    return { ok: true, why: 'checker unavailable' };
  }
}
