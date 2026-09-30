import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'assistant-imessage-history-'));
process.env.ASSISTANT_DB_PATH = join(root, 'test.db');
process.env.ASSISTANT_PROFILE_PATH = join(root, 'missing-profile.json');
process.env.LOCAL_LLM_BASE_URL = 'http://127.0.0.1:11434';
process.env.LOCAL_LLM_MODEL = 'test-local';

const dbModule = await import('../src/db.js');
const historyModule = await import('../src/imessage-history.js');
const db = dbModule.default;

function insert(rowid: number, chatId: string, text: string, ts: string): void {
  dbModule.backfillIMessage({
    rowid_src: rowid,
    chat_id: chatId,
    sender: '+15550001111',
    direction: 'in',
    text,
    ts,
  });
}

try {
  insert(1, '+15550001111', "Acme's annual contract is $24,000.", '2026-08-01T12:00:00.000Z');
  insert(2, '+15550001111', 'The operating guide is https://example.com/guide', '2026-08-01T12:01:00.000Z');
  insert(3, '+15550002222', 'This old assistant answer must not become evidence.', '2026-08-01T12:02:00.000Z');
  insert(4, '+15550003333', 'Private family material.', '2026-08-01T12:03:00.000Z');
  insert(5, '+15550001111', 'After the cutoff.', '2026-09-07T12:00:00.000Z');

  const result = await historyModule.runIMessageHistoryBatch({
    before: '2026-09-06T00:00:00.000Z',
    batchSize: 20,
    maxObservations: 10,
    log: () => {},
    partition: (rows) => ({
      safe: rows.filter((row) => row.rowid_src !== 4),
      quarantined: rows.filter((row) => row.rowid_src === 4),
      familyPrivate: rows.filter((row) => row.rowid_src === 4),
    }),
    isBotGenerated: (row) => row.rowid_src === 3,
    complete: async () => JSON.stringify({
      observations: [
        {
          kind: 'figure', subject: 'Acme contract', predicate: 'annual value was', object: '$24,000',
          source_indices: [0], evidence_quote: "Acme's annual contract is $24,000.", confidence: 0.96,
        },
        {
          kind: 'link', subject: 'operating guide', predicate: 'reference URL was', object: 'https://example.com/guide',
          source_indices: [1], evidence_quote: 'The operating guide is https://example.com/guide', confidence: 0.95,
        },
        {
          kind: 'fact', subject: 'hallucination', predicate: 'was', object: 'unsupported',
          source_indices: [0], evidence_quote: 'This quote is absent', confidence: 0.99,
        },
        {
          kind: 'fact', subject: 'weak claim', predicate: 'was', object: 'too uncertain',
          source_indices: [0], evidence_quote: "Acme's annual contract is $24,000.", confidence: 0.5,
        },
      ],
    }),
  });

  assert.equal(result.scanned, 4, 'the row after the cutoff must not enter the batch');
  assert.equal(result.private, 1);
  assert.equal(result.botGenerated, 1);
  assert.equal(result.observationsAccepted, 2, 'unsupported and low-confidence claims must be rejected');
  assert.equal(result.factsInserted, 2);

  const facts = db.prepare(
    "SELECT * FROM facts WHERE source = 'imessage-history' ORDER BY id",
  ).all() as Array<{ fact_type: string; sensitive: number; object: string; confidence: number; source_ref: string }>;
  assert.equal(facts.length, 2);
  assert.ok(facts.every((fact) => fact.fact_type === 'reference'));
  assert.ok(facts.every((fact) => fact.sensitive === 1), 'message-mined facts must be owner-private');
  assert.ok(facts.every((fact) => fact.object.startsWith('[historical observation 2026-08-01]')));
  assert.ok(facts.every((fact) => fact.confidence <= 0.85), 'local historical claims must stay confidence-capped');
  assert.ok(facts.every((fact) => fact.source_ref.startsWith('imessage-history:')));

  const dispositions = db.prepare(
    `SELECT l.rowid_src, h.disposition FROM imessage_history_rows h
     JOIN imessage_log l ON l.id = h.imessage_id ORDER BY l.rowid_src`,
  ).all() as Array<{ rowid_src: number; disposition: string }>;
  assert.deepEqual(dispositions, [
    { rowid_src: 1, disposition: 'committed' },
    { rowid_src: 2, disposition: 'committed' },
    { rowid_src: 3, disposition: 'bot_generated' },
    { rowid_src: 4, disposition: 'private' },
  ]);

  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM people').get() as { n: number }).n, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM interactions').get() as { n: number }).n, 0);

  const second = await historyModule.runIMessageHistoryBatch({
    before: '2026-09-06T00:00:00.000Z',
    log: () => {},
    partition: (rows) => ({ safe: rows, quarantined: [], familyPrivate: [] }),
    isBotGenerated: () => false,
    complete: async () => '{"observations":[]}',
  });
  assert.equal(second.batchId, null, 'processed rows must not be selected twice');
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM facts WHERE source = 'imessage-history'").get() as { n: number }).n, 2);

  const cadence = dbModule.getIMessageHistoryCadence(10);
  assert.equal(cadence.length, 1, 'private and bot traffic must stay out of cadence');
  assert.equal(cadence[0].messages, 2);

  console.log('iMessage historical mining tests passed.');
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

