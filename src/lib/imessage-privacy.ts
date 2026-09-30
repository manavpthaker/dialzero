import {
  getChatParticipants,
  isFamilyScopedIMessage,
  shouldQuarantineIMessageFromGlobalExtraction,
} from '../channels/imessage.js';
import type { IMessageLogRow } from '../db.js';

// The gate that decides which observed iMessages may reach people-linking, an
// LLM, or global search — and which are shared/family conversation that must
// not.
//
// This lives in src/ rather than inside a daemon because more than one consumer
// needs the SAME answer: the live extraction daemon, and any bulk pass over the
// 156k-row imessage_log backlog. Two copies of a privacy rule is two chances to
// diverge, and the direction it would diverge in is "more data escapes".
//
// Deliberately fail-closed throughout: when participant identity cannot be
// proved, the row is quarantined rather than guessed at.

/**
 * A chat id that addresses exactly one other party.
 *
 * chat.db uses the handle itself (a phone number or an email) for a 1:1 thread,
 * and an opaque `chat...` / `iMessage;...` identifier for a group. Anything that
 * is not clearly direct is treated as a group, which is the conservative
 * direction: group rows get a participant lookup and can be quarantined, direct
 * rows skip it.
 */
export function isLikelyDirectChat(chatId: string): boolean {
  if (chatId.startsWith('+')) return true;
  if (chatId.startsWith('chat') || chatId.startsWith('iMessage;')) return false;
  return chatId.includes('@');
}

export interface PrivacyPartition {
  /** Safe for people-linking, extraction, and global search. */
  safe: IMessageLogRow[];
  /** Excluded from global extraction for any reason. */
  quarantined: IMessageLogRow[];
  /** The subset of `quarantined` that is specifically family-scoped. */
  familyPrivate: IMessageLogRow[];
}

/**
 * Split rows before anything can read them.
 *
 * Participant lookups hit the live chat.db and are cached per chat id for the
 * duration of the call, because a batch is usually a handful of threads and the
 * lookup is the expensive part.
 *
 * A lookup FAILURE quarantines the row. That matters most for a historical pass:
 * a group chat from years ago may no longer exist in chat.db at all, so its
 * participants are unprovable and its rows stay out of the global brain. Fewer
 * facts is the right trade against leaking a conversation the owner was only one
 * voice in.
 */
export interface PrivacyDeps {
  /** Throws when participants cannot be established — the fail-closed signal. */
  getChatParticipants: (chatId: string) => string[];
}

export function partitionPrivateRows(
  rows: IMessageLogRow[],
  // Injectable so the fail-closed behavior can be tested without a live
  // chat.db, following the dependency-injection shape family-scheduler.ts uses.
  deps: PrivacyDeps = { getChatParticipants },
): PrivacyPartition {
  const participantCache = new Map<string, { handles?: string[]; failed: boolean }>();
  const safe: IMessageLogRow[] = [];
  const quarantined: IMessageLogRow[] = [];
  const familyPrivate: IMessageLogRow[] = [];

  for (const row of rows) {
    let participantHandles: string[] | undefined;
    let participantLookupFailed = false;

    if (!isLikelyDirectChat(row.chat_id)) {
      let cached = participantCache.get(row.chat_id);
      if (!cached) {
        try {
          cached = { handles: deps.getChatParticipants(row.chat_id), failed: false };
        } catch {
          // Every row in a group is shared conversation. If participant
          // identity cannot be proved, skip global extraction rather than guess.
          cached = { failed: true };
        }
        participantCache.set(row.chat_id, cached);
      }
      participantHandles = cached.handles;
      participantLookupFailed = cached.failed;
    }

    const shouldQuarantine = shouldQuarantineIMessageFromGlobalExtraction({
      chatId: row.chat_id,
      senderHandle: row.sender,
      isFromMe: row.direction === 'out',
      participantHandles,
      participantLookupFailed,
    });
    if (shouldQuarantine) {
      quarantined.push(row);
      if (isFamilyScopedIMessage({
        chatId: row.chat_id,
        senderHandle: row.sender,
        isFromMe: row.direction === 'out',
        participantHandles,
      })) {
        familyPrivate.push(row);
      }
    } else {
      safe.push(row);
    }
  }

  return { safe, quarantined, familyPrivate };
}
