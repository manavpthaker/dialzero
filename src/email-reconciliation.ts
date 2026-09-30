import { createHash } from 'node:crypto';
import {
  addEmailOpenLoopEvidence,
  finishEmailReconciliationRun,
  getActiveEmailOpenLoopByEntityKey,
  getEmailOpenLoopByThreadKey,
  getEmailOpenLoopEvidence,
  getRecentEmailOpenLoopTransitions,
  getTaskById,
  getTaskBySourceRef,
  listEmailOpenLoops,
  setMemory,
  startEmailReconciliationRun,
  updateEmailOpenLoopState,
  upsertEmailOpenLoop,
  type EmailOpenLoopStatus,
} from './db.js';
import { parseBoolEnv, parseNumEnv } from './lib/env.js';
import {
  EMAIL_NOT_CONNECTED,
  getEmailSource,
  type CalendarEventSummary,
  type EmailMessage,
  type EmailSource,
} from './email/source.js';
import { createSparkEmailSource, type SparkRunner } from './email/spark.js';

export { parseSparkEvents, parseSparkMessages, parseSparkOwnerEmails, parseSparkThread } from './email/spark.js';
export type { SparkRunner } from './email/spark.js';

/**
 * Observe-only reconciliation across the configured email source (Gmail or
 * Spark), its calendar, and local tasks. Exact metadata closes loops; ambiguous
 * semantic similarity is retained as evidence but never promoted to a "resolved" claim.
 *
 * This module intentionally makes no LLM calls. A 15-minute observer should not
 * rescan private bodies through a paid provider when headers, thread direction,
 * RSVP state, and source references can answer the question deterministically.
 */

export interface EmailItemToReconcile {
  messageId: string;
  kind?: string;
  requestedAction?: string;
  taskId?: number;
  calendarEventId?: string;
}

export interface ReconciliationEvidence {
  type: string;
  sourceRef: string;
  occurredAt?: string;
  direction?: 'in' | 'out';
  summary: string;
  confidence: number;
  metadata?: Record<string, unknown>;
}

export interface EmailReconciliationResult {
  messageId: string;
  openLoopId: number | null;
  subject: string;
  contact: string | null;
  status: EmailOpenLoopStatus;
  resolutionKind: string | null;
  confidence: number;
  changed: boolean;
  evidence: ReconciliationEvidence[];
  error?: string;
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'at', 'be', 'before', 'for', 'from', 'has', 'have',
  'in', 'invitation', 'is', 'it', 'me', 'my', 'new', 'of', 'on', 'or', 'our',
  're', 'regarding', 'the', 'this', 'to', 'update', 'updated', 'with', 'your',
  'am', 'pm', 'edt', 'est', 'today', 'tomorrow', 'monday', 'tuesday',
  'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'jan', 'feb', 'mar',
  'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

const TERMINAL_STATUSES = new Set<EmailOpenLoopStatus>(['responded', 'scheduled', 'resolved']);

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

export function normalizeEmailSubject(subject: string): string {
  let normalized = subject.trim();
  const prefix = /^(?:re|fw|fwd|accepted|declined|tentative|canceled|cancelled|invitation|updated invitation)\s*:\s*/i;
  while (prefix.test(normalized)) normalized = normalized.replace(prefix, '').trim();
  normalized = normalized
    .replace(/\s+@\s+(?:mon|tue|wed|thu|fri|sat|sun)[\s\S]*$/i, '')
    .replace(/\([^)]*(?:EDT|EST|PDT|PST|CDT|CST|UTC|GMT)[^)]*\)/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return normalized;
}

export function subjectTokens(subject: string): string[] {
  return Array.from(new Set(
    normalizeEmailSubject(subject)
      .split(' ')
      .map((token) => token.trim())
      .filter((token) => token.length >= 2 && !STOP_WORDS.has(token) && !/^\d+$/.test(token)),
  ));
}

export function subjectSimilarity(a: string, b: string): { score: number; overlap: number } {
  const left = subjectTokens(a);
  const right = subjectTokens(b);
  if (!left.length || !right.length) return { score: 0, overlap: 0 };
  const rightSet = new Set(right);
  const overlap = left.filter((token) => rightSet.has(token)).length;
  return { score: overlap / Math.min(left.length, right.length), overlap };
}

