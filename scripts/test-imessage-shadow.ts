import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'assistant-imessage-shadow-'));
process.env.ASSISTANT_DB_PATH = join(root, 'test.db');

const dbModule = await import('../src/db.js');
const db = dbModule.default;

function insert(rowid: number, ts: string, text: string): void {
  dbModule.logIMessage({
    rowid_src: rowid,
    chat_id: '+15550001111',
    sender: '+15550001111',
    direction: 'in',
    text,
    ts,
  });
}

try {
  insert(1, '2026-09-05T11:00:00.000Z', 'old backlog row');
  insert(2, '2026-09-06T11:00:00.000Z', 'new row one');
  insert(3, '2026-09-06T11:01:00.000Z', 'new row two');

  const selected = dbModule.getUnextractedIMessagesSince('2026-09-06T00:00:00.000Z', 100);
  assert.deepEqual(selected.map((row) => row.rowid_src), [2, 3]);
  assert.equal(dbModule.getUnextractedIMessages(100).length, 3, 'the old backlog remains present');

  const draftId = dbModule.createIMessageExtractionDraft({
    batchKey: 'batch-2-3',
    sourceRowIds: selected.map((row) => row.id),
    sourceStart: selected[0].ts,
    sourceEnd: selected[1].ts,
    extraction: { decisions: [{ subject: 'test', text: 'shadow only' }] },
  });
  assert.ok(draftId);
  assert.equal(
    dbModule.createIMessageExtractionDraft({
      batchKey: 'batch-2-3',
      sourceRowIds: selected.map((row) => row.id),
      extraction: { decisions: [{ subject: 'test', text: 'duplicate retry' }] },
    }),
    null,
    'retrying one source batch must not create a second review item',
  );

  dbModule.markIMessagesExtracted(selected.map((row) => row.id));
  const remaining = dbModule.getUnextractedIMessages(100);
  assert.deepEqual(remaining.map((row) => row.rowid_src), [1], 'activation must not consume the old backlog');

  const drafts = dbModule.listIMessageExtractionDrafts({ status: 'pending' });
  assert.equal(drafts.length, 1);
  assert.match(drafts[0].extraction_json, /shadow only/);
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  assert.equal(count('facts'), 0);
  assert.equal(count('tasks'), 0);
  assert.equal(count('people'), 0);
  assert.equal(count('interactions'), 0);

  console.log('iMessage shadow extraction tests passed.');
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
