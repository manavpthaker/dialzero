import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'assistant-relationships-'));
process.env.ASSISTANT_DB_PATH = join(testDir, 'test.db');

try {
  const db = await import('../src/db.js');

  const alex = db.upsertPerson({ name: 'Alex Example', emails: ['alex@example.test'] });
  const blair = db.upsertPerson({ name: 'Blair Example', emails: ['blair@example.test'] });
  const casey = db.upsertPerson({ name: 'Casey Example', emails: ['casey@example.test'] });

  db.upsertRelationshipPlan({ person_id: alex, cadence_days: 7, source_ref: 'test' });
  db.upsertRelationshipPlan({ person_id: blair, cadence_days: 14, source_ref: 'test' });
  db.upsertRelationshipPlan({ person_id: casey, cadence_days: 30, source_ref: 'test' });

  assert.equal(
    db.listRelationshipStatuses({ person_id: alex, as_of: '2026-01-01T12:00:00Z' })[0].state,
    'baseline_unknown',
    'a plan without evidence must not fabricate a contact baseline',
  );

  const attemptId = db.recordRelationshipEvent({
    person_id: alex,
    occurred_at: '2026-01-01T12:00:00Z',
    channel: 'call',
    direction: 'outgoing',
    counts_as_outreach: true,
    counts_as_meaningful: false,
    source: 'test',
    source_ref: 'attempt-1',
  });
  const afterAttempt = db.listRelationshipStatuses({
    person_id: alex,
    as_of: '2026-01-02T12:00:00Z',
  })[0];
  assert.equal(afterAttempt.state, 'waiting_for_reply');
  assert.equal(afterAttempt.last_meaningful_at, null, 'an unanswered attempt must not reset meaningful contact');
  assert.equal(afterAttempt.last_outreach_at, '2026-01-01 12:00:00');

  db.recordRelationshipEvent({
    person_id: alex,
    occurred_at: '2026-01-03T12:00:00Z',
    channel: 'call',
    direction: 'incoming',
    counts_as_outreach: false,
    counts_as_meaningful: true,
    source: 'test',
    source_ref: 'connected-1',
  });
  const afterContact = db.listRelationshipStatuses({
    person_id: alex,
    as_of: '2026-01-05T12:00:00Z',
  })[0];
  assert.equal(afterContact.state, 'upcoming');
  assert.equal(afterContact.last_outreach_at, '2026-01-01 12:00:00');
  assert.equal(afterContact.last_meaningful_at, '2026-01-03 12:00:00');
  assert.equal(afterContact.next_due_at, '2026-01-10 12:00:00');

  assert.equal(
    db.listRelationshipStatuses({ person_id: alex, as_of: '2026-01-10T12:00:00Z' })[0].state,
    'due',
    'cadence boundary should become due at the exact interval',
  );

  const replayId = db.recordRelationshipEvent({
    person_id: alex,
    occurred_at: '2026-01-01T12:00:00Z',
    channel: 'call',
    direction: 'outgoing',
    counts_as_outreach: true,
    counts_as_meaningful: false,
    source: 'test',
    source_ref: 'attempt-1',
  });
  assert.equal(replayId, attemptId, 'source replay should be idempotent');
  assert.equal(
    db.getRelationshipEvents(alex).filter((event) => event.source_ref === 'attempt-1').length,
    1,
  );

  db.recordSharedRelationshipEvent([alex, blair], {
    occurred_at: '2026-01-20T18:00:00Z',
    channel: 'in_person',
    direction: 'two_way',
    counts_as_outreach: true,
    counts_as_meaningful: true,
    source: 'test',
    source_ref: 'shared-visit-1',
    confidence: 1,
    summary: 'Confirmed shared visit',
  });
  assert.equal(
    db.listRelationshipStatuses({ person_id: alex, as_of: '2026-01-21T12:00:00Z' })[0].last_meaningful_at,
    '2026-01-20 18:00:00',
  );
  assert.equal(
    db.listRelationshipStatuses({ person_id: blair, as_of: '2026-01-21T12:00:00Z' })[0].last_meaningful_at,
    '2026-01-20 18:00:00',
    'every explicitly named shared participant should get the contact event',
  );

  const due = db.getDueRelationshipStatuses({
    as_of: '2026-02-05T18:00:00Z',
    limit: 3,
    nudge_cooldown_days: 6,
  });
  assert.equal(due.length, 3, 'due selection should include due contacts plus unknown baselines');
  assert.notEqual(due[0].person_id, casey, 'known due cadences should outrank unknown baselines');
  assert(due.some((status) => status.person_id === casey && status.state === 'baseline_unknown'));

  db.markRelationshipPlansNudged([casey], '2026-02-05T18:00:00Z');
  assert(
    !db.getDueRelationshipStatuses({
      as_of: '2026-02-06T18:00:00Z',
      limit: 10,
      nudge_cooldown_days: 6,
    }).some((status) => status.person_id === casey),
    'a delivered nudge should apply a cooldown',
  );

  db.upsertRelationshipPlan({ person_id: blair, status: 'paused' });
  assert.equal(
    db.listRelationshipStatuses({ person_id: blair, include_inactive: true, as_of: '2026-02-10T12:00:00Z' })[0].state,
    'paused',
  );
  db.upsertRelationshipPlan({
    person_id: alex,
    snoozed_until: '2026-03-01T12:00:00Z',
  });
  assert.equal(
    db.listRelationshipStatuses({ person_id: alex, as_of: '2026-02-10T12:00:00Z' })[0].state,
    'snoozed',
  );

  assert.throws(
    () => db.upsertRelationshipPlan({ person_id: 999999, cadence_days: 7 }),
    /No person on file/,
  );

  console.log('relationship tracker tests passed');
} finally {
  rmSync(testDir, { recursive: true, force: true });
}
