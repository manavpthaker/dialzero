import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const testDir = mkdtempSync(join(tmpdir(), 'assistant-email-reconciliation-'));
process.env.ASSISTANT_DB_PATH = join(testDir, 'test.db');

const OWNER = 'owner@example.test';
const CONTACT = 'contact@example.test';

function message(input: {
  id: string;
  date: string;
  from: string;
  to: string;
  subject: string;
  type?: string;
  flags?: string;
  body?: string;
}): string {
  return `  ID: ${input.id}
  Date: ${input.date}
  From: ${input.from}
  To: ${input.to}
  Subject: ${input.subject}
  Type: ${input.type || 'Received'}
  Flags: ${input.flags || ''}

${input.body || ''}`;
}

function thread(title: string, key: string, messages: string[]): string {
  return `Thread: ${title}
Link: spark://thread/${key}

${messages.join('\n\n')}`;
}

function search(messages: string[]): string {
  return `Search results: ${messages.length}

${messages.join('\n\n')}`;
}

function fixtureRunner(input: {
  threadOutput: string;
  searchOutput?: string;
  eventsOutput?: string;
}) {
  return async (args: string[]): Promise<string> => {
    if (args[0] === 'accounts') return `Email Account: Owner <${OWNER}>`;
    if (args[0] === 'thread') return input.threadOutput;
    if (args[0] === 'search') return input.searchOutput || 'Search results: 0';
    if (args[0] === 'events') return input.eventsOutput || 'No events found.';
    throw new Error(`Unexpected Spark fixture command: ${args.join(' ')}`);
  };
}

let closeDb: (() => void) | undefined;

