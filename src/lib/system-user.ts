import type { User } from '../user-resolver.js';
import { getOwner } from '../config.js';

// The canonical owner/admin user used by all system-initiated work (cron jobs,
// pulses, daemons) where there's no inbound sender to resolve. Previously this
// was copy-pasted into six modules; one of them (heartbeat) had drifted to a
// shorter allowedGroups list. Single source of truth lives here — derived from
// the profile config so a new operator's name/tone/groups flow through.
export function getSystemUser(): User {
  const owner = getOwner();
  return {
    id: owner.id,
    name: owner.name,
    phone: (owner.phoneEnv && process.env[owner.phoneEnv]) || '',
    role: owner.role,
    tone: owner.tone,
    allowedGroups: owner.allowedGroups,
    systemAuthored: true,
  };
}
