// The first thing a business hears from the assistant. A stranger's name, "AI
// assistant" and "on a recorded line" up front, then a 20-word question, sound like a
// robocall, and people hung up on the opener itself. Now the opener is written before
// the call: who it is in six words ("Hi, this is Sam, Alex Rivera's assistant."), then
// a plain question of ten words or so. It says it's an AI whenever asked; the details
// come once they say yes.

import { OPENAI_ROUTER_MODEL, openAIText } from './openai.js';
import { withLlmContext } from './llm-context.js';
import { normalizePhone } from './phone.js';

/**
 * Area codes where one party to a call may record it (New Jersey, New York, DC): no
 * recording notice is needed there. Anywhere else the assistant keeps "on a recorded line" when
 * calls are recorded, since states like CA, FL, PA, IL and WA need everyone's consent.
 * Unknown means notice.
 */
const ONE_PARTY_AREA_CODES = new Set([
  // New Jersey
  '201', '551', '609', '640', '732', '848', '856', '862', '908', '973',
  // New York
  '212', '315', '332', '347', '363', '516', '518', '585', '607', '631', '646', '680', '716', '718', '838', '845', '914', '917', '929', '934',
  // Washington, DC
  '202', '771',
]);

/** Must the opener say the call is recorded? Only when it is, and the number isn't in a one-party state. */
export function needsRecordingNotice(to: string, recorded: boolean): boolean {
  if (!recorded) return false;
  const ten = normalizePhone(to);
  return !(ten.length === 10 && ONE_PARTY_AREA_CODES.has(ten.slice(0, 3)));
}

export interface OpenerOptions {
  /** Say "AI assistant" in the opener (PHONE_OPENER_AI=true). Off by default: it says so whenever asked. */
  ai?: boolean;
  /** Add "on a recorded line" (see needsRecordingNotice). */
  notice?: boolean;
}

/** Who the assistant is, as said in the opener: "Hi, this is Sam, Alex Rivera's assistant." */
export function whoLine(bot: string, full: string, o: OpenerOptions = {}): string {
  return `Hi, this is ${bot}, ${full}'s ${o.ai ? 'AI ' : ''}assistant${o.notice ? ', on a recorded line' : ''}.`;
}

/** The whole opener: who, then the short question. */
export function openerLine(bot: string, full: string, ask: string, o: OpenerOptions = {}): string {
  return `${whoLine(bot, full, o)} ${ask}`;
}

const MAX_ASK_WORDS = 12;

/** A usable first question: one short spoken question with no intro of its own. Null otherwise. */
export function cleanAsk(raw: string): string | null {
  let t = (raw ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  t = t.replace(/^(question|ask|answer)\s*:\s*/i, '').replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, '').trim();
  if (!t.endsWith('?')) return null;
  // One question, not two.
  if ((t.match(/\?/g) ?? []).length > 1) return null;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 3 || words.length > MAX_ASK_WORDS) return null;
  if (/\b(this is|assistant|i'?m calling|calling (for|on behalf)|on behalf of)\b/i.test(t)) return null;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

const ASK_RULES = `You write the first question a polite caller asks a business, right after saying "Hi, this is <assistant>, <name>'s assistant."
Rules:
- ONE short spoken question, 4 to 10 words, ending with "?".
- The plain ask only, in everyday words. Leave out sizes, measurements, colors, model numbers, addresses, names and extra conditions: those come later, once they say yes.
- No greeting, no introduction, never "I'm calling" or "on behalf of".
Examples:
GOAL: Ask whether they have a ready-to-pick-up painted wood arched slatted garden gate about 39 in wide by 46 in tall → Do you have wooden garden gates ready for pickup?
GOAL: Find the earliest date and time they can come out for an on-site inspection for a roof or chimney leak, and whether they give a written estimate → How soon could you come look at a roof leak?
GOAL: Book a table for 4 tomorrow at 7pm for a birthday, vegetarian → Could I book a table for four tomorrow at 7?
GOAL: Ask what time the store closes today → What time do you close today?
GOAL: Ask the current wait time for a family of three walking in → How long is the wait right now for three?
GOAL: Register the family for the Halloween event → Could you help me sign up for the Halloween event?
Reply with the question only.`;

type AskWriter = (goal: string) => Promise<string | null>;

const defaultWriter: AskWriter = async (goal) => {
  // Isolated test runs never call a model unless they stub one in.
  if (process.env.ASSISTANT_DB_PATH && !process.env.CALL_OPENER_LIVE) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), Number(process.env.CALL_OPENER_TIMEOUT_MS || 6000));
  try {
    return await withLlmContext({ caller: 'call-opener', lane: 'batch' }, () => openAIText({
      model: process.env.CALL_OPENER_MODEL || OPENAI_ROUTER_MODEL,
      system: ASK_RULES,
      prompt: `GOAL: ${goal.replace(/\s+/g, ' ').slice(0, 800)} →`,
      maxOutputTokens: 120,
      signal: ctl.signal,
    }));
  } finally {
    clearTimeout(timer);
  }
};

let writer: AskWriter = defaultWriter;
/** Tests swap in a stub. */
export function setAskWriter(fn: AskWriter | null): void { writer = fn ?? defaultWriter; }

/** The first question for this goal, or null (no model, too slow, or unusable): the prompt rule takes over. */
export async function writeOpenerAsk(goal: string): Promise<string | null> {
  try {
    return cleanAsk((await writer(goal)) ?? '');
  } catch (err) {
    console.warn('[phone] opener question not written:', err instanceof Error ? err.message.slice(0, 120) : err);
    return null;
  }
}
