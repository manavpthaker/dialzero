import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { transcribeAudio } from '../transcribe.js';
import {
  activateFamilyIMessageInbox,
  claimFamilyIMessage,
  getLatestObservedIMessageRowId,
  getQueuedFamilyIMessages,
  getFamilyIMessageInboxCursor,
  logIMessage,
  getMemory,
  setMemory,
  hasAssistantReplySince,
  dropUnansweredUserRowsSince,
  markFamilyIMessageFailedBeforeDispatch,
  markFamilyIMessageSendInDoubt,
  markFamilyIMessageSucceeded,
  quarantineIMessageChat,
  rebaseFamilyIMessageInboxAfterSourceReset,
  recordFamilyIMessageScan,
  recoverInterruptedFamilyIMessages,
  type FamilyIMessageInboxRow,
} from '../db.js';
import { toPlainText } from '../lib/plaintext.js';
import { decodeIMessageAttributedBody } from '../lib/imessage-attributed-body.js';
import { getProfileConfig, getOwner, getBotName } from '../config.js';
import { isFamilyOnlyHandle } from '../user-resolver.js';

const exec = promisify(execFile);

const TRIGGER = (process.env.TRIGGER_WORD || getProfileConfig().triggerWord).toLowerCase();
const CHAT_DB_PATH = `${homedir()}/Library/Messages/chat.db`;

export function getDefaultRecipient(): string | null {
  const ownerPhoneEnv = getOwner().phoneEnv || 'USER_OWNER';
  return process.env.DM_RECIPIENT || process.env[ownerPhoneEnv] || null;
}
const POLL_INTERVAL_MS = 2000;
const APPLE_EPOCH_OFFSET = 978307200;
const IMESSAGE_APPLESCRIPT_TIMEOUT_MS = Math.max(
  1_000,
  Number(process.env.IMESSAGE_APPLESCRIPT_TIMEOUT_MS) || 15_000,
);
const FAMILY_MESSAGE_SETTLE_MS = Math.max(
  2_000,
  Number(process.env.FAMILY_MESSAGE_SETTLE_MS) || 30_000,
);
const FAMILY_INBOX_MAX_AGE_MS = Math.max(
  60 * 60 * 1000,
  (Number(process.env.FAMILY_INBOX_MAX_AGE_HOURS) || 24) * 60 * 60 * 1000,
);
const FAMILY_ATTACHMENT_RETRY_DELAYS_MS = [500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000] as const;

// chat.db `message.date` is nanoseconds since 2001-01-01 on modern macOS
// (older versions stored seconds). Convert either to a Unix ISO timestamp.
function appleDateToISO(date: number): string {
  if (!date) return new Date(0).toISOString();
  const ms2001 = date > 1e12 ? date / 1e6 : date * 1000; // ns vs s
  return new Date(ms2001 + APPLE_EPOCH_OFFSET * 1000).toISOString();
}

export type ImageData = {
  base64: string;
  mimetype: string;
};

export type DocumentData = {
  base64: string;
  mimetype: string;
};

export type IMessageSourceMetadata = {
  rowId: number;
  guid: string | null;
  /** Original Messages.app timestamp, not Assistant's processing time. */
  timestamp: string;
  /** Opaque, stable identity for idempotent downstream action receipts. */
  key: string;
};

type MessageHandler = (msg: {
  remoteJid: string;
  senderJid: string;
  text: string;
  image?: ImageData;
  document?: DocumentData;
  sourceMessage: IMessageSourceMetadata;
}) => Promise<void>;

// Apple stores iMessage voice memos as Core Audio (.caf); other clips may be m4a/amr/etc.
const SUPPORTED_IMAGE = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
// Most iMessage photos arrive as HEIC (Claude vision can't read it). Convert with sips,
// which ships with macOS. Absolute path: launchd's PATH may be minimal.
const SIPS_BIN = process.env.SIPS_BIN || '/usr/bin/sips';

// Convert an unsupported image (heic/heic-sequence/tiff/avif/...) to a base64 JPEG via
// sips. Returns null on failure so the caller can skip without crashing the poll loop.
function convertImageToJpegBase64(
  filePath: string,
  rowId: number,
  privacySafeLogs = false,
): string | null {
  const tmpPath = join(tmpdir(), `assistant-img-${rowId}-${Date.now()}.jpg`);
  try {
    execFileSync(SIPS_BIN, ['-s', 'format', 'jpeg', filePath, '--out', tmpPath], {
      stdio: 'ignore',
    });
    const base64 = readFileSync(tmpPath).toString('base64');
    console.log(privacySafeLogs
      ? '[iMessage] Converted a Family image to JPEG via sips'
      : `[iMessage] Converted image → JPEG via sips: ${filePath}`);
    return base64;
  } catch (err) {
    if (privacySafeLogs) {
      console.warn('[iMessage] Family image conversion failed');
    } else {
      console.warn(`[iMessage] Image convert failed for ${filePath}:`, err instanceof Error ? err.message : err);
    }
    return null;
  } finally {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* best-effort cleanup */ }
  }
}

let onMessage: MessageHandler;
let lastMessageRowId = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let chatDb: InstanceType<typeof Database> | null = null;
let messageHasAttachmentCacheColumn = false;

export function setMessageHandler(handler: MessageHandler) {
  onMessage = handler;
}

async function runAppleScript(script: string): Promise<string> {
  const { stdout } = await exec('osascript', ['-e', script], {
    timeout: IMESSAGE_APPLESCRIPT_TIMEOUT_MS,
    killSignal: 'SIGKILL',
  });
  return stdout.trim();
}

