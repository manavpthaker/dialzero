import { createHash } from 'node:crypto';
import type { MessageRow } from './db.js';
import {
  FAMILY_CORRECTION_TTL_MS,
  isFamilyAffirmation,
  isNaturalDirectRequest,
  isUnsafeFamilyActionContext,
} from './family-natural-intent.js';
import type { ToolContext, ToolDef } from './tools/index.js';

/**
 * A Family turn is interpreted by the same model that handles the conversation,
 * but a write is not authorized by an open-ended tool call. The model first
 * commits one source-bound manifest. The runtime then grants exactly one call
 * for each exact (tool name, canonical arguments) pair in that manifest.
 *
 * This deliberately separates semantic interpretation from the security
 * boundary. Natural language may evolve without adding another verb regex;
 * callable tools, authenticated chat/user context, source quotes, argument
 * equality, and destructive confirmation remain deterministic.
 */

export const FAMILY_TURN_MANIFEST_TOOL = 'family_set_turn_manifest';
export const FAMILY_TURN_SOURCE_TTL_MS = 30 * 60 * 1000;
const MAX_MANIFEST_ACTIONS = 16;
const MAX_BINDINGS_PER_ACTION = 12;
const MAX_ARGUMENT_DEPTH = 12;
const MAX_ARGUMENT_COLLECTION = 100;
const MAX_CANONICAL_ARGUMENT_BYTES = 64 * 1024;

export type FamilyTurnClassification =
  | 'conversation'
  | 'context'
  | 'question'
  | 'action'
  | 'mixed'
  | 'ambiguous';

export type FamilyManifestActionKind =
  | 'new_action'
  | 'continuation'
  | 'correction'
  | 'destructive_request'
  | 'destructive_confirmation'
  | 'context_write';

export type FamilyToolPolicy =
  | 'internal'
  | 'family-read'
  | 'low-risk-write'
  | 'delete-request'
  | 'delete-confirm';

/** Default-deny classification of every tool callable by the Family group. */
export const FAMILY_TOOL_POLICIES: Readonly<Record<string, FamilyToolPolicy>> = Object.freeze({
  family_list_events: 'family-read',
  family_create_event: 'low-risk-write',
  family_update_event: 'low-risk-write',
  family_request_event_delete: 'delete-request',
  family_confirm_event_delete: 'delete-confirm',
  list_family_lists: 'family-read',
  create_family_list: 'low-risk-write',
  list_family_items: 'family-read',
  add_family_item: 'low-risk-write',
  edit_family_item: 'low-risk-write',
  complete_family_item: 'low-risk-write',
  reopen_family_item: 'low-risk-write',
  archive_family_item: 'low-risk-write',
  restore_family_item: 'low-risk-write',
  remember_family_context: 'internal',
  note_family_coordination: 'internal',
  resolve_family_coordination: 'internal',
  list_family_coordination: 'family-read',
  recall_family_context: 'family-read',
  list_family_context: 'family-read',
  web_search: 'family-read',
  fetch_url: 'family-read',
  research: 'family-read',
  ask_owner: 'low-risk-write',
  mcp_instacart_create_recipe: 'low-risk-write',
  mcp_instacart_create_shopping_list: 'low-risk-write',
  mcp_spotify_search: 'family-read',
  mcp_spotify_play: 'low-risk-write',
});

export interface FamilyTurnSource {
  ref: string;
  role: string;
  senderId: string;
  content: string;
  createdAt: string;
  current: boolean;
}

export interface FamilyManifestSourceBinding {
  sourceRef: string;
  /** Exact, non-empty substring copied from the referenced raw message. */
  quote: string;
  /** Trusted runtime metadata copied from the source ledger, never the model. */
  sourceRole: string;
  senderId: string;
  createdAt: string;
  current: boolean;
}

export interface FamilyManifestAction {
  intentId: string;
  toolName: string;
  kind: FamilyManifestActionKind;
  /** Exact arguments the later tool call must use. */
  arguments: Record<string, unknown>;
  /** Hash is diagnostic; equality is always checked against canonicalArgs. */
  argumentsHash: string;
  sourceBindings: readonly FamilyManifestSourceBinding[];
  canonicalArgs: string;
}

export interface FamilyTurnManifest {
  version: 1;
  turnId: string;
  chatId: string;
  requesterId: string;
  createdAtMs: number;
  classification: FamilyTurnClassification;
  actions: readonly FamilyManifestAction[];
}

/**
 * Opaque grant passed to a Family mutation handler after the central gate has
 * matched an unconsumed manifest action. A WeakSet brand means a handler cannot
 * be reached safely by fabricating a lookalike ToolContext in another caller.
 */
export interface FamilyManifestActionAuthorization {
  readonly manifest: FamilyTurnManifest;
  readonly action: FamilyManifestAction;
}

const trustedManifests = new WeakSet<object>();
const trustedAuthorizations = new WeakSet<object>();
const authorizationState = new WeakMap<object, 'claimed' | 'committed' | 'released'>();
const trustedSendInDoubtErrors = new WeakSet<object>();

export interface AuthorizedFamilyManifestEvidence {
  kind: FamilyManifestActionKind;
  intentId: string;
  sourceBindings: readonly FamilyManifestSourceBinding[];
}

/**
 * Create a branded error only after a provider mutation has been dispatched.
 * The agent consumes that manifest grant instead of blindly retrying a call
 * whose remote outcome is unknown.
 */
export function familyActionSendInDoubt(message: string): Error {
  const error = new Error(message);
  error.name = 'FamilyActionSendInDoubtError';
  trustedSendInDoubtErrors.add(error);
  return error;
}

export function isFamilyActionSendInDoubt(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && trustedSendInDoubtErrors.has(error));
}

