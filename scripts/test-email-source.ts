import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { calendar_v3, gmail_v1 } from 'googleapis';

// Isolated: no network, no real Gmail or Spark. The googleapis client and the
// Spark CLI runner are stubbed; the DB is a throwaway file.
const testDir = mkdtempSync(join(tmpdir(), 'dialzero-email-source-'));
process.env.ASSISTANT_DB_PATH = join(testDir, 'test.db');

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64url');

function gmailMessage(input: {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  date: string;
  body?: string;
  html?: string;
  labels?: string[];
  snippet?: string;
  messageId?: string;
}): gmail_v1.Schema$Message {
  const parts: gmail_v1.Schema$MessagePart[] = [];
  if (input.body !== undefined) parts.push({ mimeType: 'text/plain', body: { data: b64(input.body) } });
  if (input.html !== undefined) parts.push({ mimeType: 'text/html', body: { data: b64(input.html) } });
  return {
    id: input.id,
    threadId: input.threadId,
    labelIds: input.labels ?? ['INBOX', 'UNREAD'],
    snippet: input.snippet ?? 'Snippet &amp; more',
    internalDate: String(Date.parse(input.date)),
    payload: {
      mimeType: 'multipart/alternative',
      headers: [
        { name: 'From', value: input.from },
        { name: 'To', value: input.to },
        { name: 'Subject', value: input.subject },
        { name: 'Date', value: input.date },
        { name: 'Message-ID', value: input.messageId ?? `<${input.id}@mail.example.test>` },
      ],
      parts,
    },
  };
}

interface Call { method: string; params: Record<string, unknown> }

function stubGmail(messages: gmail_v1.Schema$Message[], calls: Call[]): gmail_v1.Gmail {
  const byId = new Map(messages.map((m) => [m.id!, m]));
  const stub = {
    users: {
      getProfile: async (params: Record<string, unknown>) => {
        calls.push({ method: 'getProfile', params });
        return { data: { emailAddress: 'Owner@Example.test' } };
      },
      settings: {
        sendAs: {
          list: async () => ({ data: { sendAs: [{ sendAsEmail: 'alias@example.test' }] } }),
        },
      },
      messages: {
        list: async (params: Record<string, unknown>) => {
          calls.push({ method: 'messages.list', params });
          return { data: { messages: messages.map((m) => ({ id: m.id, threadId: m.threadId })) } };
        },
        get: async (params: { id: string } & Record<string, unknown>) => {
          calls.push({ method: 'messages.get', params });
          const m = byId.get(params.id);
          if (!m) throw new Error(`404 no message ${params.id}`);
          return { data: m };
        },
        modify: async (params: Record<string, unknown>) => {
          calls.push({ method: 'messages.modify', params });
          return { data: {} };
        },
      },
      threads: {
        get: async (params: { id: string } & Record<string, unknown>) => {
          calls.push({ method: 'threads.get', params });
          return { data: { id: params.id, messages: messages.filter((m) => m.threadId === params.id) } };
        },
      },
      drafts: {
        create: async (params: Record<string, unknown>) => {
          calls.push({ method: 'drafts.create', params });
          return { data: { id: 'r-draft-1' } };
        },
      },
    },
  };
  return stub as unknown as gmail_v1.Gmail;
}

function stubCalendar(): calendar_v3.Calendar {
  return {
    events: {
      list: async () => ({
        data: {
          items: [{
            id: 'evt1',
            summary: 'Budget review',
            start: { dateTime: '2026-09-08T14:00:00-04:00' },
            end: { dateTime: '2026-09-08T15:00:00-04:00' },
            attendees: [
              { email: 'Contact@Example.test', responseStatus: 'accepted' },
              { email: 'other@example.test', responseStatus: 'declined' },
              { email: 'maybe@example.test', responseStatus: 'tentative' },
              { email: 'pending@example.test', responseStatus: 'needsAction' },
            ],
          }],
        },
      }),
    },
  } as unknown as calendar_v3.Calendar;
}