function escapeForAppleScript(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function isGroupChat(identifier: string): boolean {
  // Group chats: "chat..." prefix, "iMessage;+;chat..." prefix, or hex UUID (e.g. "ce51a40a...")
  if (identifier.startsWith('chat') || identifier.startsWith('iMessage;+;chat')) return true;
  // Hex UUIDs from iMessage group chats (not a phone number, not an email)
  if (!identifier.startsWith('+') && !identifier.includes('@') && /^[a-f0-9]{20,}$/.test(identifier)) return true;
  return false;
}

function isDM(identifier: string): boolean {
  if (identifier.startsWith('+')) return true;
  if (identifier.startsWith('chat') || identifier.startsWith('iMessage;')) return false;
  if (identifier.includes('@') && !identifier.startsWith('chat')) return true;
  return false;
}

export function isConfiguredFamilyChat(
  chatId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const configured = env.GROUP_FAMILY?.trim();
  return Boolean(configured && chatId === configured);
}

export function buildIMessageSourceKey(chatId: string, rowId: number, guid: string | null): string {
  const identity = guid?.trim() ? `guid:${guid.trim()}` : `rowid:${rowId}`;
  return createHash('sha256').update(`${chatId}\0${identity}`).digest('hex');
}

/**
 * Choose the first durable Family cursor without creating a stop/start blind
 * spot. The prior process's exact-chat observation watermark closes that gap,
 * but it is not a handler-completion receipt: first activation still requires a
 * quiet, settled handoff so an already-observed in-flight row is not skipped.
 * If the global observation watermark is ahead of the current chat.db tip,
 * Messages was rebuilt/restored and old ROWIDs are no longer comparable, so
 * fail closed at the current tip rather than replaying restored history.
 */
export function chooseFamilyInboxActivationRowId(input: {
  currentLatestRowId: number;
  latestObservedGlobalRowId: number | null;
  latestObservedFamilyRowId: number | null;
}): number {
  const current = Math.max(0, Math.trunc(input.currentLatestRowId));
  const observedGlobal = input.latestObservedGlobalRowId;
  const observedFamily = input.latestObservedFamilyRowId;
  if (observedGlobal !== null && observedGlobal > current) return current;
  if (observedFamily !== null && observedFamily >= 0 && observedFamily <= current) {
    return observedFamily;
  }
  return current;
}

/** Messages.app sometimes leaves `text` NULL and stores the visible body only
 * in attributedBody. Live Family delivery and the observation ledger must use
 * the same resolved text or the durable cursor could permanently skip a real
 * request as an empty row. */
export function resolveIMessageText(
  text: string | null,
  attributedBody: Buffer | null,
): string {
  return text || decodeIMessageAttributedBody(attributedBody) || '';
}

export function isFamilyIMessageTooOld(
  timestamp: string,
  nowMs = Date.now(),
  maxAgeMs = FAMILY_INBOX_MAX_AGE_MS,
): boolean {
  const timestampMs = Date.parse(timestamp);
  return Number.isFinite(timestampMs) && nowMs - timestampMs > maxAgeMs;
}

export function shouldWaitForFamilyMessageContent(
  input: {
    outgoing: boolean;
    reaction: boolean;
    observationOnlyCollision: boolean;
    senderHandle: string;
    substantive: boolean;
    timestamp: string;
    /** Messages says an attachment exists but its join row is not visible yet. */
    attachmentMetadataPending?: boolean;
  },
  nowMs = Date.now(),
  settleMs = FAMILY_MESSAGE_SETTLE_MS,
): boolean {
  const timestampMs = Date.parse(input.timestamp);
  return !input.outgoing
    && !input.reaction
    && !input.observationOnlyCollision
    && Boolean(input.senderHandle)
    && (!input.substantive || input.attachmentMetadataPending === true)
    && Number.isFinite(timestampMs)
    && nowMs >= timestampMs
    && nowMs - timestampMs < settleMs;
}

export function isSubstantiveFamilyMessage(text: string, hasAttachment = false): boolean {
  if (hasAttachment) return true;
  return /[\p{L}\p{N}]/u.test(text.trim());
}

/** A mention is never required in Family, but accepting and removing one keeps
 * an optional "@assistant add..." or "Assistant, add..." from confusing action gates. */
export function stripOptionalFamilyMention(
  text: string,
  trigger = TRIGGER,
  botName = getProfileConfig().botName,
): string {
  const aliases = [trigger.replace(/^@+/, ''), botName]
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (aliases.length === 0) return text.trim();
  const mention = new RegExp(
    `^\\s*@?(?:${aliases.join('|')})(?:\\s*[:,;\\-]\\s*|\\s+|$)`,
    'i',
  );
  return text.replace(mention, '').trim();
}

/**
 * Decide whether a live iMessage row must bypass the global extraction daemon.
 * Besides the Family chat itself, this protects a Family-only user's messages
 * if they contact the assistant elsewhere. Outgoing group messages check participants
 * because their sender column is just `me`.
 */
export function shouldQuarantineIMessageFromGlobalExtraction(
  input: {
    chatId: string;
    senderHandle: string;
    isFromMe: boolean;
    participantHandles?: readonly string[];
    participantLookupFailed?: boolean;
  },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isFamilyScopedIMessage(input, env)) return true;
  if (input.participantLookupFailed) return true;
  return false;
}

/** True when a row is known to contain Family-private conversation. Unlike a
 * generic participant-lookup failure, these rows receive a durable privacy
 * marker so they can never reappear in global search after a remap/restart. */
export function isFamilyScopedIMessage(
  input: {
    chatId: string;
    senderHandle: string;
    isFromMe: boolean;
    participantHandles?: readonly string[];
  },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isConfiguredFamilyChat(input.chatId, env)) return true;
  if (!input.isFromMe && isFamilyOnlyHandle(input.senderHandle)) return true;
  if (input.isFromMe && isFamilyOnlyHandle(input.chatId)) return true;
  return (input.participantHandles ?? []).some((handle) => isFamilyOnlyHandle(handle));
}

/**
 * Terminal chat mode (scripts/chat.ts) replaces real sends with this, so you can
 * try the assistant without Messages: texts it would send are printed instead.
 */
type OutboundOverride = (recipient: string, text: string) => Promise<void>;
let outboundOverride: OutboundOverride | null = null;
export function setOutboundOverride(fn: OutboundOverride | null): void {
  outboundOverride = fn;
}

