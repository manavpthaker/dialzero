import type Anthropic from '@anthropic-ai/sdk';
import { calendarTools } from './calendar.js';
import { githubTools } from './github.js';
import { webTools } from './web.js';
import { linkedinTools } from './linkedin.js';
import { codexTools } from './codex.js';
import { householdTools } from './household.js';
import { browserTools } from './browser.js';
import { memoryTools } from './memory.js';
import { taskTools } from './tasks.js';
import { sparkTools } from './spark.js';
import { emailTools } from './email.js';
import { peopleTools } from './people.js';
import { relationshipTools } from './relationships.js';
import { messagesTools } from './messages.js';
import { recallTools } from './recall.js';
import { actionTools } from './actions.js';
import { errandTools } from './errands.js';
import { sendNowTools } from './send-now.js';
import { webBookingTools, bookingBrowserTools } from './web-booking.js';
import { wakeUpTools } from './wakeup.js';
import { computerUseTools } from './computer-use.js';
import { notionTools } from './notion.js';
import { familyCalendarTools } from './family-calendar.js';
import { familyListTools } from './family-lists.js';
import { familyMemoryTools } from './family-memory.js';
import { emailReconciliationTools } from './email-reconciliation.js';
import { startMcpServers } from '../mcp-manager.js';
import { getProfileConfig } from '../config.js';
import type { MessageRow } from '../db.js';
import {
  FAMILY_TOOL_POLICIES,
  hasAuthorizedFamilyManifestAction,
  type FamilyManifestActionAuthorization,
  type FamilyTurnManifest,
} from '../family-turn-manifest.js';

export interface ToolContext {
  groupKey: string;
  /** Authenticated profile user who caused this tool call. */
  userId?: string;
  /** Stable identifier shared by every tool call in one inbound agent run. */
  turnId?: string;
  /** Opaque stable identity of the exact inbound iMessage. Family action
   * receipts use this instead of a process-local turn UUID. */
  sourceMessageKey?: string;
  /** Original Apple message timestamp (ISO), not the later processing time. */
  sourceMessageTimestamp?: string;
  sourceMessageRowId?: number;
  sourceMessageGuid?: string | null;
  /** Exact text from the current inbound message, never prior conversation. */
  currentMessage?: string;
  /** Timestamped, Family-only transcript used for bounded shared continuations. */
  recentMessages?: ReadonlyArray<Pick<MessageRow, 'role' | 'content' | 'created_at'>>;
  /** The iMessage handle (phone/email for a DM, chat id for a group) to reply to.
   *  Present on the live message path; undefined for scheduler/heartbeat-authored
   *  runs. Used by tools that send the user an attachment (e.g. send_screenshot). */
  recipient?: string;
  /** Exact chat identifier. Kept distinct from recipient for authorization checks. */
  chatId?: string;
  /** Trusted, source-bound intent committed once for this Family inbound turn. */
  familyTurnManifest?: FamilyTurnManifest;
  /** Opaque grant for the exact mutable tool name + arguments being executed. */
  familyManifestAuthorization?: FamilyManifestActionAuthorization;
  /** Re-read the live Family participant set immediately before an external
   * mutation. Only the iMessage runtime supplies this capability. */
  reverifyFamilyAudience?: () => Promise<boolean>;
}

// Handlers normally return a string. The computer_use screenshot action returns
// an array of content blocks (image + text) so the model can actually see the
// screen; the OpenAI adapter converts these into function-call output content.
export type ToolResult = string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam>;

export interface ToolDef {
  definition: Anthropic.Tool;
  handler: (input: Record<string, unknown>, context?: ToolContext) => Promise<ToolResult>;
}

export const toolRegistry: Record<string, ToolDef[]> = {
  calendar: calendarTools,
  github: githubTools,
  web: webTools,
  linkedin: linkedinTools,
  codex: codexTools,
  household: householdTools,
  browser: browserTools,
  memory: memoryTools,
  tasks: taskTools,
  spark: sparkTools,
  email: emailTools,
  people: peopleTools,
  relationships: relationshipTools,
  messages: messagesTools,
  recall: recallTools,
  // Split by feature module (src/modules.ts) so each can be switched off alone.
  actions: [...actionTools, ...sendNowTools],
  errands: [...errandTools, ...wakeUpTools],
  'web-booking': webBookingTools,
  // Only the booking sub-agent (web-booking.ts BOOKING_GROUP) gets these.
  'booking-browser': bookingBrowserTools,
  'computer-use': computerUseTools,
  notion: notionTools,
  'family-calendar': familyCalendarTools,
  'family-lists': familyListTools,
  'family-memory': familyMemoryTools,
  'email-reconciliation': emailReconciliationTools,
  'family-web': createFamilyContextBoundTools(
    webTools.filter((tool) => tool.definition.name === 'web_search'),
  ),
};