export interface FamilyManifestDraftInput {
  classification: FamilyTurnClassification;
  actions: Array<{
    intent_id: string;
    tool_name: string;
    kind: FamilyManifestActionKind;
    arguments: Record<string, unknown>;
    source_bindings: Array<{
      source_ref: string;
      quote: string;
    }>;
  }>;
}

export interface FamilyManifestActionClaim {
  intentId: string;
  authorization: FamilyManifestActionAuthorization;
}

export type FamilyManifestClaimFailure = {
  error: string;
  reason: 'manifest_required' | 'manifest_action_mismatch' | 'manifest_action_consumed';
};

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_ARGUMENT_DEPTH) {
    throw new Error(`Family manifest arguments exceed depth ${MAX_ARGUMENT_DEPTH}.`);
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Family manifest arguments must contain finite numbers.');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > MAX_ARGUMENT_COLLECTION) {
      throw new Error('Family manifest argument arrays are too large.');
    }
    return Object.freeze(value.map((entry) => canonicalValue(entry, depth + 1)));
  }
  if (!isPlainRecord(value)) {
    throw new Error('Family manifest arguments must be ordinary JSON values.');
  }
  const keys = Object.keys(value).sort();
  if (keys.length > MAX_ARGUMENT_COLLECTION) {
    throw new Error('Family manifest argument objects contain too many fields.');
  }
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error(`Family manifest argument key "${key}" is not allowed.`);
    }
    if (value[key] === undefined) {
      throw new Error('Family manifest arguments cannot contain undefined values.');
    }
    out[key] = canonicalValue(value[key], depth + 1);
  }
  return Object.freeze(out);
}

export function canonicalFamilyToolArguments(input: Record<string, unknown>): string {
  if (!isPlainRecord(input)) throw new Error('Family tool arguments must be an object.');
  const canonical = JSON.stringify(canonicalValue(input));
  if (Buffer.byteLength(canonical, 'utf8') > MAX_CANONICAL_ARGUMENT_BYTES) {
    throw new Error('Family manifest arguments are too large.');
  }
  return canonical;
}

function hashCanonicalArgs(canonicalArgs: string): string {
  return createHash('sha256').update(canonicalArgs).digest('hex');
}

