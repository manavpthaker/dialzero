import { randomUUID } from 'node:crypto';
import { captionPhoto, transcribePhotoForFamily } from './lib/photo-caption.js';
import { budgetStopResponse, isLlmBudgetError } from './lib/token-budget.js';
import type { GroupConfig } from './group-resolver.js';
import type { User } from './user-resolver.js';
import type { ImageData, DocumentData } from './channels/imessage.js';
import { loadSystemBlocks, getRetrievedBlocksSmart } from './context-resolver.js';
import { getRecentMessages, getRecentMessagesWithMetadata, listFamilyLists, saveMessage, appendToMessage, type MessageRow } from './db.js';
import { toolRegistry, type ToolDef } from './tools/index.js';
import { getProfileConfig } from './config.js';
import { bindFamilyListAddRequest } from './family-list-intent.js';
import {
  authorizeNaturalCalendarCreate,
  authorizeNaturalCalendarUpdate,
  isNaturalDirectRequest,
  isUnsafeFamilyActionContext,
  naturalTargetScore,
} from './family-natural-intent.js';
import {
  buildFamilyTurnSources,
  claimFamilyManifestAction,
  commitFamilyManifestActionAuthorization,
  createFamilyTurnManifestTool,
  FAMILY_TOOL_POLICIES as FAMILY_MANIFEST_TOOL_POLICIES,
  FAMILY_TURN_MANIFEST_TOOL,
  isFamilyActionSendInDoubt,
  releaseFamilyManifestActionAuthorization,
  type FamilyManifestActionClaim,
  type FamilyTurnManifest,
} from './family-turn-manifest.js';
import { logFamilyToolDecision } from './family-tool-observability.js';
import {
  OPENAI_MODEL,
  createOpenAIResponse,
  openAIFunctionCalls,
  openAITextFromResponse,
  toOpenAIFunctionTool,
  toolOutputToOpenAI,
} from './lib/openai.js';

// Turn cap: worst-case a runaway tool loop is MAX_TURNS primary-model calls each carrying
// the full context, so this is a cost ceiling as much as a safety one. The tool-strip
// at `turn === MAX_TURNS - 2` stays correct because it's relative to this constant.
const MAX_TURNS = 12;
const MODEL = OPENAI_MODEL;
const MAX_TOKENS_DEFAULT = 8000;
const MAX_TOKENS_THINKING = 16000;

// Extended thinking doubles max_tokens (8K→16K) and adds a 3K thinking budget, so
// it's a real cost multiplier. Gate it on genuinely complex asks — a high length
// floor plus deliberate planning/analysis verbs (not casual "why"/"explain").
const COMPLEX_PATTERN = /\b(plan|analyze|research|compare|design|debug|troubleshoot|strategize)\b/i;

function shouldThink(userMessage: string): boolean {
  if (userMessage.length > 400) return true;
  if (COMPLEX_PATTERN.test(userMessage)) return true;
  return false;
}

export type ProgressCallback = (message: string) => Promise<void>;

export interface AgentRuntimeOverrides {
  /** Deterministic Responses API substitute for full conversation-to-tool-loop
   * acceptance tests. Production never supplies this. */
  createResponse?: typeof createOpenAIResponse;
  turnId?: string;
  /** More tool turns for long sub-agent runs (browser jobs). Default MAX_TURNS. */
  maxTurns?: number;
}

const TOOL_LABELS: Record<string, string> = {
  // Errands
  start_errand: '🧾 Planning the errand...',
  call_now: '📞 Placing the call...',
  book_online: '🍽️ Booking online...',
  list_errands: '🧾 Checking errands...',
  update_errand: '🧾 Updating the errand...',
  cancel_errand: '🧾 Cancelling the errand...',
  send_now: '✉️ Sending...',
  // Calendar
  list_events: '📅 Checking calendar...',
  create_event: '📅 Creating event...',
  // Web
  web_search: '🔍 Searching the web...',
  fetch_url: '🌐 Reading that page...',
  // Browser
  browser_navigate: '🌐 Opening URL...',
  browser_read_page: '🌐 Reading page content...',
  browser_click: '🌐 Interacting with page...',
  browser_input: '🌐 Filling in form...',
  browser_action: '🌐 Driving browser...',
  clip_to_facts: '📎 Clipping page...',
  // Computer use (desktop control)
  computer_use: '🖥️ Controlling the desktop...',
  // LinkedIn
  linkedin_search: '💼 Searching LinkedIn...',
  // GitHub
  git_commit_summary: '📦 Checking commits...',
  read_context_file: '📄 Reading context...',
  write_context_file: '📄 Writing context...',
  list_repo_files: '📄 Browsing repo...',
  // Codex CLI
  spawn_codex: '⚡ Spawning Codex...',
  // Household
  read_household: '🏠 Reading household doc...',
  update_household: '🏠 Updating household doc...',
  append_household: '🏠 Adding to household doc...',
  // Email
  email_list: '📧 Checking email...',
  email_search: '📧 Searching email...',
  email_read_thread: '📧 Reading the thread...',
  email_archive: '📧 Archiving...',
  email_draft: '📧 Drafting a reply...',
  // Memory
  remember: '🧠 Saving to memory...',
  recall: '🧠 Checking memory...',
  read_group_context: '🧠 Reading group context...',
  assign_human_task: '📌 Creating task for you...',
  memory_checkpoint: '🧠 Saving checkpoint...',
  save_fact: '🧠 Filing a fact...',
  search_facts: '🧠 Searching facts...',
  facts_about: '🧠 Pulling profile...',
  // People
  find_person: '👤 Looking up person...',
  note_about_person: '👤 Updating contact...',
  recent_interactions: '👤 Pulling interactions...',
  // Tasks
  create_task: '📌 Creating task...',
  list_tasks: '📌 Checking tasks...',
  update_task: '📌 Updating task...',
  complete_task: '✅ Completing task...',
  cancel_task: '✂️ Cancelling task...',
  snooze_task: '😴 Snoozing task...',
  get_task_summary: '📊 Summarizing tasks...',
  get_schedulable_tasks: '📌 Finding unscheduled tasks...',
  link_task_to_event: '📌 Linking task to calendar...',
  unlink_task_from_event: '📌 Unlinking task from calendar...',
  reconcile_email_items: '🔄 Reconciling email, calendar, and tasks...',
  list_email_open_loops: '🔄 Checking email follow-ups...',
  delete_event: '📅 Removing event...',
  update_event: '📅 Updating event...',
  // MCP — Instacart
  mcp_instacart_create_recipe: '🛒 Creating recipe page on Instacart...',
  mcp_instacart_create_shopping_list: '🛒 Creating shopping list on Instacart...',
  // MCP — Spotify
  mcp_spotify_play: '🎵 Playing music...',
  mcp_spotify_search: '🎵 Searching Spotify...',
  mcp_spotify_get_playlists: '🎵 Checking playlists...',
  mcp_spotify_get_current_track: '🎵 Checking what\'s playing...',
};

