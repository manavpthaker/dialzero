import { existsSync } from 'node:fs';

// Provider-neutral email access. The agent tools (src/tools/email.ts), the
// inbox-signal daemon, the meeting daemon and email reconciliation all go
// through an EmailSource instead of a specific client, so Gmail (the default,
// riding the owner's existing Google OAuth) and the Spark desktop CLI are
// interchangeable. Message ids are opaque strings: Gmail's hex ids, Spark's
// integers. Nothing outside the implementations should parse them.

export type EmailSourceKind = 'gmail' | 'spark';

export interface EmailMessage {
  id: string;
  /** Provider thread id when known ('' for list rows that don't carry one). */
  threadId: string;
  subject: string;
  from: string;
  to: string;
  cc: string;
  /** ISO timestamp when the provider gives a parseable date, else the raw value. */
  date: string;
  snippet: string;
  /** Plain-text body. Empty for metadata-only reads. */
  body: string;
  labels: string[];
  /** 'Received' | 'Sent' | 'Draft' (Spark passes its own Type column through). */
  type: string;
  flags: string;
  fromEmail: string | null;
  toEmails: string[];
}

export interface EmailThread {
  id: string;
  /** Stable key for the reconciliation ledger (loop_key). */
  key: string;
  title: string;
  messages: EmailMessage[];
}

export interface CalendarAttendee {
  email: string;
  status: 'yes' | 'no' | 'maybe' | null;
}

export interface CalendarEventSummary {
  id: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  time: string | null;
  attendees: CalendarAttendee[];
}

export interface ListRecentOptions {
  /** Gmail-style age window, e.g. '2d'. */
  newerThan?: string;
  limit?: number;
  /** Folder/label. Defaults to the inbox. */
  folder?: string;
  /** Extra Gmail-style filter, e.g. 'from:alice@co.com is:unread'. */
  query?: string;
}

export interface SearchOptions {
  newerThan?: string;
  limit?: number;
}

export interface DraftInput {
  to?: string[];
  cc?: string[];
  subject?: string;
  body: string;
  /** Message id (from this source) being replied to. */
  inReplyTo?: string;
}

export interface EmailSource {
  kind: EmailSourceKind;
  listRecent(opts?: ListRecentOptions): Promise<EmailMessage[]>;
  search(query: string, opts?: SearchOptions): Promise<EmailMessage[]>;
  /** The whole conversation containing this message, bodies included. */
  readThread(messageId: string): Promise<EmailThread>;
  archive(messageIds: string[]): Promise<void>;
  createDraft(draft: DraftInput): Promise<{ id: string; detail?: string }>;
  /** Every address/alias that is the owner (to tell sent from received). */
  ownerEmails(): Promise<Set<string>>;
  /** Calendar events with attendee RSVP state, for reconciliation. Optional. */
  calendarEvents?(start: string, end: string): Promise<CalendarEventSummary[]>;
  isValidMessageId(id: string): boolean;
}

export const EMAIL_NOT_CONNECTED =
  "Email isn't connected. Run `npm run auth:google` to connect Gmail, "
  + 'or set EMAIL_SOURCE=spark if you use the Spark desktop app and its CLI.';

/** Loose shape check for an id from any source; each source is stricter. */
export function isValidEmailMessageId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(id);
}

export function firstEmail(value: string): string | null {
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0].toLowerCase() : null;
}

export function allEmails(value: string): string[] {
  const matches = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? [];
  return Array.from(new Set(matches.map((email) => email.toLowerCase())));
}

export const DEFAULT_SPARK_BIN = '/usr/local/bin/spark';

type Env = Record<string, string | undefined>;

/**
 * Which source to use. EMAIL_SOURCE=gmail|spark|none wins; otherwise Gmail when
 * a Google refresh token is configured, else Spark when its CLI is installed,
 * else none (tools answer with EMAIL_NOT_CONNECTED).
 */
export function resolveEmailSourceKind(
  env: Env = process.env,
  fileExists: (path: string) => boolean = existsSync,
): EmailSourceKind | null {
  const hasGoogle = Boolean(env.GOOGLE_CALENDAR_REFRESH_TOKEN && env.GOOGLE_CALENDAR_CLIENT_ID && env.GOOGLE_CALENDAR_CLIENT_SECRET);
  const explicit = (env.EMAIL_SOURCE || '').trim().toLowerCase();
  if (explicit === 'none' || explicit === 'off') return null;
  if (explicit === 'gmail') return hasGoogle ? 'gmail' : null;
  if (explicit === 'spark') return 'spark';
  if (hasGoogle) return 'gmail';
  if (fileExists(env.SPARK_BIN || DEFAULT_SPARK_BIN)) return 'spark';
  return null;
}

let override: EmailSource | null | undefined;
let cached: { kind: EmailSourceKind; source: EmailSource } | null = null;

/** Tests only: force a source (or null for "not connected"); undefined clears. */
export function setEmailSourceForTests(source: EmailSource | null | undefined): void {
  override = source;
  cached = null;
}

/** The configured source, or null when no email account is connected. */
export async function getEmailSource(): Promise<EmailSource | null> {
  if (override !== undefined) return override;
  const kind = resolveEmailSourceKind();
  if (!kind) return null;
  if (cached?.kind === kind) return cached.source;
  const source = kind === 'gmail'
    ? (await import('./gmail.js')).createGmailEmailSource()
    : (await import('./spark.js')).createSparkEmailSource();
  cached = { kind, source };
  return source;
}

/** Human-readable block for one message, used by tools and daemons. */
export function formatEmailMessage(message: EmailMessage, opts: { body?: boolean; maxBody?: number } = {}): string {
  const lines = [
    `ID: ${message.id}`,
    ...(message.threadId ? [`Thread: ${message.threadId}`] : []),
    ...(message.date ? [`Date: ${message.date}`] : []),
    ...(message.from ? [`From: ${message.from}`] : []),
    ...(message.to ? [`To: ${message.to}`] : []),
    ...(message.cc ? [`Cc: ${message.cc}`] : []),
    ...(message.subject ? [`Subject: ${message.subject}`] : []),
    ...(message.type ? [`Type: ${message.type}`] : []),
    ...(message.labels.length ? [`Labels: ${message.labels.join(', ')}`] : []),
  ];
  const text = opts.body && message.body ? message.body : message.snippet;
  if (text) {
    const max = opts.maxBody ?? 4000;
    lines.push('', text.length > max ? `${text.slice(0, max)}…` : text);
  }
  return lines.join('\n');
}
