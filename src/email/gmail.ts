import { google, type calendar_v3, type gmail_v1 } from 'googleapis';
import {
  allEmails,
  firstEmail,
  type CalendarAttendee,
  type CalendarEventSummary,
  type DraftInput,
  type EmailMessage,
  type EmailSource,
} from './source.js';

// EmailSource over the Gmail API, using the same Google OAuth refresh token as
// Calendar/Tasks (GOOGLE_CALENDAR_*). Needs the gmail.modify scope (read,
// archive, drafts); `npm run auth:google` grants it. Nothing here sends mail.

const METADATA_HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date', 'Message-ID', 'Reply-To'];
const SCOPE_HINT = 'Gmail needs read access. Run `npm run auth:google` once to grant it (the gmail.modify permission), then restart.';

export interface GmailClients {
  gmail: gmail_v1.Gmail;
  calendar?: calendar_v3.Calendar;
}

function defaultClients(): GmailClients {
  const auth = new google.auth.OAuth2(process.env.GOOGLE_CALENDAR_CLIENT_ID, process.env.GOOGLE_CALENDAR_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN });
  return {
    gmail: google.gmail({ version: 'v1', auth }),
    calendar: google.calendar({ version: 'v3', auth }),
  };
}

/** Turn a missing-scope failure into an instruction the owner can act on. */
function explain(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/insufficient|scope|403/i.test(msg)) return new Error(`${msg}. ${SCOPE_HINT}`);
  return err instanceof Error ? err : new Error(msg);
}

function headerValue(headers: gmail_v1.Schema$MessagePartHeader[] | undefined, name: string): string {
  const lower = name.toLowerCase();
  return headers?.find((h) => (h.name || '').toLowerCase() === lower)?.value?.trim() ?? '';
}

function decode(data: string | null | undefined): string {
  return data ? Buffer.from(data, 'base64url').toString('utf8') : '';
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Plain-text body: first text/plain part, else the first text/html part stripped. */
export function extractBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return '';
  const find = (p: gmail_v1.Schema$MessagePart, mime: string): string | null => {
    if (p.mimeType === mime && p.body?.data) return decode(p.body.data);
    for (const child of p.parts ?? []) {
      const hit = find(child, mime);
      if (hit !== null) return hit;
    }
    return null;
  };
  const plain = find(part, 'text/plain');
  if (plain !== null) return plain.trim();
  const html = find(part, 'text/html');
  return html !== null ? htmlToText(html) : '';
}

function isoDate(dateHeader: string, internalDate: string | null | undefined): string {
  const parsed = Date.parse(dateHeader);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString();
  const ms = Number(internalDate);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  return dateHeader;
}

/** Gmail API message → the provider-neutral shape. */
export function normalizeGmailMessage(message: gmail_v1.Schema$Message): EmailMessage {
  const headers = message.payload?.headers ?? undefined;
  const from = headerValue(headers, 'From');
  const to = headerValue(headers, 'To');
  const cc = headerValue(headers, 'Cc');
  const labels = message.labelIds ?? [];
  const type = labels.includes('DRAFT') ? 'Draft' : labels.includes('SENT') ? 'Sent' : 'Received';
  return {
    id: message.id ?? '',
    threadId: message.threadId ?? '',
    subject: headerValue(headers, 'Subject'),
    from,
    to,
    cc,
    date: isoDate(headerValue(headers, 'Date'), message.internalDate),
    snippet: decodeEntities(message.snippet ?? ''),
    body: extractBody(message.payload ?? undefined),
    labels,
    type,
    flags: labels.join(' '),
    fromEmail: firstEmail(from),
    toEmails: allEmails([to, cc].filter(Boolean).join(', ')),
  };
}

