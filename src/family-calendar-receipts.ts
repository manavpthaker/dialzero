import db from './db.js';

/**
 * Durable, local receipts for Family calendar creates.
 *
 * The Google Calendar API has no insert idempotency token. We therefore write
 * a receipt before dispatch and place the same opaque key on the event as a
 * private extended property. A retry reconciles that key instead of blindly
 * inserting again.
 */

export type FamilyCalendarReceiptState =
  | 'reserved'
  | 'dispatched'
  | 'succeeded'
  | 'send_in_doubt';

export interface FamilyCalendarActionReceipt {
  action_key: string;
  calendar_id: string;
  source_message_key: string;
  payload_hash: string;
  dedupe_eligible: number;
  state: FamilyCalendarReceiptState;
  provider_event_id: string | null;
  created_at: string;
  updated_at: string;
}

db.exec(`
  CREATE TABLE IF NOT EXISTS family_calendar_action_receipts (
    action_key         TEXT PRIMARY KEY,
    calendar_id        TEXT NOT NULL,
    source_message_key TEXT NOT NULL,
    payload_hash       TEXT NOT NULL,
    dedupe_eligible    INTEGER NOT NULL DEFAULT 1 CHECK (dedupe_eligible IN (0, 1)),
    state              TEXT NOT NULL CHECK (
      state IN ('reserved', 'dispatched', 'succeeded', 'send_in_doubt')
    ),
    provider_event_id  TEXT,
    created_at         TEXT NOT NULL,
    updated_at         TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_family_calendar_receipts_payload
    ON family_calendar_action_receipts(
      calendar_id,
      payload_hash,
      dedupe_eligible,
      created_at
    );
`);

function receiptByKey(actionKey: string): FamilyCalendarActionReceipt | undefined {
  return db.prepare(
    `SELECT action_key, calendar_id, source_message_key, payload_hash,
            dedupe_eligible, state, provider_event_id, created_at, updated_at
       FROM family_calendar_action_receipts
      WHERE action_key = ?`,
  ).get(actionKey) as FamilyCalendarActionReceipt | undefined;
}

export function getFamilyCalendarActionReceipt(
  actionKey: string,
): FamilyCalendarActionReceipt | undefined {
  return receiptByKey(actionKey);
}

export function findRecentFamilyCalendarActionReceipt(input: {
  calendarId: string;
  payloadHash: string;
  notBefore: string;
}): FamilyCalendarActionReceipt | undefined {
  return db.prepare(
    `SELECT action_key, calendar_id, source_message_key, payload_hash,
            dedupe_eligible, state, provider_event_id, created_at, updated_at
       FROM family_calendar_action_receipts
      WHERE calendar_id = ?
        AND payload_hash = ?
        AND dedupe_eligible = 1
        AND created_at >= ?
      ORDER BY CASE state
                 WHEN 'dispatched' THEN 0
                 WHEN 'send_in_doubt' THEN 1
                 WHEN 'reserved' THEN 2
                 ELSE 3
               END,
               created_at DESC
      LIMIT 1`,
  ).get(input.calendarId, input.payloadHash, input.notBefore) as
    FamilyCalendarActionReceipt | undefined;
}

export function reserveFamilyCalendarActionReceipt(input: {
  actionKey: string;
  calendarId: string;
  sourceMessageKey: string;
  payloadHash: string;
  dedupeEligible: boolean;
  now: string;
}): FamilyCalendarActionReceipt {
  db.prepare(
    `INSERT OR IGNORE INTO family_calendar_action_receipts
       (action_key, calendar_id, source_message_key, payload_hash,
        dedupe_eligible, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)`,
  ).run(
    input.actionKey,
    input.calendarId,
    input.sourceMessageKey,
    input.payloadHash,
    input.dedupeEligible ? 1 : 0,
    input.now,
    input.now,
  );
  const receipt = receiptByKey(input.actionKey);
  if (!receipt) throw new Error('Could not persist the Family calendar action receipt.');
  if (
    receipt.calendar_id !== input.calendarId
    || receipt.source_message_key !== input.sourceMessageKey
    || receipt.payload_hash !== input.payloadHash
    || receipt.dedupe_eligible !== (input.dedupeEligible ? 1 : 0)
  ) {
    throw new Error('The Family calendar action receipt does not match this request.');
  }
  return receipt;
}

/** Only one worker may cross the provider-dispatch boundary. */
export function claimFamilyCalendarActionDispatch(
  actionKey: string,
  now: string,
): boolean {
  return db.prepare(
    `UPDATE family_calendar_action_receipts
        SET state = 'dispatched', updated_at = ?
      WHERE action_key = ? AND state = 'reserved'`,
  ).run(now, actionKey).changes === 1;
}

/** Return a claimed receipt to retryable state only before any provider call. */
export function releaseFamilyCalendarActionDispatch(
  actionKey: string,
  now: string,
): boolean {
  return db.prepare(
    `UPDATE family_calendar_action_receipts
        SET state = 'reserved', updated_at = ?
      WHERE action_key = ? AND state = 'dispatched'`,
  ).run(now, actionKey).changes === 1;
}

export function markFamilyCalendarActionSucceeded(
  actionKey: string,
  providerEventId: string,
  now: string,
): void {
  const changed = db.prepare(
    `UPDATE family_calendar_action_receipts
        SET state = 'succeeded', provider_event_id = ?, updated_at = ?
      WHERE action_key = ?
        AND state IN ('dispatched', 'send_in_doubt', 'succeeded')`,
  ).run(providerEventId, now, actionKey).changes;
  if (changed !== 1) throw new Error('Could not finalize the Family calendar action receipt.');
}

export function markFamilyCalendarActionSendInDoubt(
  actionKey: string,
  now: string,
): void {
  db.prepare(
    `UPDATE family_calendar_action_receipts
        SET state = 'send_in_doubt', updated_at = ?
      WHERE action_key = ? AND state IN ('dispatched', 'send_in_doubt')`,
  ).run(now, actionKey);
}