function parseSqliteTimestamp(value: string): number {
  const raw = value.trim();
  if (!raw) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`);
}

/** Build the only source ledger from which a turn manifest may quote. */
export function buildFamilyTurnSources(input: {
  currentMessage: string;
  currentSenderId: string;
  recentMessages: ReadonlyArray<MessageRow>;
  currentCreatedAt?: string;
  /** Transcript of a photo attached to the current message (role "photo"). */
  currentPhoto?: string;
  nowMs?: number;
}): FamilyTurnSource[] {
  const nowMs = input.nowMs ?? Date.now();
  const historical = input.recentMessages
    .filter((message) => {
      const at = parseSqliteTimestamp(message.created_at);
      return Number.isFinite(at)
        && at >= nowMs - FAMILY_TURN_SOURCE_TTL_MS
        && at <= nowMs + 60_000;
    })
    .map((message): FamilyTurnSource => ({
      ref: `message:${message.id}`,
      role: message.role,
      senderId: message.sender,
      content: message.content,
      createdAt: message.created_at,
      current: false,
    }));

  return [
    ...historical,
    {
      ref: 'current',
      role: 'user',
      senderId: input.currentSenderId,
      content: input.currentMessage,
      createdAt: input.currentCreatedAt && Number.isFinite(Date.parse(input.currentCreatedAt))
        ? new Date(input.currentCreatedAt).toISOString()
        : new Date(nowMs).toISOString(),
      current: true,
    },
    // A photo's text can supply an event's or item's details, but it is never
    // anyone's request: only role "user" text authorizes (see hasCurrentBinding).
    ...(input.currentPhoto ? [{
      ref: 'current_photo',
      role: 'photo',
      senderId: input.currentSenderId,
      content: input.currentPhoto,
      createdAt: input.currentCreatedAt && Number.isFinite(Date.parse(input.currentCreatedAt))
        ? new Date(input.currentCreatedAt).toISOString()
        : new Date(nowMs).toISOString(),
      current: true,
    }] : []),
  ];
}

function parseClassification(value: unknown): FamilyTurnClassification {
  const allowed = new Set<FamilyTurnClassification>([
    'conversation', 'context', 'question', 'action', 'mixed', 'ambiguous',
  ]);
  if (typeof value !== 'string' || !allowed.has(value as FamilyTurnClassification)) {
    throw new Error('Family manifest classification is invalid.');
  }
  return value as FamilyTurnClassification;
}

function parseActionKind(value: unknown): FamilyManifestActionKind {
  const allowed = new Set<FamilyManifestActionKind>([
    'new_action', 'continuation', 'correction', 'destructive_request',
    'destructive_confirmation', 'context_write',
  ]);
  if (typeof value !== 'string' || !allowed.has(value as FamilyManifestActionKind)) {
    throw new Error('Family manifest action kind is invalid.');
  }
  return value as FamilyManifestActionKind;
}

function assertActionPolicy(toolName: string, kind: FamilyManifestActionKind): FamilyToolPolicy {
  if (!Object.hasOwn(FAMILY_TOOL_POLICIES, toolName)) {
    throw new Error(`Tool "${toolName}" is not classified for Family access.`);
  }
  const policy = FAMILY_TOOL_POLICIES[toolName];
  if (policy === 'family-read') {
    throw new Error(`Read-only tool "${toolName}" does not need a mutation grant.`);
  }
  if (policy === 'internal' && kind !== 'context_write') {
    throw new Error(`Internal Family tool "${toolName}" requires context_write intent.`);
  }
  if (policy === 'delete-request' && kind !== 'destructive_request') {
    throw new Error('A Family deletion request must use destructive_request intent.');
  }
  if (policy === 'delete-confirm' && kind !== 'destructive_confirmation') {
    throw new Error('A Family deletion confirmation must use destructive_confirmation intent.');
  }
  if (policy === 'low-risk-write' && (kind === 'destructive_request'
    || kind === 'destructive_confirmation' || kind === 'context_write')) {
    throw new Error(`Intent kind ${kind} does not match low-risk Family tool "${toolName}".`);
  }
  return policy;
}

/**
 * Return only the clause that actually contains an exact manifest quote.
 * Safety vetoes are intentionally clause-scoped: in "don't add milk; add eggs"
 * the first clause cannot authorize milk, but it must not erase the independent
 * eggs request. If the quote spans clauses, fail closed by returning the full
 * source text.
 */
function sourceClauseForQuote(source: string, quote: string): string {
  const actionStart = '(?:add|archive|book|cancel|change|complete|create|delete|edit|make|mark|move|play|put|remove|reopen|reschedule|restore|schedule|set|update)';
  const clauses = source
    .split(new RegExp(
      `(?:[;\\n]+|[.!?]+\\s+|\\s+\\bbut\\b\\s+|,\\s*(?=(?:please\\s+)?${actionStart}\\b)|\\s+and\\s+(?=(?:please\\s+)?${actionStart}\\b))`,
      'i',
    ))
    .map((clause) => clause.trim())
    .filter(Boolean);
  const matches = clauses.filter((clause) => clause.includes(quote));
  return matches.length === 1 ? matches[0] : source;
}

const POSITIVE_REMINDER_IDIOM = /^(?:please\s+)?don[’']?t\s+let\s+(?:me|us)\s+forget\s+to\b/i;
const REMINDER_REMAINDER_VETO = /^(?:not|never|don[’']?t|do\s+not|maybe|might|perhaps|possibly|consider|if|when|once|unless)\b/i;
const FUTURE_ACTION_COMMITMENT = /\b[a-z][a-z-]{0,40}(?:[’']ll|\s+will|(?:[’'](?:m|s|re)|\s+(?:am|is|are))\s+going\s+to|\s+plans?\s+to|\s+intends?\s+to)\s+(?:add|archive|arrange|book|bring|buy|call|cancel|change|complete|create|delete|drop\s+off|edit|email|finish|get|grab|mail|make|mark|move|order|pack|pay|pick\s+up|play|print|purchase|put|refill|remove|reopen|reschedule|restore|schedule|send|set|start|take|text|update|wash)\b/i;
const FAMILY_MUTATION_VERB = '(?:add|archive|book|buy|cancel|change|complete|create|delete|edit|get|make|mark|move|order|pick\\s+up|play|put|remove|reopen|reschedule|restore|schedule|send|set|take|update)';
const QUOTED_MUTATION = new RegExp(`["“][^"”\\n]{0,240}\\b${FAMILY_MUTATION_VERB}\\b[^"”\\n]{0,240}["”]`, 'i');
const REPORTED_MUTATION = new RegExp(`^(?:.{0,100}\\b(?:said|says|wrote|texted|mentioned|quoted|asked)\\b).{0,240}\\b${FAMILY_MUTATION_VERB}\\b`, 'i');
const IDENTITY_BOUND_LIST_TOOLS = new Set([
  'complete_family_item',
  'reopen_family_item',
  'archive_family_item',
  'restore_family_item',
]);
const DEFERRED_LIST_STATE_CHANGE = /\b(?:later|tomorrow|tonight|after(?:wards?)?|as\s+soon\s+as|once|when|next\s+(?:day|week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in\s+(?:an?|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:minutes?|hours?|days?|weeks?|months?)|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)\b/i;

const POSITIVE_REMINDER_REQUEST = /^(?:please\s+)?don[’']?t\s+let\s+(?:me|us)\s+forget\s+to\b/i;
const HOUSEHOLD_LIST_INPUT = /^(?:(?:we|i)(?:[’'](?:re|ll|m)|\s+(?:are|will|am))\s+)?(?:out\s+of|running\s+low\s+on|low\s+on)\b|^(?:we(?:[’']ll|\s+will)?\s+)?need\s+(?!to\b)\S/i;
const NAMED_LIST_SHORTHAND_INPUT = /^[a-z0-9][a-z0-9 '&-]{0,60}\s*:\s*\S/i;
const COMPLETION_STATUS_INPUT = /^(?:(?:we|i)\s+)?(?:bought|completed|did|finished|got|grabbed|picked\s+up|purchased|returned|sent|took\s+care\s+of)\b|\b(?:is|are|was|were)\s+(?:all\s+)?done\b/i;
const CALENDAR_DATE_INPUT = /\b(?:today|tomorrow|tonight|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}(?:st|nd|rd|th))\b/i;
const CALENDAR_TIME_INPUT = /\b(?:all[ -]?day|noon|midday|midnight)\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:at|between|from)\s+\d{1,2}(?::\d{2})?\b|\b\d{1,2}\s*[-–—]\s*\d{1,2}\s*(?:am|pm)?\b|\b(?:at\s+)?(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)(?:\s+o[’']?clock)?(?:\s*(?:a\.?m\.?|p\.?m\.?)|\s+in\s+the\s+(?:morning|afternoon|evening))\b/i;
const DECLARATIVE_CONTEXT_PREDICATE = /\b(?:likes?|loves?|hates?|prefers?|favorites?|enjoys?|usually|often|sometimes|always|never|believes?|thinks?|remembers?|knows?)\b/i;
const DECLARATIVE_COPULA = /^[^,;.!?\n]{1,100}\s+(?:am|is|are|was|were|has|have|had)\b/i;

function isDirectWriteRequest(clause: string): boolean {
  return isNaturalDirectRequest(clause)
    || POSITIVE_REMINDER_REQUEST.test(clause)
    || /^(?:please\s+)?(?:bring|drop\s+off|grab|pack|pick\s+up|print|refill|return|send|take|text|wash)\b/i.test(clause)
    || /^(?:let[’']?s|i\s+(?:want|need)\s+you\s+to)\b/i.test(clause);
}

function isTelegraphicCalendarInput(clause: string): boolean {
  const trimmed = clause.trim();
  if (!CALENDAR_DATE_INPUT.test(trimmed) || !CALENDAR_TIME_INPUT.test(trimmed)) return false;
  if (DECLARATIVE_CONTEXT_PREDICATE.test(trimmed) || DECLARATIVE_COPULA.test(trimmed)) return false;
  return trimmed.length <= 500;
}

function isActionInitiatingBinding(
  toolName: string,
  clause: string,
): boolean {
  if (isDirectWriteRequest(clause)) return true;
  if (toolName === 'add_family_item') {
    return HOUSEHOLD_LIST_INPUT.test(clause) || NAMED_LIST_SHORTHAND_INPUT.test(clause) || isMistypedListAdd(clause);
  }
  if (toolName === 'complete_family_item') return COMPLETION_STATUS_INPUT.test(clause);
  if (toolName === 'family_create_event') return isTelegraphicCalendarInput(clause);
  return false;
}

// A mistyped "add" ("Did peanut butter to the list", "As pumpkin spice to the
// list") reads as an add to any person: "<x> to the list" with no other verb
// isn't a sentence otherwise. Questions ("Did peanut butter get added to the
// list?") and anything with a real second verb stay out.
const MISTYPED_ADD = /^(?:please\s+)?(?:did|ad|sdd|adf|addd|aad|asd|as|ads)\s+(?!.*\b(?:get|got|gets|added|already|ever|go|went|make|made|end|ended|still)\b)(.+?)\s+(?:to|on|onto)\s+(?:the\s+|our\s+|my\s+)?(?:[a-z]+\s+)?list\b[\s.!]*$/i;
function isMistypedListAdd(clause: string): boolean {
  const c = clause.trim();
  return !c.includes('?') && MISTYPED_ADD.test(c);
}

function isContinuationOrCorrectionBinding(clause: string): boolean {
  const trimmed = clause.trim();
  if (!trimmed || isUnsafeFamilyActionContext(trimmed)) return false;
  if (isFamilyAffirmation(trimmed) || isDirectWriteRequest(trimmed)) return true;
  // Short field answers such as "Friday", "All day", "two gallons", or an
  // address may complete one already-authorized request. A full declarative
  // preference/fact sentence may not be laundered through that earlier request.
  return trimmed.length <= 500
    && !DECLARATIVE_CONTEXT_PREDICATE.test(trimmed)
    && !DECLARATIVE_COPULA.test(trimmed);
}

const ITEM_IDENTITY_WORDS_BEFORE = new Set([
  'add', 'also', 'archive', 'archived', 'bought', 'buy', 'can', 'complete',
  'completed', 'could', 'did', 'done', 'entry', 'finish', 'finished', 'get',
  'got', 'grab', 'grabbed', 'had', 'have', 'i', 'item', 'just', 'list', 'mark',
  'move', 'moved', 'my', 'need', 'now', 'our', 'pick', 'picked', 'please', 'put',
  'purchase', 'purchased', 'remove', 'removed', 'reopen', 'reopened', 'restore',
  'restored', 'take', 'task', 'that', 'the', 'this', 'to', 'took', 'want', 'we',
  'will', 'with', 'would', 'you', 'your',
]);
const ITEM_IDENTITY_WORDS_AFTER = new Set([
  'again', 'also', 'archived', 'at', 'back', 'because', 'bought', 'complete',
  'completed', 'done', 'entry', 'finished', 'for', 'from', 'gone', 'had', 'has',
  'have', 'in', 'is', 'item', 'list', 'now', 'of', 'off', 'on', 'out', 'picked',
  'please', 'purchased', 'removed', 'reopened', 'restored', 'since', 'so', 'task',
  'that', 'the', 'then', 'this', 'to', 'too', 'was', 'with', 'yesterday',
]);

interface IndexedWord {
  value: string;
  start: number;
  end: number;
}

function indexedWords(value: string): IndexedWord[] {
  return [...value.toLowerCase().matchAll(/[a-z0-9]+/g)].map((match) => ({
    value: match[0],
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
  }));
}

/**
 * Reject a live row name that appears only as part of a more specific noun
 * phrase. "Peanut butter" cannot silently stand in for "almond peanut butter"
 * or "peanut butter cookies". We inspect the trusted full source clause, not
 * just the model-selected quote, so quoting the shorter span cannot bypass it.
 */
function hasUngroundedAdjacentListItemQualifier(
  clause: string,
  toolName: string,
  toolArguments: Record<string, unknown>,
): boolean {
  if (!IDENTITY_BOUND_LIST_TOOLS.has(toolName)) return false;
  const itemText = typeof toolArguments.item_text === 'string'
    ? toolArguments.item_text.trim()
    : '';
  const target = indexedWords(itemText);
  const words = indexedWords(clause);
  if (target.length === 0 || words.length < target.length) return false;

  for (let index = 0; index <= words.length - target.length; index += 1) {
    if (!target.every((word, offset) => words[index + offset].value === word.value)) continue;
    const last = words[index + target.length - 1];
    const previous = words[index - 1];
    const next = words[index + target.length];
    const previousIsExplicitId = Boolean(previous
      && /^\d+$/.test(previous.value)
      && /#(?:family-item:)?\s*$/i.test(clause.slice(
        Math.max(0, previous.start - 20),
        previous.start,
      )));
    const nextIsExplicitId = Boolean(next
      && /^\s*(?:\(\s*)?#(?:family-item:)?\d+\b/i.test(clause.slice(last.end)));
    const previousConflicts = Boolean(previous
      && !previousIsExplicitId
      && !ITEM_IDENTITY_WORDS_BEFORE.has(previous.value));
    const nextConflicts = Boolean(next
      && !nextIsExplicitId
      && !ITEM_IDENTITY_WORDS_AFTER.has(next.value));
    if (previousConflicts || nextConflicts) return true;
  }
  return false;
}

function withoutLiteralItemTarget(
  clause: string,
  toolArguments: Record<string, unknown>,
): string {
  const itemText = typeof toolArguments.item_text === 'string'
    ? toolArguments.item_text.trim()
    : '';
  const tokens = indexedWords(itemText).map((word) => word.value);
  if (tokens.length === 0) return clause;
  const escaped = tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return clause.replace(new RegExp(`\\b${escaped.join('\\s+')}\\b`, 'gi'), ' ');
}

function hasDeferredListStateChange(
  _source: FamilyTurnSource,
  clause: string,
  toolName: string,
  toolArguments: Record<string, unknown>,
): boolean {
  if (!IDENTITY_BOUND_LIST_TOOLS.has(toolName)) return false;
  return DEFERRED_LIST_STATE_CHANGE.test(withoutLiteralItemTarget(clause, toolArguments));
}

function isVagueNewListStateAction(
  source: FamilyTurnSource,
  clause: string,
  toolName: string,
  kind: FamilyManifestActionKind,
  toolArguments: Record<string, unknown>,
): boolean {
  if (!source.current || kind !== 'new_action' || !IDENTITY_BOUND_LIST_TOOLS.has(toolName)) {
    return false;
  }
  if (!/\b(?:it|this|that|one)\b/i.test(clause)) return false;
  const target = typeof toolArguments.item_text === 'string'
    ? toolArguments.item_text.trim()
    : '';
  const normalizedClause = indexedWords(clause).map((word) => word.value).join(' ');
  const normalizedTarget = indexedWords(target).map((word) => word.value).join(' ');
  const itemId = Number(toolArguments.item_id);
  const hasTarget = normalizedTarget.length > 0
    && ` ${normalizedClause} `.includes(` ${normalizedTarget} `);
  const hasItemId = Number.isInteger(itemId) && itemId > 0
    && new RegExp(`(?:#(?:family-item:)?|\\bitem\\s*#?\\s*)${itemId}\\b`, 'i').test(clause);
  return !hasTarget && !hasItemId;
}

function hasAmbiguousListStateReferences(
  clause: string,
  toolName: string,
  toolArguments: Record<string, unknown>,
): boolean {
  if (!IDENTITY_BOUND_LIST_TOOLS.has(toolName)) return false;
  const ids = new Set<number>();
  for (const match of clause.matchAll(/#(?:family-item:)?(\d+)\b/gi)) {
    ids.add(Number(match[1]));
  }
  for (const match of clause.matchAll(/\bitem\s*#?\s*(\d+)\b/gi)) {
    ids.add(Number(match[1]));
  }
  if (ids.size === 0) return false;
  const itemId = Number(toolArguments.item_id);
  return ids.size !== 1 || !ids.has(itemId);
}

/**
 * "Don't let us forget to ..." is a positive household request, but only its
 * fixed prefix is exceptional. The requested remainder still has to survive
 * the normal negation, hypothetical, reported-speech, and condition checks.
 */
function isUnsafeBoundActionText(value: string): boolean {
  const reminder = value.match(POSITIVE_REMINDER_IDIOM);
  if (!reminder) return isUnsafeFamilyActionContext(value);
  const remainder = value.slice(reminder[0].length).trim();
  return !remainder
    || REMINDER_REMAINDER_VETO.test(remainder)
    || isUnsafeFamilyActionContext(remainder);
}

function isQuotedOrReportedMutation(value: string): boolean {
  return QUOTED_MUTATION.test(value) || REPORTED_MUTATION.test(value);
}

function hasUnresolvedAlternative(
  clause: string,
  toolArguments: Record<string, unknown>,
): boolean {
  if (!/\b(?:either\b[^.\n]{0,120}\bor|or)\b/i.test(clause)) return false;
  // Preserve literal names such as "Trick or Treat" when the whole target was
  // copied. "Either milk or eggs" remains ambiguous even if the model picks one.
  if (/\beither\b/i.test(clause)) return true;
  const normalizedClause = clause.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return !['title', 'text'].some((field) => {
    const value = toolArguments[field];
    if (typeof value !== 'string' || !/\bor\b/i.test(value)) return false;
    const normalizedValue = value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    return normalizedValue.length > 0 && normalizedClause.includes(normalizedValue);
  });
}

/** Questions such as "Got milk?" describe or ask; they are not status writes.
 * Polite direct questions remain valid natural requests. */
function isNonDirectiveQuestion(source: FamilyTurnSource, quote: string): boolean {
  if (!source.content.trim().endsWith('?')) return false;
  const clause = sourceClauseForQuote(source.content, quote).trim();
  if (!clause.endsWith('?')) return false;
  return !/^(?:please\b|(?:can|could|will|would)\s+you\b)/i.test(clause);
}

/** Validate and bind an LLM-authored draft to trusted runtime identity/source. */
export function createFamilyTurnManifest(input: {
  draft: FamilyManifestDraftInput;
  turnId: string;
  chatId: string;
  requesterId: string;
  sources: readonly FamilyTurnSource[];
  nowMs?: number;
}): FamilyTurnManifest {
  if (!isPlainRecord(input.draft)) throw new Error('Family manifest draft must be an object.');
  for (const [label, value, max] of [
    ['turnId', input.turnId, 256],
    ['chatId', input.chatId, 512],
    ['requesterId', input.requesterId, 256],
  ] as const) {
    if (!value.trim() || value.length > max || /[\r\n\0]/.test(value)) {
      throw new Error(`Family manifest ${label} is invalid.`);
    }
  }
  const classification = parseClassification(input.draft.classification);
  const drafts = input.draft.actions;
  if (!Array.isArray(drafts) || drafts.length > MAX_MANIFEST_ACTIONS) {
    throw new Error(`A Family turn may declare at most ${MAX_MANIFEST_ACTIONS} actions.`);
  }
  if (!['action', 'mixed'].includes(classification) && drafts.length > 0) {
    const contextOnly = classification === 'context'
      && drafts.every((draft) => isPlainRecord(draft) && draft.kind === 'context_write');
    if (!contextOnly) throw new Error(`Classification "${classification}" cannot contain actions.`);
  }

  const sourceByRef = new Map(input.sources.map((source) => [source.ref, source]));
  const seenIds = new Set<string>();
  const seenCalls = new Set<string>();
  const nowMs = input.nowMs ?? Date.now();
  const actions = drafts.map((draft): FamilyManifestAction => {
    if (!isPlainRecord(draft)) throw new Error('Every Family manifest action must be an object.');
    const intentId = typeof draft.intent_id === 'string' ? draft.intent_id.trim() : '';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(intentId) || seenIds.has(intentId)) {
      throw new Error('Every Family manifest action needs a unique safe intent_id.');
    }
    seenIds.add(intentId);
    const toolName = typeof draft.tool_name === 'string' ? draft.tool_name.trim() : '';
    const kind = parseActionKind(draft.kind);
    const policy = assertActionPolicy(toolName, kind);
    if (!isPlainRecord(draft.arguments)) {
      throw new Error(`Family intent ${intentId} arguments must be an object.`);
    }
    if (!Array.isArray(draft.source_bindings)
      || draft.source_bindings.length === 0
      || draft.source_bindings.length > MAX_BINDINGS_PER_ACTION) {
      throw new Error(`Family intent ${intentId} needs 1-${MAX_BINDINGS_PER_ACTION} source bindings.`);
    }

    let hasCurrentBinding = false;
    let hasEarlierBinding = false;
    let hasEarlierUserBinding = false;
    const bindings = draft.source_bindings.map((binding): FamilyManifestSourceBinding => {
      if (!isPlainRecord(binding)) throw new Error(`Family intent ${intentId} has an invalid source binding.`);
      const sourceRef = typeof binding.source_ref === 'string' ? binding.source_ref.trim() : '';
      const quote = typeof binding.quote === 'string' ? binding.quote.trim() : '';
      const source = sourceByRef.get(sourceRef);
      if (!source) throw new Error(`Family intent ${intentId} cites unavailable source ${sourceRef || '(empty)'}.`);
      if (!quote || !source.content.includes(quote)) {
        throw new Error(`Family intent ${intentId} must quote an exact non-empty span from ${sourceRef}.`);
      }
      if (source.current && source.role === 'user') hasCurrentBinding = true;
      else {
        hasEarlierBinding = true;
        if (source.role === 'user') hasEarlierUserBinding = true;
        if (kind === 'correction') {
          const sourceAt = parseSqliteTimestamp(source.createdAt);
          if (!Number.isFinite(sourceAt) || sourceAt < nowMs - FAMILY_CORRECTION_TTL_MS) {
            throw new Error(`Family correction intent ${intentId} cites an earlier turn outside the correction window.`);
          }
        }
      }

      // Hard vetoes detect negation, examples, hypotheticals, reported speech,
      // and unresolved conditions around the cited clause. They do not try to
      // enumerate positive verbs or let one negated clause veto another action.
      const sourceClause = sourceClauseForQuote(source.content, quote);
      const unsafeSourceClause = isUnsafeBoundActionText(sourceClause);
      const unsafeQuote = isUnsafeBoundActionText(quote);
      if (policy !== 'internal' && source.role === 'user'
        && (unsafeSourceClause
          || unsafeQuote
          || isQuotedOrReportedMutation(sourceClause)
          || isNonDirectiveQuestion(source, quote)
          || FUTURE_ACTION_COMMITMENT.test(sourceClause)
          || hasDeferredListStateChange(source, sourceClause, toolName, draft.arguments)
          || isVagueNewListStateAction(source, sourceClause, toolName, kind, draft.arguments)
          || hasAmbiguousListStateReferences(sourceClause, toolName, draft.arguments)
          || hasUngroundedAdjacentListItemQualifier(sourceClause, toolName, draft.arguments)
          || hasUnresolvedAlternative(sourceClause, draft.arguments))) {
        throw new Error(`Family intent ${intentId} cites unsafe or non-direct action language.`);
      }
      return Object.freeze({
        sourceRef,
        quote,
        sourceRole: source.role,
        senderId: source.senderId,
        createdAt: source.createdAt,
        current: source.current,
      });
    });
    if (!hasCurrentBinding) {
      throw new Error(`Family intent ${intentId} must cite the current inbound message.`);
    }
    if ((kind === 'continuation' || kind === 'correction') && !hasEarlierBinding) {
      throw new Error(`Family ${kind} intent ${intentId} must cite an earlier turn.`);
    }
    if ((kind === 'continuation' || kind === 'correction') && !hasEarlierUserBinding) {
      throw new Error(`Family ${kind} intent ${intentId} must cite an earlier user request; assistant text alone cannot authorize a write.`);
    }
    if (policy === 'low-risk-write' || policy === 'delete-request') {
      const boundClauses = bindings
        .filter((binding) => binding.sourceRole === 'user')
        .map((binding) => {
          const source = sourceByRef.get(binding.sourceRef)!;
          return {
            current: binding.current,
            clause: sourceClauseForQuote(source.content, binding.quote),
          };
        });
      if (kind === 'continuation' || kind === 'correction') {
        const earlierInitiated = boundClauses.some((binding) =>
          !binding.current && isActionInitiatingBinding(toolName, binding.clause));
        const currentContinues = boundClauses.some((binding) =>
          binding.current && isContinuationOrCorrectionBinding(binding.clause));
        // "Add it to the active list": the current message is itself a direct
        // request that only points back ("it", "that", "those") for the item,
        // which comes from an earlier member message in the 30-minute window.
        const currentInitiatesWithReference = kind === 'continuation' && boundClauses.some((binding) =>
          binding.current
          && isActionInitiatingBinding(toolName, binding.clause)
          && /\b(?:it|that|this|them|those|these)\b/i.test(binding.clause));
        if ((!earlierInitiated || !currentContinues) && !currentInitiatesWithReference) {
          throw new Error(`Family intent ${intentId} cites unsafe or non-direct action language.`);
        }
      } else {
        const currentInitiates = boundClauses.some((binding) =>
          binding.current && isActionInitiatingBinding(toolName, binding.clause));
        if (!currentInitiates) {
          throw new Error(`Family intent ${intentId} cites unsafe or non-direct action language.`);
        }
      }
    }
    const canonicalArgs = canonicalFamilyToolArguments(draft.arguments);
    const exactCall = `${toolName}\n${canonicalArgs}`;
    if (seenCalls.has(exactCall)) {
      throw new Error(`Family manifest repeats the same exact ${toolName} call.`);
    }
    seenCalls.add(exactCall);
    return Object.freeze({
      intentId,
      toolName,
      kind,
      arguments: canonicalValue(draft.arguments) as Record<string, unknown>,
      argumentsHash: hashCanonicalArgs(canonicalArgs),
      sourceBindings: Object.freeze(bindings),
      canonicalArgs,
    });
  });

  const manifest: FamilyTurnManifest = Object.freeze({
    version: 1 as const,
    turnId: input.turnId,
    chatId: input.chatId,
    requesterId: input.requesterId,
    createdAtMs: nowMs,
    classification,
    actions: Object.freeze(actions),
  });
  trustedManifests.add(manifest);
  return manifest;
}

/** Match one unconsumed exact tool/argument grant. The caller commits on success. */
export function claimFamilyManifestAction(input: {
  manifest: FamilyTurnManifest | undefined;
  toolName: string;
  toolInput: Record<string, unknown>;
  unavailableIntentIds?: ReadonlySet<string>;
  currentMessage: string;
}): FamilyManifestActionClaim | FamilyManifestClaimFailure {
  const manifest = input.manifest;
  if (!manifest || !trustedManifests.has(manifest)) {
    return {
      error: `Call ${FAMILY_TURN_MANIFEST_TOOL} before any Family mutation.`,
      reason: 'manifest_required',
    };
  }
  if (!Object.hasOwn(FAMILY_TOOL_POLICIES, input.toolName)) return {
    error: `Tool "${input.toolName}" is not classified for Family access.`,
    reason: 'manifest_action_mismatch',
  };
  const policy = FAMILY_TOOL_POLICIES[input.toolName];
  if (policy === 'family-read') {
    return {
      error: `Read-only tool "${input.toolName}" does not require a mutation grant.`,
      reason: 'manifest_action_mismatch',
    };
  }

  let canonicalArgs: string;
  try {
    canonicalArgs = canonicalFamilyToolArguments(input.toolInput);
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      reason: 'manifest_action_mismatch',
    };
  }
  const matching = manifest.actions.filter((candidate) =>
    candidate.toolName === input.toolName && candidate.canonicalArgs === canonicalArgs);
  const action = matching.find((candidate) => !input.unavailableIntentIds?.has(candidate.intentId));
  if (!action) {
    return {
      error: `No unconsumed Family manifest action matches ${input.toolName} with argument hash ${hashCanonicalArgs(canonicalArgs)}.`,
      reason: matching.length > 0 ? 'manifest_action_consumed' : 'manifest_action_mismatch',
    };
  }

  if (policy === 'delete-confirm') {
    const code = typeof input.toolInput.confirmation_code === 'string'
      ? input.toolInput.confirmation_code.trim().toUpperCase()
      : '';
    const exact = input.currentMessage.trim().toUpperCase().replace(/\s+/g, ' ');
    if (!code || exact !== `CONFIRM DELETE ${code}`) {
      return {
        error: 'Family event deletion requires the exact current-message confirmation code.',
        reason: 'manifest_action_mismatch',
      };
    }
  }

  const authorization: FamilyManifestActionAuthorization = Object.freeze({ manifest, action });
  trustedAuthorizations.add(authorization);
  authorizationState.set(authorization, 'claimed');
  return { intentId: action.intentId, authorization };
}

/** Commit only after the handler has returned successfully. */
export function commitFamilyManifestActionAuthorization(
  authorization: FamilyManifestActionAuthorization,
): boolean {
  if (!trustedAuthorizations.has(authorization)
    || authorizationState.get(authorization) !== 'claimed') return false;
  authorizationState.set(authorization, 'committed');
  return true;
}

/** Release a failed/pre-dispatch claim so the same exact action may retry. */
export function releaseFamilyManifestActionAuthorization(
  authorization: FamilyManifestActionAuthorization,
): boolean {
  if (!trustedAuthorizations.has(authorization)
    || authorizationState.get(authorization) !== 'claimed') return false;
  authorizationState.set(authorization, 'released');
  return true;
}

/** Handler-side proof that the central gate authorized this exact call. */
export function hasAuthorizedFamilyManifestAction(
  context: ToolContext | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  const manifest = context?.familyTurnManifest;
  const authorization = context?.familyManifestAuthorization;
  if (!manifest || !authorization) return false;
  if (!trustedManifests.has(manifest) || !trustedAuthorizations.has(authorization)) return false;
  if (authorizationState.get(authorization) !== 'claimed') return false;
  if (authorization.manifest !== manifest || authorization.action.toolName !== toolName) return false;
  if (
    context.groupKey !== 'family'
    || context.turnId !== manifest.turnId
    || context.chatId !== manifest.chatId
    || context.userId !== manifest.requesterId
    || (context.recipient !== undefined && context.recipient !== manifest.chatId)
  ) return false;
  try {
    return authorization.action.canonicalArgs === canonicalFamilyToolArguments(toolInput);
  } catch {
    return false;
  }
}

/**
 * Handler-side access to the trusted evidence behind an already-authorized
 * exact call. Callers must still validate domain invariants (calendar binding,
 * live row identity, date/time resolution, and uniqueness).
 */
export function getAuthorizedFamilyManifestEvidence(
  context: ToolContext | undefined,
  toolName: string,
  toolInput: Record<string, unknown>,
): AuthorizedFamilyManifestEvidence | null {
  if (!hasAuthorizedFamilyManifestAction(context, toolName, toolInput)) return null;
  const action = context?.familyManifestAuthorization?.action;
  if (!action) return null;
  return Object.freeze({
    kind: action.kind,
    intentId: action.intentId,
    sourceBindings: action.sourceBindings,
  });
}

function manifestToolDescription(sources: readonly FamilyTurnSource[]): string {
  const available = sources.map((source) =>
    `${source.ref} (role=${source.role}, sender=${source.senderId}, at=${source.createdAt})`).join('; ');
  return [
    'Commit the single source-bound intent manifest for this Family inbound turn before calling any tool that mutates calendar, lists, Instacart-hosted pages, Spotify playback, or deletion state.',
    'This is not user confirmation. Interpret ordinary language as naturally as in Personal. Use continuation for a missing detail supplied in a later turn (including a standalone "All day") and correction for a change to a recent action.',
    'Every action must include the exact later tool name and exact complete arguments object. Copy exact source quotes; do not paraphrase them. Cite current plus the earlier request for a continuation/correction. If ambiguous, declare no actions and ask one concise question.',
    `Available source refs: ${available || 'current only'}.`,
  ].join(' ');
}

export function createFamilyTurnManifestTool(input: {
  turnId: string;
  chatId: string;
  requesterId: string;
  sources: readonly FamilyTurnSource[];
  getManifest: () => FamilyTurnManifest | undefined;
  setManifest: (manifest: FamilyTurnManifest) => void;
  nowMs?: number;
}): ToolDef {
  const sourceRefs = input.sources.map((source) => source.ref);
  const mutableTools = Object.entries(FAMILY_TOOL_POLICIES)
    .filter(([, policy]) => policy !== 'family-read')
    .map(([name]) => name);
  return {
    definition: {
      name: FAMILY_TURN_MANIFEST_TOOL,
      description: manifestToolDescription(input.sources),
      input_schema: {
        type: 'object' as const,
        properties: {
          classification: {
            type: 'string',
            enum: ['conversation', 'context', 'question', 'action', 'mixed', 'ambiguous'],
          },
          actions: {
            type: 'array',
            maxItems: MAX_MANIFEST_ACTIONS,
            items: {
              type: 'object',
              properties: {
                intent_id: { type: 'string', description: 'Unique short ID within this turn, e.g. action_1.' },
                tool_name: { type: 'string', enum: mutableTools },
                kind: {
                  type: 'string',
                  enum: ['new_action', 'continuation', 'correction', 'destructive_request', 'destructive_confirmation', 'context_write'],
                },
                arguments: {
                  type: 'object',
                  description: 'Exact complete arguments object that the later tool call will use.',
                  additionalProperties: true,
                },
                source_bindings: {
                  type: 'array',
                  minItems: 1,
                  maxItems: MAX_BINDINGS_PER_ACTION,
                  items: {
                    type: 'object',
                    properties: {
                      source_ref: { type: 'string', enum: sourceRefs },
                      quote: { type: 'string', description: 'Exact non-empty substring copied from that raw message.' },
                    },
                    required: ['source_ref', 'quote'],
                    additionalProperties: false,
                  },
                },
              },
              required: ['intent_id', 'tool_name', 'kind', 'arguments', 'source_bindings'],
              additionalProperties: false,
            },
          },
        },
        required: ['classification', 'actions'],
        additionalProperties: false,
      },
    },
    handler: async (raw, context) => {
      if (input.getManifest()) {
        throw new Error('This Family turn already has an intent manifest; it cannot be replaced or widened.');
      }
      if (
        context?.groupKey !== 'family'
        || context.turnId !== input.turnId
        || context.userId !== input.requesterId
        || context.chatId !== input.chatId
        || (context.recipient !== undefined && context.recipient !== input.chatId)
      ) {
        throw new Error('Family intent manifest context does not match the authenticated inbound turn.');
      }
      const manifest = createFamilyTurnManifest({
        draft: raw as unknown as FamilyManifestDraftInput,
        turnId: input.turnId,
        chatId: input.chatId,
        requesterId: input.requesterId,
        sources: input.sources,
        nowMs: input.nowMs,
      });
      input.setManifest(manifest);
      return `Family turn manifest accepted (${manifest.actions.length} action${manifest.actions.length === 1 ? '' : 's'}).`;
    },
  };
}