export async function sendMessage(recipient: string, text: string) {
  if (outboundOverride) return outboundOverride(recipient, toPlainText(text));
  // iMessage renders no markdown — strip it here, at the single outbound
  // chokepoint, so EVERY message (agent replies, scheduler briefs, proactive
  // pings) is plaintext, not just the paths that route through cos-outbound.
  // toPlainText is idempotent, so double-sanitizing an already-clean message
  // (e.g. one composed by ops-digest) is a harmless no-op.
  const escaped = escapeForAppleScript(toPlainText(text));

  const MAX_CHUNK = 15000;
  const chunks: string[] = [];
  for (let i = 0; i < escaped.length; i += MAX_CHUNK) {
    chunks.push(escaped.slice(i, i + MAX_CHUNK));
  }

  for (const chunk of chunks) {
    try {
      if (isGroupChat(recipient)) {
        // AppleScript chat IDs use "any;+;" or "iMessage;+;" prefix — try common prefixes
        const chatId = recipient.includes(';') ? recipient : `any;+;${recipient}`;
        await runAppleScript(
          `tell application "Messages" to send "${chunk}" to chat id "${chatId}"`
        );
      } else {
        await runAppleScript(
          `tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to buddy "${recipient}" of targetService
  send "${chunk}" to targetBuddy
end tell`
        );
      }
    } catch (err) {
      if (isConfiguredFamilyChat(recipient)) {
        console.error('[iMessage] Failed to send to the configured Family chat');
      } else {
        console.error(`[iMessage] Failed to send to ${recipient}:`, err);
      }
      throw err;
    }

    if (chunks.length > 1) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// Send an image file as an iMessage attachment. The reply path is otherwise
// text-only (sendMessage); this is the one outbound-attachment path, used by
// computer_use's send_screenshot. Mirrors sendMessage's DM-vs-group branch.
export async function sendImageMessage(recipient: string, filePath: string): Promise<void> {
  if (outboundOverride) return outboundOverride(recipient, `[image: ${filePath}]`);
  const escapedPath = filePath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  try {
    if (isGroupChat(recipient)) {
      const chatId = recipient.includes(';') ? recipient : `any;+;${recipient}`;
      await runAppleScript(
        `tell application "Messages" to send (POSIX file "${escapedPath}") to chat id "${chatId}"`
      );
    } else {
      await runAppleScript(
        `tell application "Messages"
  set targetService to 1st account whose service type = iMessage
  set targetBuddy to buddy "${recipient}" of targetService
  send (POSIX file "${escapedPath}") to targetBuddy
end tell`
      );
    }
  } catch (err) {
    if (isConfiguredFamilyChat(recipient)) {
      console.error('[iMessage] Failed to send an image to the configured Family chat');
    } else {
      console.error(`[iMessage] Failed to send image to ${recipient}:`, err);
    }
    throw err;
  }
}

async function alertOwnerOfUncertainFamilyDelivery(count: number): Promise<void> {
  if (count <= 0) return;
  const privateRecipient = getDefaultRecipient();
  if (!privateRecipient) {
    console.error('[iMessage] Could not privately alert the owner: no DM recipient is configured');
    return;
  }
  try {
    await sendMessage(
      privateRecipient,
      `${getBotName()} paused ${count} Family request${count === 1 ? '' : 's'} with an uncertain completion because replay could duplicate an action. Check whether each action already happened before resending it in the Family chat.`,
    );
  } catch {
    console.error('[iMessage] Could not deliver the private Family recovery alert');
  }
}

async function alertOwnerOfUnreadableFamilyAttachment(count: number): Promise<void> {
  if (count <= 0) return;
  const privateRecipient = getDefaultRecipient();
  if (!privateRecipient) {
    console.error('[iMessage] Could not privately alert the owner about an unreadable Family attachment');
    return;
  }
  try {
    await sendMessage(
      privateRecipient,
      `${getBotName()} could not safely read all attachments on ${count} Family request${count === 1 ? '' : 's'}, so no action was taken. Please resend the attachment${count === 1 ? '' : 's'} one message at a time in the Family chat.`,
    );
  } catch {
    console.error('[iMessage] Could not deliver the private Family attachment alert');
  }
}

async function alertOwnerOfFamilyInboxRebase(): Promise<void> {
  const privateRecipient = getDefaultRecipient();
  if (!privateRecipient) {
    console.error('[iMessage] Could not privately alert the owner about a Messages database reset');
    return;
  }
  try {
    await sendMessage(
      privateRecipient,
      `${getBotName()} detected that the Messages database was rebuilt and safely reset Family chat delivery at the current boundary. Restored older messages were not treated as new requests; resend anything that still matters.`,
    );
  } catch {
    console.error('[iMessage] Could not deliver the private Messages-reset alert');
  }
}

let staleFamilyAlertCount = 0;
let staleFamilyAlertTimer: ReturnType<typeof setTimeout> | null = null;

function queueStaleFamilyMessageAlert(): void {
  staleFamilyAlertCount += 1;
  if (staleFamilyAlertTimer) return;
  staleFamilyAlertTimer = setTimeout(() => {
    const count = staleFamilyAlertCount;
    staleFamilyAlertCount = 0;
    staleFamilyAlertTimer = null;
    const privateRecipient = getDefaultRecipient();
    if (!privateRecipient) {
      console.error('[iMessage] Could not privately alert the owner about stale Family requests');
      return;
    }
    void sendMessage(
      privateRecipient,
      `${getBotName()} skipped ${count} old Family request${count === 1 ? '' : 's'} recovered from Messages because acting on stale directives could be unsafe. Please resend anything that still matters in the Family chat.`,
    ).catch(() => {
      console.error('[iMessage] Could not deliver the private stale-Family-request alert');
    });
  }, 250);
}

type LoadedAttachments = {
  image?: ImageData;
  document?: DocumentData;
  audioPath?: string;
  supportedAttachmentCount: number;
  unsupportedMultiplicity: boolean;
};

type DispatchMessageArgs = {
  chatId: string;
  senderHandle: string;
  cleaned: string;
  sourceMessage: IMessageSourceMetadata;
  familyInboxId?: number;
  expectsAttachment?: boolean;
  image?: ImageData;
  document?: DocumentData;
  audioPath?: string;
};

// Keep each chat strictly ordered while allowing unrelated chats to run in
// parallel. pollMessages reads rows in ascending ROWID order, so appending each
// dispatch to its chat's tail preserves that order through async transcription
// and agent work as well.
const chatDispatchTails = new Map<string, Promise<void>>();
const scheduledFamilyInboxIds = new Set<number>();

// Pull the first image, PDF, and audio attachment off a message (one of each, at most).
function loadAttachments(messageRowId: number, privacySafeLogs = false): LoadedAttachments {
  const result: LoadedAttachments = {
    supportedAttachmentCount: 0,
    unsupportedMultiplicity: false,
  };
  if (!chatDb) return result;

  try {
    const rows = chatDb.prepare(`
      SELECT a.filename, a.mime_type
      FROM message_attachment_join maj
      JOIN attachment a ON maj.attachment_id = a.ROWID
      WHERE maj.message_id = ?
      AND (
        a.mime_type LIKE 'image/%'
        OR a.mime_type LIKE 'audio/%'
        OR a.mime_type = 'application/pdf'
      )
    `).all(messageRowId) as Array<{ filename: string | null; mime_type: string | null }>;

    result.supportedAttachmentCount = rows.length;
    const imageCount = rows.filter((att) => att.mime_type?.startsWith('image/')).length;
    const documentCount = rows.filter((att) => att.mime_type === 'application/pdf').length;
    const audioCount = rows.filter((att) => att.mime_type?.startsWith('audio/')).length;
    result.unsupportedMultiplicity = imageCount > 1 || documentCount > 1 || audioCount > 1;

    for (const att of rows) {
      if (!att.filename) continue;
      const filePath = att.filename.replace(/^~/, homedir());
      if (!existsSync(filePath)) continue;

      const mime = att.mime_type || '';

      if (mime.startsWith('image/') && !result.image) {
        if (SUPPORTED_IMAGE.includes(mime)) {
          result.image = { base64: readFileSync(filePath).toString('base64'), mimetype: mime };
        } else {
          // HEIC and friends: convert to JPEG via sips rather than dropping the image.
          const base64 = convertImageToJpegBase64(filePath, messageRowId, privacySafeLogs);
          if (base64) result.image = { base64, mimetype: 'image/jpeg' };
        }
      } else if (mime === 'application/pdf' && !result.document) {
        result.document = { base64: readFileSync(filePath).toString('base64'), mimetype: mime };
      } else if (mime.startsWith('audio/') && !result.audioPath) {
        // Transcribed lazily in the async handler (whisper.cpp is slow-ish).
        result.audioPath = filePath;
      }
    }
  } catch (err) {
    if (privacySafeLogs) {
      console.error('[iMessage] Family attachment load failed');
    } else {
      console.error('[iMessage] Attachment load error:', err);
    }
  }

  return result;
}

export function hasCompleteLoadedAttachmentSet(value: {
  image?: ImageData;
  document?: DocumentData;
  audioPath?: string;
  supportedAttachmentCount: number;
}): boolean {
  const loadedCount = Number(Boolean(value.image))
    + Number(Boolean(value.document))
    + Number(Boolean(value.audioPath));
  return value.supportedAttachmentCount > 0
    && loadedCount === value.supportedAttachmentCount;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Attachment metadata can reach chat.db before its file is readable. Keep the
 * message at the head of the per-chat FIFO while retrying for about 22 seconds;
 * only then fail closed and ask the owner to resend. */
async function loadDurableFamilyAttachments(
  messageRowId: number,
  expectsAttachment: boolean,
): Promise<LoadedAttachments> {
  let loaded = loadAttachments(messageRowId, true);
  if (!expectsAttachment) return loaded;
  let previousCount = -1;
  let stableSamples = 0;
  for (const delayMs of FAMILY_ATTACHMENT_RETRY_DELAYS_MS) {
    if (
      hasCompleteLoadedAttachmentSet(loaded)
      && loaded.supportedAttachmentCount === previousCount
    ) {
      stableSamples += 1;
      // Two unchanged rechecks give multi-attachment joins time to settle. The
      // handler can carry one image, one PDF, and one audio transcript; more of
      // any type is rejected explicitly rather than silently dropping files.
      if (stableSamples >= 2) return loaded;
    } else {
      stableSamples = 0;
    }
    previousCount = loaded.supportedAttachmentCount;
    await wait(delayMs);
    loaded = loadAttachments(messageRowId, true);
  }
  return loaded;
}

// Handles transcription and a few placeholder fallbacks, then forwards to the handler.
async function dispatchMessage(args: DispatchMessageArgs): Promise<void> {
  const {
    chatId,
    senderHandle,
    cleaned,
    image: suppliedImage,
    document: suppliedDocument,
    audioPath: suppliedAudioPath,
    sourceMessage,
    familyInboxId,
    expectsAttachment,
  } = args;
  const durableFamily = familyInboxId !== undefined;
  let image = suppliedImage;
  let document = suppliedDocument;
  let audioPath = suppliedAudioPath;
  let text = cleaned;
  let unsupportedAttachmentMultiplicity = false;
  let incompleteAttachmentSet = false;

  try {
    // Load durable Family attachments only when this row reaches the head of
    // its chat FIFO. A downtime backlog can therefore never retain every photo
    // or PDF as base64 in memory while waiting for earlier messages to finish.
    if (durableFamily) {
      const loaded = await loadDurableFamilyAttachments(
        sourceMessage.rowId,
        Boolean(expectsAttachment),
      );
      ({ image, document, audioPath } = loaded);
      unsupportedAttachmentMultiplicity = loaded.unsupportedMultiplicity;
      incompleteAttachmentSet = Boolean(
        expectsAttachment && !hasCompleteLoadedAttachmentSet(loaded),
      );
      if (incompleteAttachmentSet) {
        throw new Error('Expected Family attachment is unavailable.');
      }
      if (unsupportedAttachmentMultiplicity) {
        throw new Error('More than one supported Family attachment of the same type was received.');
      }
    }
    if (audioPath) {
      const transcript = await transcribeAudio(audioPath, { privacySafeLogs: durableFamily });
      if (transcript) {
        if (durableFamily) {
          console.log('[iMessage] Transcribed a Family voice message');
        } else {
          console.log(`[iMessage] 🎙️ transcribed: "${transcript.slice(0, 80)}"`);
        }
        // Prepend any typed caption, then the voice transcript.
        text = text ? `${text}\n\n[Voice message]: ${transcript}` : transcript;
      } else if (!text && !image && !document) {
        // Couldn't transcribe and there's nothing else to act on.
        text = "(I received a voice message but couldn't transcribe it.)";
      }
    }

    if (!text) {
      if (image) text = 'What is this image?';
      else if (document) text = 'What is in this document?';
    }
    if (!text) throw new Error('No dispatchable Family content remained.');
  } catch (err) {
    if (durableFamily) {
      const unreadableAttachment = incompleteAttachmentSet
        || Boolean(expectsAttachment && !image && !document && !audioPath);
      const marked = markFamilyIMessageFailedBeforeDispatch(
        familyInboxId,
        unsupportedAttachmentMultiplicity
          ? 'multiple_same_type_attachments'
          : unreadableAttachment ? 'attachment_unavailable' : 'content_preparation_failed',
      );
      console.error('[iMessage] Family message failed before handler dispatch');
      if (marked && (unreadableAttachment || unsupportedAttachmentMultiplicity)) {
        await alertOwnerOfUnreadableFamilyAttachment(1);
      }
      return;
    }
    throw err;
  }

  if (durableFamily && !claimFamilyIMessage(familyInboxId)) return;

  try {
    await onMessage({
      remoteJid: chatId,
      senderJid: senderHandle,
      text,
      image,
      document,
      sourceMessage,
    });
    if (durableFamily && !markFamilyIMessageSucceeded(familyInboxId)) {
      throw new Error('Family inbox completion transition failed.');
    }
  } catch (err) {
    if (durableFamily) {
      markFamilyIMessageSendInDoubt(familyInboxId, 'handler_outcome_unknown');
      console.error('[iMessage] Family handler outcome is uncertain; message will not be replayed');
      await alertOwnerOfUncertainFamilyDelivery(1);
    } else {
      console.error('[iMessage] Handler error:', err);
    }
  }
}

function enqueueMessage(args: DispatchMessageArgs): void {
  if (args.familyInboxId !== undefined) {
    if (scheduledFamilyInboxIds.has(args.familyInboxId)) return;
    scheduledFamilyInboxIds.add(args.familyInboxId);
  }
  const previous = chatDispatchTails.get(args.chatId) ?? Promise.resolve();

  // The stored tail always absorbs failures, so one bad message cannot poison
  // later messages in the same chat. dispatchMessage handles agent-handler
  // errors itself; this catch also covers transcription and unexpected errors.
  const tail = previous
    .then(() => dispatchMessage(args))
    .catch((err) => {
      if (args.familyInboxId !== undefined) {
        // dispatchMessage normally records the precise terminal state itself.
        // This outer catch is a final privacy-safe guard for an unexpected
        // failure in the queue plumbing.
        console.error('[iMessage] Family dispatch queue failed');
      } else {
        console.error(`[iMessage] Dispatch failed for chat ${args.chatId}:`, err);
      }
    });

  chatDispatchTails.set(args.chatId, tail);
  void tail.finally(() => {
    if (args.familyInboxId !== undefined) {
      scheduledFamilyInboxIds.delete(args.familyInboxId);
    }
    // Do not delete a newer tail that was appended while this item ran.
    if (chatDispatchTails.get(args.chatId) === tail) {
      chatDispatchTails.delete(args.chatId);
    }
  });
}

type IMessageDatabaseRow = {
  ROWID: number;
  guid: string | null;
  text: string | null;
  attributedBody: Buffer | null;
  date: number;
  is_from_me: number;
  associated_message_type: number | null;
  sender_handle: string | null;
  chat_id: string | null;
  chat_name: string | null;
  attachment_cache_expected: number;
  has_joined_attachment: number;
  has_supported_attachment: number;
};

/** Persist before enqueueing. A ledger failure never falls back to an
 * untracked dispatch, because that would reintroduce duplicate mutations. */
function persistAndEnqueueFamilyRow(msg: IMessageDatabaseRow, chatId: string): boolean {
  const timestamp = appleDateToISO(msg.date);
  const senderHandle = msg.sender_handle || '';
  const rawText = resolveIMessageText(msg.text, msg.attributedBody);
  const outgoing = Boolean(msg.is_from_me);
  const reaction = (msg.associated_message_type ?? 0) !== 0;
  const observationOnlyCollision = false; // no observe-only chats ship in this repo
  const cleaned = stripOptionalFamilyMention(rawText);
  const substantive = isSubstantiveFamilyMessage(cleaned, Boolean(msg.has_supported_attachment));

  // A new Messages row can appear before its attributed body or attachment
  // join/file is ready. Do not advance the durable cursor past a fresh empty
  // incoming row; keep it at the FIFO head until the local database settles.
  if (shouldWaitForFamilyMessageContent({
    outgoing,
    reaction,
    observationOnlyCollision,
    senderHandle,
    substantive,
    timestamp,
    attachmentMetadataPending: Boolean(
      msg.attachment_cache_expected && !msg.has_joined_attachment,
    ),
  })) {
    return false;
  }
  const dispatchable = !outgoing
    && !reaction
    && !observationOnlyCollision
    && Boolean(senderHandle)
    && substantive;
  const stale = dispatchable && isFamilyIMessageTooOld(timestamp);

  try {
    const recorded = recordFamilyIMessageScan({
      chatId,
      sourceRowId: msg.ROWID,
      sourceGuid: msg.guid,
      ...(dispatchable ? {
        sender: senderHandle,
        rawText,
        messageTimestamp: timestamp,
        hasAttachment: Boolean(msg.has_supported_attachment),
      } : {}),
    });
    if (!recorded.inserted || recorded.inboxId === null) return true;

    if (stale) {
      markFamilyIMessageFailedBeforeDispatch(recorded.inboxId, 'message_too_old');
      console.error('[iMessage] Stale Family request skipped before handler dispatch');
      queueStaleFamilyMessageAlert();
      return true;
    }

    console.log('[iMessage] Family inbound message durably queued');
    enqueueMessage({
      chatId,
      senderHandle,
      cleaned,
      familyInboxId: recorded.inboxId,
      expectsAttachment: Boolean(msg.has_supported_attachment),
      sourceMessage: {
        rowId: msg.ROWID,
        guid: msg.guid,
        timestamp,
        key: buildIMessageSourceKey(chatId, msg.ROWID, msg.guid),
      },
    });
    return true;
  } catch {
    console.error('[iMessage] Family durable inbox write failed; message was not dispatched');
    return false;
  }
}

function iMessageRowSelect(): string {
  const attachmentCacheExpression = messageHasAttachmentCacheColumn
    ? 'CASE WHEN COALESCE(m.cache_has_attachments, 0) <> 0 THEN 1 ELSE 0 END'
    : '0';
  return `
  SELECT
    m.ROWID,
    m.guid,
    m.text,
    m.attributedBody,
    m.date,
    m.is_from_me,
    m.associated_message_type,
    h.id as sender_handle,
    c.chat_identifier as chat_id,
    c.display_name as chat_name,
    ${attachmentCacheExpression} AS attachment_cache_expected,
    EXISTS (
      SELECT 1
      FROM message_attachment_join maj1
      WHERE maj1.message_id = m.ROWID
    ) AS has_joined_attachment,
    EXISTS (
      SELECT 1
      FROM message_attachment_join maj2
      JOIN attachment a2 ON maj2.attachment_id = a2.ROWID
      WHERE maj2.message_id = m.ROWID
        AND (
          a2.mime_type LIKE 'image/%'
          OR a2.mime_type LIKE 'audio/%'
          OR a2.mime_type = 'application/pdf'
        )
    ) AS has_supported_attachment
  FROM message m
  LEFT JOIN handle h ON m.handle_id = h.ROWID
  LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
  LEFT JOIN chat c ON cmj.chat_id = c.ROWID`;
}

function pollMessages() {
  if (!chatDb || !onMessage) return;

  try {
    // The Family cursor is independent of the legacy in-memory global cursor.
    // Scan it first on every tick so a transient local write failure cannot let
    // a later ROWID advance past an unrecorded Family request.
    const configuredFamilyChat = process.env.GROUP_FAMILY?.trim();
    if (configuredFamilyChat && getFamilyIMessageInboxCursor(configuredFamilyChat)) {
      // Schedule already-queued rows before scanning newer chat.db rows so a
      // prior commit/enqueue crash cannot let a later message overtake it.
      for (const row of getQueuedFamilyIMessages(configuredFamilyChat)) {
        enqueuePersistedFamilyMessage(row);
      }
      scanFamilyMessagesSinceDurableCursor(configuredFamilyChat);
      // Sweep durable queued work on every tick. This closes the narrow crash /
      // exception window after the DB transaction commits but before the
      // in-memory FIFO append completes. The scheduled-id set and DB claim CAS
      // make repeated sweeps harmless.
      for (const row of getQueuedFamilyIMessages(configuredFamilyChat)) {
        enqueuePersistedFamilyMessage(row);
      }
    }

    const messages = chatDb.prepare(`${iMessageRowSelect()}
      WHERE m.ROWID > ?
      ORDER BY m.ROWID ASC
    `).all(lastMessageRowId) as IMessageDatabaseRow[];

    const extractionParticipantCache = new Map<string, {
      handles?: string[];
      failed: boolean;
    }>();

    for (const msg of messages) {
      lastMessageRowId = msg.ROWID;

      const text = resolveIMessageText(msg.text, msg.attributedBody);

      const senderHandle = msg.sender_handle || '';
      const chatId = msg.chat_id || senderHandle;

      if (!chatId) continue; // can't attribute a chat → skip
      const family = isConfiguredFamilyChat(chatId);
      let participantHandles: string[] | undefined;
      let participantLookupFailed = false;
      if (!family && !isDM(chatId)) {
        let cached = extractionParticipantCache.get(chatId);
        if (!cached) {
          try {
            cached = { handles: getChatParticipants(chatId), failed: false };
          } catch {
            // A group row is shared conversation, regardless of which member
            // authored it. If participants cannot be proved, quarantine it.
            cached = { failed: true };
            console.error('[iMessage] Participant lookup failed; group row quarantined from global extraction');
          }
          extractionParticipantCache.set(chatId, cached);
        }
        participantHandles = cached.handles;
        participantLookupFailed = cached.failed;
      }
      const familyOnlyOutOfFamily = shouldQuarantineIMessageFromGlobalExtraction({
        chatId,
        senderHandle,
        isFromMe: Boolean(msg.is_from_me),
        participantHandles,
        participantLookupFailed,
      });
      const familyPrivate = isFamilyScopedIMessage({
        chatId,
        senderHandle,
        isFromMe: Boolean(msg.is_from_me),
        participantHandles,
      });

      // Phase 5: passive ingestion. Log every message (both directions, all
      // chats) BEFORE any trigger gating — observing and replying are separate
      // decisions now. Outgoing rows have an empty sender_handle, which is why
      // this runs before the senderHandle guard below.
      try {
        logIMessage({
          rowid_src: msg.ROWID,
          chat_id: chatId,
          chat_name: msg.chat_name,
          sender: msg.is_from_me ? 'me' : senderHandle,
          direction: msg.is_from_me ? 'out' : 'in',
          text,
          ts: appleDateToISO(msg.date),
          alreadyExtracted: family || familyOnlyOutOfFamily,
          privacyScope: familyPrivate ? 'family' : undefined,
        });
      } catch (err) {
        console.error('[iMessage] imessage_log write failed:', err);
      }

      // Family delivery was handled by the persistent cursor scan at the start
      // of this tick. Every Family branch exits here so it can never fall
      // through to the legacy at-most-once dispatch path.
      if (family) {
        continue;
      }

      // A Family-only participant has no DM or alternate-group access. The row
      // is already durably privacy-scoped above; stop before attachment loading,
      // content logging, trigger routing, or handler dispatch.
      if (familyPrivate) continue;

      // Reply path below is unchanged. Never dispatch our own messages to the agent.
      if (msg.is_from_me) continue;
      if (!senderHandle) continue; // incoming needs a sender to route

      const dm = isDM(chatId);

      // DMs and the verified Family chat do not need the trigger word. All
      // existing group chats keep their current explicit-trigger behavior.
      if (!dm) {
        const triggerFound = text.toLowerCase().includes(TRIGGER);
        if (!triggerFound) continue;
      }

      // Strip trigger word and optional @ prefix (e.g., "@bb" when TRIGGER is "bb")
      const escapedTrigger = TRIGGER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const cleaned = text.replace(
        new RegExp(`@?${escapedTrigger}`, 'gi'),
        '',
      ).trim();

      const { image, document, audioPath } = loadAttachments(msg.ROWID);

      if (!cleaned && !image && !document && !audioPath) continue;

      console.log(`[iMessage] ${senderHandle}: "${cleaned.slice(0, 80)}"`);

      // Dispatch off the polling loop without losing per-chat ROWID order.
      enqueueMessage({
        chatId,
        senderHandle,
        cleaned,
        image,
        document,
        audioPath,
        sourceMessage: {
          rowId: msg.ROWID,
          guid: msg.guid,
          timestamp: appleDateToISO(msg.date),
          key: buildIMessageSourceKey(chatId, msg.ROWID, msg.guid),
        },
      });
    }
  } catch (err) {
    console.error('[iMessage] Poll error:', err);
  }
}

// ── Restart recovery ─────────────────────────────────────────────────────────
// The live cursor starts at MAX(ROWID) on boot, so a DM that arrived while the
// previous process was mid-reply (killed by a deploy or a manual restart) was
// silently dropped: it had been read, but never answered. On 2026-09-29 a
// restart 6 seconds after "call the town public works office" lost that request.
// Family has its own durable inbox; this covers direct messages only.
const RECOVERY_WINDOW_MS = (Number(process.env.IMESSAGE_RECOVERY_WINDOW_MIN) || 10) * 60_000;
const RECOVERY_GROUP = 'imessage-recovery';

function recoverInterruptedDMs(): void {
  if (!chatDb || !onMessage) return;
  const cutoff = Date.now() - RECOVERY_WINDOW_MS;
  const rows = chatDb.prepare(`${iMessageRowSelect()}
    WHERE m.ROWID > ? AND m.ROWID <= ?
    ORDER BY m.ROWID ASC
  `).all(Math.max(0, lastMessageRowId - 300), lastMessageRowId) as IMessageDatabaseRow[];

  for (const msg of rows) {
    if (msg.is_from_me) continue;
    const senderHandle = msg.sender_handle || '';
    const chatId = msg.chat_id || senderHandle;
    if (!chatId || !senderHandle || !isDM(chatId)) continue;
    if (isConfiguredFamilyChat(chatId) || isFamilyOnlyHandle(senderHandle)) continue;
    const at = appleDateToISO(msg.date);
    if (Date.parse(at) < cutoff) continue;
    // Anything the bot said after this message means the run finished.
    if (hasAssistantReplySince(at)) continue;
    // Once per message: a message that itself crashes the bot must not loop.
    const key = `recovered_${msg.ROWID}`;
    if (getMemory(RECOVERY_GROUP, key)) continue;
    setMemory(RECOVERY_GROUP, key, new Date().toISOString());

    const text = resolveIMessageText(msg.text, msg.attributedBody);
    const { image, document, audioPath } = loadAttachments(msg.ROWID);
    if (!text.trim() && !image && !document && !audioPath) continue;
    const dropped = dropUnansweredUserRowsSince(at);
    console.log(`[iMessage] Recovering an unanswered DM from before the restart (row ${msg.ROWID}${dropped ? `, replaced ${dropped} half-saved row(s)` : ''})`);
    enqueueMessage({
      chatId,
      senderHandle,
      cleaned: text.trim(),
      image,
      document,
      audioPath,
      sourceMessage: {
        rowId: msg.ROWID,
        guid: msg.guid,
        timestamp: at,
        key: buildIMessageSourceKey(chatId, msg.ROWID, msg.guid),
      },
    });
  }
}

export function listChats(): Array<{ chatId: string; displayName: string; participants: string }> {
  const db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const chats = db.prepare(`
      SELECT
        c.chat_identifier as chatId,
        c.display_name as displayName,
        GROUP_CONCAT(h.id, ', ') as participants
      FROM chat c
      LEFT JOIN chat_handle_join chj ON c.ROWID = chj.chat_id
      LEFT JOIN handle h ON chj.handle_id = h.ROWID
      GROUP BY c.ROWID
      ORDER BY c.ROWID DESC
      LIMIT 50
    `).all() as Array<{ chatId: string; displayName: string; participants: string }>;
    return chats;
  } finally {
    db.close();
  }
}

/** Read the exact current participant handles for a chat. The local Messages
 * account is not returned by chat_handle_join, so a shared chat must resolve to
 * precisely the approved profile users. */
export function getChatParticipants(chatId: string): string[] {
  const db = chatDb ?? new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
  const ownsDb = db !== chatDb;
  try {
    const rows = db.prepare(`
      SELECT DISTINCT h.id AS handle
      FROM chat c
      JOIN chat_handle_join chj ON c.ROWID = chj.chat_id
      JOIN handle h ON chj.handle_id = h.ROWID
      WHERE c.chat_identifier = ?
      ORDER BY h.id
    `).all(chatId) as Array<{ handle: string }>;
    return rows.map((row) => row.handle).filter(Boolean);
  } finally {
    if (ownsDb) db.close();
  }
}

function enqueuePersistedFamilyMessage(row: FamilyIMessageInboxRow): void {
  if (isFamilyIMessageTooOld(row.message_ts)) {
    if (markFamilyIMessageFailedBeforeDispatch(row.id, 'message_too_old')) {
      console.error('[iMessage] Stale queued Family request skipped before handler dispatch');
      queueStaleFamilyMessageAlert();
    }
    return;
  }
  enqueueMessage({
    chatId: row.chat_id,
    senderHandle: row.sender,
    cleaned: stripOptionalFamilyMention(row.raw_text || ''),
    familyInboxId: row.id,
    expectsAttachment: Boolean(row.has_attachment),
    sourceMessage: {
      rowId: row.source_rowid,
      guid: row.source_guid,
      timestamp: row.message_ts,
      key: buildIMessageSourceKey(row.chat_id, row.source_rowid, row.source_guid),
    },
  });
}

/** Scan only the exact configured Family chat after its persistent activation
 * boundary. This is what closes the service-downtime gap without replaying any
 * pre-activation history. */
function scanFamilyMessagesSinceDurableCursor(chatId: string): number {
  if (!chatDb) return 0;
  const cursor = getFamilyIMessageInboxCursor(chatId);
  if (!cursor) throw new Error('Family durable inbox is not activated.');
  const rows = chatDb.prepare(`${iMessageRowSelect()}
    WHERE c.chat_identifier = ? AND m.ROWID > ?
    ORDER BY m.ROWID ASC
  `).all(chatId, cursor.last_scanned_rowid) as IMessageDatabaseRow[];

  let scanned = 0;
  for (const row of rows) {
    const senderHandle = row.sender_handle || '';
    try {
      logIMessage({
        rowid_src: row.ROWID,
        chat_id: chatId,
        chat_name: row.chat_name,
        sender: row.is_from_me ? 'me' : senderHandle,
        direction: row.is_from_me ? 'out' : 'in',
        text: resolveIMessageText(row.text, row.attributedBody),
        ts: appleDateToISO(row.date),
        alreadyExtracted: true,
        privacyScope: 'family',
      });
    } catch {
      // Delivery does not depend on the observation ledger. The durable Family
      // inbox below remains the authority and is itself private/local.
      console.error('[iMessage] Family observation-log write failed during recovery');
    }
    if (!persistAndEnqueueFamilyRow(row, chatId)) break;
    scanned += 1;
  }
  return scanned;
}

export async function startIMessage() {
  console.log('[iMessage] Starting...');

  // Quarantine any Family rows logged before this feature/startup completed.
  // Do this before touching chat.db so a Messages permission/startup failure
  // cannot leave the private backlog visible to the global daemon.
  const configuredFamilyChat = process.env.GROUP_FAMILY?.trim();
  if (configuredFamilyChat) {
    const quarantined = quarantineIMessageChat(configuredFamilyChat);
    if (quarantined > 0) {
      console.log(`[iMessage] Quarantined ${quarantined} existing Family row(s) from global extraction`);
    }
  }

  if (!existsSync(CHAT_DB_PATH)) {
    console.error(`[iMessage] chat.db not found at ${CHAT_DB_PATH}`);
    console.error('[iMessage] Make sure Messages.app is set up and Full Disk Access is granted.');
    process.exit(1);
  }

  chatDb = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });
  const messageColumns = chatDb.prepare('PRAGMA table_info(message)').all() as Array<{ name: string }>;
  messageHasAttachmentCacheColumn = messageColumns.some(
    (column) => column.name === 'cache_has_attachments',
  );

  // Start from the latest message (don't process old messages)
  const latest = chatDb.prepare('SELECT MAX(ROWID) as maxId FROM message').get() as { maxId: number } | undefined;
  lastMessageRowId = latest?.maxId || 0;
  console.log(`[iMessage] Starting from message ROWID ${lastMessageRowId}`);
  try {
    recoverInterruptedDMs();
  } catch (err) {
    console.error('[iMessage] Restart recovery failed:', err);
  }

  // Verify Messages.app can send
  try {
    await runAppleScript('tell application "Messages" to get name');
    console.log('[iMessage] Messages.app is accessible');
  } catch (err) {
    console.error('[iMessage] Cannot access Messages.app:', err);
    console.error('[iMessage] Make sure iMessage is signed in and Messages.app can be scripted.');
    process.exit(1);
  }

  if (configuredFamilyChat) {
    // First activation uses the previous process's observed Family watermark
    // when available so the stop/start gap is scanned. Because observation is
    // not handler completion, deploy this first activation only at a quiet,
    // settled Family boundary. Every later boot recovers the exact gap after
    // the last committed Family scan cursor. A row left in `processing` is
    // uncertain and terminal; queued rows are the only rows automatically
    // resumed.
    const existingCursor = getFamilyIMessageInboxCursor(configuredFamilyChat);
    const activationBoundary = existingCursor
      ? lastMessageRowId
      : chooseFamilyInboxActivationRowId({
          currentLatestRowId: lastMessageRowId,
          latestObservedGlobalRowId: getLatestObservedIMessageRowId(),
          latestObservedFamilyRowId: getLatestObservedIMessageRowId(configuredFamilyChat),
        });
    const activation = activateFamilyIMessageInbox(configuredFamilyChat, activationBoundary);
    const interrupted = recoverInterruptedFamilyIMessages(configuredFamilyChat);
    const sourceReset = activation.activated
      ? { rebased: false, retiredRows: 0 }
      : rebaseFamilyIMessageInboxAfterSourceReset(configuredFamilyChat, lastMessageRowId);
    for (const row of getQueuedFamilyIMessages(configuredFamilyChat)) {
      enqueuePersistedFamilyMessage(row);
    }
    const recoveredRows = scanFamilyMessagesSinceDurableCursor(configuredFamilyChat);
    if (activation.activated) {
      console.log('[iMessage] Family durable inbox activated at the settled handoff boundary');
    } else if (sourceReset.rebased) {
      console.error('[iMessage] Messages database reset detected; Family inbox rebased without replaying history');
      await alertOwnerOfFamilyInboxRebase();
    } else if (recoveredRows > 0) {
      console.log(`[iMessage] Recovered ${recoveredRows} Family message row(s) from service downtime`);
    }
    if (interrupted > 0) {
      console.error(`[iMessage] ${interrupted} interrupted Family request(s) marked send-in-doubt; none were replayed`);
      await alertOwnerOfUncertainFamilyDelivery(interrupted);
    }
  }

  // Log available chats if groups aren't configured
  const groupEnvVars = ['GROUP_ADMIN', 'GROUP_WORK', 'GROUP_HOME', 'GROUP_FAMILY', 'GROUP_HEALTH'];
  const hasAnyGroup = groupEnvVars.some((v) => process.env[v]);
  if (!hasAnyGroup) {
    console.log('\n[iMessage] No groups configured. Available iMessage chats:');
    try {
      const chats = listChats();
      for (const chat of chats) {
        console.log(`  ${chat.chatId} — "${chat.displayName || '(unnamed)'}" [${chat.participants || 'no participants'}]`);
      }
      console.log('\n[iMessage] Add chat IDs to your .env file as GROUP_ADMIN, GROUP_HOME, etc.\n');
    } catch (err) {
      console.error('[iMessage] Could not list chats:', err);
    }
  }

  // Start polling
  pollTimer = setInterval(pollMessages, POLL_INTERVAL_MS);
  console.log(`[iMessage] Polling chat.db every ${POLL_INTERVAL_MS}ms`);
  console.log('[iMessage] Connected and ready!');
}
