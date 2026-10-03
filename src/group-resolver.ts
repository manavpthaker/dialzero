import { getProfileConfig } from './config.js';
import { enabledToolKeys, isOwnedOn } from './modules.js';

export interface GroupConfig {
  key: string;
  name: string;
  tools: string[];
  contextPath: string;
  /** Whether replies are visible only to the owner or to multiple trusted users. */
  audience?: 'private' | 'shared';
  /** Group-chat dispatch policy. DMs are handled separately by the channel. */
  replyPolicy?: 'trigger' | 'always' | 'smart' | 'observe';
  /** Exact profile user ids expected in a shared chat. */
  expectedUserIds?: string[];
}

const groups: Map<string, GroupConfig> = new Map();
const ambiguousGroupIds = new Set<string>();
// Chat IDs configured for a group whose module is off. Never fall through to admin.
const disabledGroupIds = new Set<string>();

// The owner's full toolset. Used by the Admin group and by the DM fallback in
// resolveGroup, so the two can't drift apart.
// Filtered to the tools of switched-on modules (src/modules.ts) at use time.
const ADMIN_TOOLS = ['calendar', 'github', 'web', 'linkedin', 'codex', 'household', 'browser', 'memory', 'tasks', 'email', 'email-reconciliation', 'people', 'relationships', 'messages', 'recall', 'actions', 'errands', 'web-booking', 'instacart', 'spotify', 'computer-use', 'notion', 'omi'];

export function adminTools(): string[] {
  return enabledToolKeys(ADMIN_TOOLS);
}

export function initGroups() {
  groups.clear();
  ambiguousGroupIds.clear();
  disabledGroupIds.clear();
  const profile = getProfileConfig();
  const familyUsers = [profile.owner, ...profile.members]
    .filter((user) => user.allowedGroups.includes('family'))
    .map((user) => user.id);

  const defs: { envKey: string; config: Omit<GroupConfig, 'key'> & { key: string } }[] = [
    {
      envKey: 'GROUP_ADMIN',
      config: {
        key: 'admin',
        name: 'Admin',
        tools: ADMIN_TOOLS,
        contextPath: 'context/admin',
      },
    },
    {
      envKey: 'GROUP_WORK',
      config: {
        key: 'work',
        name: 'Work',
        tools: ['github', 'web', 'codex', 'browser', 'memory', 'tasks'],
        contextPath: 'context/work',
      },
    },
    {
      envKey: 'GROUP_HOME',
      config: {
        key: 'home',
        name: 'Home',
        tools: ['calendar', 'household', 'web', 'browser', 'memory', 'tasks', 'email', 'people', 'instacart', 'spotify'],
        contextPath: 'context/personal',
      },
    },
    {
      envKey: 'GROUP_FAMILY',
      config: {
        key: 'family',
        name: 'Family',
        tools: ['family-calendar', 'family-lists', 'family-memory', 'family-web', 'family-instacart', 'family-spotify'],
        contextPath: 'context/family',
        audience: 'shared',
        replyPolicy: 'smart',
        expectedUserIds: familyUsers,
      },
    },
    {
      envKey: 'GROUP_HEALTH',
      config: {
        key: 'health',
        name: 'Health',
        tools: ['memory', 'tasks', 'people'],
        contextPath: 'context/health',
      },
    },
  ];

  // Synthetic group used by the nightly reflection job. Not env-gated — registered
  // unconditionally because the scheduler instantiates it directly without going
  // through resolveGroup. Defined here so its config lives next to other groups.

  // Collisions are judged across every configured chat ID, including groups
  // whose module is switched off, so turning a module off can never turn a
  // shared chat ID into a live one.
  const claimed = new Map<string, string>();
  for (const { envKey, config } of defs) {
    const groupId = process.env[envKey]?.trim();
    if (!groupId) continue;
    if (ambiguousGroupIds.has(groupId)) continue;
    const existing = claimed.get(groupId);
    if (existing) {
      console.error(`[groups] Configuration collision: ${existing} and ${config.name} share one chat ID; both are disabled`);
      groups.delete(groupId);
      ambiguousGroupIds.add(groupId);
      continue;
    }
    claimed.set(groupId, config.name);
    if (!isOwnedOn('groups', config.key)) {
      console.log(`[groups] ${config.name} chat configured but its module is off; ignoring it`);
      disabledGroupIds.add(groupId);
      continue;
    }
    groups.set(groupId, { ...config, tools: enabledToolKeys(config.tools) });
  }
}

