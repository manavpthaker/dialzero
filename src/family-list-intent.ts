import { getProfileConfig, getTimezone } from './config.js';

export interface FamilyListAddBinding {
  listName: string;
  itemText: string;
  quantity?: string;
  notes?: string;
  dueDate?: string;
  assignee?: string;
}

export type FamilyListAddBindingResult =
  | { ok: true; binding: FamilyListAddBinding }
  | { ok: false; reason: string };

const CROSS_SURFACE = /\b(?:calendar|event|appointment|instacart|cart|basket|checkout|spotify|music|song|track|album|artist|playlist)\b/;
const WEEKDAY_SOURCE = 'mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?';
const EVENT_TIME = new RegExp(`\\b(?:today|tomorrow|tonight|${WEEKDAY_SOURCE}|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}(?::\\d{2})?\\s*(?:am|pm))\\b`);
const CLOCK_TIME = /\b(?:noon|midday|midnight)\b|\b(?:between|from|at)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/;
const TASK_DEADLINE = /\b(?:by|due|before)\b/;
const PRIVATE_TASK_SURFACE = /\b(?:google|owner|personal|private|admin|home|work)\s+(?:tasks?|task list|to[ -]?do list)\b/;
const NEGATION = /\b(?:do not|don't|dont|never|not yet|no need to|hold off|not a request|not a directive|not asking you to|do not actually|don't actually)\b/;
// "when you get a chance" and "if you can" are politeness aimed at the
// assistant, not conditions on the request. Only a condition the assistant
// genuinely cannot resolve should withhold the action.
const POLITE_SOFTENER = /\b(?:if|when)\s+you\s+(?:can|could|would|get|have|see|next|remember|don'?t mind)\b|\b(?:let|tell|text|ping|remind)\s+(?:me|us)\s+(?:know\s+)?when\b|\bwhenever\s+you\b|\bonce\s+(?:a|per)\s+(?:day|week|month|year)\b/;
const CONDITIONAL = /\b(?:unless|provided(?: that)?|assuming(?: that)?|depending on|as soon as)\b|(?:^|[,;]\s*)\s*(?:if|when|once)\b|\b(?:if|when|once)\s+(?!you\b)/;
const TENTATIVE = /\b(?:should we|could we|would we|what if|maybe|might|considering|thinking about|just discussing|for example|example|hypothetical|hypothetically|pretend|suppose)\b/;
const REPORTED = /\b(?:said|says|wrote|texted|mentioned|quoted)\b/;
// Only nouns that actually mean "this is merely a proposal". The bare
// adjectives that used to live here turned "it is urgent" into "it is only an
// idea", which is the opposite of what the sender meant.
const CONTEXT_ONLY_CLAIM = /\b(?:is|was|would be|could be|might be|sounds|seems|looks)\s+(?:(?:just|only)\s+)?(?:(?:an?|one|the)\s+)?(?:idea|option|suggestion|possibility|example|plan|thought|worth discussing)\b/;
// A quoted directive is someone relaying an instruction; a quoted name is not.
const QUOTED_DIRECTIVE = /["\u201c][^"\u201d\n]{0,240}\b(?:add|book|buy|cancel|create|delete|get|make|order|pick up|put|remove|schedule|send|set)\b[^"\u201d\n]{0,240}["\u201d]/;
// "our grocery list" is how a couple refers to a shared list; only "the" used
// to resolve, so every possessive form fell through as an unknown list.
const DETERMINER = '(?:the|our|my|your|a)';
const NON_ACTION_NEED = /^(?:consider|discuss|decide|think about|figure out whether|see if)\b/;
const VAGUE_TARGET = /^(?:it|that|this|them|those|something|stuff)(?:\b|$)/;
const POSITIVE_FORGET_CAPTURE = /^(?:please\s+)?don'?t let (?:me|us) forget to\b/;

// This is intentionally broader than the original add/put gate. These are
// concise household imperatives, not a semantic list router: without an
// explicit list cue they all go to Family Tasks.
// Inflections matter: "Picking up milk" and "Grabbed the forms" are the same
// household imperative as "Pick up milk", and were refused on word form alone.
const TASK_VERB_BASE = '(?:add|apply|arrange|ask|book|bring|buy|call|cancel|change|check|choose|clean|collect|confirm|contact|coordinate|decide|email|enroll|file|find|finish|fix|gather|get|mail|make|order|organize|pack|pay|prepare|print|put|refill|register|renew|replace|request|research|respond|return|review|rsvp|schedule|send|sign|submit|take|text|update|upload|visit|wash)';
// Verbs that double their final consonant, which the generic suffix cannot form.
const TASK_VERB_DOUBLING = '(?:grab(?:s|bed|bing)?|plan(?:s|ned|ning)?|drop(?:s|ped|ping)?|wrap(?:s|ped|ping)?)';
const TASK_VERB_PHRASE = '(?:drop(?:s|ped|ping)?\\s+off|pick(?:s|ed|ing)?\\s+up|fill(?:s|ed|ing)?\\s+out|follow(?:s|ed|ing)?\\s+up|set(?:s|ting)?\\s+up|shop(?:s|ped|ping)?\\s+for|talk(?:s|ed|ing)?\\s+to)';
const TASK_VERB_SOURCE = `(?:${TASK_VERB_PHRASE}|${TASK_VERB_DOUBLING}|${TASK_VERB_BASE}(?:s|es|ed|d|ing)?)`;
const STANDALONE_TASK_VERB = new RegExp(`^${TASK_VERB_SOURCE}\\b`);
const SECOND_ACTION = new RegExp(`(?:\\band(?:\\s+then)?\\s+|\\bthen\\s+|,\\s*|[.!?]\\s+|\\s+(?:&|\\+|/)\\s+|\\s+-\\s+)(?:please\\s+)?(?:also\\s+)?${TASK_VERB_SOURCE}\\b`);

/** Split a natural multi-action message into independently bindable clauses.
 * The model may call the list tool once per clause, but each call still has to
 * reproduce the exact clause text. Alternatives remain fail-closed. */
function actionClauses(message: string): string[] {
  const actionBoundary = new RegExp(
    `(?:\\s*[;\\n]+\\s*|[.!?]+\\s+|\\s+and(?:\\s+then)?\\s+(?=(?:please\\s+)?(?:also\\s+)?${TASK_VERB_SOURCE}\\b)|\\s+then\\s+(?=(?:please\\s+)?(?:also\\s+)?${TASK_VERB_SOURCE}\\b))`,
    'i',
  );
  return message
    .split(actionBoundary)
    .map((clause) => clause.replace(/^(?:please\\s+)?also\\s+/i, '').trim())
    .filter(Boolean);
}

function normalizedIdentity(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : '';
}

function normalizedText(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, ' ').trim().replace(/[.!?]+$/g, '').trim()
    : '';
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const trimmed = String(value).trim();
  return trimmed || undefined;
}

