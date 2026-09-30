import {
  addFamilyListItem,
  archiveFamilyListItem,
  completeFamilyListItem,
  createFamilyList,
  getFamilyListByName,
  getFamilyListItem,
  listFamilyListItems,
  listFamilyLists,
  reopenFamilyListItem,
  restoreFamilyListItem,
  updateFamilyListItem,
  type FamilyListItem,
  type FamilyListItemStatus,
} from '../db.js';
import { getProfileConfig, type ProfileUser } from '../config.js';
import {
  getAuthorizedFamilyManifestEvidence,
  type AuthorizedFamilyManifestEvidence,
} from '../family-turn-manifest.js';
import { naturalTargetScore } from '../family-natural-intent.js';
import type { ToolContext, ToolDef } from './index.js';
import { isDateGroundedInFamilyManifestEvidence } from './family-calendar.js';

interface FamilyToolContext extends ToolContext {
  userId?: string;
}

type FamilyHandler = (
  input: Record<string, unknown>,
  context: FamilyToolContext,
) => Promise<string | FamilyListRejection>;

interface FamilyListRejection {
  readonly rejected: true;
  readonly message: string;
}

function rejectFamilyList(message: string): FamilyListRejection {
  return Object.freeze({ rejected: true, message });
}

function familyOnly(handler: FamilyHandler): ToolDef['handler'] {
  return async (input, context) => {
    if (context?.groupKey !== 'family') {
      throw new Error('Family lists are only available inside the Family group.');
    }
    const configuredChat = process.env.GROUP_FAMILY?.trim();
    const liveChat = context.chatId?.trim();
    const recipient = context.recipient?.trim();
    const requesterId = context.userId?.trim();
    const approved = requesterId
      ? familyUsers().some((user) => user.id === requesterId && user.allowedGroups.includes('family'))
      : false;
    if (
      !configuredChat
      || !liveChat
      || liveChat !== configuredChat
      || (recipient !== undefined && recipient !== liveChat)
      || !approved
    ) {
      throw new Error('Family lists require an authenticated participant in the configured Family chat.');
    }
    const result = await handler(input, context as FamilyToolContext);
    if (typeof result !== 'string') throw new Error(result.message);
    return result;
  };
}

function familyUsers(): ProfileUser[] {
  const profile = getProfileConfig();
  return [
    profile.owner,
    ...profile.members.filter((member) => member.allowedGroups.includes('family')),
  ];
}

function contextUserId(context: FamilyToolContext): string | undefined {
  const id = context.userId?.trim();
  return id || undefined;
}

function resolveAssignee(
  value: unknown,
  context: FamilyToolContext,
  evidence?: AuthorizedFamilyManifestEvidence,
): { value: string | null } | { error: string } {
  if (value === undefined || value === null) return { value: null };
  const raw = String(value).trim();
  if (!raw || ['unassigned', 'none', 'nobody'].includes(raw.toLowerCase())) {
    return { value: null };
  }
  if (raw.toLowerCase() === 'both') return { value: 'both' };
  if (raw.toLowerCase() === 'me') {
    if (evidence) {
      const firstPersonSenders = firstPersonAssigneeSenderIds(evidence);
      if (firstPersonSenders.length !== 1) {
        return {
          error: firstPersonSenders.length > 1
            ? 'The Family request uses me/my for more than one sender, so I did not assign the item.'
            : 'The assignee "me" is not grounded in a source-bound Family message.',
        };
      }
      return { value: firstPersonSenders[0] };
    }
    const requester = contextUserId(context);
    return requester
      ? { value: requester }
      : { error: 'I could not identify who sent this request, so I did not assign the item.' };
  }

  const normalized = raw.toLowerCase();
  const matched = familyUsers().find(
    (user) => user.id.toLowerCase() === normalized || user.name.toLowerCase() === normalized,
  );
  if (matched) return { value: matched.id };

  const choices = familyUsers().map((user) => `${user.name} (${user.id})`);
  return {
    error: `Unknown Family assignee "${raw}". Use me, both, unassigned, or ${choices.join(', ')}.`,
  };
}

function displayAssignee(assignee: string | null): string {
  if (!assignee) return 'unassigned';
  if (assignee === 'both') return 'both';
  const user = familyUsers().find((candidate) => candidate.id === assignee);
  return user?.name || assignee;
}