function isDM(identifier: string): boolean {
  // iMessage DMs use phone (+1...) or email (user@domain.com)
  // Group chats use identifiers starting with "chat" or "iMessage;+;chat"
  if (identifier.startsWith('+')) return true;
  if (identifier.startsWith('chat') || identifier.startsWith('iMessage;')) return false;
  if (identifier.includes('@') && !identifier.startsWith('chat')) return true;
  return false;
}

export function resolveGroup(remoteJid: string): GroupConfig | null {
  const normalizedId = remoteJid.trim();

  // Check mapped groups first
  const mapped = groups.get(normalizedId);
  if (mapped) return mapped;

  // A duplicated ID is unsafe even if its shape resembles a DM. Without this
  // guard, removing both mapped groups above could fall through to full Admin.
  if (ambiguousGroupIds.has(normalizedId)) {
    console.error('[groups] Refusing an ambiguous chat ID shared by multiple group configurations');
    return null;
  }

  if (disabledGroupIds.has(normalizedId)) return null;

  // DMs (phone or email) — treat as admin context with all tools
  if (isDM(normalizedId)) {
    return {
      key: 'admin',
      name: 'Admin',
      tools: adminTools(),
      contextPath: 'context/admin',
    };
  }

  // Unmapped chat — log it so we can capture the ID
  console.log(`[groups] Unmapped chat: ${normalizedId} — add to .env to enable`);
  return null;
}

/** Exposed for startup health checks and isolated authorization tests. */
export function isAmbiguousGroupId(remoteJid: string): boolean {
  return ambiguousGroupIds.has(remoteJid.trim());
}

export function getAllGroups(): GroupConfig[] {
  return Array.from(groups.values());
}

export const REFLECTION_GROUP: GroupConfig = {
  key: 'reflection',
  name: 'Nightly Reflection',
  tools: ['email', 'calendar', 'github', 'memory', 'tasks', 'people'],
  contextPath: 'context/reflection',
};

// Tier 1 Phase 1: Brain Pulse synthetic group. Drives the 11/16 proactive
// cron AND (Phase 2) the weekly hygiene summary. Same terse system-initiated
// tone in both cases.
//
// Tool list uses 'memory' (which covers save_fact/search_facts/facts_about per
// toolRegistry); do NOT use 'facts' — it's not a registered key and would be
// silently dropped by getScopedTools.
export const BRAIN_PULSE_GROUP: GroupConfig = {
  key: 'brain-pulse',
  name: 'Brain Pulse',
  tools: ['memory', 'tasks', 'people', 'calendar'],
  contextPath: 'context/brain-pulse',
};

// Owner-private relationship reminder composer. It receives deterministic
// cadence rows in its prompt and has no tools, so an unattended pulse cannot
// send to a contact or mutate the ledger.
export const RELATIONSHIP_PULSE_GROUP: GroupConfig = {
  key: 'relationship-pulse',
  name: 'Relationship Pulse',
  tools: [],
  contextPath: 'context/relationship-pulse',
};

// Idea Pulse synthetic group. Drives the twice-daily (10/15) proactive
// "here's what I could help with / ideas" ping. Distinct from BRAIN_PULSE_GROUP:
// brain-pulse surfaces aging DB rows (stale commitments, expiring facts, dormant
// leads); idea-pulse is generative — grounded in current state but allowed to
// pitch new angles. Broader read scope so the ideas are specific, not generic.
//
// 'memory' covers the fact ops; 'facts' is not a real registry key.
export const IDEA_PULSE_GROUP: GroupConfig = {
  key: 'idea-pulse',
  name: 'Idea Pulse',
  tools: ['memory', 'tasks', 'people', 'calendar'],
  contextPath: 'context/idea-pulse',
};
