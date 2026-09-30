import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-family-inbox-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');

const dbModule = await import('../src/db.js');
const channelModule = await import('../src/channels/imessage.js');
const chatId = 'test-family-chat';
const otherChatId = 'test-other-family-chat';

try {
  assert.equal(channelModule.chooseFamilyInboxActivationRowId({
    currentLatestRowId: 1_000,
    latestObservedGlobalRowId: 995,
    latestObservedFamilyRowId: 900,
  }), 900, 'first activation skipped the old process handoff watermark');
  assert.equal(channelModule.chooseFamilyInboxActivationRowId({
    currentLatestRowId: 1_000,
    latestObservedGlobalRowId: 1_200,
    latestObservedFamilyRowId: 900,
  }), 1_000, 'a rebuilt Messages database replayed incomparable old ROWIDs');
  assert.equal(channelModule.chooseFamilyInboxActivationRowId({
    currentLatestRowId: 1_000,
    latestObservedGlobalRowId: 995,
    latestObservedFamilyRowId: null,
  }), 1_000, 'a new Family mapping replayed pre-activation history');

  dbModule.logIMessage({
    rowid_src: 90,
    chat_id: chatId,
    sender: '+10000000001',
    direction: 'in',
    text: 'already observed',
    ts: '2026-09-19T11:59:00.000Z',
  });
  dbModule.logIMessage({
    rowid_src: 95,
    chat_id: otherChatId,
    sender: '+10000000003',
    direction: 'in',
    text: 'other observed row',
    ts: '2026-09-19T11:59:30.000Z',
  });
  assert.equal(dbModule.getLatestObservedIMessageRowId(chatId), 90);
  assert.equal(dbModule.getLatestObservedIMessageRowId(), 95);

  const first = dbModule.activateFamilyIMessageInbox(chatId, 100);
  assert.equal(first.activated, true);
  assert.equal(first.cursor.activation_rowid, 100);
  assert.equal(first.cursor.last_scanned_rowid, 100);

  // First activation is a hard historical boundary. Re-running activation at a
  // later chat.db tip must not move it or skip a downtime message.
  const repeated = dbModule.activateFamilyIMessageInbox(chatId, 999);
  assert.equal(repeated.activated, false);
  assert.equal(repeated.cursor.activation_rowid, 100);
  assert.equal(repeated.cursor.last_scanned_rowid, 100);

  assert.deepEqual(
    dbModule.recordFamilyIMessageScan({
      chatId,
      sourceRowId: 99,
      sourceGuid: 'pre-activation',
      sender: '+10000000001',
      rawText: 'must never replay',
      messageTimestamp: '2026-09-19T12:00:00.000Z',
    }),
    { inserted: false, inboxId: null },
  );

  const one = dbModule.recordFamilyIMessageScan({
    chatId,
    sourceRowId: 101,
    sourceGuid: 'family-guid-one',
    sender: '+10000000001',
    rawText: 'Add milk',
    messageTimestamp: '2026-09-19T12:01:00.000Z',
  });
  assert.equal(one.inserted, true);
  assert.ok(one.inboxId);

  // The same chat.db row cannot be delivered twice.
  assert.deepEqual(
    dbModule.recordFamilyIMessageScan({
      chatId,
      sourceRowId: 101,
      sourceGuid: 'family-guid-one',
      sender: '+10000000001',
      rawText: 'Add milk',
      messageTimestamp: '2026-09-19T12:01:00.000Z',
    }),
    { inserted: false, inboxId: null },
  );

  // A restored/re-numbered chat.db row with the same Apple GUID is also a
  // duplicate, but its scan cursor advances atomically so it is not rescanned.
  assert.deepEqual(
    dbModule.recordFamilyIMessageScan({
      chatId,
      sourceRowId: 102,
      sourceGuid: 'family-guid-one',
      sender: '+10000000001',
      rawText: 'Add milk',
      messageTimestamp: '2026-09-19T12:01:00.000Z',
    }),
    { inserted: false, inboxId: null },
  );
  assert.equal(dbModule.getFamilyIMessageInboxCursor(chatId)?.last_scanned_rowid, 102);

  // Non-dispatchable rows (outgoing messages, reactions, empty rows) still
  // advance the durable cursor without creating work.
  assert.deepEqual(
    dbModule.recordFamilyIMessageScan({ chatId, sourceRowId: 103, sourceGuid: 'reaction' }),
    { inserted: false, inboxId: null },
  );

  const two = dbModule.recordFamilyIMessageScan({
    chatId,
    sourceRowId: 104,
    sourceGuid: 'family-guid-two',
    sender: '+10000000002',
    rawText: 'Schedule dinner tomorrow at six',
    messageTimestamp: '2026-09-19T12:02:00.000Z',
    hasAttachment: true,
  });
  assert.equal(two.inserted, true);
  assert.ok(two.inboxId);
  assert.deepEqual(
    dbModule.getQueuedFamilyIMessages(chatId).map((row) => row.source_rowid),
    [101, 104],
    'queued work must remain oldest-first',
  );

  // Claim is a compare-and-set: an accidental duplicate in-memory enqueue
  // cannot enter the handler twice.
  assert.equal(dbModule.claimFamilyIMessage(one.inboxId!), true);
  assert.equal(dbModule.claimFamilyIMessage(one.inboxId!), false);

  // A restart never replays processing work. It becomes terminal
  // send-in-doubt while later queued work remains eligible.
  assert.equal(dbModule.recoverInterruptedFamilyIMessages(chatId), 1);
  assert.deepEqual(
    dbModule.getQueuedFamilyIMessages(chatId).map((row) => row.source_rowid),
    [104],
  );
  const recovered = dbModule.getFamilyIMessageInboxRows(chatId)
    .find((row) => row.source_rowid === 101);
  assert.equal(recovered?.state, 'send_in_doubt');
  assert.equal(recovered?.error_code, 'process_interrupted');

  assert.equal(dbModule.claimFamilyIMessage(two.inboxId!), true);
  assert.equal(dbModule.markFamilyIMessageSucceeded(two.inboxId!), true);
  assert.equal(dbModule.markFamilyIMessageSucceeded(two.inboxId!), false);

  const three = dbModule.recordFamilyIMessageScan({
    chatId,
    sourceRowId: 105,
    sourceGuid: 'family-guid-three',
    sender: '+10000000002',
    rawText: '',
    messageTimestamp: '2026-09-19T12:03:00.000Z',
    hasAttachment: true,
  });
  assert.equal(three.inserted, true);
  assert.equal(dbModule.markFamilyIMessageFailedBeforeDispatch(three.inboxId!), true);
  assert.equal(
    dbModule.getFamilyIMessageInboxRows(chatId).find((row) => row.source_rowid === 105)?.state,
    'failed_before_dispatch',
  );

  // Exact-chat isolation: another configured chat gets its own activation and
  // cannot observe or claim this chat's rows.
  dbModule.activateFamilyIMessageInbox(otherChatId, 500);
  assert.equal(dbModule.getQueuedFamilyIMessages(otherChatId).length, 0);
  assert.equal(dbModule.recoverInterruptedFamilyIMessages(otherChatId), 0);

  const guidKey = channelModule.buildIMessageSourceKey(chatId, 101, 'family-guid-one');
  assert.match(guidKey, /^[a-f0-9]{64}$/);
  assert.equal(
    guidKey,
    channelModule.buildIMessageSourceKey(chatId, 999, 'family-guid-one'),
    'Apple GUID must remain the preferred identity if chat.db ROWIDs change',
  );
  assert.notEqual(
    guidKey,
    channelModule.buildIMessageSourceKey(otherChatId, 101, 'family-guid-one'),
    'the exact chat is part of the action identity',
  );
  assert.notEqual(
    channelModule.buildIMessageSourceKey(chatId, 101, null),
    channelModule.buildIMessageSourceKey(chatId, 102, null),
    'ROWID is the deterministic fallback when Apple GUID is absent',
  );

  const attributedText = 'Body-only Family request';
  const attributedBody = Buffer.concat([
    Buffer.from('typedstream-prefix NSString', 'latin1'),
    Buffer.from([0x2b, attributedText.length]),
    Buffer.from(attributedText, 'utf8'),
  ]);
  assert.equal(
    channelModule.resolveIMessageText(null, attributedBody),
    attributedText,
    'a body-only iMessage would be advanced as an empty Family row',
  );
  assert.equal(
    channelModule.resolveIMessageText('plain text wins', attributedBody),
    'plain text wins',
  );
  const settleNow = Date.parse('2026-09-19T12:10:00.000Z');
  assert.equal(channelModule.shouldWaitForFamilyMessageContent({
    outgoing: false,
    reaction: false,
    observationOnlyCollision: false,
    senderHandle: '+10000000001',
    substantive: false,
    timestamp: '2026-09-19T12:09:50.000Z',
  }, settleNow, 30_000), true, 'a fresh empty row would be permanently advanced before settling');
  assert.equal(channelModule.shouldWaitForFamilyMessageContent({
    outgoing: false,
    reaction: false,
    observationOnlyCollision: false,
    senderHandle: '+10000000001',
    substantive: true,
    timestamp: '2026-09-19T12:09:50.000Z',
    attachmentMetadataPending: true,
  }, settleNow, 30_000), true, 'a captioned message advanced before its attachment join was visible');
  assert.equal(channelModule.isFamilyIMessageTooOld(
    '2026-09-18T12:09:59.000Z',
    settleNow,
    24 * 60 * 60 * 1000,
  ), true, 'stale restored directives were not age-gated');
  assert.equal(channelModule.hasCompleteLoadedAttachmentSet({
    image: { base64: 'image', mimetype: 'image/jpeg' },
    supportedAttachmentCount: 1,
  }), true);
  assert.equal(channelModule.hasCompleteLoadedAttachmentSet({
    image: { base64: 'image', mimetype: 'image/jpeg' },
    supportedAttachmentCount: 2,
  }), false, 'a partially readable multi-type attachment set was accepted');
  assert.equal(channelModule.hasCompleteLoadedAttachmentSet({
    supportedAttachmentCount: 0,
  }), false);

  const reset = dbModule.rebaseFamilyIMessageInboxAfterSourceReset(chatId, 5);
  assert.equal(reset.rebased, true);
  assert.ok(reset.retiredRows > 0);
  assert.equal(dbModule.getFamilyIMessageInboxCursor(chatId)?.last_scanned_rowid, 5);
  assert.equal(dbModule.getFamilyIMessageInboxRows(chatId).length, 0);
  const afterReset = dbModule.recordFamilyIMessageScan({
    chatId,
    sourceRowId: 6,
    // Reusing an old-generation GUID must not collide after a real chat.db reset.
    sourceGuid: 'family-guid-one',
    sender: '+10000000001',
    rawText: 'New generation request',
    messageTimestamp: '2026-09-19T12:10:01.000Z',
  });
  assert.equal(afterReset.inserted, true);
  assert.deepEqual(
    dbModule.rebaseFamilyIMessageInboxAfterSourceReset(chatId, 6),
    { rebased: false, retiredRows: 0 },
  );

  const rollbackChatId = 'test-transaction-rollback-chat';
  dbModule.activateFamilyIMessageInbox(rollbackChatId, 10);
  assert.throws(() => dbModule.recordFamilyIMessageScan({
    chatId: rollbackChatId,
    sourceRowId: 11,
    sourceGuid: 'invalid-time',
    sender: '+10000000003',
    rawText: 'Add eggs',
    messageTimestamp: 'not-a-date',
  }));
  assert.equal(
    dbModule.getFamilyIMessageInboxCursor(rollbackChatId)?.last_scanned_rowid,
    10,
    'a failed enqueue must roll back its cursor advance',
  );
  assert.equal(dbModule.getFamilyIMessageInboxRows(rollbackChatId).length, 0);

  // Pin the production plumbing contracts that make the ledger useful to
  // downstream idempotent actions and keep Family text out of console logs.
  const channelSource = readFileSync(join(process.cwd(), 'src/channels/imessage.ts'), 'utf8');
  const agentSource = readFileSync(join(process.cwd(), 'src/agent.ts'), 'utf8');
  const indexSource = readFileSync(join(process.cwd(), 'src/index.ts'), 'utf8');
  assert.match(channelSource, /m\.guid/);
  assert.match(channelSource, /m\.attributedBody/);
  assert.match(channelSource, /loadDurableFamilyAttachments/);
  assert.match(channelSource, /cache_has_attachments/);
  assert.match(channelSource, /multiple_same_type_attachments/);
  assert.match(channelSource, /hasCompleteLoadedAttachmentSet/);
  assert.match(channelSource, /alertOwnerOfUnreadableFamilyAttachment/);
  assert.match(channelSource, /for \(const row of getQueuedFamilyIMessages\(configuredFamilyChat\)\)/);
  assert.match(channelSource, /rebaseFamilyIMessageInboxAfterSourceReset/);
  assert.match(channelSource, /getLatestObservedIMessageRowId/);
  assert.match(channelSource, /chooseFamilyInboxActivationRowId/);
  assert.match(channelSource, /Family inbound message durably queued/);
  assert.match(channelSource, /Family handler outcome is uncertain; message will not be replayed/);
  assert.match(agentSource, /sourceMessageKey: sourceMessage\?\.key/);
  assert.match(agentSource, /currentCreatedAt: sourceMessage\?\.timestamp/);
  assert.match(
    indexSource,
    /if \(group\.key === 'family'\) \{\s*console\.log\('\[assistant\] Authenticated Family message received'\);\s*\} else \{\s*console\.log\(`\[assistant\].*text\.slice/,
  );

  console.log('Family durable inbox tests passed.');
} finally {
  dbModule.default.close();
  rmSync(tempRoot, { recursive: true, force: true });
}
