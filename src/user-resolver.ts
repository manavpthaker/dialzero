import { getProfileConfig, type ProfileUser } from './config.js';

export interface User {
  id: string;
  name: string;
  phone: string;
  role: 'admin' | 'member' | 'child';
  tone: 'direct' | 'warm' | 'playful';
  allowedGroups: string[];
  /**
   * True only for the synthetic user that cron jobs, pulses and daemons run as
   * (lib/system-user.ts). It is otherwise identical to the owner — same id, same
   * tone — so this flag is the only way to tell "the scheduler is talking" from
   * "the owner is talking". runAgent uses it to keep system-initiated work out
   * of the conversation history.
   */
  systemAuthored?: true;
}

const users: Map<string, User> = new Map();
const ambiguousAuthHandles = new Set<string>();

/**
 * Normalize a phone handle for authentication without dropping its country
 * code. The CRM's last-ten-digits normalizer is intentionally not safe here:
 * two different international numbers can share the same national suffix.
 *
 * A bare ten-digit number is treated as US/Canada for compatibility with the
 * onboarding input. All other international numbers must carry `+` or `00`.
 */
export function normalizeAuthPhone(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes('@') || !/^[+\d().\-\s]+$/.test(trimmed)) return '';

  const compact = trimmed.replace(/[\s().-]/g, '');
  let digits = '';
  if (/^\+\d+$/.test(compact)) {
    digits = compact.slice(1);
  } else if (/^00\d+$/.test(compact)) {
    digits = compact.slice(2);
  } else if (/^\d{10}$/.test(compact)) {
    digits = `1${compact}`;
  } else if (/^1\d{10}$/.test(compact)) {
    digits = compact;
  } else {
    return '';
  }

  return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : '';
}

function registerAuthHandle(key: string, user: User): void {
  if (!key || ambiguousAuthHandles.has(key)) return;
  const existing = users.get(key);
  if (existing && existing.id !== user.id) {
    users.delete(key);
    ambiguousAuthHandles.add(key);
    console.error('[users] Configuration collision: two users share one authentication handle; that handle is disabled');
    return;
  }
  users.set(key, user);
}

// Build a resolvable User from a profile entry. Phone/email come from env vars
// named by the profile (USER_<ID> / USER_<ID>_EMAIL by default), so secrets
// stay in .env and the committed profile carries no PII.
function registerProfileUser(p: ProfileUser): void {
  const phone = (p.phoneEnv && process.env[p.phoneEnv]) || '';
  const email = (p.emailEnv && process.env[p.emailEnv]) || '';

  const user: User = {
    id: p.id,
    name: p.name,
    phone,
    role: p.role,
    tone: p.tone,
    allowedGroups: p.allowedGroups,
  };

  const normalizedPhone = normalizeAuthPhone(phone);
  if (normalizedPhone) registerAuthHandle(`phone:${normalizedPhone}`, user);

  const normalizedEmail = email.trim().toLowerCase();
  if (normalizedEmail) registerAuthHandle(`email:${normalizedEmail}`, user);
}

export function initUsers() {
  users.clear();
  ambiguousAuthHandles.clear();
  const profile = getProfileConfig();
  registerProfileUser(profile.owner);
  for (const member of profile.members) registerProfileUser(member);
}

export function resolveUser(senderJid: string): User | null {
  // Phone authorization is exact after E.164 normalization. Never reuse the
  // CRM's last-ten-digits matching for an access-control decision.
  const phone = normalizeAuthPhone(senderJid);
  if (phone) {
    const byPhone = users.get(`phone:${phone}`);
    if (byPhone) return byPhone;
  }

  // Try email match (iMessage can use email handles)
  const byEmail = users.get(`email:${senderJid.trim().toLowerCase()}`);
  if (byEmail) return byEmail;

  return null;
}

export function isAllowed(user: User, groupKey: string): boolean {
  return user.allowedGroups.includes(groupKey);
}

/** True only for a profile that has Family access and no other group access. */
export function isFamilyOnlyUser(user: User | null | undefined): boolean {
  if (!user) return false;
  const allowed = new Set(user.allowedGroups);
  return allowed.size === 1 && allowed.has('family');
}

/** Resolve a raw iMessage handle and classify it without exposing profile data. */
export function isFamilyOnlyHandle(handle: string): boolean {
  return isFamilyOnlyUser(resolveUser(handle));
}

export interface ParticipantValidation {
  ok: boolean;
  actualUserIds: string[];
  unknownHandles: string[];
  missingUserIds: string[];
}

/**
 * Fail-closed membership check for shared chats. A participant may appear by
 * either their configured phone or email; both resolve to the same profile id.
 */
export function validateGroupParticipants(
  participantHandles: string[],
  expectedUserIds: string[],
): ParticipantValidation {
  const expected = new Set(expectedUserIds);
  const actual = new Set<string>();
  const unknownHandles: string[] = [];

  for (const handle of participantHandles) {
    const user = resolveUser(handle);
    if (!user || !expected.has(user.id)) {
      unknownHandles.push(handle);
      continue;
    }
    actual.add(user.id);
  }

  const missingUserIds = [...expected].filter((id) => !actual.has(id));
  return {
    ok: expected.size > 0 && unknownHandles.length === 0 && missingUserIds.length === 0,
    actualUserIds: [...actual].sort(),
    unknownHandles,
    missingUserIds,
  };
}

export function getRedirectMessage(user: User, groupKey: string): string {
  if (user.tone === 'warm') {
    const familyAvailable = user.allowedGroups.includes('family');
    return familyAvailable
      ? `Hey ${user.name}! I can only help you inside the Family group.`
      : `Hey ${user.name}! This group isn't set up for your account.`;
  }
  return `${user.name}, you don't have access to the ${groupKey} group.`;
}