const MIN_PROGRESS_INTERVAL_MS = 2000;
export const FAMILY_SILENT_RESPONSE = 'FAMILY_SILENT';

export interface InboundMessageSource {
  key: string;
  rowId: number;
  guid: string | null;
  timestamp: string;
}

function familyHistoryMetadata(message: MessageRow): string {
  return `<family_message_metadata source_ref="message:${message.id}" sender_id=${JSON.stringify(message.sender)} role=${JSON.stringify(message.role)} created_at=${JSON.stringify(message.created_at)} />`;
}

function currentFamilyMetadata(senderId: string): string {
  return `<family_message_metadata source_ref="current" sender_id=${JSON.stringify(senderId)} role="user" />`;
}

type FamilyToolPolicy =
  | 'internal'
  | 'family-read'
  | 'calendar-create'
  | 'calendar-update'
  | 'calendar-delete-request'
  | 'calendar-delete-confirm'
  | 'list-create'
  | 'list-add'
  | 'list-edit'
  | 'list-complete'
  | 'list-reopen'
  | 'list-archive'
  | 'list-restore'
  | 'web-search'
  | 'instacart-search'
  | 'instacart-cart'
  | 'spotify-search'
  | 'spotify-play';

/** Every callable Family tool has an explicit policy. A future tool is denied
 * until somebody deliberately classifies it here. */
const FAMILY_TOOL_POLICIES: Readonly<Record<string, FamilyToolPolicy>> = {
  family_list_events: 'family-read',
  family_create_event: 'calendar-create',
  family_update_event: 'calendar-update',
  family_request_event_delete: 'calendar-delete-request',
  family_confirm_event_delete: 'calendar-delete-confirm',
  list_family_lists: 'family-read',
  create_family_list: 'list-create',
  list_family_items: 'family-read',
  add_family_item: 'list-add',
  edit_family_item: 'list-edit',
  complete_family_item: 'list-complete',
  reopen_family_item: 'list-reopen',
  archive_family_item: 'list-archive',
  restore_family_item: 'list-restore',
  remember_family_context: 'internal',
  note_family_coordination: 'internal',
  resolve_family_coordination: 'internal',
  list_family_coordination: 'family-read',
  recall_family_context: 'family-read',
  list_family_context: 'family-read',
  web_search: 'web-search',
  mcp_instacart_create_recipe: 'instacart-cart',
  mcp_instacart_create_shopping_list: 'instacart-cart',
  mcp_spotify_search: 'spotify-search',
  mcp_spotify_play: 'spotify-play',
};

function normalizeFamilyRequest(message: string): string {
  let text = message.toLowerCase().replace(/[’]/g, "'").trim();
  const profile = getProfileConfig();
  const aliases = [profile.triggerWord.replace(/^@+/, ''), profile.botName]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (aliases.length > 0) {
    text = text.replace(
      new RegExp(`^\\s*@?(?:${aliases.join('|')})(?:\\s*[:,;\\-]\\s*|\\s+|$)`, 'i'),
      '',
    ).trim();
  }
  return text;
}

function hasFamilyNegation(text: string): boolean {
  return /\b(?:do not|don't|not yet|no need to|hold off|just discussing|for now|not a request|not a directive|not asking you to|do not actually|don't actually|was (?:just )?(?:an? )?(?:example|idea|plan))\b/.test(text);
}