function normalizeOptionalText(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeDate(value: unknown, field: string): { value?: string | null; error?: string } {
  const normalized = normalizeOptionalText(value);
  if (normalized === undefined || normalized === null) return { value: normalized };
  if (Number.isNaN(new Date(normalized).getTime())) {
    return { error: `${field} must be an ISO date or timestamp.` };
  }
  return { value: normalized };
}

function positiveInteger(value: unknown, field: string): { value?: number; error?: string } {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return { error: `${field} must be a positive integer.` };
  return { value: parsed };
}

function formatItem(item: FamilyListItem): string {
  const state = item.archived_at ? '🗄️' : item.status === 'completed' ? '✅' : '☐';
  const quantity = item.quantity ? ` × ${item.quantity}` : '';
  const due = item.due_date ? ` · due ${item.due_date}` : '';
  const assignee = ` · ${displayAssignee(item.assignee)}`;
  const notes = item.notes ? ` · ${item.notes}` : '';
  return `${state} #family-item:${item.id} ${item.text}${quantity}${due}${assignee}${notes}`;
}

function itemNotFound(itemId: number): string {
  return `Family item #family-item:${itemId} was not found.`;
}

function normalizedIdentity(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    : '';
}

function referencedFamilyItemIds(message: string): number[] {
  const ids = new Set<number>();
  for (const pattern of [
    /#family-item:(\d+)\b/gi,
    /\bitem\s*#?\s*(\d+)\b/gi,
    /(?:^|[^a-z0-9:])#(\d+)\b/gi,
  ]) {
    for (const match of message.matchAll(pattern)) {
      const id = Number(match[1]);
      if (Number.isInteger(id) && id > 0) ids.add(id);
    }
  }
  return [...ids];
}

function familyListIdentityAliases(name: string): string[] {
  const normalized = normalizedIdentity(name);
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

function explicitlyNamedFamilyLists(message: string): FamilyListItem['list_name'][] {
  const normalizedMessage = normalizedIdentity(message);
  const rawMessage = message.toLowerCase().trim();
  // Task:/Tasks:/To do: are reserved natural aliases for Family Tasks. A
  // legacy custom list literally named "Task" must never steal that route.
  if (/^(?:tasks?|to\s*do|todo)\s*:/i.test(rawMessage)) {
    const familyTasks = listFamilyLists().find(
      (list) => normalizedIdentity(list.name) === 'family tasks',
    );
    return familyTasks ? [familyTasks.name] : [];
  }
  return listFamilyLists()
    .map((list) => list.name)
    .filter((name) => familyListIdentityAliases(name).some((alias) => {
      const escaped = alias.split(' ')
        .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('\\s+');
      const routed = new RegExp(`(?:^|\\s)(?:from|in|on|to)\\s+(?:the\\s+)?${escaped}(?:\\s|$)`);
      const header = new RegExp(`^${escaped}\\s*:`);
      return routed.test(normalizedMessage) || header.test(rawMessage);
    }));
}

function evidenceText(evidence: AuthorizedFamilyManifestEvidence): string {
  return evidence.sourceBindings.map((binding) => binding.quote).join('\n');
}

function evidenceSpans(evidence: AuthorizedFamilyManifestEvidence): string[] {
  return evidence.sourceBindings.flatMap((binding) => binding.quote
    .split(/\r?\n/)
    .map((span) => span.trim())
    .filter(Boolean));
}

function valueGroundedInOneEvidenceSpan(
  evidence: AuthorizedFamilyManifestEvidence,
  value: unknown,
): boolean {
  return evidenceSpans(evidence).some((span) => naturalTargetScore(span, value) >= 1);
}

function currentEvidenceText(evidence: AuthorizedFamilyManifestEvidence): string {
  return evidence.sourceBindings
    .filter((binding) => binding.current)
    .map((binding) => binding.quote)
    .join('\n');
}

function explicitDuplicateItemRequested(
  evidence: AuthorizedFamilyManifestEvidence,
): boolean {
  return evidence.sourceBindings.some((binding) =>
    binding.sourceRole === 'user'
    && /\b(?:another|one\s+more|duplicate)\b|\b(?:an?\s+)?additional\s+(?:item|entry|one|copy)\b/i.test(binding.quote));
}

function withoutBotAddress(message: string): string {
  const profile = getProfileConfig();
  const aliases = [profile.botName, profile.triggerWord.replace(/^@+/, '')]
    .map((alias) => alias.trim())
    .filter(Boolean)
    .map((alias) => alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (aliases.length === 0) return message.trim();
  return message
    .replace(new RegExp(`^\\s*@?(?:${aliases.join('|')})(?:\\s*[:,;\u2014-]\\s*|\\s+)`, 'i'), '')
    .trim();
}

/**
 * The manifest owns semantic interpretation. List handlers do not maintain a
 * second positive-verb grammar; they verify the branded exact call and the
 * domain invariants the model cannot safely decide by itself.
 */
function authorizedListMutation(
  toolName: string,
  input: Record<string, unknown>,
  context: FamilyToolContext,
): { evidence: AuthorizedFamilyManifestEvidence; text: string } | { error: string } {
  const evidence = getAuthorizedFamilyManifestEvidence(context, toolName, input);
  if (!evidence) {
    return { error: 'This Family-list change was not authorized by the current source-bound request.' };
  }

  const current = withoutBotAddress(context.currentMessage?.trim() || '');
  // A question must not mutate a same-named row unless it is structurally
  // addressed to the assistant as a polite request. This blocks "Got milk?",
  // "Milk?", and "Should we remove milk?" without enumerating action verbs.
  const informationQuestion = /^(?:can|could|will|would)\s+you\s+(?:tell\b|let\s+(?:me|us)\s+know\b|find\s+out\b|(?:see|check)\s+(?:if|whether)\b)/i.test(current);
  if (/\?\s*$/.test(current)
    && (informationQuestion
      || !/^(?:please\b|(?:can|could|will|would)\s+you\b)/i.test(current))) {
    return { error: 'That message is a question, not an authorized Family-list change.' };
  }

  return { evidence, text: evidenceText(evidence) };
}

const OTHER_SURFACE = /\b(?:calendar|event|appointment|schedule|instacart|cart|basket|checkout|spotify|music|song|track|album|artist|playlist)\b|\bgrocery\s+order\b/i;
const CALENDAR_DATE_CUE = /\b(?:today|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tues?|wed|thurs?|fri|sat|sun|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|\d{4}-\d{2}-\d{2}|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?)\b/i;
const CALENDAR_TIME_CUE = /\b(?:at|between|from)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}\s*[-–—]\s*\d{1,2}\s*(?:am|pm)\b/i;

function evidenceTargetsAnotherSurface(message: string): boolean {
  const calendarShaped = CALENDAR_DATE_CUE.test(message) && CALENDAR_TIME_CUE.test(message);
  if (!OTHER_SURFACE.test(message) && !calendarShaped) return false;
  // An explicit local list target wins. This keeps an appointment form usable
  // as a task while preventing a calendar/cart/playback request from being
  // reinterpreted as a similarly named local row.
  return explicitlyNamedFamilyLists(message).length === 0;
}

function manifestTargetsAnotherSurface(evidence: AuthorizedFamilyManifestEvidence): boolean {
  const currentText = currentEvidenceText(evidence);
  if (OTHER_SURFACE.test(currentText)) return evidenceTargetsAnotherSurface(currentText);
  return evidenceTargetsAnotherSurface(evidenceText(evidence));
}

function dueDateIsGrounded(
  value: unknown,
  evidence: AuthorizedFamilyManifestEvidence,
): boolean {
  if (value === undefined) return true;
  const due = String(value).trim();
  if (!due) return false;
  if (normalizedIdentity(evidenceText(evidence)).includes(normalizedIdentity(due))) return true;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) return false;
  return isDateGroundedInFamilyManifestEvidence(due, evidence);
}

function firstPersonAssigneeSenderIds(
  evidence: AuthorizedFamilyManifestEvidence,
): string[] {
  const approvedIds = new Set(familyUsers().map((user) => user.id));
  return [...new Set(evidence.sourceBindings
    .filter((binding) => binding.sourceRole === 'user'
      && /\b(?:me|my|mine|myself)\b/i.test(binding.quote)
      && approvedIds.has(binding.senderId))
    .map((binding) => binding.senderId))];
}

function assigneeIsGrounded(
  value: unknown,
  evidence: AuthorizedFamilyManifestEvidence,
): boolean {
  const spans = evidenceSpans(evidence);
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return false;
  if (raw === 'me') return firstPersonAssigneeSenderIds(evidence).length === 1;
  if (raw === 'both') return spans.some((span) => /\b(?:both|us|we)\b/i.test(span));
  if (['unassigned', 'none', 'nobody'].includes(raw)) {
    return spans.some((span) => /\b(?:unassigned|none|nobody|no one)\b/i.test(span));
  }
  const named = familyUsers().find(
    (user) => user.id.toLowerCase() === raw || user.name.toLowerCase() === raw,
  );
  if (named && firstPersonAssigneeSenderIds(evidence).includes(named.id)) return true;
  return spans.some((span) => naturalTargetScore(span, value) >= 1);
}

function validateAddEvidence(
  input: Record<string, unknown>,
  evidence: AuthorizedFamilyManifestEvidence,
): string | undefined {
  const message = evidenceText(evidence);
  const spans = evidenceSpans(evidence);
  const requestedText = String(input.text ?? '').trim();
  const normalizedRequestedText = normalizedIdentity(requestedText);
  const itemSpans = spans.filter((span) => naturalTargetScore(span, input.text) >= 1);
  if (itemSpans.length === 0) {
    return 'The requested item text is not grounded in the authorized Family message.';
  }
  const meaningfulItemTokens = normalizedRequestedText.split(' ').filter((token) =>
    token.length > 1
    && !new Set([
      'a', 'add', 'an', 'as', 'family', 'it', 'list', 'make', 'on', 'put',
      'something', 'task', 'tasks', 'that', 'the', 'thing', 'this', 'to',
    ]).has(token));
  if (meaningfulItemTokens.length === 0) {
    return 'The requested item is only a vague reference, not a grounded Family-list item.';
  }
  // Never join separate clauses/items into one synthesized row. Legitimate
  // compound names such as "mac and cheese" remain valid when the sender used
  // that exact contiguous phrase; "milk, eggs and bread" cannot become the
  // invented item "milk and bread". A conjunction followed by another action
  // is always a compound request, not one item.
  if ((/\b(?:and|or)\b/i.test(normalizedRequestedText)
      && !itemSpans.some((span) => normalizedIdentity(span).includes(normalizedRequestedText)))
    || /(?:\b(?:and|or)\b|&|[.!?;]|\n)\s*(?:add|archive|buy|call|complete|create|drop|edit|get|grab|mark|move|order|pick|put|remove|reopen|restore|schedule|send|take|update)\b/i.test(requestedText)) {
    return 'The requested item combines separate Family actions or non-contiguous items.';
  }
  const requestedItemPattern = requestedText
    .split(/\s+/)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  const losesProductPercentage = requestedItemPattern.length > 0
    && !/\d+(?:\.\d+)?\s*%/.test(requestedText)
    && itemSpans.some((span) => new RegExp(
      `\\b\\d+(?:\\.\\d+)?\\s*%\\s+${requestedItemPattern}\\b`,
      'i',
    ).test(span));
  if (losesProductPercentage) {
    return 'The requested item drops a product percentage from the authorized Family message.';
  }
  if (manifestTargetsAnotherSurface(evidence)) {
    return 'The authorized message targets another surface, not a Family list.';
  }
  const currentText = currentEvidenceText(evidence);
  const currentNamedLists = explicitlyNamedFamilyLists(currentText);
  const namedLists = currentNamedLists.length > 0
    ? currentNamedLists
    : explicitlyNamedFamilyLists(message);
  if (namedLists.length > 1) return 'The authorized message names more than one Family list.';
  if (namedLists.length === 1
    && normalizedIdentity(namedLists[0]) !== normalizedIdentity(input.list)) {
    return 'The requested list conflicts with the list named in the authorized message.';
  }

  for (const field of ['quantity', 'notes'] as const) {
    if (input[field] !== undefined && !valueGroundedInOneEvidenceSpan(evidence, input[field])) {
      return `${field} is not grounded in the authorized Family message.`;
    }
  }
  if (input.assignee !== undefined && !assigneeIsGrounded(input.assignee, evidence)) {
    return 'assignee is not grounded in the authorized Family message.';
  }
  if (!dueDateIsGrounded(input.due_date, evidence)) {
    return 'due_date is not grounded in the authorized Family message.';
  }
  return undefined;
}

function validateAuthorizedItemIdentity(
  input: Record<string, unknown>,
  evidence: AuthorizedFamilyManifestEvidence,
  options: { includeArchived?: boolean } = {},
): { item: FamilyListItem } | { error: string } {
  const currentText = currentEvidenceText(evidence);
  const currentReferences = referencedFamilyItemIds(currentText);
  const currentNamesRequestedItem = currentText.split(/\r?\n/)
    .some((span) => naturalTargetScore(span, input.item_text) > 0);
  if (currentReferences.length > 0 || currentNamesRequestedItem) {
    return validateNaturalItemIdentity(input, currentText, options);
  }
  return validateNaturalItemIdentity(input, evidenceText(evidence), options);
}

function validateNaturalItemIdentity(
  input: Record<string, unknown>,
  message: string,
  options: { includeArchived?: boolean } = {},
): { item: FamilyListItem } | { error: string } {
  const parsed = positiveInteger(input.item_id, 'item_id');
  if (parsed.error || !parsed.value) return { error: parsed.error || 'Invalid item_id.' };
  const item = getFamilyListItem(parsed.value);
  if (!item) return { error: itemNotFound(parsed.value) };
  const expectedText = String(input.item_text || '').trim();
  const expectedList = String(input.current_list || input.list || '').trim();
  if (!expectedText || !expectedList) {
    return { error: 'The live item text and list are required to resolve a natural Family reference.' };
  }
  if (
    normalizedIdentity(item.text) !== normalizedIdentity(expectedText)
    || normalizedIdentity(item.list_name) !== normalizedIdentity(expectedList)
  ) {
    return { error: 'The item ID, text, and list do not identify the same live Family row.' };
  }
  if (!message.trim()) return { error: 'The Family-list action has no source evidence.' };
  const references = referencedFamilyItemIds(message);
  if (references.length > 1 || (references.length === 1 && references[0] !== item.id)) {
    return { error: 'The current message references a different or ambiguous Family item.' };
  }
  const namedLists = explicitlyNamedFamilyLists(message);
  const allowedNamedLists = new Set([
    normalizedIdentity(item.list_name),
    normalizedIdentity(input.list),
  ].filter(Boolean));
  if (namedLists.some((name) => !allowedNamedLists.has(normalizedIdentity(name)))) {
    return { error: 'The current message names a different or ambiguous Family list.' };
  }
  if (references.length === 0) {
    const candidates = listFamilyListItems({
      include_archived: options.includeArchived === true,
      limit: 500,
    });
    if (candidates.length >= 500) {
      return { error: 'I could not safely prove the natural item reference is unique.' };
    }
    const shouldScopeToCurrentList = namedLists.some(
      (name) => normalizedIdentity(name) === normalizedIdentity(item.list_name),
    );
    const scopedCandidates = shouldScopeToCurrentList
      ? candidates.filter((candidate) => normalizedIdentity(candidate.list_name) === normalizedIdentity(item.list_name))
      : candidates;
    const ranked = scopedCandidates
      .map((candidate) => ({
        candidate,
        score: Math.max(0, ...message.split(/\r?\n/)
          .map((span) => naturalTargetScore(span, candidate.text))),
      }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);
    if (ranked.length === 0 || ranked[0].candidate.id !== item.id
      || (ranked[1] && ranked[1].score === ranked[0].score)) {
      return { error: 'That natural item reference is missing or ambiguous.' };
    }
  }
  return { item };
}

function editFieldsAreGrounded(
  input: Record<string, unknown>,
  evidence: AuthorizedFamilyManifestEvidence,
): boolean {
  const message = evidenceText(evidence);
  for (const field of ['list', 'text', 'quantity', 'notes'] as const) {
    if (input[field] !== undefined && !valueGroundedInOneEvidenceSpan(evidence, input[field])) return false;
  }
  if (input.assignee !== undefined && !assigneeIsGrounded(input.assignee, evidence)) return false;
  if (!dueDateIsGrounded(input.due_date, evidence)) return false;
  if (Array.isArray(input.clear_fields)) {
    for (const field of input.clear_fields.map(String)) {
      if (!new RegExp(`\\b(?:clear|remove|unset|no)\\b[^.]{0,80}\\b${field.replace('_', ' ')}\\b`, 'i').test(message)) {
        return false;
      }
    }
  }
  return true;
}

export const familyListTools: ToolDef[] = [
  {
    definition: {
      name: 'list_family_lists',
      description: 'List the Family-only lists and their item counts. These lists are local to the Family group and never sync to Google Tasks.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    handler: familyOnly(async () => {
      const lists = listFamilyLists();
      return lists.map((list) =>
        `${list.name}: ${list.open_count} open, ${list.completed_count} completed, ${list.archived_count} archived`,
      ).join('\n');
    }),
  },
  {
    definition: {
      name: 'create_family_list',
      description: 'Create an additional named list inside the Family group. This does not create a Google Tasks list.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'List name, such as Packing or School Supplies.' },
        },
        required: ['name'],
      },
    },
    handler: familyOnly(async (input, context) => {
      const authorization = authorizedListMutation('create_family_list', input, context);
      if ('error' in authorization) return rejectFamilyList(authorization.error);
      const name = String(input.name || '').trim();
      if (!name) return rejectFamilyList('A Family list name is required.');
      if (naturalTargetScore(authorization.text, name) < 1) {
        return rejectFamilyList('The new list name is not grounded in the authorized Family message.');
      }
      if (manifestTargetsAnotherSurface(authorization.evidence)
        && !/\blist\b/i.test(authorization.text)) {
        return rejectFamilyList('The authorized message targets another surface, not a new Family list.');
      }
      const existing = getFamilyListByName(name);
      if (existing) return `The Family list "${existing.name}" already exists.`;
      const normalizedName = normalizedIdentity(name);
      if (['task', 'tasks', 'to do', 'todo', 'family task', 'family tasks', 'list'].includes(normalizedName)) {
        return rejectFamilyList(`"${name}" is reserved for natural Family Task input. Choose a more specific list name.`);
      }
      const requestedAliases = new Set(familyListIdentityAliases(name));
      const aliasCollision = listFamilyLists().find((candidate) =>
        familyListIdentityAliases(candidate.name).some((alias) => requestedAliases.has(alias)));
      if (aliasCollision) {
        return rejectFamilyList(`"${name}" conflicts with the existing Family list "${aliasCollision.name}". Choose a distinct name.`);
      }
      const id = createFamilyList(name, contextUserId(context));
      return `Created Family list #${id}: "${name}".`;
    }),
  },
  {
    definition: {
      name: 'list_family_items',
      description: 'List Family-only items. Use for Family Tasks, Groceries, Errands, or another named Family list. Archived items are hidden unless explicitly requested.',
      input_schema: {
        type: 'object' as const,
        properties: {
          list: { type: 'string', description: 'Optional exact Family list name.' },
          status: { type: 'string', enum: ['open', 'completed', 'all'], description: 'Optional item status; defaults to all active items.' },
          assignee: { type: 'string', description: 'Optional assignee: me, both, unassigned, a Family member name, or stable user id.' },
          include_archived: { type: 'boolean', description: 'Include recoverably archived items. Defaults to false.' },
          due_after: { type: 'string', description: 'Optional inclusive ISO lower bound for due dates.' },
          due_before: { type: 'string', description: 'Optional inclusive ISO upper bound for due dates.' },
          limit: { type: 'number', description: 'Maximum results, from 1 to 500. Defaults to 200.' },
        },
        required: [],
      },
    },
    handler: familyOnly(async (input, context) => {
      let listId: number | undefined;
      let listName: string | undefined;
      if (input.list !== undefined) {
        listName = String(input.list).trim();
        const list = getFamilyListByName(listName);
        if (!list) return `No Family list named "${listName}".`;
        listId = list.id;
        listName = list.name;
      }

      const statusRaw = input.status === undefined ? undefined : String(input.status);
      const status = statusRaw && statusRaw !== 'all'
        ? statusRaw as FamilyListItemStatus
        : undefined;
      if (statusRaw && !['open', 'completed', 'all'].includes(statusRaw)) {
        return 'status must be open, completed, or all.';
      }

      let assignee: string | null | undefined;
      if (input.assignee !== undefined) {
        const resolved = resolveAssignee(input.assignee, context);
        if ('error' in resolved) return resolved.error;
        assignee = resolved.value;
      }

      const dueAfter = normalizeDate(input.due_after, 'due_after');
      if (dueAfter.error) return dueAfter.error;
      const dueBefore = normalizeDate(input.due_before, 'due_before');
      if (dueBefore.error) return dueBefore.error;
      if (dueAfter.value && dueBefore.value && new Date(dueAfter.value) > new Date(dueBefore.value)) {
        return 'due_after must be before or equal to due_before.';
      }

      let limit: number | undefined;
      if (input.limit !== undefined) {
        const parsed = positiveInteger(input.limit, 'limit');
        if (parsed.error || !parsed.value || parsed.value > 500) return 'limit must be an integer from 1 to 500.';
        limit = parsed.value;
      }

      const items = listFamilyListItems({
        list_id: listId,
        status,
        assignee,
        include_archived: input.include_archived === true,
        due_after: dueAfter.value || undefined,
        due_before: dueBefore.value || undefined,
        limit,
      });
      if (items.length === 0) {
        return listName ? `No matching items in "${listName}".` : 'No matching Family items.';
      }

      const groups = new Map<string, FamilyListItem[]>();
      for (const item of items) {
        const group = groups.get(item.list_name) || [];
        group.push(item);
        groups.set(item.list_name, group);
      }
      return Array.from(groups.entries())
        .map(([name, rows]) => `${name}:\n${rows.map(formatItem).join('\n')}`)
        .join('\n\n');
    }),
  },
  {
    definition: {
      name: 'add_family_item',
      description: 'Add one source-bound item to an existing Family-only list. Natural household input such as "we\'re out of milk" is actionable without a magic phrase. If a message names several items ("milk, eggs and bread"), call this once per item and do not combine them into one row. Pick whichever live list fits best; an explicit list cue wins. An exact open item is idempotent unless the sender explicitly says another, one more, duplicate, or additional item. Completed and archived rows are history, so a fresh add creates a new active row. Never ask the user to rephrase, re-send, or confirm. Include quantity, notes, due date, or assignee only when plainly stated in the cited request; labels are not required. This never creates or syncs an owner task.',
      input_schema: {
        type: 'object' as const,
        properties: {
          list: { type: 'string', description: 'Exact Family list name.' },
          text: { type: 'string', description: 'Item or task text.' },
          quantity: { type: 'string', description: 'Optional quantity, including units such as "2" or "1 lb".' },
          notes: { type: 'string', description: 'Optional notes.' },
          due_date: { type: 'string', description: 'Optional ISO date or timestamp.' },
          assignee: { type: 'string', description: 'Optional: me, both, unassigned, a Family member name, or stable user id. Defaults to unassigned.' },
        },
        required: ['list', 'text'],
      },
    },
    handler: familyOnly(async (input, context) => {
      const authorization = authorizedListMutation('add_family_item', input, context);
      if ('error' in authorization) return rejectFamilyList(authorization.error);
      const groundingError = validateAddEvidence(input, authorization.evidence);
      if (groundingError) return rejectFamilyList(`Nothing was added: ${groundingError}`);

      const listName = String(input.list || '').trim();
      const list = getFamilyListByName(listName);
      if (!list) return rejectFamilyList(`No Family list named "${listName}". Create it first with create_family_list.`);
      const itemText = String(input.text || '').trim();
      if (!itemText) return rejectFamilyList('Family item text cannot be empty.');

      const due = normalizeDate(input.due_date, 'due_date');
      if (due.error) return rejectFamilyList(due.error);
      const assignee = resolveAssignee(input.assignee, context, authorization.evidence);
      if ('error' in assignee) return rejectFamilyList(assignee.error);

      const activeItems = listFamilyListItems({
        list_id: list.id,
        status: 'open',
        include_archived: false,
        limit: 500,
      });
      const existing = activeItems.find(
        (candidate) => normalizedIdentity(candidate.text) === normalizedIdentity(itemText),
      );
      if (existing && !explicitDuplicateItemRequested(authorization.evidence)) {
        return `Already on ${list.name}: ${formatItem(existing)}`;
      }
      if (activeItems.length >= 500) {
        return rejectFamilyList(`I could not safely check all active items in ${list.name} for a duplicate; nothing was added.`);
      }

      const id = addFamilyListItem({
        list_id: list.id,
        text: itemText,
        quantity: normalizeOptionalText(input.quantity),
        notes: normalizeOptionalText(input.notes),
        due_date: due.value,
        assignee: assignee.value,
        created_by_user_id: contextUserId(context),
      });
      const item = getFamilyListItem(id);
      return item ? `Added to ${list.name}: ${formatItem(item)}` : `Added Family item #family-item:${id}.`;
    }),
  },
  {
    definition: {
      name: 'edit_family_item',
      description: 'Edit or move an active Family-only list item. To clear quantity, notes, due date, or assignee, include that field in clear_fields.',
      input_schema: {
        type: 'object' as const,
        properties: {
          item_id: { type: 'number', description: 'The N in #family-item:N.' },
          item_text: { type: 'string', description: 'Exact current item text returned by list_family_items.' },
          current_list: { type: 'string', description: 'Exact current list name returned by list_family_items.' },
          list: { type: 'string', description: 'Move the item to this exact Family list name.' },
          text: { type: 'string', description: 'Replacement item text.' },
          quantity: { type: 'string', description: 'Replacement quantity.' },
          notes: { type: 'string', description: 'Replacement notes.' },
          due_date: { type: 'string', description: 'Replacement ISO due date or timestamp.' },
          assignee: { type: 'string', description: 'Replacement: me, both, unassigned, a Family member name, or stable user id.' },
          clear_fields: {
            type: 'array',
            items: { type: 'string', enum: ['quantity', 'notes', 'due_date', 'assignee'] },
            description: 'Optional fields to clear.',
          },
        },
        required: ['item_id', 'item_text', 'current_list'],
      },
    },
    handler: familyOnly(async (input, context) => {
      const authorization = authorizedListMutation('edit_family_item', input, context);
      if ('error' in authorization) return rejectFamilyList(authorization.error);
      if (manifestTargetsAnotherSurface(authorization.evidence)) {
        return rejectFamilyList('The authorized message targets another surface, not a Family list item.');
      }
      const identity = validateAuthorizedItemIdentity(input, authorization.evidence);
      if ('error' in identity) return rejectFamilyList(identity.error);
      const item = identity.item;
      if (!editFieldsAreGrounded(input, authorization.evidence)) {
        return rejectFamilyList('One or more proposed Family-item changes were not grounded in the authorized Family messages; nothing was updated.');
      }
      if (item.archived_at) return rejectFamilyList(`#family-item:${item.id} is archived. Restore it before editing.`);

      const changes: Parameters<typeof updateFamilyListItem>[1] = {
        updated_by_user_id: contextUserId(context),
      };
      let requestedChanges = 0;

      if (input.list !== undefined) {
        const listName = String(input.list).trim();
        const list = getFamilyListByName(listName);
        if (!list) return rejectFamilyList(`No Family list named "${listName}".`);
        changes.list_id = list.id;
        requestedChanges += 1;
      }
      if (input.text !== undefined) {
        const text = String(input.text).trim();
        if (!text) return rejectFamilyList('Family item text cannot be empty.');
        changes.text = text;
        requestedChanges += 1;
      }
      if (input.quantity !== undefined) {
        changes.quantity = normalizeOptionalText(input.quantity) ?? null;
        requestedChanges += 1;
      }
      if (input.notes !== undefined) {
        changes.notes = normalizeOptionalText(input.notes) ?? null;
        requestedChanges += 1;
      }
      if (input.due_date !== undefined) {
        const due = normalizeDate(input.due_date, 'due_date');
        if (due.error) return rejectFamilyList(due.error);
        changes.due_date = due.value ?? null;
        requestedChanges += 1;
      }
      if (input.assignee !== undefined) {
        const assignee = resolveAssignee(input.assignee, context, authorization.evidence);
        if ('error' in assignee) return rejectFamilyList(assignee.error);
        changes.assignee = assignee.value;
        requestedChanges += 1;
      }

      const clearFields = Array.isArray(input.clear_fields)
        ? input.clear_fields.map(String)
        : [];
      const allowedClear = new Set(['quantity', 'notes', 'due_date', 'assignee']);
      if (clearFields.some((field) => !allowedClear.has(field))) {
        return rejectFamilyList('clear_fields may contain only quantity, notes, due_date, or assignee.');
      }
      for (const field of clearFields) {
        changes[field as 'quantity' | 'notes' | 'due_date' | 'assignee'] = null;
        requestedChanges += 1;
      }

      if (requestedChanges === 0) return rejectFamilyList('No Family item changes were specified.');
      const targetListId = changes.list_id ?? item.list_id;
      const targetText = changes.text ?? item.text;
      if (targetListId !== item.list_id || normalizedIdentity(targetText) !== normalizedIdentity(item.text)) {
        const targetItems = listFamilyListItems({
          list_id: targetListId,
          status: item.status,
          include_archived: false,
          limit: 500,
        });
        if (targetItems.length >= 500) {
          return rejectFamilyList('I could not safely check the destination list for a duplicate; nothing was updated.');
        }
        const duplicate = targetItems.find((candidate) =>
          candidate.id !== item.id
          && normalizedIdentity(candidate.text) === normalizedIdentity(targetText));
        if (duplicate) return rejectFamilyList(`That change would duplicate ${formatItem(duplicate)}; nothing was updated.`);
      }
      const updated = updateFamilyListItem(item.id, changes);
      if (!updated) return rejectFamilyList(`#family-item:${item.id} could not be updated.`);
      const latest = getFamilyListItem(item.id);
      return latest ? `Updated ${formatItem(latest)}` : `Updated #family-item:${item.id}.`;
    }),
  },
  {
    definition: {
      name: 'complete_family_item',
      description: 'Mark an active Family-only list item complete. This does not affect Google Tasks or the owner task system.',
      input_schema: {
        type: 'object' as const,
        properties: {
          item_id: { type: 'number', description: 'The N in #family-item:N.' },
          item_text: { type: 'string', description: 'Exact current item text returned by list_family_items.' },
          list: { type: 'string', description: 'Exact current list name returned by list_family_items.' },
        },
        required: ['item_id', 'item_text', 'list'],
      },
    },
    handler: familyOnly(async (input, context) => {
      const authorization = authorizedListMutation('complete_family_item', input, context);
      if ('error' in authorization) return rejectFamilyList(authorization.error);
      if (manifestTargetsAnotherSurface(authorization.evidence)) {
        return rejectFamilyList('The authorized message targets another surface, not a Family list item.');
      }
      const identity = validateAuthorizedItemIdentity(input, authorization.evidence);
      if ('error' in identity) return rejectFamilyList(identity.error);
      const item = identity.item;
      if (item.archived_at) return rejectFamilyList(`#family-item:${item.id} is archived. Restore it before completing it.`);
      if (item.status === 'completed') return `#family-item:${item.id} is already completed.`;
      if (!completeFamilyListItem(item.id, contextUserId(context))) {
        return rejectFamilyList(`#family-item:${item.id} could not be completed.`);
      }
      return `Completed #family-item:${item.id}: ${item.text}.`;
    }),
  },
  {
    definition: {
      name: 'reopen_family_item',
      description: 'Reopen a completed Family-only list item.',
      input_schema: {
        type: 'object' as const,
        properties: {
          item_id: { type: 'number', description: 'The N in #family-item:N.' },
          item_text: { type: 'string', description: 'Exact current item text returned by list_family_items.' },
          list: { type: 'string', description: 'Exact current list name returned by list_family_items.' },
        },
        required: ['item_id', 'item_text', 'list'],
      },
    },
    handler: familyOnly(async (input, context) => {
      const authorization = authorizedListMutation('reopen_family_item', input, context);
      if ('error' in authorization) return rejectFamilyList(authorization.error);
      if (manifestTargetsAnotherSurface(authorization.evidence)) {
        return rejectFamilyList('The authorized message targets another surface, not a Family list item.');
      }
      const identity = validateAuthorizedItemIdentity(input, authorization.evidence);
      if ('error' in identity) return rejectFamilyList(identity.error);
      const item = identity.item;
      if (item.archived_at) return rejectFamilyList(`#family-item:${item.id} is archived. Restore it before reopening it.`);
      if (item.status === 'open') return `#family-item:${item.id} is already open.`;
      if (!reopenFamilyListItem(item.id, contextUserId(context))) {
        return rejectFamilyList(`#family-item:${item.id} could not be reopened.`);
      }
      return `Reopened #family-item:${item.id}: ${item.text}.`;
    }),
  },
  {
    definition: {
      name: 'archive_family_item',
      description: 'Recoverably archive a Family-only list item. This hides it from normal lists but does not delete it.',
      input_schema: {
        type: 'object' as const,
        properties: {
          item_id: { type: 'number', description: 'The N in #family-item:N.' },
          item_text: { type: 'string', description: 'Exact current item text from list_family_items. Never infer or paraphrase it.' },
          list: { type: 'string', description: 'Exact current Family list name from list_family_items.' },
        },
        required: ['item_id', 'item_text', 'list'],
      },
    },
    handler: familyOnly(async (input, context) => {
      const authorization = authorizedListMutation('archive_family_item', input, context);
      if ('error' in authorization) return rejectFamilyList(authorization.error);
      if (manifestTargetsAnotherSurface(authorization.evidence)) {
        return rejectFamilyList('The authorized message targets another surface, not a Family list item; nothing was archived.');
      }
      const identity = validateAuthorizedItemIdentity(input, authorization.evidence);
      if ('error' in identity) return rejectFamilyList(identity.error);
      const item = identity.item;
      if (item.archived_at) return `#family-item:${item.id} is already archived.`;
      if (!archiveFamilyListItem(item.id, contextUserId(context))) {
        return rejectFamilyList(`#family-item:${item.id} could not be archived.`);
      }
      return `Archived #family-item:${item.id}: ${item.text}. It can be restored.`;
    }),
  },
  {
    definition: {
      name: 'restore_family_item',
      description: 'Restore a previously archived Family-only list item without changing whether it was open or completed.',
      input_schema: {
        type: 'object' as const,
        properties: {
          item_id: { type: 'number', description: 'The N in #family-item:N.' },
          item_text: { type: 'string', description: 'Exact current item text returned by list_family_items.' },
          list: { type: 'string', description: 'Exact current list name returned by list_family_items.' },
        },
        required: ['item_id', 'item_text', 'list'],
      },
    },
    handler: familyOnly(async (input, context) => {
      const authorization = authorizedListMutation('restore_family_item', input, context);
      if ('error' in authorization) return rejectFamilyList(authorization.error);
      if (manifestTargetsAnotherSurface(authorization.evidence)) {
        return rejectFamilyList('The authorized message targets another surface, not a Family list item.');
      }
      const identity = validateAuthorizedItemIdentity(input, authorization.evidence, { includeArchived: true });
      if ('error' in identity) return rejectFamilyList(identity.error);
      const item = identity.item;
      if (!item.archived_at) return `#family-item:${item.id} is not archived.`;
      if (!restoreFamilyListItem(item.id, contextUserId(context))) {
        return rejectFamilyList(`#family-item:${item.id} could not be restored.`);
      }
      return `Restored #family-item:${item.id}: ${item.text}.`;
    }),
  },
];