try {
  const db = await import('../src/db.js');
  const reconciliation = await import('../src/email-reconciliation.js');
  closeDb = () => db.default.close();
  const now = new Date('2026-09-06T12:00:00-04:00');

  assert.equal(reconciliation.normalizeEmailSubject('Re: Accepted: First Fragments @ Tue Sep 8, 2026'), 'first fragments');
  assert.deepEqual(reconciliation.subjectSimilarity('Re: First Fragments', 'Accepted: First Fragments').overlap, 2);

  const firstInbound = message({
    id: '169727',
    date: '2026-09-03T12:00:00-04:00',
    from: `Christopher <${CONTACT}>`,
    to: `Owner <${OWNER}>`,
    subject: 'First Fragments',
    body: 'Could we reschedule? PRIVATE_BODY_MUST_NOT_PERSIST',
  });
  const acceptance = message({
    id: '169760',
    date: '2026-09-04T09:00:00-04:00',
    from: `Christopher <${CONTACT}>`,
    to: `Owner <${OWNER}>`,
    subject: 'Accepted: First Fragments @ Tue Sep 8, 2026 2pm - 3pm (EDT)',
    body: 'Christopher has accepted this invitation. PRIVATE_ACCEPTANCE_BODY',
  });
  const firstResults = await reconciliation.reconcileEmailItems({
    items: [{ messageId: '169727', kind: 'meeting', requestedAction: 'Choose a new time' }],
    spark: fixtureRunner({
      threadOutput: thread('First Fragments', 'first-fragments', [firstInbound]),
      searchOutput: search([acceptance]),
      eventsOutput: `── Tuesday, Sep 8, 2026 ──────────────────
  14:00 – 15:00  First Fragments
  ID: event-first-fragments
  14:00 – 15:00
  Attendees: ${OWNER} (yes), ${CONTACT} (yes)`,
    }),
    source: 'test:first-fragments',
    now,
  });
  assert.equal(firstResults[0].status, 'scheduled', 'a later acceptance plus matching attendee RSVP should close the scheduling question');
  assert.equal(firstResults[0].resolutionKind, 'invitation_accepted_email');
  assert(firstResults[0].changed);
  assert(firstResults[0].evidence.some((row) => row.sourceRef === 'email:169760'));
  assert(firstResults[0].evidence.some((row) => row.sourceRef === 'calendar:event-first-fragments'));

  const angelaInbound = message({
    id: '169930',
    date: '2026-09-05T08:00:00-04:00',
    from: `Angela <${CONTACT}>`,
    to: `Owner <${OWNER}>`,
    subject: 'Tuesday practice confirmation',
    body: 'Is practice confirmed?',
  });
  const angelaSent = message({
    id: '170483',
    date: '2026-09-05T10:00:00-04:00',
    from: `Owner <${OWNER}>`,
    to: `Angela <${CONTACT}>`,
    subject: 'Re: Tuesday practice confirmation',
    type: 'Sent',
    flags: 'Sent',
    body: 'Yes, Tuesday is confirmed. PRIVATE_SENT_BODY',
  });
  const angelaResults = await reconciliation.reconcileEmailItems({
    items: [{ messageId: '169930', kind: 'reply' }],
    spark: fixtureRunner({
      threadOutput: thread('Tuesday practice confirmation', 'angela-practice', [angelaInbound]),
      searchOutput: search([angelaSent]),
      eventsOutput: `── Tuesday, Sep 8, 2026 ──────────────────
  17:30 – 18:30  Tuesday practice confirmation
  ID: local-practice-hold
  17:30 – 18:30`,
    }),
    source: 'test:sent-reply',
    now,
  });
  assert.equal(angelaResults[0].status, 'responded', 'a newer Sent message should suppress a stale reply question');
  assert.equal(angelaResults[0].resolutionKind, 'sent_reply_or_followup');
  assert.equal(angelaResults[0].evidence.find((row) => row.sourceRef === 'calendar:local-practice-hold')?.summary.includes('hold only'), true);
  assert.equal(
    db.getEmailOpenLoopByMessageId('170483')?.id,
    angelaResults[0].openLoopId,
    'any evidence message ID should resolve back to the same cross-thread loop',
  );
  db.linkEmailOpenLoopCalendarByMessageId('170483', 'calendar-linked-through-evidence');
  assert.equal(
    db.getEmailOpenLoopByMessageId('169930')?.calendar_event_id,
    'calendar-linked-through-evidence',
    'artifact links should work from either the source ID or a later evidence ID',
  );

  const localOnlyInbound = message({
    id: '200001',
    date: '2026-09-05T11:00:00-04:00',
    from: `Contact <${CONTACT}>`,
    to: `Owner <${OWNER}>`,
    subject: 'Pool day for Casey and Riley',
    body: 'Does this work?',
  });
  const unrelatedSent = message({
    id: '200002',
    date: '2026-09-05T13:00:00-04:00',
    from: `Owner <${OWNER}>`,
    to: 'Someone Else <someone-else@example.test>',
    subject: 'Re: Pool day for Casey and Riley',
    type: 'Sent',
    body: 'This went to a different person.',
  });
  const localOnlyResults = await reconciliation.reconcileEmailItems({
    items: [{ messageId: '200001' }],
    spark: fixtureRunner({
      threadOutput: thread('Pool day for Casey and Riley', 'pool-day', [localOnlyInbound, unrelatedSent]),
      eventsOutput: `── Sunday, Sep 6, 2026 ──────────────────
  17:00 – 20:00  Pool day for Casey and Riley
  ID: local-pool-hold
  17:00 – 20:00`,
    }),
    source: 'test:local-hold',
    now,
  });
  assert.equal(localOnlyResults[0].status, 'open', 'a local calendar hold without the contact must not prove notification');
  assert.equal(localOnlyResults[0].resolutionKind, 'calendar_hold_only');

  const invoiceInbound = message({
    id: '300001',
    date: '2026-09-05T09:00:00-04:00',
    from: `Vendor <${CONTACT}>`,
    to: `Owner <${OWNER}>`,
    subject: 'Invoice payment requested',
    body: 'Please pay this invoice.',
  });
  const invoiceSent = message({
    id: '300002',
    date: '2026-09-05T10:00:00-04:00',
    from: `Owner <${OWNER}>`,
    to: `Vendor <${CONTACT}>`,
    subject: 'Re: Invoice payment requested',
    type: 'Sent',
    body: 'I am checking on this.',
  });
  const invoiceResults = await reconciliation.reconcileEmailItems({
    items: [{ messageId: '300001', kind: 'bill', requestedAction: 'Pay the invoice' }],
    spark: fixtureRunner({
      threadOutput: thread('Invoice payment requested', 'invoice', [invoiceInbound]),
      searchOutput: search([invoiceSent]),
    }),
    source: 'test:payment-not-closed-by-reply',
    now,
  });
  assert.equal(invoiceResults[0].status, 'open', 'a reply must not prove that a financial obligation was paid');
  assert.equal(invoiceResults[0].resolutionKind, 'contacted_payment_still_unverified');

  const replyTaskInbound = message({
    id: '400001',
    date: '2026-09-05T09:00:00-04:00',
    from: `Contact <${CONTACT}>`,
    to: `Owner <${OWNER}>`,
    subject: 'Please confirm the form details',
    body: 'Can you confirm these details?',
  });
  const replyTaskSent = message({
    id: '400002',
    date: '2026-09-05T10:00:00-04:00',
    from: `Owner <${OWNER}>`,
    to: `Contact <${CONTACT}>`,
    subject: 'Re: Please confirm the form details',
    type: 'Sent',
    body: 'Confirmed.',
  });
  const replyTaskId = db.createTask({
    title: 'Reply with form confirmation',
    group_id: 'home',
    due_date: '2020-01-01T09:00:00Z',
    source: 'test',
    source_ref: 'email:400001',
    sync_to_google: false,
  });
  const replyTaskResults = await reconciliation.reconcileEmailItems({
    items: [{ messageId: '400001', kind: 'reply' }],
    spark: fixtureRunner({
      threadOutput: thread('Please confirm the form details', 'reply-task', [replyTaskInbound]),
      searchOutput: search([replyTaskSent]),
    }),
    source: 'test:reply-task-suppression',
    now,
  });
  assert.equal(replyTaskResults[0].status, 'responded');
  assert(db.getOpenTasks().some((task) => task.id === replyTaskId), 'observe mode must leave the task open and visible');
  assert(!db.getOverdueTasks().some((task) => task.id === replyTaskId), 'a reconciled reply task must stop generating proactive stale reminders');
  assert(!db.getSchedulableTasks().some((task) => task.id === replyTaskId), 'a reconciled reply task must not be proposed for calendar blocking');

  const taskInbound = message({
    id: '42',
    date: '2026-09-05T12:00:00-04:00',
    from: `DMV <${CONTACT}>`,
    to: `Owner <${OWNER}>`,
    subject: 'Renew vehicle registration',
    body: 'Renew by the deadline.',
  });
  const taskId = db.createTask({
    title: 'Renew vehicle registration',
    group_id: 'home',
    source: 'test',
    source_ref: 'email:42',
    sync_to_google: false,
  });
  const taskRunner = fixtureRunner({
    threadOutput: thread('Renew vehicle registration', 'registration', [taskInbound]),
  });
  const tasked = await reconciliation.reconcileEmailItems({
    items: [{ messageId: '42' }],
    spark: taskRunner,
    source: 'test:task-open',
    now,
  });
  assert.equal(tasked[0].status, 'tasked');
  assert.equal(tasked[0].openLoopId !== null, true);
  db.updateTaskStatus(taskId, 'done');
  const completed = await reconciliation.reconcileEmailItems({
    items: [{ messageId: '42' }],
    spark: taskRunner,
    source: 'test:task-complete',
    now: new Date(now.getTime() + 60_000),
  });
  assert.equal(completed[0].status, 'resolved');
  assert.equal(completed[0].resolutionKind, 'task_completed');

  db.default.prepare(
    "UPDATE tasks SET completed_at = '2026-09-04 12:00:00', updated_at = '2026-09-04 12:00:00' WHERE id = ?",
  ).run(taskId);
  const reopened = await reconciliation.reconcileEmailItems({
    items: [{ messageId: '42' }],
    spark: taskRunner,
    source: 'test:new-inbound-after-task-close',
    now: new Date(now.getTime() + 120_000),
  });
  assert.equal(reopened[0].status, 'open', 'a new inbound after task completion must reopen the loop');
  assert.equal(reopened[0].resolutionKind, 'newer_inbound');

  const declined = message({
    id: '500002',
    date: '2026-09-05T12:00:00-04:00',
    from: `Contact <${CONTACT}>`,
    to: `Owner <${OWNER}>`,
    subject: 'Declined: Planning call @ Tue Sep 8, 2026',
    body: 'The invitation was declined.',
  });
  const declineResults = await reconciliation.reconcileEmailItems({
    items: [{ messageId: '500001', kind: 'meeting' }],
    spark: fixtureRunner({
      threadOutput: thread('Planning call', 'planning-call', [message({
        id: '500001',
        date: '2026-09-05T09:00:00-04:00',
        from: `Contact <${CONTACT}>`,
        to: `Owner <${OWNER}>`,
        subject: 'Planning call',
        body: 'Can we meet?',
      })]),
      searchOutput: search([declined]),
      eventsOutput: `── Tuesday, Sep 8, 2026 ──────────────────
  14:00 – 15:00  Planning call
  ID: event-declined
  14:00 – 15:00
  Attendees: ${OWNER} (yes), ${CONTACT} (no)`,
    }),
    source: 'test:decline',
    now,
  });
  assert.equal(declineResults[0].status, 'open');
  assert.equal(declineResults[0].resolutionKind, 'invitation_declined_needs_decision');

  const transitions = db.default.prepare(
    'SELECT from_status, to_status FROM email_open_loop_transitions ORDER BY id',
  ).all() as Array<{ from_status: string; to_status: string }>;
  assert(transitions.some((row) => row.from_status === 'open' && row.to_status === 'scheduled'));
  assert(transitions.some((row) => row.from_status === 'tasked' && row.to_status === 'resolved'));

  const persistedText = JSON.stringify({
    loops: db.default.prepare('SELECT subject, metadata_json FROM email_open_loops').all(),
    evidence: db.default.prepare('SELECT summary, metadata_json FROM email_open_loop_evidence').all(),
    runs: db.default.prepare('SELECT report_json FROM email_reconciliation_runs').all(),
  });
  assert(!persistedText.includes('PRIVATE_BODY_MUST_NOT_PERSIST'));
  assert(!persistedText.includes('PRIVATE_ACCEPTANCE_BODY'));
  assert(!persistedText.includes('PRIVATE_SENT_BODY'));

  console.log('email reconciliation tests passed');
} finally {
  closeDb?.();
  rmSync(testDir, { recursive: true, force: true });
}
