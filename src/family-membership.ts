import { deleteMemory, getMemory, setMemory } from './db.js';
import {
  getChatParticipants,
  getDefaultRecipient,
  sendMessage,
} from './channels/imessage.js';
import type { GroupConfig } from './group-resolver.js';
import { validateGroupParticipants } from './user-resolver.js';
import { getBotName } from './config.js';

const FAMILY_MEMBERSHIP_ALERT_KEY = 'security_membership_alert';

/** Fail closed for every live or scheduled shared-audience path. The alert is
 * persisted and deduplicated across restarts, while a restored participant set
 * automatically clears the suspension marker. */
export async function verifySharedAudience(
  chatId: string,
  group: GroupConfig,
): Promise<boolean> {
  if (group.audience !== 'shared') return true;

  let signature: string;
  try {
    const validation = validateGroupParticipants(
      getChatParticipants(chatId),
      group.expectedUserIds ?? [],
    );
    if (validation.ok) {
      deleteMemory(group.key, FAMILY_MEMBERSHIP_ALERT_KEY);
      return true;
    }
    signature = JSON.stringify({
      actual: validation.actualUserIds,
      missing: validation.missingUserIds,
      unknownCount: validation.unknownHandles.length,
    });
  } catch (err) {
    console.error(`[assistant] Could not verify ${group.name} participants:`, err);
    signature = 'participant-check-unavailable';
  }

  console.warn(`[assistant] Suspended ${group.name}: participant set is not approved`);
  if (getMemory(group.key, FAMILY_MEMBERSHIP_ALERT_KEY) !== signature) {
    const ownerRecipient = getDefaultRecipient();
    if (ownerRecipient) {
      try {
        await sendMessage(
          ownerRecipient,
          `${getBotName()} paused the ${group.name} group because its participants no longer match the approved Family set. It will resume automatically after the participant list is corrected.`,
        );
        setMemory(group.key, FAMILY_MEMBERSHIP_ALERT_KEY, signature);
      } catch (err) {
        // Membership failure must suspend only this shared group, not crash the
        // complete Assistant service. Leave the marker unset so the next check
        // retries the private alert.
        console.error('[assistant] Could not privately send the Family suspension alert:', err);
      }
    } else {
      console.error('[assistant] Could not privately alert the owner: no DM recipient is configured');
    }
  }
  return false;
}