function decodeEntities(s: string): string {
  return s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

/** RFC 822 message, base64url-encoded for the Gmail API `raw` field. */
export function buildRawDraft(p: {
  to: string[];
  cc?: string[];
  subject: string;
  body: string;
  inReplyTo?: string | null;
  references?: string | null;
}): string {
  const strip = (s: string) => s.replace(/[\r\n]+/g, ' ');
  const cc = p.cc ?? [];
  const headers = [
    ...(p.to.length ? [`To: ${p.to.map(strip).join(', ')}`] : []),
    ...(cc.length ? [`Cc: ${cc.map(strip).join(', ')}`] : []),
    `Subject: ${encodeHeader(strip(p.subject))}`,
    ...(p.inReplyTo ? [`In-Reply-To: ${strip(p.inReplyTo)}`, `References: ${strip(p.references || p.inReplyTo)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(p.body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

function folderQuery(folder: string | undefined): string {
  const f = (folder || 'inbox').trim().toLowerCase();
  if (f === 'inbox') return 'in:inbox';
  if (f === 'archive') return '-in:inbox -in:sent -in:drafts -in:spam -in:trash';
  if (f === 'all' || f === 'anywhere') return '';
  if (/^[a-z]+$/.test(f)) return `in:${f}`;
  return `label:"${folder!.replace(/"/g, '')}"`;
}

function rsvp(status: string | null | undefined): CalendarAttendee['status'] {
  if (status === 'accepted') return 'yes';
  if (status === 'declined') return 'no';
  if (status === 'tentative') return 'maybe';
  return null;
}

export function createGmailEmailSource(clients: GmailClients = defaultClients()): EmailSource {
  const { gmail, calendar } = clients;

  async function listIds(q: string, limit: number): Promise<string[]> {
    try {
      const res = await gmail.users.messages.list({ userId: 'me', q: q || undefined, maxResults: Math.min(Math.max(limit, 1), 100) });
      return (res.data.messages ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
    } catch (err) {
      throw explain(err);
    }
  }

  async function getMessages(ids: string[], format: 'metadata' | 'full'): Promise<EmailMessage[]> {
    const out: EmailMessage[] = [];
    for (const id of ids) {
      try {
        const res = await gmail.users.messages.get({
          userId: 'me',
          id,
          format,
          ...(format === 'metadata' ? { metadataHeaders: METADATA_HEADERS } : {}),
        });
        out.push(normalizeGmailMessage(res.data));
      } catch (err) {
        throw explain(err);
      }
    }
    return out;
  }

  return {
    kind: 'gmail',
    isValidMessageId: (id) => /^[A-Za-z0-9_-]{6,128}$/.test(id),
    async listRecent(opts = {}) {
      const q = [folderQuery(opts.folder), opts.newerThan ? `newer_than:${opts.newerThan}` : '', opts.query || '']
        .filter(Boolean).join(' ');
      return getMessages(await listIds(q, opts.limit ?? 20), 'metadata');
    },
    async search(query, opts = {}) {
      const q = [query, opts.newerThan ? `newer_than:${opts.newerThan}` : ''].filter(Boolean).join(' ');
      return getMessages(await listIds(q, opts.limit ?? 20), 'full');
    },
    async readThread(messageId) {
      try {
        const first = await gmail.users.messages.get({ userId: 'me', id: messageId, format: 'minimal' });
        const threadId = first.data.threadId || messageId;
        const res = await gmail.users.threads.get({ userId: 'me', id: threadId, format: 'full' });
        const messages = (res.data.messages ?? []).map(normalizeGmailMessage);
        return {
          id: threadId,
          key: `gmail-thread:${threadId}`,
          title: messages[0]?.subject ?? '',
          messages,
        };
      } catch (err) {
        throw explain(err);
      }
    },
    async archive(messageIds) {
      for (const id of messageIds) {
        try {
          await gmail.users.messages.modify({ userId: 'me', id, requestBody: { removeLabelIds: ['INBOX'] } });
        } catch (err) {
          throw explain(err);
        }
      }
    },
    async createDraft(draft: DraftInput) {
      let to = draft.to ?? [];
      let subject = draft.subject ?? '';
      let threadId: string | undefined;
      let inReplyTo: string | null = null;
      let references: string | null = null;
      try {
        if (draft.inReplyTo) {
          const orig = await gmail.users.messages.get({
            userId: 'me',
            id: draft.inReplyTo,
            format: 'metadata',
            metadataHeaders: METADATA_HEADERS.concat('References'),
          });
          const headers = orig.data.payload?.headers ?? undefined;
          threadId = orig.data.threadId ?? undefined;
          inReplyTo = headerValue(headers, 'Message-ID') || null;
          const priorRefs = headerValue(headers, 'References');
          references = inReplyTo ? [priorRefs, inReplyTo].filter(Boolean).join(' ') : null;
          if (!to.length) {
            const replyTo = headerValue(headers, 'Reply-To') || headerValue(headers, 'From');
            to = replyTo ? [replyTo] : [];
          }
          if (!subject) {
            const s = headerValue(headers, 'Subject');
            subject = /^re:/i.test(s) ? s : `Re: ${s}`;
          }
        }
        const res = await gmail.users.drafts.create({
          userId: 'me',
          requestBody: {
            message: {
              raw: buildRawDraft({ to, cc: draft.cc, subject, body: draft.body, inReplyTo, references }),
              ...(threadId ? { threadId } : {}),
            },
          },
        });
        return { id: res.data.id ?? '', detail: `Draft saved in Gmail (draft ${res.data.id ?? '?'}) to ${to.join(', ') || '(no recipient)'}: "${subject}"` };
      } catch (err) {
        throw explain(err);
      }
    },
    async ownerEmails() {
      const owners = new Set<string>();
      try {
        const profile = await gmail.users.getProfile({ userId: 'me' });
        if (profile.data.emailAddress) owners.add(profile.data.emailAddress.toLowerCase());
      } catch (err) {
        throw explain(err);
      }
      try {
        const aliases = await gmail.users.settings.sendAs.list({ userId: 'me' });
        for (const alias of aliases.data.sendAs ?? []) {
          if (alias.sendAsEmail) owners.add(alias.sendAsEmail.toLowerCase());
        }
      } catch { /* aliases are a bonus; the profile address is enough */ }
      return owners;
    },
    async calendarEvents(start, end) {
      if (!calendar) return [];
      const res = await calendar.events.list({
        calendarId: 'primary',
        timeMin: new Date(`${start}T00:00:00Z`).toISOString(),
        timeMax: new Date(`${end}T23:59:59Z`).toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 250,
      });
      return (res.data.items ?? []).map((event): CalendarEventSummary => {
        const startDT = event.start?.dateTime;
        const endDT = event.end?.dateTime;
        return {
          id: event.id ?? '',
          title: event.summary ?? '',
          date: (startDT || event.start?.date || '').slice(0, 10),
          time: startDT && endDT ? `${startDT.slice(11, 16)} – ${endDT.slice(11, 16)}` : 'All day',
          attendees: (event.attendees ?? [])
            .filter((a) => a.email)
            .map((a) => ({ email: a.email!.toLowerCase(), status: rsvp(a.responseStatus) })),
        };
      });
    },
  };
}
