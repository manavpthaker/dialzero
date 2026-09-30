/**
 * Pure tests for the iMessage quarantine gate.
 *
 * This is the rule that decides which observed messages may reach people
 * linking, an LLM, or global search. It is now shared between the live
 * extraction daemon and any bulk pass over the 156k-row imessage_log backlog,
 * so its fail-closed behavior is worth pinning: at that scale, "guessed wrong
 * once" means a shared conversation in the global brain.
 *
 * No chat.db and no network — participant lookup is injected.
 *
 *   npm run test:imessage-privacy
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-imsg-privacy-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'privacy-test.db');

const FAMILY_CHAT = 'chat999family';
const OWNER_PHONE = '+15550000001';
const PARTNER_PHONE = '+15550000002';
const OUTSIDER_PHONE = '+15550000009';

process.env.GROUP_FAMILY = FAMILY_CHAT;

// A minimal profile so the family-scope predicate has members to reason about.
const profilePath = join(tempRoot, 'config', 'profile.json');
mkdirSync(dirname(profilePath), { recursive: true });
writeFileSync(profilePath, JSON.stringify({
  botName: 'Test Assistant',
  triggerWord: '@testassistant',
  householdName: 'Test Household',
  owner: {
    id: 'owner', name: 'Owner', tone: 'direct', role: 'admin',
    phones: [OWNER_PHONE], allowedGroups: ['admin', 'family'],
  },
  members: [{
    id: 'partner', name: 'Partner', tone: 'warm', role: 'member',
    phones: [PARTNER_PHONE], allowedGroups: ['family'],
  }],
  groups: {},
}, null, 2));
process.env.ASSISTANT_PROFILE_PATH = profilePath;

const failures: string[] = [];
function test(name: string, body: () => void): void {
  try {
    body();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}`);
    console.log(err instanceof Error ? (err.stack ?? err.message) : String(err));
  }
}

interface Row {
  id: number; chat_id: string; sender: string; direction: 'in' | 'out'; text: string; ts: string;
}
let nextId = 1;
function row(chat_id: string, sender: string, direction: 'in' | 'out' = 'in'): Row {
  return { id: nextId++, chat_id, sender, direction, text: 'hello', ts: '2026-09-02T12:00:00.000Z' };
}

async function main(): Promise<void> {
  const { isLikelyDirectChat, partitionPrivateRows } = await import('../src/lib/imessage-privacy.js');
  // Cast: the partition only reads chat_id/sender/direction, so the fixtures
  // deliberately omit the columns it never touches.
  const partition = (rows: Row[], get: (id: string) => string[]) =>
    partitionPrivateRows(rows as never, { getChatParticipants: get });

  test('a phone number and an email are direct chats; an opaque id is a group', () => {
    assert.equal(isLikelyDirectChat('+15551234567'), true);
    assert.equal(isLikelyDirectChat('someone@example.com'), true);
    assert.equal(isLikelyDirectChat('chat123456789'), false);
    assert.equal(isLikelyDirectChat('iMessage;+;chat987'), false);
  });

  test('an unrecognized id shape is treated as a GROUP, not a direct chat', () => {
    // The conservative direction: groups get a participant lookup and can be
    // quarantined, direct chats skip it. Guessing "direct" would skip the gate.
    assert.equal(isLikelyDirectChat('weird-new-format-2026'), false);
  });

  test('a 1:1 chat with an outsider is safe and needs no participant lookup', () => {
    let lookups = 0;
    const { safe, quarantined } = partition(
      [row(OUTSIDER_PHONE, OUTSIDER_PHONE)],
      () => { lookups += 1; return []; },
    );
    assert.equal(safe.length, 1);
    assert.equal(quarantined.length, 0);
    assert.equal(lookups, 0, 'a direct chat must not hit chat.db at all');
  });

  test('a failed participant lookup quarantines the row instead of guessing', () => {
    const { safe, quarantined } = partition(
      [row('chat-long-gone', OUTSIDER_PHONE)],
      () => { throw new Error('chat no longer exists in chat.db'); },
    );
    assert.equal(safe.length, 0, 'unprovable participants must never reach the global brain');
    assert.equal(quarantined.length, 1);
  });

  test('the configured family chat is quarantined and marked family-private', () => {
    const { safe, quarantined, familyPrivate } = partition(
      [row(FAMILY_CHAT, PARTNER_PHONE)],
      () => [OWNER_PHONE, PARTNER_PHONE],
    );
    assert.equal(safe.length, 0);
    assert.equal(quarantined.length, 1);
    assert.equal(familyPrivate.length, 1, 'family rows must be identifiable for scoped storage');
  });

  test('participant lookups are cached per chat across a batch', () => {
    let lookups = 0;
    const rows = [
      row('chat-group-a', OUTSIDER_PHONE),
      row('chat-group-a', OUTSIDER_PHONE),
      row('chat-group-a', OUTSIDER_PHONE),
      row('chat-group-b', OUTSIDER_PHONE),
    ];
    partition(rows, (id) => { lookups += 1; return [OWNER_PHONE, id]; });
    assert.equal(lookups, 2, 'one lookup per distinct chat, not per row');
  });

  test('a failed lookup is cached too — a dead chat is not retried per row', () => {
    let lookups = 0;
    const rows = [row('chat-dead', OUTSIDER_PHONE), row('chat-dead', OUTSIDER_PHONE)];
    const { quarantined } = partition(rows, () => { lookups += 1; throw new Error('gone'); });
    assert.equal(lookups, 1, 'a throwing lookup must be cached, or a bulk pass re-throws per row');
    assert.equal(quarantined.length, 2);
  });

  test('every row lands in exactly one bucket', () => {
    const rows = [
      row(OUTSIDER_PHONE, OUTSIDER_PHONE),
      row(FAMILY_CHAT, PARTNER_PHONE),
      row('chat-dead', OUTSIDER_PHONE),
    ];
    const { safe, quarantined } = partition(rows, (id) => {
      if (id === 'chat-dead') throw new Error('gone');
      return [OWNER_PHONE, PARTNER_PHONE];
    });
    assert.equal(safe.length + quarantined.length, rows.length, 'no row may be dropped or double-counted');
  });

  try { rmSync(tempRoot, { recursive: true, force: true }); } catch { /* best effort */ }

  if (failures.length) {
    console.error(`\n${failures.length} iMessage privacy check(s) failed.`);
    process.exit(1);
  }
  console.log('\niMessage privacy gate tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
