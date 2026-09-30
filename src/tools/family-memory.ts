import { deleteMemory, getMemory, getRecentMemory, setMemory } from '../db.js';
import { getProfileConfig } from '../config.js';
import { hasAuthorizedFamilyManifestAction } from '../family-turn-manifest.js';
import type { ToolContext, ToolDef } from './index.js';

const FAMILY_GROUP = 'family';
const MAX_KEY_LENGTH = 120;
const MAX_VALUE_LENGTH = 4_000;

function requireFamily(context?: ToolContext): void {
  if (context?.groupKey !== FAMILY_GROUP) {
    throw new Error('Family memory is available only inside the verified Family group.');
  }
  const configuredChatId = process.env.GROUP_FAMILY?.trim();
  const requesterId = context.userId?.trim();
  const chatId = context.chatId?.trim();
  const recipient = context.recipient?.trim();
  const profile = getProfileConfig();
  const approvedUser = [profile.owner, ...profile.members].some(
    (user) => user.id === requesterId && user.allowedGroups.includes(FAMILY_GROUP),
  );
  if (
    !configuredChatId
    || !requesterId
    || !chatId
    || chatId !== configuredChatId
    || (recipient !== undefined && recipient !== chatId)
    || !approvedUser
  ) {
    throw new Error('Family memory requires an authenticated participant in the configured Family group chat.');
  }
}

function requireFamilyMutation(
  toolName: string,
  input: Record<string, unknown>,
  context?: ToolContext,
): void {
  requireFamily(context);
  if (!hasAuthorizedFamilyManifestAction(context, toolName, input)) {
    throw new Error('This Family-memory change was not authorized by the current source-bound request.');
  }
}

function normalizeKeySyntax(raw: string): string {
  const key = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, MAX_KEY_LENGTH);
  if (!key) {
    throw new Error('Use a descriptive Family memory key.');
  }
  return key;
}

function normalizeUserKey(raw: string): string {
  const key = normalizeKeySyntax(raw);
  if (
    key.startsWith('delivery_')
    || key.startsWith('security_')
    || key.startsWith('coordination_')
  ) {
    throw new Error('Use a descriptive Family memory key that does not use a reserved prefix.');
  }
  return key;
}

function normalizeValue(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error('Family memory cannot be empty.');
  if (value.length > MAX_VALUE_LENGTH) {
    throw new Error(`Family memory is limited to ${MAX_VALUE_LENGTH} characters per entry.`);
  }
  return value;
}

export const familyMemoryTools: ToolDef[] = [
  {
    definition: {
      name: 'remember_family_context',
      description: 'Save a household note, recurring logistic, preference, or decision in the isolated Family memory. This never writes global facts or another group. Context-only conversation may use this tool before returning FAMILY_SILENT.',
      input_schema: {
        type: 'object' as const,
        properties: {
          key: { type: 'string', description: 'Short descriptive key, such as school_pickup_routine or dinner_preference.' },
          value: { type: 'string', description: 'The Family-only information to remember.' },
        },
        required: ['key', 'value'],
      },
    },
    handler: async (input, context) => {
      requireFamilyMutation('remember_family_context', input, context);
      const { key: rawKey, value: rawValue } = input as { key: string; value: string };
      const key = normalizeUserKey(rawKey);
      const value = normalizeValue(rawValue);
      setMemory(FAMILY_GROUP, key, value);
      return `Saved to Family memory: ${key}.`;
    },
  },
  {
    definition: {
      name: 'note_family_coordination',
      description: 'Record an unresolved Family coordination need or open decision. This is Family-only context and does not change calendars, lists, carts, playback, or outside state.',
      input_schema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string', description: 'Short topic, such as school_pickup or holiday_plan.' },
          note: { type: 'string', description: 'What still needs coordination or a decision.' },
        },
        required: ['topic', 'note'],
      },
    },
    handler: async (input, context) => {
      requireFamilyMutation('note_family_coordination', input, context);
      const { topic, note } = input as { topic: string; note: string };
      const normalizedTopic = normalizeKeySyntax(topic);
      const key = `coordination_open_${normalizedTopic}`;
      setMemory(FAMILY_GROUP, key, normalizeValue(note));
      return `Saved open Family coordination: ${normalizedTopic}.`;
    },
  },
  {
    definition: {
      name: 'resolve_family_coordination',
      description: 'Mark an open Family coordination topic resolved while preserving it in Family-only memory.',
      input_schema: {
        type: 'object' as const,
        properties: {
          topic: { type: 'string', description: 'The topic used when the coordination note was saved.' },
          resolution: { type: 'string', description: 'Optional short resolution or decision.' },
        },
        required: ['topic'],
      },
    },
    handler: async (input, context) => {
      requireFamilyMutation('resolve_family_coordination', input, context);
      const { topic, resolution } = input as { topic: string; resolution?: string };
      const normalizedTopic = normalizeKeySyntax(topic);
      const openKey = `coordination_open_${normalizedTopic}`;
      const existing = getMemory(FAMILY_GROUP, openKey);
      if (!existing) return `No open Family coordination topic exists for ${normalizedTopic}.`;
      const resolvedValue = resolution?.trim()
        ? `${existing}\nResolution: ${normalizeValue(resolution)}`
        : existing;
      setMemory(FAMILY_GROUP, `coordination_resolved_${normalizedTopic}`, resolvedValue);
      deleteMemory(FAMILY_GROUP, openKey);
      return `Resolved Family coordination: ${normalizedTopic}.`;
    },
  },
  {
    definition: {
      name: 'list_family_coordination',
      description: 'List unresolved coordination needs and open decisions from Family-only memory.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
    handler: async (_input, context) => {
      requireFamily(context);
      const rows = getRecentMemory(FAMILY_GROUP, { prefix: 'coordination_open_', limit: 50 });
      if (rows.length === 0) return 'No unresolved Family coordination needs.';
      return rows
        .map((row) => `- ${row.key.slice('coordination_open_'.length)}: ${row.value}`)
        .join('\n');
    },
  },
  {
    definition: {
      name: 'recall_family_context',
      description: 'Read one exact entry from the isolated Family memory. It cannot search global facts, people, messages, tasks, or other groups.',
      input_schema: {
        type: 'object' as const,
        properties: {
          key: { type: 'string', description: 'The Family memory key.' },
        },
        required: ['key'],
      },
    },
    handler: async (input, context) => {
      requireFamily(context);
      const key = normalizeUserKey((input as { key: string }).key);
      const value = getMemory(FAMILY_GROUP, key);
      return value ? `${key}: ${value}` : `No Family memory is stored for ${key}.`;
    },
  },
  {
    definition: {
      name: 'list_family_context',
      description: 'List recent entries from the isolated Family memory. Internal delivery-dedup records are never returned.',
      input_schema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Maximum entries to return, from 1 to 20. Defaults to 10.' },
        },
        required: [],
      },
    },
    handler: async (input, context) => {
      requireFamily(context);
      const requested = Number((input as { limit?: number }).limit ?? 10);
      const limit = Math.max(1, Math.min(20, Number.isFinite(requested) ? Math.floor(requested) : 10));
      const rows = getRecentMemory(FAMILY_GROUP, {
        excludePrefixes: ['delivery_', 'security_'],
        limit,
      });
      if (rows.length === 0) return 'Family memory is empty.';
      return rows.map((row) => `- ${row.key}: ${row.value}`).join('\n');
    },
  },
];
