// Retrieval planner — the Chief-of-Staff's memory reflex.
//
// Replaces the capitalized-token + raw-FTS heuristic in context-resolver with a
// reasoning pass: a fast model reads the user's latest message PLUS the recent
// conversation and decides what to pull from the brain — resolving pronouns and
// vague references ("did he get back to me" -> Jordan; "the food startup role"
// -> CookUnity) and expanding vocabulary ("worried about money" -> runway/burn).
// It does NOT fetch anything itself; it emits resolved, expanded search terms
// that context-resolver runs against the existing brain accessors.
//
// Same reliability contract as router.ts: hard latency cap, and ANY failure
// (kill-switch off, missing key, timeout, unparseable output) returns null so
// the caller falls back to the original heuristic. Never throws.

import { parseStrEnv, parseNumEnv, parseBoolEnv } from './lib/env.js';
import { OPENAI_ROUTER_MODEL, openAIText, llmConfigured } from './lib/openai.js';

export interface RetrievalPlan {
  people: string[];       // resolved person names/entities to look up
  factQueries: string[];  // expanded short phrases to search the fact store
  messageQuery?: string;  // set only when the user refers to a past thread
}

const ENABLED = parseBoolEnv('ASSISTANT_SMART_RETRIEVAL', true);
// Reuse the router model by default; override independently if desired.
const MODEL = parseStrEnv('OPENAI_RETRIEVAL_MODEL', OPENAI_ROUTER_MODEL);
const TIMEOUT_MS = parseNumEnv('ASSISTANT_RETRIEVAL_TIMEOUT_MS', 2000);

const SYSTEM =
  "You are the retrieval planner for a personal AI chief-of-staff. Given the user's latest " +
  "message and the recent conversation, decide what to pull from the assistant's memory (a " +
  "store of facts, people, and past messages) so it can answer well.\n" +
  "Resolve pronouns and vague references using the conversation: 'he'/'she'/'that role'/'the " +
  "startup guy' become the actual name or topic. Expand vocabulary with synonyms and specifics " +
  "(a worry about 'money' -> 'runway', 'burn rate', 'cash').\n" +
  "Output ONLY a JSON object, no prose, no markdown fence:\n" +
  '{"people": [..names..], "factQueries": [..short phrases..], "messageQuery": "..optional.."}\n' +
  "- people: proper names of people to look up, resolved from context. [] if none.\n" +
  "- factQueries: 1-4 short search phrases, expanded. [] if the message needs no memory " +
  "(smalltalk, or a fresh command with no referent).\n" +
  "- messageQuery: include ONLY if the user refers to a past conversation/thread ('did he " +
  "reply', 'what did she say'); otherwise omit the key.\n" +
  'Return {"people":[],"factQueries":[]} when no retrieval is needed.';

function parsePlan(raw: string): RetrievalPlan | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const o = JSON.parse(match[0]) as Record<string, unknown>;
    const strArr = (v: unknown): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0) : [];
    const people = strArr(o.people).slice(0, 6);
    const factQueries = strArr(o.factQueries).slice(0, 4);
    const mq = typeof o.messageQuery === 'string' ? o.messageQuery.trim() : '';
    const messageQuery = mq ? mq.slice(0, 80) : undefined;
    return { people, factQueries, messageQuery };
  } catch {
    return null;
  }
}

/**
 * Plan what to retrieve for `message` given recent `thread`. Returns null on any
 * failure or when smart retrieval is disabled — the caller then uses the
 * heuristic. Never throws.
 */
export async function planRetrieval(
  message: string,
  thread: { role: string; content: string }[],
): Promise<RetrievalPlan | null> {
  if (!ENABLED) return null;
  if (!llmConfigured()) return null;
  const trimmed = message.trim();
  if (!trimmed) return null;

  const ctx = thread
    .slice(-6)
    .map((m) => `${m.role}: ${m.content.replace(/\s+/g, ' ').slice(0, 300)}`)
    .join('\n');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const raw = await openAIText({
      model: MODEL,
      maxOutputTokens: 256,
      system: SYSTEM,
      prompt: `Recent conversation:\n${ctx || '(none)'}\n\nLatest message:\n${trimmed.slice(0, 800)}`,
      reasoningEffort: 'none',
      signal: controller.signal,
    });
    return parsePlan(raw);
  } catch (err) {
    console.log(
      `[retrieval-planner] failed, falling back to heuristic: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}