// "when you get a chance" / "if you can" / "let me know when it's on" are
// politeness aimed at the assistant, not conditions the request hangs on.
const FAMILY_POLITE_SOFTENER = /\b(?:if|when)\s+you\s+(?:can|could|would|get|have|see|next|remember|don'?t mind)\b|\b(?:let|tell|text|ping|remind)\s+(?:me|us)\s+(?:know\s+)?when\b|\bwhenever\s+you\b|\bonce\s+(?:a|per)\s+(?:day|week|month|year)\b/;

function hasUnresolvedFamilyCondition(text: string): boolean {
  if (FAMILY_POLITE_SOFTENER.test(text)) return false;
  return /\b(?:unless)\b|(?:^|[,;]\s*)\s*(?:if|when|once)\b|\b(?:if|when|once)\s+(?!you\b)/.test(text);
}

function isDirectFamilyAction(text: string, verbs: string): boolean {
  return new RegExp(`^(?:please\\s+)?(?:${verbs})\\b`).test(text)
    || new RegExp(`^(?:please\\s+)?(?:can|could|will|would) you\\s+(?:please\\s+)?(?:${verbs})\\b`).test(text)
    || new RegExp(`^i (?:want|need) you to\\s+(?:${verbs})\\b`).test(text)
    || new RegExp(`^let'?s\\s+(?:${verbs})\\b`).test(text);
}

const FAMILY_DIRECT_VERBS = '(?:add|archive|block|book|build|cancel|change|check|complete|confirm|create|delete|edit|find|get|look up|make|mark|move|play|put|remove|reopen|restore|resume|schedule|search|set|show|start|tell|update)';

function isReportedFamilyAction(text: string): boolean {
  // A real directive must begin the current message after the optional bot
  // mention is stripped. Quoted/example/reported directives later in a message
  // are context, not authorization.
  if (isDirectFamilyAction(text, FAMILY_DIRECT_VERBS)) return false;
  if (/\b(?:said|says|wrote|texted|mentioned|quoted|example|hypothetical)\b/.test(text)) {
    return true;
  }
  return new RegExp(`["“][^"”\\n]{0,240}\\b${FAMILY_DIRECT_VERBS}\\b[^"”\\n]{0,240}["”]`).test(text);
}

const CALENDAR_SURFACE = /\b(?:calendars?|events?|appointments?|appts?)\b/;
const TIME_SURFACE = /\b(?:today|tomorrow|tonight|mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?|\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}(?::\d{2})?\s*(?:am|pm))\b/;
const CLOCK_TIME_SURFACE = /\b(?:noon|midday|midnight)\b|\b(?:between|from|at)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/;
const CART_SURFACE = /\b(?:cart|basket)\b/;
const SPOTIFY_SURFACE = /\b(?:spotify|music|song|track|album|artist|playlist)\b/;
const FAMILY_TASK_CAPTURE = /^(?:task|to[ -]?do)\s*:|^(?:please\s+)?(?:remember to|remind (?:me|us) to|don'?t let (?:me|us) forget to)|^(?:(?:we|i)\s+)?(?:need|have) to\b|\b(?:by|due|before)\b/;
// Only nouns that mean "this is merely a proposal". With the bare adjectives
// in here, "add the school forms, it is urgent" read as "it is only an idea".
const CONTEXT_ONLY_FAMILY_CLAIM = /\b(?:is|was|would be|could be|might be|sounds|seems|looks)\s+(?:(?:just|only)\s+)?(?:(?:an?|one|the)\s+)?(?:idea|option|suggestion|possibility|example|plan|thought|worth discussing)\b/;
const TEXTUAL_LIST_TARGET = /\b(?:to|on|in|from)\s+(?:(?:the|our|my|your|a)\s+)?(?:family tasks?|groceries|errands|shopping list|[a-z0-9][a-z0-9 -]{0,40}\s+list)\b/;
const CALENDAR_TITLE_STOPWORDS = new Set([
  'add', 'appointment', 'calendar', 'create', 'event', 'family', 'for', 'schedule',
  'the', 'with',
]);

function normalizedLiteral(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : '';
}

function mentionsLiteral(text: string, value: unknown): boolean {
  const literal = normalizedLiteral(value);
  if (!literal) return false;
  const normalizedText = text.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return ` ${normalizedText} `.includes(` ${literal} `);
}

function explicitFamilyListTarget(text: string, toolInput: Record<string, unknown>): boolean {
  const listName = toolInput.list ?? toolInput.name;
  return mentionsLiteral(text, listName)
    || /\b(?:family tasks?|shopping list|grocery list|errands list)\b/.test(text);
}

function calendarTitleMatchesRequest(text: string, title: unknown): boolean {
  const literal = normalizedLiteral(title);
  if (!literal) return false;
  if (mentionsLiteral(text, literal)) return true;
  const meaningfulTokens = [...new Set(literal.split(' ').filter(
    (token) => token.length >= 3 && !CALENDAR_TITLE_STOPWORDS.has(token),
  ))];
  return meaningfulTokens.some((token) => new RegExp(`\\b${token}\\b`).test(text));
}

function exactFamilyItemReference(text: string, toolInput: Record<string, unknown>): boolean {
  const itemId = Number(toolInput.item_id);
  if (!Number.isInteger(itemId) || itemId <= 0) return false;
  return new RegExp(`(?:#family-item:${itemId}\\b|\\bitem\\s*#?${itemId}\\b)`).test(text);
}

function familyItemReferences(text: string): number[] {
  const ids = new Set<number>();
  for (const pattern of [
    /#family-item:(\d+)\b/g,
    /\bitem\s*#?\s*(\d+)\b/g,
    /(?:^|[^a-z0-9:])#(\d+)\b/g,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const id = Number(match[1]);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
  }
  return [...ids];
}

function familyListAliases(name: string): string[] {
  const normalized = normalizedLiteral(name);
  const aliases = new Set<string>([normalized]);
  if (normalized && !normalized.endsWith(' list')) aliases.add(`${normalized} list`);
  if (normalized === 'groceries') {
    aliases.add('grocery list');
    aliases.add('shopping list');
  } else if (normalized === 'errands') {
    aliases.add('errands list');
  } else if (normalized === 'family tasks') {
    aliases.add('family task');
    aliases.add('family task list');
    aliases.add('family tasks list');
  }
  return [...aliases].filter(Boolean);
}

function stripDirectFamilyActionPrefix(text: string, verbs: string): string | null {
  const patterns = [
    new RegExp(`^(?:please\\s+)?(?:${verbs})\\b\\s*`),
    new RegExp(`^(?:please\\s+)?(?:can|could|will|would) you\\s+(?:please\\s+)?(?:${verbs})\\b\\s*`),
    new RegExp(`^i (?:want|need) you to\\s+(?:${verbs})\\b\\s*`),
    new RegExp(`^let'?s\\s+(?:${verbs})\\b\\s*`),
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return text.slice(match[0].length);
  }
  return null;
}

function archiveFamilyItemTargetMatches(
  text: string,
  toolInput: Record<string, unknown>,
): boolean {
  const itemId = Number(toolInput.item_id);
  const itemText = normalizedLiteral(toolInput.item_text);
  const listName = normalizedLiteral(toolInput.list);
  if (!Number.isInteger(itemId) || itemId <= 0 || !itemText || !listName) return false;

  const references = familyItemReferences(text);
  if (references.length > 1 || (references.length === 1 && references[0] !== itemId)) {
    return false;
  }

  const rawTarget = stripDirectFamilyActionPrefix(text, 'archive|remove');
  if (rawTarget === null) return false;
  const escapedId = String(itemId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const target = normalizedLiteral(rawTarget
    .replace(new RegExp(`#family-item:${escapedId}\\b`, 'g'), ' ')
    .replace(new RegExp(`\\b(?:grocery\\s+)?item\\s*#?\\s*${escapedId}\\b`, 'g'), ' ')
    .replace(new RegExp(`#${escapedId}\\b`, 'g'), ' '));
  if (target === itemText) return true;

  const allowedListTargets = new Set<string>(['list', 'the list']);
  for (const alias of familyListAliases(listName)) {
    allowedListTargets.add(alias);
    allowedListTargets.add(`the ${alias}`);
  }
  return [...allowedListTargets].some((listTarget) =>
    ['from', 'in', 'on', 'to'].some(
      (preposition) => target === `${itemText} ${preposition} ${listTarget}`,
    ));
}

function isExplicitLookup(text: string, surface: RegExp): boolean {
  if (hasFamilyNegation(text) || !surface.test(text)) return false;
  return /\?$/.test(text)
    || isDirectFamilyAction(text, 'search|look up|find|check|show|get|tell');
}

/** Deterministic second line of defense behind the Family system prompt: tools
 * that change outside state require action language in the current message. */
export function isExplicitFamilyMutationRequest(message: string): boolean {
  const text = normalizeFamilyRequest(message);
  if (hasFamilyNegation(text) || hasUnresolvedFamilyCondition(text)) return false;
  if (/\b(?:should we|what if|maybe|might|thinking about|considering)\b/.test(text)
      && !/\b(?:please|can you|could you|will you)\b/.test(text)) {
    return false;
  }
  const verb = '(?:add|archive|build|change|complete|confirm|create|delete|edit|mark|move|play|put|remove|reopen|restore|schedule|set|start|update)';
  return isDirectFamilyAction(text, verb);
}

/** Why the gate refused, in words the model can act on.
 *
 * `canRunFamilyTool` is a bare boolean, so a blocked call used to reach the
 * model as an unexplained refusal. With nothing to go on it invented a cause,
 * blamed the sender's phrasing, and dictated a replacement sentence it had
 * never checked — which the gate then refused too. Only `list-add` carries a
 * machine-readable reason today; everything else falls back to the generic
 * line. */
export function familyBlockReason(
  toolName: string,
  currentMessage: string,
  toolInput: Record<string, unknown> = {},
): string | undefined {
  if (!Object.hasOwn(FAMILY_TOOL_POLICIES, toolName)) return undefined;
  const policy = FAMILY_TOOL_POLICIES[toolName];
  if (policy === 'calendar-create' || policy === 'calendar-update') {
    return 'every detail of the event must already appear in this chat, and the current message must either add a detail or plainly agree to what you proposed';
  }
  if (policy !== 'list-add') return undefined;
  try {
    const binding = bindFamilyListAddRequest({
      message: currentMessage,
      requestedList: toolInput.list,
      requestedText: toolInput.text,
      requestedQuantity: toolInput.quantity,
      requestedNotes: toolInput.notes,
      requestedDueDate: toolInput.due_date,
      requestedAssignee: toolInput.assignee,
      liveListNames: listFamilyLists().map((list) => list.name),
    });
    return binding.ok ? undefined : binding.reason;
  } catch {
    return undefined;
  }
}

export function canRunFamilyTool(
  toolName: string,
  currentMessage: string,
  toolInput: Record<string, unknown> = {},
  recentMessages: ReadonlyArray<Pick<MessageRow, 'role' | 'content' | 'created_at'>> = [],
): boolean {
  if (!Object.hasOwn(FAMILY_TOOL_POLICIES, toolName)) return false;
  const policy = FAMILY_TOOL_POLICIES[toolName];
  if (policy === 'internal' || policy === 'family-read') return true;

  const text = normalizeFamilyRequest(currentMessage);
  const positiveForgetCapture = policy === 'list-add'
    && /^(?:please\s+)?don'?t let (?:me|us) forget to\b/.test(text);
  if (
    (!positiveForgetCapture && hasFamilyNegation(text))
    || hasUnresolvedFamilyCondition(text)
    || isReportedFamilyAction(text)
    || CONTEXT_ONLY_FAMILY_CLAIM.test(text)
  ) return false;

  switch (policy) {
    case 'calendar-create':
      return ((CALENDAR_SURFACE.test(text) || TIME_SURFACE.test(text))
        && !FAMILY_TASK_CAPTURE.test(text)
        && (!TEXTUAL_LIST_TARGET.test(text) || CALENDAR_SURFACE.test(text))
        && !CART_SURFACE.test(text)
        && !SPOTIFY_SURFACE.test(text)
        && calendarTitleMatchesRequest(text, toolInput.title)
        && (isDirectFamilyAction(text, 'schedule|book|block|arrange|plan|set up')
          || ((CALENDAR_SURFACE.test(text) || CLOCK_TIME_SURFACE.test(text))
            && isDirectFamilyAction(text, 'create|add|put|set'))))
        || authorizeNaturalCalendarCreate({ currentMessage, recentMessages }, toolInput);
    case 'calendar-update':
      return ((CALENDAR_SURFACE.test(text) || TIME_SURFACE.test(text) || /^\s*(?:please\s+)?reschedule\b/.test(text))
        && (!explicitFamilyListTarget(text, toolInput) || CALENDAR_SURFACE.test(text))
        && (isDirectFamilyAction(text, 'reschedule')
          || (CALENDAR_SURFACE.test(text) && isDirectFamilyAction(text, 'change|edit|move|set|update'))))
        || authorizeNaturalCalendarUpdate({ currentMessage, recentMessages }, toolInput);
    case 'calendar-delete-request':
      return (CALENDAR_SURFACE.test(text) || TIME_SURFACE.test(text) || /\bevent[_ -]?id\b/.test(text))
        && isDirectFamilyAction(text, 'cancel|delete|remove');
    case 'calendar-delete-confirm': {
      const code = typeof toolInput.confirmation_code === 'string'
        ? toolInput.confirmation_code.trim().toUpperCase()
        : '';
      return Boolean(code) && text.toUpperCase().replace(/\s+/g, ' ') === `CONFIRM DELETE ${code}`;
    }
    case 'list-create':
      return /\blist\b/.test(text)
        && explicitFamilyListTarget(text, toolInput)
        && !CALENDAR_SURFACE.test(text)
        && !CART_SURFACE.test(text)
        && isDirectFamilyAction(text, 'create|make|start');
    case 'list-add':
      try {
        return bindFamilyListAddRequest({
          message: currentMessage,
          requestedList: toolInput.list,
          requestedText: toolInput.text,
          requestedQuantity: toolInput.quantity,
          requestedNotes: toolInput.notes,
          requestedDueDate: toolInput.due_date,
          requestedAssignee: toolInput.assignee,
          liveListNames: listFamilyLists().map((list) => list.name),
        }).ok;
      } catch {
        return false;
      }
    case 'list-edit':
      return (exactFamilyItemReference(text, toolInput)
          || naturalTargetScore(currentMessage, toolInput.item_text) > 0)
        && !CALENDAR_SURFACE.test(text)
        && !CART_SURFACE.test(text)
        && isNaturalDirectRequest(currentMessage);
    case 'list-complete':
      return (exactFamilyItemReference(text, toolInput)
          || naturalTargetScore(currentMessage, toolInput.item_text) > 0)
        && !isUnsafeFamilyActionContext(currentMessage)
        && (isDirectFamilyAction(text, 'complete[ds]?|completing|mark(?:ed|s|ing)?|check(?:ed)? off|cross(?:ed)? off|finish(?:ed)?|got|picked up|did')
          || /\b(?:is|are|'s|was|were)\s+done\b|^done with\b/.test(text));
    case 'list-reopen':
      return (exactFamilyItemReference(text, toolInput)
          || naturalTargetScore(currentMessage, toolInput.item_text) > 0)
        && isDirectFamilyAction(text, 'reopen');
    case 'list-archive':
      return !/\b(?:calendar|event|appointment|schedule|instacart|cart|basket|order|spotify|music|song|track|album|artist|playlist)\b/.test(text)
        && archiveFamilyItemTargetMatches(text, toolInput)
        && isDirectFamilyAction(text, 'archive|remove');
    case 'list-restore':
      return (exactFamilyItemReference(text, toolInput)
          || naturalTargetScore(currentMessage, toolInput.item_text) > 0)
        && isDirectFamilyAction(text, 'restore');
    case 'web-search':
      return isExplicitLookup(text, /\b(?:web|online|internet|weather|forecast|news|price|hours|address)\b/);
    case 'instacart-search':
      return isExplicitLookup(text, /\b(?:instacart|grocer(?:y|ies)|product|recipe|ingredient|store)\b/);
    case 'instacart-cart':
      return /\b(?:instacart|shopping list|recipe|ingredients?)\b/.test(text)
        && !CALENDAR_SURFACE.test(text)
        && isDirectFamilyAction(text, 'build|create|make|add|put|send');
    case 'spotify-search':
      return isExplicitLookup(text, /\b(?:spotify|music|song|track|album|artist|playlist)\b/);
    case 'spotify-play':
      return SPOTIFY_SURFACE.test(text)
        && !CALENDAR_SURFACE.test(text)
        && isDirectFamilyAction(text, 'play|resume');
    default:
      return false;
  }
}

export async function runAgent(
  groupConfig: GroupConfig,
  user: User,
  userMessage: string,
  image?: ImageData,
  onProgress?: ProgressCallback,
  document?: DocumentData,
  recipient?: string,
  authorizeFamilyTool?: () => Promise<boolean>,
  sourceMessage?: InboundMessageSource,
  runtimeOverrides?: AgentRuntimeOverrides,
): Promise<string> {
  // One opaque ID spans the complete tool loop for this inbound message. Tools
  // with two-message confirmation flows use it to reject same-run execution.
  const turnId = runtimeOverrides?.turnId ?? randomUUID();
  const createResponse = runtimeOverrides?.createResponse ?? createOpenAIResponse;

  // Load conversation history first — the smart retrieval reasoning-pass needs
  // the recent thread to resolve references ("he", "that role") before it can
  // decide what to pull from the brain.
  //
  // System-initiated runs (cron, pulses, daemons) skip history entirely. Their
  // prompts are self-contained by construction -- each builds its full context
  // from a gather step -- so the history was never load-bearing, but it was
  // expensive and self-poisoning: runAgent writes every call into `messages`,
  // and getRecentMessages reads the last 75 back, so a 30-minute loop fills its
  // own window with its own boilerplate within about two days. Measured on the
  // `home` group: 69 of the last 75 rows were the heartbeat talking to itself,
  // 53k chars (~47% of the prompt) of pure self-echo, and the window spanned
  // only Aug 4-6. It cost tokens and degraded answers at the same time.
  const systemAuthored = user.systemAuthored === true;
  const familyHistory = groupConfig.key === 'family'
    ? getRecentMessagesWithMetadata(groupConfig.key)
    : [];
  const history = systemAuthored
    ? []
    : groupConfig.key === 'family'
      ? familyHistory
      : getRecentMessages(groupConfig.key);

  // Family source refs survive process restarts because historical refs are DB
  // message IDs. `current` is deliberately turn-local. Sender identity remains
  // separate from the raw message body, so the owner and partner can continue one
  // shared pending request without the model mistaking who said what.
  // A Family photo is transcribed before the turn so its details can be used
  // now and remembered for a follow-up ("add the second one too").
  const familyPhoto = groupConfig.key === 'family' && image && !systemAuthored
    ? await Promise.race([
      transcribePhotoForFamily(image),
      new Promise<null>((r) => setTimeout(() => r(null), 20_000)),
    ])
    : null;
  const familySources = groupConfig.key === 'family'
    ? buildFamilyTurnSources({
      currentMessage: userMessage,
      currentSenderId: user.id,
      recentMessages: familyHistory,
      currentCreatedAt: sourceMessage?.timestamp,
      currentPhoto: familyPhoto ?? undefined,
    })
    : [];
  let familyTurnManifest: FamilyTurnManifest | undefined;
  const consumedFamilyIntentIds = new Set<string>();
  const reservedFamilyIntentIds = new Set<string>();
  // A later Family mutation may refer naturally to an event returned by a
  // read earlier in this same agent run. Keep only the dedicated Family
  // calendar reader's trusted output; no private/global tool result can enter
  // this identity-resolution transcript.
  const sameRunFamilyCalendarReads: Array<Pick<MessageRow, 'role' | 'content' | 'created_at'>> = [];

  // Smart retrieval (the CoS's memory reflex): run the async reasoning-pass over
  // (message + thread), render the retrieval block, and hand it to the otherwise
  // synchronous prompt builder. Falls back to the heuristic internally on any
  // failure. Only for real inbound messages; system-authored runs skip it.
  const precomputedRetrieval = userMessage && groupConfig.key !== 'family'
    ? await getRetrievedBlocksSmart(userMessage, groupConfig.key, history)
    : groupConfig.key === 'family' ? '' : undefined;

  // OpenAI's Responses API accepts one instruction string. Keep the stable and
  // dynamic sections separate until this boundary so prompt caching can still be
  // measured and optimized later without changing context construction.
  const { staticPrefix, dynamic } = loadSystemBlocks(groupConfig, user, userMessage, precomputedRetrieval);
  const instructions = `${staticPrefix}\n\n${dynamic}`;
  // Responses API content part types are role-sensitive: user messages use
  // `input_text`, while assistant history must use `output_text`. Sending an
  // assistant turn back as `input_text` produces a 400 on the next message
  // ("Supported values are: output_text and refusal").
  const input: Array<Record<string, unknown>> = history.map((m) => {
    const metadata = groupConfig.key === 'family' && 'id' in m
      ? familyHistoryMetadata(m as MessageRow)
      : undefined;
    if (m.role === 'assistant') {
      return {
        role: 'assistant',
        content: [
          ...(metadata ? [{ type: 'output_text', text: metadata }] : []),
          { type: 'output_text', text: m.content },
        ],
      };
    }
    return {
      role: 'user',
      content: [
        ...(metadata ? [{ type: 'input_text', text: metadata }] : []),
        { type: 'input_text', text: m.content },
      ],
    };
  });

  // Build current message content — text + optional image / PDF document
  if (image || document) {
    const content: Array<Record<string, unknown>> = [];
    if (groupConfig.key === 'family') {
      content.push({ type: 'input_text', text: currentFamilyMetadata(user.id) });
    }
    if (image) {
      content.push({
        type: 'input_image',
        image_url: `data:${image.mimetype};base64,${image.base64}`,
      });
    }
    if (document) {
      content.push({
        type: 'input_file',
        filename: 'attachment.pdf',
        file_data: `data:${document.mimetype || 'application/pdf'};base64,${document.base64}`,
      });
    }
    content.push({ type: 'input_text', text: userMessage });
    input.push({ role: 'user', content });
  } else {
    input.push({
      role: 'user',
      content: [
        ...(groupConfig.key === 'family'
          ? [{ type: 'input_text', text: currentFamilyMetadata(user.id) }]
          : []),
        { type: 'input_text', text: userMessage },
        ...(familyPhoto
          ? [{ type: 'input_text', text: `<family_photo source_ref="current_photo" role="photo">\n${familyPhoto}\n</family_photo>` }]
          : []),
      ],
    });
  }
  // Not written for system-initiated runs: nothing reads it back (see above),
  // it crowds out real conversation in the 75-message window, and the table has
  // no retention policy. What the system actually SAID is recorded in
  // outbound_log by the arbiter, which is the better record anyway.
  if (!systemAuthored) {
    const savedId = saveMessage(
      groupConfig.key,
      user.id,
      'user',
      userMessage,
      groupConfig.key === 'family' ? sourceMessage?.timestamp : undefined,
    );
    // History keeps text only; note what the photo showed so "pay that one"
    // later still has something to refer to. In the background, off the reply path.
    if (image && groupConfig.key !== 'family') {
      void captionPhoto(image).then((c) => { if (c) appendToMessage(savedId, `\n[Photo: ${c}]`); });
    }
    // Family: the photo's text is its own row (role "photo"), never mixed into
    // the sender's words, so it can supply details but never authorize a change.
    if (familyPhoto) saveMessage(groupConfig.key, user.id, 'photo', `Text of the photo ${user.name} sent:\n${familyPhoto}`, sourceMessage?.timestamp);
  }

  // Get scoped tools for this group
  const tools = getScopedTools(groupConfig.tools);
  if (groupConfig.key === 'family') {
    tools.unshift(createFamilyTurnManifestTool({
      turnId,
      chatId: recipient?.trim() || '',
      requesterId: user.id,
      sources: familySources,
      getManifest: () => familyTurnManifest,
      setManifest: (manifest) => { familyTurnManifest = manifest; },
    }));
  }
  const toolDefs = tools.map((t) => toOpenAIFunctionTool(t.definition));

  const thinkingEnabled = shouldThink(userMessage);

  let response: string = '';
  let lastProgressTime = 0;

  const maxTurns = Math.max(2, runtimeOverrides?.maxTurns ?? MAX_TURNS);
  for (let turn = 0; turn < maxTurns; turn++) {
    let result: Awaited<ReturnType<typeof createOpenAIResponse>>;
    try {
      result = await createResponse({
        model: MODEL,
        maxOutputTokens: thinkingEnabled ? MAX_TOKENS_THINKING : MAX_TOKENS_DEFAULT,
        instructions,
        input,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        reasoningEffort: thinkingEnabled ? 'medium' : 'low',
      });
    } catch (err) {
      // The budget can run out mid-loop: turn 1 was affordable, turn 8 was not.
      // Tools already ran and their side effects are real, so throwing here
      // would discard completed work and surface a raw error. Stop cleanly and
      // return whatever has accumulated instead. Only the budget is handled this
      // way — every other failure still propagates.
      if (isLlmBudgetError(err)) {
        console.warn(`[agent] budget stop on turn ${turn}: ${err.message}`);
        // A system-authored run has no human waiting for an explanation. Its
        // caller interprets any non-empty text as useful output (heartbeat, for
        // example, sends anything except HEARTBEAT_CLEAR), so exposing this
        // internal control message turns one cap breach into a notification
        // every 30 minutes. Stay silent; the breach is already recorded for
        // doctor/dashboard. Interactive work still explains why it stopped.
        response = budgetStopResponse(systemAuthored, response, err.message);
        break;
      }
      throw err;
    }

    // Preserve every Responses output item, including reasoning items, before
    // appending function results. This is required for multi-turn tool calls.
    input.push(...(result.output || []));
    const toolUseBlocks = openAIFunctionCalls(result);

    if (toolUseBlocks.length === 0) {
      response = openAITextFromResponse(result);
      break;
    }

    // Execute tools and collect results
    for (const block of toolUseBlocks) {
      // Send progress update (rate-limited)
      if (onProgress) {
        const now = Date.now();
        if (now - lastProgressTime >= MIN_PROGRESS_INTERVAL_MS) {
          const label = TOOL_LABELS[block.name] || `Working on ${block.name}...`;
          try {
            await onProgress(label);
          } catch {
            // Don't let progress failures break the agent loop
          }
          lastProgressTime = now;
        }
      }

      const tool = tools.find((t) => t.definition.name === block.name);
      if (!tool) {
        if (groupConfig.key === 'family') {
          logFamilyToolDecision({
            decision: 'blocked',
            toolName: block.name,
            reasonCode: 'tool_unavailable',
            userId: user.id,
            chatId: recipient,
            turnId,
          });
        }
        input.push({
          type: 'function_call_output',
          call_id: block.call_id,
          output: `Tool "${block.name}" not available in this group.`,
        });
        continue;
      }

      let toolInput: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(block.arguments) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          toolInput = parsed as Record<string, unknown>;
        }
      } catch {
        if (groupConfig.key === 'family') {
          logFamilyToolDecision({
            decision: 'blocked',
            toolName: block.name,
            reasonCode: 'invalid_arguments',
            userId: user.id,
            chatId: recipient,
            turnId,
          });
        }
        input.push({ type: 'function_call_output', call_id: block.call_id, output: `Invalid JSON arguments for ${block.name}.` });
        continue;
      }

      if (groupConfig.key === 'family') {
        logFamilyToolDecision({
          decision: 'attempted',
          toolName: block.name,
          reasonCode: 'model_requested',
          userId: user.id,
          chatId: recipient,
          turnId,
        });
      }

      let familyClaim: FamilyManifestActionClaim | undefined;
      try {
        if (groupConfig.key === 'family' && block.name !== FAMILY_TURN_MANIFEST_TOOL) {
          if (!Object.hasOwn(FAMILY_MANIFEST_TOOL_POLICIES, block.name)) {
            logFamilyToolDecision({
              decision: 'blocked',
              toolName: block.name,
              reasonCode: 'intent_not_authorized',
              userId: user.id,
              chatId: recipient,
              turnId,
            });
            input.push({
              type: 'function_call_output',
              call_id: block.call_id,
              output: `Blocked: tool "${block.name}" has no explicit Family policy.`,
            });
            continue;
          }
          const policy = FAMILY_MANIFEST_TOOL_POLICIES[block.name];
          if (policy !== 'family-read') {
            const unavailable = new Set([...consumedFamilyIntentIds, ...reservedFamilyIntentIds]);
            const claimed = claimFamilyManifestAction({
              manifest: familyTurnManifest,
              toolName: block.name,
              toolInput,
              unavailableIntentIds: unavailable,
              currentMessage: userMessage,
            });
            if ('error' in claimed) {
              logFamilyToolDecision({
                decision: 'blocked',
                toolName: block.name,
                reasonCode: claimed.reason,
                userId: user.id,
                chatId: recipient,
                turnId,
              });
              input.push({
                type: 'function_call_output',
                call_id: block.call_id,
                output: [
                  `Blocked by the source-bound Family turn manifest: ${claimed.error}`,
                  `This is not a calendar/provider permission error and the sender must not be asked to rephrase or repeat an exact sentence.`,
                  familyTurnManifest
                    ? 'The committed manifest cannot be widened. Ask one concise clarification if the request is genuinely ambiguous; otherwise state briefly that this action could not be completed.'
                    : `Call ${FAMILY_TURN_MANIFEST_TOOL} with the exact tool name, exact complete arguments, and exact source quotes, then retry the same tool call.`,
                ].join(' '),
              });
              continue;
            }
            familyClaim = claimed;
            reservedFamilyIntentIds.add(claimed.intentId);
          }
        }
        if (
          groupConfig.key === 'family'
          && (!authorizeFamilyTool || !(await authorizeFamilyTool()))
        ) {
          if (familyClaim) reservedFamilyIntentIds.delete(familyClaim.intentId);
          if (familyClaim) releaseFamilyManifestActionAuthorization(familyClaim.authorization);
          logFamilyToolDecision({
            decision: 'blocked',
            toolName: block.name,
            reasonCode: 'audience_reverification_failed',
            userId: user.id,
            chatId: recipient,
            turnId,
          });
          input.push({
            type: 'function_call_output',
            call_id: block.call_id,
            output: 'Blocked: the Family participant set could not be re-verified for this tool call.',
          });
          continue;
        }
        if (groupConfig.key === 'family') {
          logFamilyToolDecision({
            decision: 'allowed',
            toolName: block.name,
            reasonCode: 'policy_allowed',
            userId: user.id,
            chatId: recipient,
            turnId,
          });
        }
        const output = await tool.handler(toolInput, {
          groupKey: groupConfig.key,
          userId: user.id,
          turnId,
          currentMessage: userMessage,
          recentMessages: [...familyHistory, ...sameRunFamilyCalendarReads],
          recipient,
          chatId: recipient,
          sourceMessageKey: sourceMessage?.key,
          sourceMessageTimestamp: sourceMessage?.timestamp,
          sourceMessageRowId: sourceMessage?.rowId,
          sourceMessageGuid: sourceMessage?.guid,
          familyTurnManifest,
          familyManifestAuthorization: familyClaim?.authorization,
          reverifyFamilyAudience: groupConfig.key === 'family' ? authorizeFamilyTool : undefined,
        });
        if (groupConfig.key === 'family'
          && block.name === 'family_list_events'
          && typeof output === 'string') {
          sameRunFamilyCalendarReads.push({
            role: 'assistant',
            content: output,
            created_at: new Date().toISOString(),
          });
        }
        if (familyClaim) {
          reservedFamilyIntentIds.delete(familyClaim.intentId);
          consumedFamilyIntentIds.add(familyClaim.intentId);
          commitFamilyManifestActionAuthorization(familyClaim.authorization);
        }
        if (groupConfig.key === 'family') {
          logFamilyToolDecision({
            decision: 'executed',
            toolName: block.name,
            reasonCode: 'handler_completed',
            userId: user.id,
            chatId: recipient,
            turnId,
          });
        }
        input.push({
          type: 'function_call_output',
          call_id: block.call_id,
          output: toolOutputToOpenAI(output),
        });
      } catch (err) {
        // Pre-dispatch failures may retry the same exact grant. Once a remote
        // mutation was dispatched, consume it: the provider may have accepted
        // the write even when its response was lost.
        if (familyClaim) {
          reservedFamilyIntentIds.delete(familyClaim.intentId);
          if (isFamilyActionSendInDoubt(err)) {
            consumedFamilyIntentIds.add(familyClaim.intentId);
            commitFamilyManifestActionAuthorization(familyClaim.authorization);
          } else {
            releaseFamilyManifestActionAuthorization(familyClaim.authorization);
          }
        }
        if (groupConfig.key === 'family') {
          logFamilyToolDecision({
            decision: block.name === FAMILY_TURN_MANIFEST_TOOL ? 'blocked' : 'failed',
            toolName: block.name,
            reasonCode: block.name === FAMILY_TURN_MANIFEST_TOOL
              ? 'manifest_rejected'
              : isFamilyActionSendInDoubt(err) ? 'provider_send_in_doubt' : 'handler_failed',
            userId: user.id,
            chatId: recipient,
            turnId,
          });
        }
        input.push({
          type: 'function_call_output',
          call_id: block.call_id,
          output: `Error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    }

    // On the second-to-last turn, force a final text response (no more tools).
    if (turn === maxTurns - 2) {
      toolDefs.length = 0;
    }
  }

  // If we still have no response, do one final call with no tools to force text output
  if (!response) {
    try {
      const finalResult = await createResponse({
        model: MODEL,
        maxOutputTokens: MAX_TOKENS_DEFAULT,
        instructions,
        input,
        reasoningEffort: 'low',
      });
      response = openAITextFromResponse(finalResult);
    } catch {
      // last resort
    }
  }

  if (response && !(groupConfig.key === 'family' && response.trim() === FAMILY_SILENT_RESPONSE)) {
    if (!systemAuthored) saveMessage(groupConfig.key, 'assistant', 'assistant', response);
  }

  // A scheduled/background run that produced nothing (e.g. the budget refused
  // every call) says nothing: callers send only non-empty replies, and an
  // apology texted at 11am for a check the owner never asked about is noise.
  if (!response && systemAuthored) return '';
  return response || 'Sorry, I ran out of processing steps. Try a simpler request or break it into parts.';
}

function getScopedTools(toolKeys: string[]): ToolDef[] {
  return toolKeys.flatMap((key) => toolRegistry[key] || []);
}