const FAMILY_MCP_ALLOWLIST: Record<string, ReadonlySet<string>> = {
  instacart: new Set([
    'mcp_instacart_create_recipe',
    'mcp_instacart_create_shopping_list',
  ]),
  spotify: new Set([
    'mcp_spotify_play',
    'mcp_spotify_search',
  ]),
};

/** Deterministic authorization check used by every connector-style Family tool. */
export function isAuthorizedFamilyToolContext(
  context: ToolContext | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (context?.groupKey !== 'family') return false;

  const userId = context.userId?.trim();
  const chatId = context.chatId?.trim();
  const configuredChatId = env.GROUP_FAMILY?.trim();
  if (!userId || !chatId || !configuredChatId || chatId !== configuredChatId) return false;

  // If a recipient is present, it must be the same authenticated chat. This
  // prevents a confused-deputy call from reading in Family context while
  // directing an output somewhere else.
  const recipient = context.recipient?.trim();
  if (recipient && recipient !== chatId) return false;

  const profile = getProfileConfig();
  return [profile.owner, ...profile.members].some(
    (user) => user.id === userId && user.allowedGroups.includes('family'),
  );
}

/** Back-compatible, explicit name for callers testing Family MCP aliases. */
export function isAuthorizedFamilyMcpContext(
  context: ToolContext | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return isAuthorizedFamilyToolContext(context, env);
}

/** Apply authenticated user + exact Family-chat binding without mutating tools. */
export function createFamilyContextBoundTools(
  tools: readonly ToolDef[],
): ToolDef[] {
  return tools.map((tool) => ({
    definition: tool.definition,
    handler: async (input, context) => {
      if (!isAuthorizedFamilyToolContext(context)) {
        throw new Error('Family connector tools require an approved user in the configured Family chat.');
      }
      const toolName = tool.definition.name;
      if (!Object.hasOwn(FAMILY_TOOL_POLICIES, toolName)) {
        throw new Error(`Tool "${toolName}" has no explicit Family policy.`);
      }
      if (
        FAMILY_TOOL_POLICIES[toolName] !== 'family-read'
        && !hasAuthorizedFamilyManifestAction(context, toolName, input)
      ) {
        throw new Error('This Family connector change was not authorized by the current source-bound request.');
      }
      return tool.handler(input, context);
    },
  }));
}

/**
 * Build a Family alias from an MCP server through both an exact tool-name
 * allowlist and a live authenticated sender/chat wrapper. The raw server tools
 * remain available only under their original private registry key.
 */
export function createFamilyMcpAliasTools(
  serverName: string,
  tools: readonly ToolDef[],
): ToolDef[] {
  const allowlist = FAMILY_MCP_ALLOWLIST[serverName];
  if (!allowlist) return [];

  return createFamilyContextBoundTools(
    tools.filter((tool) => allowlist.has(tool.definition.name)),
  );
}

export interface McpRegistrationResult {
  registered: string[];
  familyAliases: string[];
  rejected: string[];
}

/**
 * Merge already-discovered MCP tools through the protected registry boundary.
 * Exported so acceptance tests can inject malicious server names without
 * launching a connector process or making a network request.
 */
export function registerDiscoveredMcpTools(
  mcpTools: Record<string, ToolDef[]>,
): McpRegistrationResult {
  const result: McpRegistrationResult = {
    registered: [],
    familyAliases: [],
    rejected: [],
  };

  for (const [serverName, tools] of Object.entries(mcpTools)) {
    const validName = /^[a-z0-9][a-z0-9_-]*$/.test(serverName);
    const familyAliasKey = `family-${serverName}`;
    const aliasWouldCollide = Boolean(
      FAMILY_MCP_ALLOWLIST[serverName]
      && familyAliasKey in toolRegistry,
    );
    if (
      !validName
      || serverName.startsWith('family-')
      || serverName in toolRegistry
      || aliasWouldCollide
    ) {
      console.warn(`[Tools] Refusing MCP server name that collides with a protected registry key: ${serverName}`);
      result.rejected.push(serverName);
      continue;
    }
    toolRegistry[serverName] = tools;
    result.registered.push(serverName);
    console.log(`[Tools] Registered MCP tools: ${serverName} (${tools.length} tools)`);

    if (FAMILY_MCP_ALLOWLIST[serverName]) {
      const familyTools = createFamilyMcpAliasTools(serverName, tools);
      toolRegistry[familyAliasKey] = familyTools;
      result.familyAliases.push(familyAliasKey);
      console.log(`[Tools] Registered Family-safe MCP tools: ${serverName} (${familyTools.length} tools)`);
    }
  }

  return result;
}

export async function registerMcpTools(): Promise<void> {
  const mcpTools = await startMcpServers();
  registerDiscoveredMcpTools(mcpTools);
}