function escapeWords(value: string): string {
  return value.split(/\s+/)
    .map((token) => token.replace(/[.*+?^$\{\}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
}

function normalizeMessage(message: string): string {
  let text = message.toLowerCase().replace(/[’]/g, "'").trim();
  const profile = getProfileConfig();
  const aliases = [profile.triggerWord.replace(/^@+/, ''), profile.botName]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map(escapeWords);
  if (aliases.length > 0) {
    text = text.replace(
      new RegExp(`^\\s*@?(?:${aliases.join('|')})(?:\\s*[:,;\\-]\\s*|\\s+|$)`, 'i'),
      '',
    ).trim();
  }
  return text.replace(/[.!]+$/g, '').trim();
}

function listAliases(name: string): string[] {
  const normalized = normalizedIdentity(name);
  const aliases = new Set<string>([normalized]);
  if (normalized && !normalized.endsWith(' list')) aliases.add(`${normalized} list`);
  if (normalized === 'groceries') {
    aliases.add('grocery list');
    aliases.add('shopping list');
  } else if (normalized === 'errands') {
    aliases.add('errands list');
    aliases.add('errand list');
  } else if (normalized === 'family tasks') {
    aliases.add('family task');
    aliases.add('family task list');
    aliases.add('family tasks list');
    aliases.add('task list');
    aliases.add('to do list');
  }
  return [...aliases].filter(Boolean);
}

function canonicalLiveList(requested: unknown, liveListNames: string[]): string | undefined {
  const normalized = normalizedIdentity(requested);
  if (!normalized) return undefined;
  return liveListNames.find((name) => normalizedIdentity(name) === normalized);
}

interface ListAliasCandidate {
  name: string;
  alias: string;
  ambiguous: boolean;
}

function listAliasCandidates(liveListNames: string[]): ListAliasCandidate[] {
  const owners = new Map<string, Set<string>>();
  for (const name of liveListNames) {
    for (const alias of listAliases(name)) {
      const names = owners.get(alias) || new Set<string>();
      names.add(name);
      owners.set(alias, names);
    }
  }
  return [...owners.entries()]
    .flatMap(([alias, names]) => [...names].map((name) => ({
      name,
      alias,
      ambiguous: names.size > 1,
    })))
    .sort((a, b) => b.alias.length - a.alias.length);
}

interface ParsedTarget {
  target: string;
  explicitList?: string;
  explicitTaskCue?: boolean;
}

function stripExplicitListTarget(target: string, liveListNames: string[]): ParsedTarget | null {
  const candidates = listAliasCandidates(liveListNames);
  for (const candidate of candidates) {
    const escaped = escapeWords(candidate.alias);
    const suffix = new RegExp(`\\s+(?:to|on|in)\\s+(?:${DETERMINER}\\s+)?${escaped}\\s*$`, 'i');
    const match = target.match(suffix);
    if (match) {
      if (candidate.ambiguous) return null;
      const stripped = target.slice(0, match.index).trim();
      return stripped ? { target: stripped, explicitList: candidate.name } : null;
    }
  }

  const genericList = target.match(new RegExp(`\\s+(?:to|on|in)\\s+(?:${DETERMINER}\\s+)?list\\s*$`, 'i'));
  if (genericList) {
    const stripped = target.slice(0, genericList.index).trim();
    return stripped ? { target: stripped } : null;
  }

  // A suffix that looks like a named list but does not resolve to one must not
  // silently become part of a default Family Task.
  if (new RegExp(`\\s+(?:to|on|in)\\s+(?:${DETERMINER}\\s+)?[a-z0-9][a-z0-9 -]{0,60}\\s+list\\s*$`, 'i').test(target)) {
    return null;
  }
  return { target: target.trim() };
}

function parseListShorthand(message: string, liveListNames: string[]): ParsedTarget | null {
  const candidates = listAliasCandidates(liveListNames);
  for (const candidate of candidates) {
    const match = message.match(new RegExp(`^${escapeWords(candidate.alias)}\\s*:\\s*(.+)$`, 'i'));
    if (match?.[1]?.trim()) {
      return candidate.ambiguous
        ? null
        : { target: match[1].trim(), explicitList: candidate.name };
    }
  }
  return null;
}

function explicitlyMentionedLists(message: string, liveListNames: string[]): Set<string> {
  const normalized = normalizedIdentity(message);
  const matches = new Set<string>();
  for (const candidate of listAliasCandidates(liveListNames)) {
    const escaped = escapeWords(candidate.alias);
    // The alias has to sit where a list goes — after to/on/in/from, or as a
    // "Groceries:" header. Matching it anywhere meant "Pick up groceries"
    // read as naming a list, and the whole request was refused for naming a
    // list without a list cue. There, "groceries" is the thing being bought.
    const routing = new RegExp(`(?:^|\\s)(?:to|on|in|from)\\s+(?:${DETERMINER}\\s+)?${escaped}(?=\\s|$)`);
    const header = new RegExp(`^${escaped}(?=\\s|$)`);
    if (routing.test(normalized) || header.test(normalizedIdentity(message.split(':')[0] || ''))) {
      matches.add(candidate.name);
    }
  }
  return matches;
}

function stripActionPrefix(message: string, verbs: string): string | null {
  for (const pattern of [
    new RegExp(`^(?:please\\s+)?(?:${verbs})\\b\\s*`, 'i'),
    new RegExp(`^(?:can|could|will|would) you\\s+(?:please\\s+)?(?:${verbs})\\b\\s*`, 'i'),
    new RegExp(`^i (?:want|need) you to\\s+(?:${verbs})\\b\\s*`, 'i'),
  ]) {
    const match = message.match(pattern);
    if (match) return message.slice(match[0].length).trim();
  }
  return null;
}

function extractNaturalTarget(message: string): ParsedTarget | null {
  for (const pattern of [
    /^(?:task|to[ -]?do)\s*:\s*(.+)$/i,
    /^(?:please\s+)?remember to\s+(.+)$/i,
    /^(?:please\s+)?remind (?:me|us) to\s+(.+)$/i,
    /^(?:please\s+)?don'?t let (?:me|us) forget to\s+(.+)$/i,
    /^(?:(?:we|i)\s+)?(?:need|have) to\s+(.+)$/i,
    /^(?:we|i)\s+need\s+(.+)$/i,
  ]) {
    const match = message.match(pattern);
    if (match?.[1]?.trim() && !NON_ACTION_NEED.test(match[1].trim())) {
      return {
        target: match[1].trim(),
        explicitTaskCue: !/^(?:we|i)\s+need\s+/i.test(message),
      };
    }
  }

  const explicitAdd = stripActionPrefix(message, 'add|put');
  if (explicitAdd !== null) return { target: explicitAdd };

  // A concise household imperative is itself an input. A descriptive sentence
  // still does not pass merely because the model proposed a matching tool row.
  if (STANDALONE_TASK_VERB.test(message)) return { target: message };
  const polite = message.match(/^(?:please\s+)(.+)$/i)
    || message.match(/^(?:can|could|will|would) you\s+(?:please\s+)?(.+)$/i)
    || message.match(/^i (?:want|need) you to\s+(.+)$/i)
    || message.match(/^let'?s\s+(.+)$/i);
  if (polite?.[1]?.trim() && STANDALONE_TASK_VERB.test(polite[1].trim())) {
    return { target: polite[1].trim() };
  }
  return null;
}

interface StructuredEvidence {
  message: string;
  quantity?: string;
  notes?: string;
  due?: string;
  assignee?: string;
  error?: string;
}

function extractStructuredEvidence(message: string, allowNaturalDue: boolean): StructuredEvidence {
  let base = message;
  const details: Omit<StructuredEvidence, 'message' | 'error'> = {};
  while (true) {
    const match = base.match(/\s*(?:,|\s+-\s+)\s*(quantity|qty|notes?|due|assign(?:ed)?\s+to)\s*:?\s*([^,]+)\s*$/i);
    if (!match) break;
    const rawKind = match[1].toLowerCase();
    const kind: keyof typeof details = rawKind === 'quantity' || rawKind === 'qty'
      ? 'quantity'
      : rawKind.startsWith('note')
        ? 'notes'
        : rawKind === 'due'
          ? 'due'
          : 'assignee';
    if (details[kind] !== undefined) {
      return { message, error: `more than one ${kind} was supplied` };
    }
    details[kind] = match[2].trim();
    base = base.slice(0, match.index).trim();
  }
  if (allowNaturalDue && details.due === undefined) {
    const dueMatch = base.match(/\s+by\s+(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4}-\d{2}-\d{2})\s*$/i);
    if (dueMatch) {
      details.due = dueMatch[1].trim();
      base = base.slice(0, dueMatch.index).trim();
    }
  }
  return { message: base, ...details };
}

function fieldMatchesEvidence(requested: unknown, evidence: string | undefined): boolean {
  const value = optionalString(requested);
  if (!value && !evidence) return true;
  return Boolean(value && evidence && normalizedText(value) === normalizedText(evidence));
}

function dueMatchesEvidence(requested: unknown, evidence: string | undefined): boolean {
  const value = optionalString(requested);
  if (!value && !evidence) return true;
  if (!value || !evidence) return false;
  if (normalizedText(value) === normalizedText(evidence)) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;

  const todayParts = new Intl.DateTimeFormat('en-US', {
    timeZone: getTimezone(),
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(todayParts.find((candidate) => candidate.type === type)?.value);
  const base = new Date(Date.UTC(part('year'), part('month') - 1, part('day'), 12));
  const normalizedEvidence = normalizedText(evidence);
  if (normalizedEvidence === 'tomorrow') base.setUTCDate(base.getUTCDate() + 1);
  else if (normalizedEvidence !== 'today') {
    const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const target = weekdays.indexOf(normalizedEvidence);
    if (target < 0) return false;
    base.setUTCDate(base.getUTCDate() + ((target - base.getUTCDay() + 7) % 7));
  }
  return value === base.toISOString().slice(0, 10);
}

// A comma, "and", "&", or "+" between two non-empty items is an enumeration
// boundary. Kept deliberately small: anything more permissive starts inventing
// boundaries inside a single item.
const ITEM_BOUNDARY = /(\s*[\n;]+\s*(?:and\s+)?|\s*,\s*(?:and\s+|&\s*|\+\s*)?|\s+and\s+|\s*&\s*|\s*\+\s*)/i;
const MAX_ENUMERATED_ITEMS = 12;

/** Every contiguous run of enumerated items in `target`, normalized.
 *
 * "milk, eggs and bread" yields the whole string plus milk / eggs / bread /
 * "milk, eggs" / "eggs and bread". Runs (rather than single items) are what let
 * an item that legitimately contains a boundary word — "mac and cheese" — still
 * bind when it sits beside other items. Every span is a literal contiguous
 * substring of the current message, so this widens which rows bind without
 * letting the model author text the sender never sent. */
function enumeratedSpans(target: string): Set<string> {
  const spans = new Set<string>();
  const whole = normalizedText(target);
  if (whole) spans.add(whole);

  // split() with one capture group alternates segment, separator, segment, …
  const parts = target.split(new RegExp(ITEM_BOUNDARY, 'gi'));
  if (parts.length < 3) return spans;

  const segmentCount = (parts.length + 1) / 2;
  if (segmentCount > MAX_ENUMERATED_ITEMS) return spans;
  for (let i = 0; i < parts.length; i += 2) {
    // A ragged split ("milk and", ", eggs") is not an enumeration.
    if (!parts[i]?.trim()) return spans;
  }

  for (let i = 0; i < segmentCount; i += 1) {
    for (let j = i; j < segmentCount; j += 1) {
      const span = normalizedText(parts.slice(2 * i, 2 * j + 1).join(''));
      if (span) spans.add(span);
    }
  }
  return spans;
}

/**
 * Bind one natural Family-list request to the exact proposed tool row.
 *
 * An explicitly named live list wins, and explicit task/reminder phrasing still
 * pins to Family Tasks. Otherwise the model routes to any live list it likes.
 * Text and optional structured fields must all be evidenced by the current
 * inbound message — that evidence, not the list choice, is the real guardrail.
 */
function bindSingleFamilyListAddRequest(input: {
  message: string;
  requestedList: unknown;
  requestedText: unknown;
  requestedQuantity?: unknown;
  requestedNotes?: unknown;
  requestedDueDate?: unknown;
  requestedAssignee?: unknown;
  liveListNames: string[];
}): FamilyListAddBindingResult {
  let normalizedMessage = normalizeMessage(input.message);
  if (!normalizedMessage) return { ok: false, reason: 'empty message' };
  if (/\bor\b/.test(normalizedMessage)) {
    return { ok: false, reason: 'multiple or alternative directives are not accepted' };
  }
  if (normalizedMessage.endsWith('?') && !/^(?:can|could|will|would) you\b/.test(normalizedMessage)) {
    return { ok: false, reason: 'a question is not a list-add directive' };
  }
  normalizedMessage = normalizedMessage.replace(/\?+$/g, '').trim();
  // A message opening with a household imperative is the sender asking in their
  // own voice. It may still mention where an item came from ("the vitamins
  // Sam texted about") or how urgent it is without becoming hearsay.
  const directRequest = /\b(?:please|can you|could you|will you|would you)\b/.test(normalizedMessage)
    || STANDALONE_TASK_VERB.test(normalizedMessage);
  if (
    (!POSITIVE_FORGET_CAPTURE.test(normalizedMessage) && NEGATION.test(normalizedMessage))
    || (CONDITIONAL.test(normalizedMessage) && !POLITE_SOFTENER.test(normalizedMessage))
    || (TENTATIVE.test(normalizedMessage) && !directRequest)
    || (REPORTED.test(normalizedMessage) && !directRequest)
    || CONTEXT_ONLY_CLAIM.test(normalizedMessage)
    || QUOTED_DIRECTIVE.test(normalizedMessage)
  ) {
    return { ok: false, reason: 'tentative, conditional, negated, quoted, or reported wording' };
  }
  // "add sunscreen when you get a chance" — the softener is addressed to the
  // assistant, so it must not end up inside the item text either.
  normalizedMessage = normalizedMessage
    .replace(/[,;\s]*\b(?:if|when)\s+you\s+(?:can|could|would|get|have|see|next|remember|don'?t mind)\b.*$/i, '')
    .replace(/[,;\s]*\bwhenever\s+you\b.*$/i, '')
    .replace(/[,;\s]*\b(?:let|tell|text|ping|remind)\s+(?:me|us)\s+(?:know\s+)?when\b.*$/i, '')
    .trim() || normalizedMessage;
  if (PRIVATE_TASK_SURFACE.test(normalizedMessage)) {
    return { ok: false, reason: 'the message targets a private task surface' };
  }

  const structured = extractStructuredEvidence(
    normalizedMessage,
    optionalString(input.requestedDueDate) !== undefined,
  );
  if (structured.error) return { ok: false, reason: structured.error };
  if (!fieldMatchesEvidence(input.requestedQuantity, structured.quantity)) {
    return { ok: false, reason: 'quantity is not bound to the current message' };
  }
  if (!fieldMatchesEvidence(input.requestedNotes, structured.notes)) {
    return { ok: false, reason: 'notes are not bound to the current message' };
  }
  if (!dueMatchesEvidence(input.requestedDueDate, structured.due)) {
    return { ok: false, reason: 'due date is not bound to the current message' };
  }
  if (!fieldMatchesEvidence(input.requestedAssignee, structured.assignee)) {
    return { ok: false, reason: 'assignee is not bound to the current message' };
  }

  const requestedList = canonicalLiveList(input.requestedList, input.liveListNames);
  if (!requestedList) return { ok: false, reason: 'the proposed list is not live' };

  const reservedTaskCue = /^(?:task|to[ -]?do)\s*:/i.test(structured.message);
  const listMentionSource = reservedTaskCue
    ? structured.message.replace(/^(?:task|to[ -]?do)\s*:\s*/i, '')
    : structured.message;
  const mentionedLists = explicitlyMentionedLists(listMentionSource, input.liveListNames);
  if (mentionedLists.size > 1) {
    return { ok: false, reason: 'more than one Family list is named' };
  }

  let parsed = reservedTaskCue ? extractNaturalTarget(structured.message) : null;
  if (!parsed) parsed = parseListShorthand(structured.message, input.liveListNames);
  if (!parsed) {
    const natural = extractNaturalTarget(structured.message);
    if (!natural) return { ok: false, reason: 'no explicit natural list input' };
    const stripped = stripExplicitListTarget(natural.target, input.liveListNames);
    if (!stripped) return { ok: false, reason: 'the named list is unknown, ambiguous, or empty' };
    parsed = { ...stripped, explicitTaskCue: natural.explicitTaskCue };
  }

  if (mentionedLists.size === 1 && !parsed.explicitList) {
    return { ok: false, reason: 'a Family list was named without one unambiguous list cue' };
  }
  if (parsed.explicitList && SECOND_ACTION.test(parsed.target)) {
    return { ok: false, reason: 'one explicit list cannot bind a multi-action directive' };
  }

  const hasExplicitLocalTarget = Boolean(parsed.explicitList || parsed.explicitTaskCue);
  if (!hasExplicitLocalTarget && CROSS_SURFACE.test(structured.message)) {
    return { ok: false, reason: 'the message targets another surface' };
  }
  const calendarAction = /^(?:arrange|book|plan|schedule|set up)\b/.test(parsed.target);
  const calendarShaped = (calendarAction && EVENT_TIME.test(structured.message))
    || CLOCK_TIME.test(structured.message);
  if (!hasExplicitLocalTarget && calendarShaped && !TASK_DEADLINE.test(structured.message)) {
    return { ok: false, reason: 'the message is calendar-shaped rather than a Family Task' };
  }

  const defaultList = canonicalLiveList('Family Tasks', input.liveListNames);
  // Explicit list/task syntax stays deterministic. Everything else defers to
  // the list the model picked, which canonicalLiveList already proved is a live
  // Family list. Routing by a hardcoded grocery vocabulary made the gate refuse
  // any household word it had not been taught ("bananas", "pumpkin spice"),
  // and a misfiled item costs one tap while a refusal costs the whole request.
  const explicitTaskRouting = reservedTaskCue
    || /^(?:please\s+)?(?:remember to|remind (?:me|us) to|don'?t let (?:me|us) forget to)\b/i.test(structured.message);
  const expectedList = parsed.explicitList
    || (explicitTaskRouting ? defaultList : requestedList)
    || defaultList;
  if (!expectedList || normalizedIdentity(expectedList) !== normalizedIdentity(requestedList)) {
    return { ok: false, reason: 'the proposed list conflicts with the current message' };
  }

  const expectedText = normalizedText(parsed.target);
  const requestedText = normalizedText(input.requestedText);
  // One message routinely carries several items ("milk, eggs and bread"). Each
  // proposed row still has to reproduce a contiguous span of the message, so
  // the model cannot invent an item, but it no longer has to swallow the whole
  // enumeration as a single nonsense row.
  if (
    !expectedText
    || VAGUE_TARGET.test(normalizedIdentity(expectedText))
    || VAGUE_TARGET.test(normalizedIdentity(requestedText))
    || !enumeratedSpans(parsed.target).has(requestedText)
  ) {
    return { ok: false, reason: 'the proposed item text does not exactly match the current message' };
  }

  return {
    ok: true,
    binding: {
      listName: expectedList,
      itemText: optionalString(input.requestedText)!,
      quantity: optionalString(input.requestedQuantity),
      notes: optionalString(input.requestedNotes),
      dueDate: optionalString(input.requestedDueDate),
      assignee: optionalString(input.requestedAssignee),
    },
  };
}

/** Fold a "header:" + one-item-per-line message into one ordinary sentence.
 *
 * "Add to groceries:\nmilk\neggs" becomes "Add milk, eggs to groceries", which
 * the normal enumeration path already binds item by item. Returns null unless
 * the message really has that shape, so nothing else changes behavior. */
function headerListMessage(message: string): string | null {
  const lines = message.split('\n').map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim());
  const header = lines[0];
  if (!header || !header.endsWith(':')) return null;
  const stem = header.slice(0, -1).trim();
  if (!stem) return null;
  const items = lines.slice(1).filter(Boolean);
  if (items.length === 0) return null;
  if (items.some((item) => item.includes(':'))) return null;

  // "add to groceries" / "groceries" -> verb + items + " to groceries".
  const routed = stem.match(new RegExp(`^(?:please\\s+)?(?:add|put)?\\s*(?:to|on|in)\\s+(?:${DETERMINER}\\s+)?(.+)$`, 'i'));
  if (routed?.[1]) return `add ${items.join(', ')} to ${routed[1].trim()}`;
  if (/^(?:please\s+)?(?:add|put)$/i.test(stem)) return `add ${items.join(', ')}`;
  // A bare "Groceries:" header.
  if (!/\s/.test(stem) || /^[a-z0-9 ]+$/i.test(stem)) return `add ${items.join(', ')} to ${stem}`;
  return null;
}

export function bindFamilyListAddRequest(input: {
  message: string;
  requestedList: unknown;
  requestedText: unknown;
  requestedQuantity?: unknown;
  requestedNotes?: unknown;
  requestedDueDate?: unknown;
  requestedAssignee?: unknown;
  liveListNames: string[];
}): FamilyListAddBindingResult {
  const direct = bindSingleFamilyListAddRequest(input);
  if (direct.ok || /\bor\b/i.test(input.message)) return direct;

  // A shopping list is often typed as a header plus one item per line:
  //   Add to groceries:
  //   milk
  //   eggs
  // Each line on its own carries no verb and no list, so nothing bound and
  // every item was refused. Rewrite it into the header's own sentence and let
  // the ordinary enumeration path handle it.
  const headered = headerListMessage(input.message);
  if (headered) {
    const bound = bindSingleFamilyListAddRequest({ ...input, message: headered });
    if (bound.ok) return bound;
  }

  const clauses = actionClauses(input.message);
  if (clauses.length <= 1) return direct;
  const matches = clauses
    .map((message) => bindSingleFamilyListAddRequest({ ...input, message }))
    .filter((result): result is { ok: true; binding: FamilyListAddBinding } => result.ok);
  if (matches.length !== 1) {
    return { ok: false, reason: 'the proposed item does not bind to exactly one message clause' };
  }
  return matches[0];
}