function parseMessageTime(value: string): number {
  if (!value) return 0;
  const parsed = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function newest(messages: EmailMessage[]): EmailMessage | undefined {
  return [...messages].sort((a, b) => parseMessageTime(b.date) - parseMessageTime(a.date))[0];
}

function isDraft(message: EmailMessage): boolean {
  return message.type.toLowerCase() === 'draft' || /\bdraft\b/i.test(message.flags);
}

function isScheduledSend(message: EmailMessage): boolean {
  return /\bscheduled\b|send later/i.test(`${message.type} ${message.flags}`);
}

function isAccepted(message: EmailMessage): boolean {
  return /^accepted\s*:/i.test(message.subject) || /\bhas accepted this invitation\b/i.test(message.body);
}

function isDeclined(message: EmailMessage): boolean {
  return /^declined\s*:/i.test(message.subject) || /\bhas declined this invitation\b/i.test(message.body);
}

function externalEmails(message: EmailMessage, ownerEmails: Set<string>): string[] {
  return Array.from(new Set(
    [message.fromEmail, ...message.toEmails]
      .filter((email): email is string => Boolean(email) && !ownerEmails.has(email!)),
  ));
}

function messageDirection(message: EmailMessage, ownerEmails: Set<string>): 'in' | 'out' | 'unknown' {
  if (message.fromEmail && ownerEmails.has(message.fromEmail)) return 'out';
  if (message.fromEmail) return 'in';
  return 'unknown';
}

function isRelatedMessage(
  candidate: EmailMessage,
  sourceSubject: string,
  contact: string | null,
  ownerEmails: Set<string>,
): boolean {
  const similarity = subjectSimilarity(sourceSubject, candidate.subject);
  const participantMatch = contact
    ? externalEmails(candidate, ownerEmails).includes(contact)
    : false;
  if (similarity.score === 1 && similarity.overlap >= 1 && (!contact || participantMatch)) return true;
  if (participantMatch && similarity.overlap >= 2 && similarity.score >= 0.45) return true;
  if (participantMatch && (isAccepted(candidate) || isDeclined(candidate)) && similarity.overlap >= 1) return true;
  return false;
}

function uniqueMessages(messages: EmailMessage[]): EmailMessage[] {
  const byId = new Map<string, EmailMessage>();
  for (const message of messages) byId.set(message.id, message);
  return Array.from(byId.values());
}

function searchQueries(subject: string, contact: string | null): string[] {
  const tokens = subjectTokens(subject).slice(0, 7);
  const queries = [
    contact,
    tokens.length >= 2 ? tokens.slice(0, 4).join(' ') : null,
    !contact && tokens.length < 2 ? subject : null,
  ].filter((query): query is string => Boolean(query?.trim()));
  return Array.from(new Set(queries));
}

function entityKey(contact: string | null, subject: string): string {
  const tokens = subjectTokens(subject).slice(0, 8).sort().join('-') || normalizeEmailSubject(subject);
  return sha(`${contact || 'unknown'}|${tokens}`);
}

function eventMatch(
  event: CalendarEventSummary,
  subject: string,
  contact: string | null,
): { matched: boolean; participant: boolean; accepted: boolean; declined: boolean; localOnly: boolean; confidence: number } {
  const similarity = subjectSimilarity(subject, event.title);
  const participant = Boolean(contact && event.attendees.some((attendee) => attendee.email === contact));
  const accepted = Boolean(contact && event.attendees.some((attendee) => attendee.email === contact && attendee.status === 'yes'));
  const declined = Boolean(contact && event.attendees.some((attendee) => attendee.email === contact && attendee.status === 'no'));
  const titleMatch = similarity.overlap >= 2 && similarity.score >= 0.5;
  const participantTitleMatch = participant && similarity.overlap >= 1 && similarity.score >= 0.34;
  const matched = titleMatch || participantTitleMatch;
  return {
    matched,
    participant,
    accepted: matched && accepted,
    declined: matched && declined,
    localOnly: matched && !participant,
    confidence: accepted && matched ? 0.99 : participantTitleMatch ? 0.9 : titleMatch ? 0.72 : 0,
  };
}

function evidenceForMessage(message: EmailMessage, direction: 'in' | 'out' | 'unknown'): ReconciliationEvidence {
  const label = isDraft(message)
    ? 'Draft'
    : isScheduledSend(message)
      ? 'Scheduled outgoing email'
      : direction === 'out'
        ? 'Sent email'
        : 'Incoming email';
  return {
    type: isAccepted(message) || isDeclined(message) ? 'calendar_response_email' : 'email_message',
    sourceRef: `email:${message.id}`,
    occurredAt: message.date || undefined,
    direction: direction === 'unknown' ? undefined : direction,
    summary: `${label}: ${message.subject || '(no subject)'}`,
    confidence: 1,
    metadata: {
      message_id: message.id,
      type: message.type || null,
      flags: message.flags || null,
    },
  };
}

function statusFromEvidence(input: {
  source: EmailMessage;
  related: EmailMessage[];
  ownerEmails: Set<string>;
  matchedEvents: Array<{ event: CalendarEventSummary; match: ReturnType<typeof eventMatch> }>;
  taskId?: number;
  kind?: string;
  requestedAction?: string;
}): {
  status: EmailOpenLoopStatus;
  resolutionKind: string | null;
  confidence: number;
  evidenceRef: string | null;
  latestInboundAt: string | null;
  latestOutboundAt: string | null;
  taskId: number | null;
  calendarEventId: string | null;
} {
  const incoming = input.related.filter((message) => messageDirection(message, input.ownerEmails) === 'in');
  const actionableIncoming = incoming.filter((message) => !isAccepted(message) && !isDeclined(message));
  const outgoing = input.related.filter((message) => messageDirection(message, input.ownerEmails) === 'out');
  const sent = outgoing.filter((message) => !isDraft(message) && !isScheduledSend(message));
  const drafts = outgoing.filter((message) => isDraft(message) || isScheduledSend(message));
  const acceptedMessages = incoming.filter(isAccepted);
  const declinedMessages = incoming.filter(isDeclined);
  const latestInbound = newest(incoming);
  const latestActionableInbound = newest(actionableIncoming);
  const latestSent = newest(sent);
  const latestDraft = newest(drafts);
  const latestAccepted = newest(acceptedMessages);
  const latestDeclined = newest(declinedMessages);
  const financialObligation = /\b(?:bill|billing|invoice|pay|payment|balance|past[ -]?due|deposit|retainer|card declined|payment failed)\b/i.test(
    `${input.kind || ''} ${input.requestedAction || ''} ${input.source.subject}`,
  );

  const linkedTask = input.taskId
    ? getTaskById(input.taskId)
    : getTaskBySourceRef(`email:${input.source.id}`);
  const linkedTaskActive = Boolean(linkedTask && ['open', 'in_progress'].includes(linkedTask.status));
  const taskClosedAt = linkedTask && (linkedTask.status === 'done' || linkedTask.status === 'cancelled')
    ? parseStoredTime(linkedTask.completed_at || linkedTask.updated_at || '')
    : 0;
  const closureTime = Math.max(
    parseMessageTime(latestSent?.date || ''),
    parseMessageTime(latestAccepted?.date || ''),
    taskClosedAt,
  );
  if (closureTime > 0 && latestActionableInbound && parseMessageTime(latestActionableInbound.date) > closureTime) {
    return {
      status: linkedTaskActive ? 'tasked' : 'open',
      resolutionKind: latestDeclined && latestDeclined.id === latestActionableInbound.id ? 'invitation_declined' : 'newer_inbound',
      confidence: 0.98,
      evidenceRef: `email:${latestActionableInbound.id}`,
      latestInboundAt: latestInbound?.date || null,
      latestOutboundAt: latestSent?.date || null,
      taskId: linkedTask?.id ?? null,
      calendarEventId: null,
    };
  }

  if (linkedTask && (linkedTask.status === 'done' || linkedTask.status === 'cancelled')) {
    return {
      status: 'resolved',
      resolutionKind: linkedTask.status === 'done' ? 'task_completed' : 'task_cancelled',
      confidence: 1,
      evidenceRef: `task:${linkedTask.id}`,
      latestInboundAt: latestInbound?.date || null,
      latestOutboundAt: latestSent?.date || null,
      taskId: linkedTask.id,
      calendarEventId: null,
    };
  }

  const acceptedEvent = input.matchedEvents.find(({ match }) => match.accepted);
  const declinedEvent = input.matchedEvents.find(({ match }) => match.declined);
  const latestCalendarResponse = newest([...acceptedMessages, ...declinedMessages]);
  const latestSentAt = parseMessageTime(latestSent?.date || '');
  if (
    (latestCalendarResponse && isDeclined(latestCalendarResponse)
      && parseMessageTime(latestCalendarResponse.date) >= latestSentAt)
    || (!latestCalendarResponse && declinedEvent && !acceptedEvent)
  ) {
    return {
      status: 'open',
      resolutionKind: 'invitation_declined_needs_decision',
      confidence: 1,
      evidenceRef: latestCalendarResponse
        ? `email:${latestCalendarResponse.id}`
        : `calendar:${declinedEvent!.event.id}`,
      latestInboundAt: latestInbound?.date || null,
      latestOutboundAt: latestSent?.date || null,
      taskId: linkedTask?.id ?? null,
      calendarEventId: declinedEvent?.event.id ?? null,
    };
  }
  if (!financialObligation && (latestAccepted || acceptedEvent)) {
    return {
      status: 'scheduled',
      resolutionKind: latestAccepted ? 'invitation_accepted_email' : 'calendar_attendee_accepted',
      confidence: latestAccepted ? 1 : acceptedEvent!.match.confidence,
      evidenceRef: latestAccepted ? `email:${latestAccepted.id}` : `calendar:${acceptedEvent!.event.id}`,
      latestInboundAt: latestInbound?.date || null,
      latestOutboundAt: latestSent?.date || null,
      taskId: linkedTask?.id ?? null,
      calendarEventId: acceptedEvent?.event.id ?? null,
    };
  }

  if (latestSent && parseMessageTime(latestSent.date) >= parseMessageTime(latestActionableInbound?.date || input.source.date)) {
    if (financialObligation) {
      return {
        status: linkedTask ? 'tasked' : 'open',
        resolutionKind: 'contacted_payment_still_unverified',
        confidence: 0.98,
        evidenceRef: `email:${latestSent.id}`,
        latestInboundAt: latestInbound?.date || null,
        latestOutboundAt: latestSent.date || null,
        taskId: linkedTask?.id ?? null,
        calendarEventId: null,
      };
    }
    return {
      status: 'responded',
      resolutionKind: 'sent_reply_or_followup',
      confidence: 0.98,
      evidenceRef: `email:${latestSent.id}`,
      latestInboundAt: latestInbound?.date || null,
      latestOutboundAt: latestSent.date || null,
      taskId: linkedTask?.id ?? null,
      calendarEventId: null,
    };
  }

  if (latestDraft && parseMessageTime(latestDraft.date) >= parseMessageTime(latestActionableInbound?.date || input.source.date)) {
    return {
      status: 'drafted',
      resolutionKind: isScheduledSend(latestDraft) ? 'reply_scheduled_not_sent' : 'draft_not_sent',
      confidence: 0.98,
      evidenceRef: `email:${latestDraft.id}`,
      latestInboundAt: latestInbound?.date || null,
      latestOutboundAt: null,
      taskId: linkedTask?.id ?? null,
      calendarEventId: null,
    };
  }

  if (linkedTask) {
    return {
      status: 'tasked',
      resolutionKind: 'linked_task_open',
      confidence: 1,
      evidenceRef: `task:${linkedTask.id}`,
      latestInboundAt: latestInbound?.date || null,
      latestOutboundAt: latestSent?.date || null,
      taskId: linkedTask.id,
      calendarEventId: null,
    };
  }

  return {
    status: 'open',
    resolutionKind: input.matchedEvents.some(({ match }) => match.localOnly) ? 'calendar_hold_only' : 'unanswered_inbound',
    confidence: 0.96,
    evidenceRef: `email:${input.source.id}`,
    latestInboundAt: latestInbound?.date || input.source.date || null,
    latestOutboundAt: latestSent?.date || null,
    taskId: null,
    calendarEventId: input.matchedEvents.find(({ match }) => match.localOnly)?.event.id ?? null,
  };
}

function compactError(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').slice(0, 300);
}

function parseStoredTime(value: string): number {
  if (!value) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function calendarWindows(now: Date): Array<{ start: string; end: string }> {
  const day = 86_400_000;
  return [
    { start: new Date(now.getTime() - 30 * day), end: now },
    { start: now, end: new Date(now.getTime() + 30 * day) },
    { start: new Date(now.getTime() + 30 * day), end: new Date(now.getTime() + 60 * day) },
  ].map(({ start, end }) => ({
    start: start.toISOString().slice(0, 10),
    end: end.toISOString().slice(0, 10),
  }));
}

export async function reconcileEmailItems(opts: {
  items: EmailItemToReconcile[];
  source?: string;
  lookbackDays?: number;
  persist?: boolean;
  /** Email source; defaults to the configured one (getEmailSource). */
  emailSource?: EmailSource;
  /** Test/legacy shorthand: a raw Spark CLI runner, wrapped as a Spark source. */
  spark?: SparkRunner;
  now?: Date;
}): Promise<EmailReconciliationResult[]> {
  const items = opts.items.slice(0, 25);
  const persist = opts.persist !== false;
  const emailSource = opts.emailSource || (opts.spark ? createSparkEmailSource(opts.spark) : null);
  const source = opts.source || 'manual';
  const lookbackDays = Math.min(Math.max(opts.lookbackDays ?? 90, 7), 365);
  const now = opts.now || new Date();
  const runId = persist ? startEmailReconciliationRun({ source, candidateCount: items.length }) : null;
  const results: EmailReconciliationResult[] = [];
  let transitions = 0;
  let errors = 0;

  try {
    const mail: EmailSource | null = emailSource || await getEmailSource();
    if (!mail) throw new Error(EMAIL_NOT_CONNECTED);
    const ownerEmails = await mail.ownerEmails();
    if (!ownerEmails.size) throw new Error('The email source returned no owner email accounts');

    const eventsById = new Map<string, CalendarEventSummary>();
    for (const window of calendarWindows(now)) {
      if (!mail.calendarEvents) break;
      try {
        for (const event of await mail.calendarEvents(window.start, window.end)) eventsById.set(event.id, event);
      } catch {
        continue;
      }
    }
    const events = Array.from(eventsById.values());
    const searchCache = new Map<string, EmailMessage[]>();

    for (const item of items) {
      try {
        if (!mail.isValidMessageId(item.messageId)) throw new Error(`Invalid ${mail.kind} message ID: ${item.messageId}`);
        const thread = await mail.readThread(item.messageId);
        const sourceMessage = thread.messages.find((message) => message.id === item.messageId)
          || newest(thread.messages);
        if (!sourceMessage) throw new Error(`Email thread ${item.messageId} contained no messages`);
        const sourceDirection = messageDirection(sourceMessage, ownerEmails);
        const contact = externalEmails(sourceMessage, ownerEmails)[0]
          || thread.messages.flatMap((message) => externalEmails(message, ownerEmails))[0]
          || null;
        const subject = sourceMessage.subject || thread.title || `(message ${item.messageId})`;

        const searchMessages: EmailMessage[] = [];
        for (const query of searchQueries(subject, contact)) {
          let matches = searchCache.get(query);
          if (!matches) {
            try {
              matches = await mail.search(query, { newerThan: `${lookbackDays}d` });
            } catch {
              matches = [];
            }
            searchCache.set(query, matches);
          }
          searchMessages.push(...matches);
        }
        const relatedThreadMessages = thread.messages.filter((candidate) =>
          candidate.id === sourceMessage.id
          || !contact
          || externalEmails(candidate, ownerEmails).includes(contact)
        );
        const related = uniqueMessages([
          ...relatedThreadMessages,
          ...searchMessages.filter((candidate) => isRelatedMessage(candidate, subject, contact, ownerEmails)),
        ]);
        const matchedEvents = events
          .map((event) => ({ event, match: eventMatch(event, subject, contact) }))
          .filter(({ match }) => match.matched)
          .sort((a, b) => b.match.confidence - a.match.confidence);

        const computed = statusFromEvidence({
          source: sourceMessage,
          related,
          ownerEmails,
          matchedEvents,
          taskId: item.taskId,
          kind: item.kind,
          requestedAction: item.requestedAction,
        });
        const evidence: ReconciliationEvidence[] = related
          .sort((a, b) => parseMessageTime(b.date) - parseMessageTime(a.date))
          .slice(0, 12)
          .map((message) => evidenceForMessage(message, messageDirection(message, ownerEmails)));
        for (const { event, match } of matchedEvents.slice(0, 4)) {
          const acceptedAttendees = event.attendees.filter((attendee) => attendee.status === 'yes').map((attendee) => attendee.email);
          const declinedAttendees = event.attendees.filter((attendee) => attendee.status === 'no').map((attendee) => attendee.email);
          evidence.push({
            type: match.accepted || match.declined ? 'calendar_rsvp' : 'calendar_event',
            sourceRef: `calendar:${event.id}`,
            occurredAt: event.date || undefined,
            summary: match.accepted
              ? `Calendar accepted: ${event.title} on ${event.date}${event.time ? ` ${event.time}` : ''}`
              : match.declined
                ? `Calendar declined: ${event.title} on ${event.date}${event.time ? ` ${event.time}` : ''}`
                : match.localOnly
                  ? `Calendar hold only: ${event.title} on ${event.date}${event.time ? ` ${event.time}` : ''}`
                  : `Calendar event (RSVP unconfirmed): ${event.title} on ${event.date}${event.time ? ` ${event.time}` : ''}`,
            confidence: match.confidence,
            metadata: {
              event_id: event.id,
              accepted_attendees: acceptedAttendees,
              declined_attendees: declinedAttendees,
              participant_match: match.participant,
            },
          });
        }
        const linkedTask = computed.taskId ? getTaskById(computed.taskId) : getTaskBySourceRef(`email:${sourceMessage.id}`);
        if (linkedTask) {
          evidence.push({
            type: 'task_status',
            sourceRef: `task:${linkedTask.id}`,
            occurredAt: linkedTask.completed_at || linkedTask.updated_at || linkedTask.created_at,
            summary: `Task #${linkedTask.id} is ${linkedTask.status}: ${linkedTask.title}`,
            confidence: 1,
            metadata: { task_id: linkedTask.id, status: linkedTask.status },
          });
        }

        let openLoopId: number | null = null;
        let changed = false;
        if (persist) {
          const eKey = entityKey(contact, subject);
          const prior = getEmailOpenLoopByThreadKey(thread.key) || getActiveEmailOpenLoopByEntityKey(eKey);
          const loop = upsertEmailOpenLoop({
            loopKey: prior?.loop_key || thread.key,
            entityKey: eKey,
            account: sourceMessage.toEmails.find((email) => ownerEmails.has(email)) || sourceMessage.fromEmail,
            sourceMessageId: prior?.source_message_id || sourceMessage.id,
            sourceThreadKey: thread.key,
            subject,
            contact,
            kind: item.kind || prior?.kind || 'email',
            requestedAction: item.requestedAction || prior?.requested_action,
            taskId: item.taskId || computed.taskId,
            calendarEventId: item.calendarEventId || computed.calendarEventId,
            metadata: {
              source_direction: sourceDirection,
              observer_mode: true,
            },
          });
          openLoopId = loop.id;
          for (const row of evidence) {
            addEmailOpenLoopEvidence({
              openLoopId: loop.id,
              evidenceType: row.type,
              sourceRef: row.sourceRef,
              occurredAt: row.occurredAt,
              direction: row.direction,
              summary: row.summary,
              confidence: row.confidence,
              metadata: row.metadata,
            });
          }
          const updated = updateEmailOpenLoopState({
            openLoopId: loop.id,
            status: computed.status,
            resolutionKind: computed.resolutionKind,
            confidence: computed.confidence,
            evidenceRef: computed.evidenceRef,
            latestInboundAt: computed.latestInboundAt,
            latestOutboundAt: computed.latestOutboundAt,
            taskId: item.taskId || computed.taskId,
            calendarEventId: item.calendarEventId || computed.calendarEventId,
            checkedAt: now.toISOString(),
          });
          changed = updated.changed;
          if (changed) transitions++;
        }

        results.push({
          messageId: item.messageId,
          openLoopId,
          subject,
          contact,
          status: computed.status,
          resolutionKind: computed.resolutionKind,
          confidence: computed.confidence,
          changed,
          evidence,
        });
      } catch (err) {
        errors++;
        results.push({
          messageId: item.messageId,
          openLoopId: null,
          subject: `(message ${item.messageId})`,
          contact: null,
          status: 'uncertain',
          resolutionKind: null,
          confidence: 0,
          changed: false,
          evidence: [],
          error: compactError(err),
        });
      }
    }
  } catch (err) {
    const error = compactError(err);
    errors = Math.max(errors, items.length || 1);
    for (const item of items) {
      results.push({
        messageId: item.messageId,
        openLoopId: null,
        subject: `(message ${item.messageId})`,
        contact: null,
        status: 'uncertain',
        resolutionKind: null,
        confidence: 0,
        changed: false,
        evidence: [],
        error,
      });
    }
    if (runId !== null) {
      finishEmailReconciliationRun({
        runId,
        checkedCount: 0,
        transitionCount: 0,
        errorCount: errors,
        report: results,
        error,
      });
    }
    return results;
  }

  if (runId !== null) {
    finishEmailReconciliationRun({
      runId,
      checkedCount: results.length - errors,
      transitionCount: transitions,
      errorCount: errors,
      report: results.map(({ evidence, ...result }) => ({ ...result, evidence_count: evidence.length })),
    });
  }
  return results;
}

export function formatEmailReconciliationResults(results: EmailReconciliationResult[]): string {
  if (!results.length) return 'No email open loops were checked.';
  const lines = ['EMAIL RECONCILIATION — OBSERVE MODE (no mailbox/calendar/task mutations)'];
  for (const result of results) {
    if (result.error) {
      lines.push(`- email:${result.messageId} — UNCERTAIN: ${result.error}`);
      continue;
    }
    const evidence = result.evidence
      .filter((row) => row.sourceRef === `email:${result.messageId}` || row.direction === 'out' || row.type !== 'email_message')
      .sort((a, b) => {
        const rank = (row: ReconciliationEvidence) =>
          ['task_status', 'calendar_rsvp', 'calendar_response_email'].includes(row.type)
            ? 0
            : row.direction === 'out'
              ? 1
              : row.sourceRef === `email:${result.messageId}`
                ? 2
                : 3;
        return rank(a) - rank(b);
      })
      .slice(0, 3)
      .map((row) => row.summary)
      .join('; ');
    lines.push(
      `- email:${result.messageId} — ${result.status.toUpperCase()} (${Math.round(result.confidence * 100)}%${result.resolutionKind ? `, ${result.resolutionKind}` : ''}): ${result.subject}`
      + `${result.changed ? ' [status changed]' : ''}`,
    );
    if (evidence) lines.push(`  Evidence: ${evidence}`);
  }
  return lines.join('\n');
}

function ageDays(value: string | null, now: Date): number {
  if (!value) return Infinity;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Infinity : (now.getTime() - parsed) / 86_400_000;
}

/** Recheck the stalest active loops plus recently resolved ones that may reopen. */
export async function reconcileTrackedEmailLoops(opts: {
  limit?: number;
  source?: string;
  persist?: boolean;
  emailSource?: EmailSource;
  spark?: SparkRunner;
  now?: Date;
} = {}): Promise<EmailReconciliationResult[]> {
  const now = opts.now || new Date();
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 50);
  const candidates = listEmailOpenLoops({ limit: 250 })
    .filter((loop) => !TERMINAL_STATUSES.has(loop.status) || ageDays(loop.resolved_at, now) <= 30)
    .sort((a, b) => {
      const at = a.last_checked_at ? Date.parse(a.last_checked_at) : 0;
      const bt = b.last_checked_at ? Date.parse(b.last_checked_at) : 0;
      return at - bt;
    })
    .slice(0, limit);
  if (!candidates.length) return [];
  return reconcileEmailItems({
    items: candidates.map((loop) => ({
      messageId: loop.source_message_id,
      kind: loop.kind,
      requestedAction: loop.requested_action || undefined,
      taskId: loop.task_id || undefined,
      calendarEventId: loop.calendar_event_id || undefined,
    })),
    source: opts.source || 'runtime',
    persist: opts.persist,
    emailSource: opts.emailSource,
    spark: opts.spark,
    now,
  });
}

/** Compact evidence packet injected into the daily inbox-zero prompt. */
export function buildEmailReconciliationPromptContext(now = new Date()): string {
  const active = listEmailOpenLoops({
    statuses: ['open', 'drafted', 'tasked', 'uncertain'],
    limit: 50,
  });
  const since = new Date(now.getTime() - 36 * 3_600_000).toISOString();
  const transitions = getRecentEmailOpenLoopTransitions(since, 30);
  const lines = [
    'EMAIL OPEN-LOOP LEDGER — OBSERVE MODE',
    'Reconciliation evidence may suppress a stale question in the report, but must not cause an archive/send/RSVP/task close.',
    'Sent proves sender-side delivery, not recipient read. Accepted proves RSVP, not attendance. A calendar hold without the relevant attendee does not prove notification.',
  ];
  if (!active.length) lines.push('No tracked email loops yet. Use reconcile_email_items on every possible reply/task/flag candidate to start the ledger.');
  for (const loop of active.slice(0, 30)) {
    lines.push(
      `- email:${loop.source_message_id} [${loop.status}, ${Math.round(loop.confidence * 100)}%] ${loop.subject}`
      + `${loop.resolution_kind ? ` — ${loop.resolution_kind}` : ''}`
      + `${loop.task_id ? ` — task #${loop.task_id}` : ''}`,
    );
  }
  if (transitions.length) {
    lines.push('Changed since the last reports:');
    for (const transition of transitions.slice(0, 15)) {
      lines.push(
        `- ${transition.subject}: ${transition.from_status || 'new'} → ${transition.to_status}`
        + `${transition.resolution_kind ? ` (${transition.resolution_kind})` : ''}`,
      );
    }
  }
  return lines.join('\n').slice(0, 8_000);
}

let runtimeStarted = false;

/** Main-process 15-minute observer. It never emits a user-facing message. */
export function startEmailReconciliationRuntime(): void {
  if (runtimeStarted) return;
  runtimeStarted = true;
  if (!parseBoolEnv('EMAIL_RECONCILIATION_ENABLED', true)) {
    console.log('[email-reconciliation] disabled (EMAIL_RECONCILIATION_ENABLED=false)');
    return;
  }
  const intervalMs = Math.max(parseNumEnv('EMAIL_RECONCILIATION_INTERVAL_MS', 15 * 60_000), 60_000);
  const batch = Math.min(Math.max(parseNumEnv('EMAIL_RECONCILIATION_BATCH', 25), 1), 50);
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const results = await reconcileTrackedEmailLoops({ limit: batch, source: 'runtime' });
      const changed = results.filter((result) => result.changed).length;
      const failed = results.filter((result) => result.error).length;
      console.log(`[email-reconciliation] observe tick: checked=${results.length} changed=${changed} errors=${failed}`);
      setMemory('system', 'email-reconciliation_last_tick', new Date().toISOString());
    } catch (err) {
      console.error('[email-reconciliation] tick failed:', err);
    } finally {
      running = false;
    }
  };
  void tick();
  setInterval(() => { void tick(); }, intervalMs);
  console.log(`[email-reconciliation] observe runtime started (${Math.round(intervalMs / 60_000)}m, batch ${batch})`);
}

/** Exposed for tests/operator review without leaking full email bodies. */
export function getEmailLoopEvidenceSummary(openLoopId: number): string[] {
  return getEmailOpenLoopEvidence(openLoopId, 25).map((row) => row.summary);
}

export function isEmailLoopTerminal(status: EmailOpenLoopStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}
