import { createHash, randomBytes } from 'node:crypto';

/**
 * Structured Family-tool telemetry deliberately contains no message text,
 * tool arguments, provider responses, or exception strings. The opaque refs
 * are salted once per process: they let one runtime correlate retries without
 * turning durable logs into an identity or chat-identifier database.
 */

export type FamilyToolDecision =
  | 'attempted'
  | 'allowed'
  | 'blocked'
  | 'executed'
  | 'failed';

export type FamilyToolReasonCode =
  | 'model_requested'
  | 'policy_allowed'
  | 'intent_not_authorized'
  | 'manifest_required'
  | 'manifest_rejected'
  | 'manifest_action_mismatch'
  | 'manifest_action_consumed'
  | 'context_not_authorized'
  | 'audience_reverification_failed'
  | 'tool_unavailable'
  | 'invalid_arguments'
  | 'handler_completed'
  | 'handler_failed'
  | 'provider_send_in_doubt'
  | 'unspecified';

export interface FamilyToolDecisionInput {
  decision: FamilyToolDecision;
  toolName: string;
  reasonCode: FamilyToolReasonCode;
  userId?: string;
  chatId?: string;
  turnId?: string;
}

export interface FamilyToolAuditRecord {
  event: 'family_tool_decision';
  recorded_at: string;
  decision: FamilyToolDecision;
  tool: string;
  reason_code: FamilyToolReasonCode;
  actor_ref?: string;
  chat_ref?: string;
  turn_ref?: string;
}

const PROCESS_REF_SALT = randomBytes(16).toString('hex');

const SAFE_DECISIONS = new Set<FamilyToolDecision>([
  'attempted', 'allowed', 'blocked', 'executed', 'failed',
]);
const SAFE_REASON_CODES = new Set<FamilyToolReasonCode>([
  'model_requested',
  'policy_allowed',
  'intent_not_authorized',
  'manifest_required',
  'manifest_rejected',
  'manifest_action_mismatch',
  'manifest_action_consumed',
  'context_not_authorized',
  'audience_reverification_failed',
  'tool_unavailable',
  'invalid_arguments',
  'handler_completed',
  'handler_failed',
  'provider_send_in_doubt',
  'unspecified',
]);

function safeDecision(value: unknown): FamilyToolDecision {
  return SAFE_DECISIONS.has(value as FamilyToolDecision)
    ? value as FamilyToolDecision
    : 'failed';
}

function safeReasonCode(value: unknown): FamilyToolReasonCode {
  return SAFE_REASON_CODES.has(value as FamilyToolReasonCode)
    ? value as FamilyToolReasonCode
    : 'unspecified';
}

function safeToolName(value: unknown): string {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return /^[a-z0-9][a-z0-9_-]{0,79}$/.test(candidate)
    ? candidate
    : 'invalid_tool_name';
}

function opaqueRuntimeRef(scope: string, value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return createHash('sha256')
    .update(`${PROCESS_REF_SALT}:${scope}:${value.trim()}`)
    .digest('hex')
    .slice(0, 16);
}

/** Pure record builder used by both runtime logging and privacy regressions. */
export function createFamilyToolAuditRecord(
  input: FamilyToolDecisionInput,
): FamilyToolAuditRecord {
  const record: FamilyToolAuditRecord = {
    event: 'family_tool_decision',
    recorded_at: new Date().toISOString(),
    decision: safeDecision(input.decision),
    tool: safeToolName(input.toolName),
    reason_code: safeReasonCode(input.reasonCode),
  };
  const actorRef = opaqueRuntimeRef('actor', input.userId);
  const chatRef = opaqueRuntimeRef('chat', input.chatId);
  const turnRef = opaqueRuntimeRef('turn', input.turnId);
  if (actorRef) record.actor_ref = actorRef;
  if (chatRef) record.chat_ref = chatRef;
  if (turnRef) record.turn_ref = turnRef;
  return record;
}

/** Best-effort only: telemetry must never affect the Family action path. */
export function logFamilyToolDecision(input: FamilyToolDecisionInput): void {
  try {
    console.info(`[family-tool] ${JSON.stringify(createFamilyToolAuditRecord(input))}`);
  } catch {
    // Do not turn a logging failure into a failed or duplicated household action.
  }
}