let closeDb: (() => void) | undefined;

try {
  const source = await import('../src/email/source.js');
  const gmailMod = await import('../src/email/gmail.js');
  const sparkMod = await import('../src/email/spark.js');

  // ── Source selection ──────────────────────────────────────────────────────
  const google = { GOOGLE_CALENDAR_CLIENT_ID: 'id', GOOGLE_CALENDAR_CLIENT_SECRET: 'secret', GOOGLE_CALENDAR_REFRESH_TOKEN: 'tok' };
  const noFile = () => false;
  const hasFile = () => true;
  assert.equal(source.resolveEmailSourceKind(google, noFile), 'gmail', 'Google token → gmail by default');
  assert.equal(source.resolveEmailSourceKind(google, hasFile), 'gmail', 'gmail beats an installed Spark');
  assert.equal(source.resolveEmailSourceKind({}, hasFile), 'spark', 'no Google token + Spark CLI → spark');
  assert.equal(source.resolveEmailSourceKind({}, noFile), null, 'nothing configured → none');
  assert.equal(source.resolveEmailSourceKind({ ...google, EMAIL_SOURCE: 'spark' }, noFile), 'spark', 'explicit spark wins');
  assert.equal(source.resolveEmailSourceKind({ EMAIL_SOURCE: 'gmail' }, hasFile), null, 'explicit gmail without a token is not connected');
  assert.equal(source.resolveEmailSourceKind({ ...google, EMAIL_SOURCE: 'none' }, hasFile), null, 'explicit none');
  assert.equal(source.resolveEmailSourceKind({ GOOGLE_CALENDAR_REFRESH_TOKEN: 'tok' }, noFile), null, 'token without client id/secret is not enough');
  let sparkPathChecked = '';
  source.resolveEmailSourceKind({ SPARK_BIN: '/opt/spark' }, (p) => { sparkPathChecked = p; return false; });
  assert.equal(sparkPathChecked, '/opt/spark', 'SPARK_BIN is the path probed');

  // ── Gmail message → normalized shape ─────────────────────────────────────
  const inbound = gmailMessage({
    id: '18c0a1b2c3d4e5f6',
    threadId: 'thr0001',
    from: 'Christopher Contact <contact@example.test>',
    to: 'Owner <owner@example.test>, second@example.test',
    subject: 'Budget review',
    date: 'Thu, 03 Sep 2026 12:00:00 -0400',
    body: 'Can we move it?',
    html: '<p>ignored because text/plain wins</p>',
  });
  const normalized = gmailMod.normalizeGmailMessage(inbound);
  assert.equal(normalized.id, '18c0a1b2c3d4e5f6');
  assert.equal(normalized.threadId, 'thr0001');
  assert.equal(normalized.from, 'Christopher Contact <contact@example.test>');
  assert.equal(normalized.fromEmail, 'contact@example.test');
  assert.equal(normalized.to, 'Owner <owner@example.test>, second@example.test');
  assert.deepEqual(normalized.toEmails, ['owner@example.test', 'second@example.test']);
  assert.equal(normalized.subject, 'Budget review');
  assert.equal(normalized.date, '2026-09-03T16:00:00.000Z');
  assert.equal(normalized.snippet, 'Snippet & more');
  assert.equal(normalized.body, 'Can we move it?');
  assert.equal(normalized.type, 'Received');
  assert.deepEqual(normalized.labels, ['INBOX', 'UNREAD']);

  const htmlOnly = gmailMod.normalizeGmailMessage(gmailMessage({
    id: 'html00001', threadId: 't', from: 'a@example.test', to: 'b@example.test', subject: 's',
    date: 'not a date', html: '<div>Hello&nbsp;<b>there</b></div><style>x{}</style>', labels: ['SENT'],
  }));
  assert.equal(htmlOnly.body, 'Hello there', 'html body is stripped to text');
  assert.equal(htmlOnly.type, 'Sent');
  assert.equal(htmlOnly.date, 'not a date', 'unparseable date passes through');
  assert.equal(gmailMod.normalizeGmailMessage(gmailMessage({
    id: 'draft0001', threadId: 't', from: 'a@example.test', to: 'b@example.test', subject: 's',
    date: 'Thu, 03 Sep 2026 12:00:00 -0400', body: 'x', labels: ['DRAFT'],
  })).type, 'Draft');

  // ── Gmail source against a stubbed client ────────────────────────────────
  const reply = gmailMessage({
    id: '18c0a1b2c3d4e5f7',
    threadId: 'thr0001',
    from: 'Owner <owner@example.test>',
    to: 'contact@example.test',
    subject: 'Re: Budget review',
    date: 'Thu, 03 Sep 2026 15:00:00 -0400',
    body: 'Sure, Tuesday works.',
    labels: ['SENT'],
  });
  const calls: Call[] = [];
  const gmail = gmailMod.createGmailEmailSource({ gmail: stubGmail([inbound, reply], calls), calendar: stubCalendar() });
  assert.equal(gmail.kind, 'gmail');
  assert.equal(gmail.isValidMessageId('18c0a1b2c3d4e5f6'), true);
  assert.equal(gmail.isValidMessageId('../etc'), false);

  const recent = await gmail.listRecent({ newerThan: '2d', limit: 5 });
  const listCall = calls.find((c) => c.method === 'messages.list')!;
  assert.equal(listCall.params.q, 'in:inbox newer_than:2d', 'listRecent defaults to the inbox');
  assert.equal(listCall.params.maxResults, 5);
  assert.equal(calls.find((c) => c.method === 'messages.get')!.params.format, 'metadata');
  assert.equal(recent.length, 2);

  calls.length = 0;
  await gmail.search('invoice', { newerThan: '90d' });
  assert.equal(calls[0].params.q, 'invoice newer_than:90d');
  assert.equal(calls[1].params.format, 'full');

  const thread = await gmail.readThread('18c0a1b2c3d4e5f6');
  assert.equal(thread.id, 'thr0001');
  assert.equal(thread.key, 'gmail-thread:thr0001');
  assert.equal(thread.title, 'Budget review');
  assert.deepEqual(thread.messages.map((m) => m.id), ['18c0a1b2c3d4e5f6', '18c0a1b2c3d4e5f7']);

  calls.length = 0;
  await gmail.archive(['18c0a1b2c3d4e5f6', '18c0a1b2c3d4e5f7']);
  const modifies = calls.filter((c) => c.method === 'messages.modify');
  assert.equal(modifies.length, 2);
  assert.deepEqual(modifies[0].params, { userId: 'me', id: '18c0a1b2c3d4e5f6', requestBody: { removeLabelIds: ['INBOX'] } });

  // Reply draft: recipient + subject default from the original, threaded.
  calls.length = 0;
  const draft = await gmail.createDraft({ body: 'Tuesday at 2 works. — Owner', inReplyTo: '18c0a1b2c3d4e5f6' });
  assert.equal(draft.id, 'r-draft-1');
  const create = calls.find((c) => c.method === 'drafts.create')!;
  const requestBody = create.params.requestBody as { message: { raw: string; threadId?: string } };
  assert.equal(requestBody.message.threadId, 'thr0001');
  assert.match(requestBody.message.raw, /^[A-Za-z0-9_-]+$/, 'raw is base64url');
  const rfc822 = Buffer.from(requestBody.message.raw, 'base64url').toString('utf8');
  const [head, encodedBody] = rfc822.split('\r\n\r\n');
  const headerLines = head.split('\r\n');
  assert.ok(headerLines.includes('To: Christopher Contact <contact@example.test>'));
  assert.ok(headerLines.includes('Subject: Re: Budget review'));
  assert.ok(headerLines.includes('In-Reply-To: <18c0a1b2c3d4e5f6@mail.example.test>'));
  assert.ok(headerLines.includes('References: <18c0a1b2c3d4e5f6@mail.example.test>'));
  assert.ok(headerLines.includes('MIME-Version: 1.0'));
  assert.ok(headerLines.includes('Content-Type: text/plain; charset="UTF-8"'));
  assert.equal(Buffer.from(encodedBody.replace(/\r\n/g, ''), 'base64').toString('utf8'), 'Tuesday at 2 works. — Owner');

  // New draft: non-ASCII subject is RFC 2047 encoded; header injection is stripped.
  const raw = gmailMod.buildRawDraft({ to: ['a@example.test'], cc: ['c@example.test'], subject: 'Café\r\nBcc: evil@example.test', body: 'hi' });
  const newHead = Buffer.from(raw, 'base64url').toString('utf8').split('\r\n\r\n')[0].split('\r\n');
  assert.ok(newHead.includes('To: a@example.test'));
  assert.ok(newHead.includes('Cc: c@example.test'));
  assert.ok(newHead.some((l) => l.startsWith('Subject: =?UTF-8?B?')), 'non-ASCII subject is encoded');
  assert.ok(!newHead.some((l) => /^Bcc:/i.test(l)), 'CRLF in subject cannot inject a header');
  assert.ok(!newHead.some((l) => l.startsWith('In-Reply-To')));

  const owners = await gmail.ownerEmails();
  assert.deepEqual([...owners].sort(), ['alias@example.test', 'owner@example.test']);

  const events = await gmail.calendarEvents!('2026-09-01', '2026-09-30');
  assert.equal(events.length, 1);
  assert.equal(events[0].date, '2026-09-08');
  assert.equal(events[0].time, '14:00 – 15:00');
  assert.deepEqual(events[0].attendees, [
    { email: 'contact@example.test', status: 'yes' },
    { email: 'other@example.test', status: 'no' },
    { email: 'maybe@example.test', status: 'maybe' },
    { email: 'pending@example.test', status: null },
  ]);

  // Missing scope turns into an actionable message.
  const scopeFail = gmailMod.createGmailEmailSource({
    gmail: { users: { messages: { list: async () => { throw new Error('Request had insufficient authentication scopes.'); } } } } as unknown as gmail_v1.Gmail,
  });
  await assert.rejects(scopeFail.listRecent(), /npm run auth:google/);

  // ── Spark source against a stubbed CLI runner ────────────────────────────
  const sparkCalls: string[][] = [];
  const spark = sparkMod.createSparkEmailSource(async (args) => {
    sparkCalls.push(args);
    if (args[0] === 'emails') return 'ID      Account   From   Subject\n169727  me@x.test  Alice <alice@example.test>  Lunch?\n\nPage 1 of 1';
    if (args[0] === 'action') return 'Archived 2';
    if (args[0] === 'thread') return 'Spark error: Is Spark Desktop running?';
    return '(no output)';
  });
  const sparkRows = await spark.listRecent({ newerThan: '2d', limit: 50 });
  assert.deepEqual(sparkCalls[0], ['emails', '--filter', 'newer_than:2d', '--page-size', '50']);
  assert.equal(sparkRows.length, 1);
  assert.equal(sparkRows[0].id, '169727');
  assert.match(sparkRows[0].snippet, /Lunch\?/);
  await spark.archive(['1', '2']);
  assert.deepEqual(sparkCalls[1], ['action', 'archive', '1', '2']);
  await assert.rejects(spark.readThread('169727'), /Spark error/);
  await assert.rejects(spark.readThread('abc'), /Invalid Spark message ID/);
  assert.equal(spark.isValidMessageId('18c0a1b2c3d4e5f6'), false);

  // ── Agent tools ──────────────────────────────────────────────────────────
  const db = await import('../src/db.js');
  closeDb = () => db.default.close();
  const { emailTools } = await import('../src/tools/email.js');
  const tool = (name: string) => emailTools.find((t) => t.definition.name === name)!.handler;
  assert.deepEqual(
    emailTools.map((t) => t.definition.name),
    ['email_list', 'email_search', 'email_read_thread', 'email_archive', 'email_draft'],
  );

  source.setEmailSourceForTests(null);
  for (const t of emailTools) {
    const out = await t.handler({ query: 'x', message_id: 'abcdef12', message_ids: ['abcdef12'], body: 'b', to: ['a@example.test'] });
    assert.equal(out, source.EMAIL_NOT_CONNECTED, `${t.definition.name} explains that email isn't connected`);
  }
  assert.match(source.EMAIL_NOT_CONNECTED, /npm run auth:google/);

  const toolCalls: Call[] = [];
  source.setEmailSourceForTests(gmailMod.createGmailEmailSource({ gmail: stubGmail([inbound, reply], toolCalls) }));
  // Reading mail never creates people; it only gives a known person filed under
  // their email address their real display name.
  const firstList = await tool('email_list')({ newer_than: '1d' }) as string;
  assert.match(firstList, /ID: 18c0a1b2c3d4e5f6/);
  assert.equal(db.findPersonByEmail('contact@example.test'), undefined, 'reading mail does not create a person');
  db.upsertPerson({ name: 'contact@example.test', emails: ['contact@example.test'] });
  const listed = await tool('email_list')({ newer_than: '1d' }) as string;
  assert.match(listed, /Subject: Budget review/);
  const person = db.findPersonByEmail('contact@example.test');
  assert.equal(person?.name, 'Christopher Contact', 'a stand-in name becomes the real display name');
  db.upsertPerson({ name: 'contact@example.test', emails: ['contact@example.test'] });
  assert.equal(db.findPersonByEmail('contact@example.test')?.name, 'Christopher Contact', 'an email never overwrites a real name');
  assert.equal(db.findPersonByEmail('owner@example.test'), undefined, 'sent mail does not create a person');

  assert.equal(await tool('email_archive')({ message_ids: ['18c0a1b2c3d4e5f6'] }), 'Archived 1 email(s).');
  assert.match(await tool('email_archive')({ message_ids: ['../x'] }) as string, /Not valid/);
  assert.match(await tool('email_draft')({ body: 'hi' }) as string, /needs "to"/);
  assert.match(await tool('email_draft')({ body: 'hi', reply_to_message_id: '18c0a1b2c3d4e5f6' }) as string, /Draft saved in Gmail/);
  assert.match(await tool('email_read_thread')({ message_id: '18c0a1b2c3d4e5f6' }) as string, /Sure, Tuesday works\./);
  assert.ok(!toolCalls.some((c) => /send/i.test(c.method)), 'no tool sends mail');

  // ── Reconciliation through a Gmail source ────────────────────────────────
  const reconciliation = await import('../src/email-reconciliation.js');
  const [result] = await reconciliation.reconcileEmailItems({
    items: [{ messageId: '18c0a1b2c3d4e5f6', kind: 'reply' }],
    emailSource: gmailMod.createGmailEmailSource({ gmail: stubGmail([inbound, reply], []) }),
    persist: false,
    now: new Date('2026-09-06T12:00:00-04:00'),
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 'responded', 'a sent Gmail reply closes the loop');
  assert.equal(result.contact, 'contact@example.test');

  source.setEmailSourceForTests(null);
  const [disconnected] = await reconciliation.reconcileEmailItems({ items: [{ messageId: '18c0a1b2c3d4e5f6' }], persist: false });
  assert.equal(disconnected.status, 'uncertain');
  assert.match(disconnected.error || '', /isn't connected/);
  source.setEmailSourceForTests(undefined);

  console.log('email source tests passed');
} finally {
  closeDb?.();
  rmSync(testDir, { recursive: true, force: true });
}
