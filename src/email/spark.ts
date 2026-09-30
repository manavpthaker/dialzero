import { createHash } from 'node:crypto';
import { sparkRaw } from '../tools/spark.js';
import {
  allEmails,
  firstEmail,
  type CalendarAttendee,
  type CalendarEventSummary,
  type EmailMessage,
  type EmailSource,
  type EmailThread,
} from './source.js';

// EmailSource over the Spark desktop app's CLI (optional; EMAIL_SOURCE=spark).
// The parsers read Spark's human-readable output and were moved here from
// email-reconciliation.ts unchanged.

export type SparkRunner = (args: string[]) => Promise<string>;

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24);
}

function assertOk(output: string): string {
  if (output.startsWith('Spark error')) throw new Error(output.split('\n')[0]);
  return output;
}

/** Parse every account + alias that represents the owner in Spark. */
export function parseSparkOwnerEmails(output: string): Set<string> {
  const result = new Set<string>();
  for (const line of output.split('\n')) {
    if (!/^\s*(?:Email Account|Alias):/i.test(line)) continue;
    const email = firstEmail(line);
    if (email) result.add(email);
  }
  return result;
}

function header(block: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return block.match(new RegExp(`^\\s{2}${escaped}:\\s*(.*)$`, 'mi'))?.[1]?.trim() ?? '';
}

/** Parse the repeated `ID: ...` message blocks returned by search/thread. */
export function parseSparkMessages(output: string): EmailMessage[] {
  const markers = Array.from(output.matchAll(/^\s{2}ID:\s*(\d+)\s*$/gm));
  const messages: EmailMessage[] = [];
  for (let i = 0; i < markers.length; i++) {
    const start = markers[i].index ?? 0;
    const end = markers[i + 1]?.index ?? output.length;
    const block = output.slice(start, end);
    const split = block.search(/\n\s*\n/);
    const headers = split >= 0 ? block.slice(0, split) : block;
    const body = split >= 0 ? block.slice(split).trim() : '';
    const from = header(headers, 'From');
    const to = header(headers, 'To');
    messages.push({
      id: markers[i][1],
      threadId: '',
      subject: header(headers, 'Subject'),
      from,
      to,
      cc: header(headers, 'Cc'),
      date: header(headers, 'Date'),
      snippet: body.replace(/\s+/g, ' ').slice(0, 200),
      body,
      labels: [],
      type: header(headers, 'Type'),
      flags: header(headers, 'Flags'),
      fromEmail: firstEmail(from),
      toEmails: allEmails(to),
    });
  }
  return messages;
}

export function parseSparkThread(output: string): EmailThread {
  const title = output.match(/^Thread:\s*(.*)$/m)?.[1]?.trim() ?? '';
  const link = output.match(/^Link:\s*(\S+)/m)?.[1]?.trim();
  const messages = parseSparkMessages(output);
  const fallback = messages.map((message) => message.id).sort((a, b) => Number(a) - Number(b))[0] || title;
  const key = `spark-thread:${sha(link || fallback)}`;
  return {
    id: key,
    title,
    key,
    messages: messages.map((message) => ({ ...message, threadId: key })),
  };
}

/** Spark `emails` list output is a column table; data rows start with the integer ID. */
export function parseSparkEmailList(output: string): EmailMessage[] {
  const rows: EmailMessage[] = [];
  for (const line of output.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(.*\S)\s*$/);
    if (!m) continue;
    const preview = m[2].replace(/\s+/g, ' ').trim();
    rows.push({
      id: m[1], threadId: '', subject: '', from: '', to: '', cc: '', date: '',
      snippet: preview, body: '', labels: [], type: '', flags: '',
      // Columns are account/from/date/subject; which address is the sender is ambiguous.
      fromEmail: null, toEmails: [],
    });
  }
  return rows;
}

/** Parse the human-readable event blocks emitted by `spark events`. */
export function parseSparkEvents(output: string): CalendarEventSummary[] {
  const lines = output.split('\n');
  const events: CalendarEventSummary[] = [];
  let date = '';
  for (let i = 0; i < lines.length; i++) {
    const dateMatch = lines[i].match(/^──\s+[^,]+,\s+([A-Za-z]{3,9}\s+\d{1,2},\s+\d{4})\s+─+/);
    if (dateMatch) {
      const parsed = new Date(`${dateMatch[1]} 12:00:00`);
      date = Number.isNaN(parsed.getTime()) ? dateMatch[1] : [
        parsed.getFullYear(),
        String(parsed.getMonth() + 1).padStart(2, '0'),
        String(parsed.getDate()).padStart(2, '0'),
      ].join('-');
      continue;
    }
    const idMatch = lines[i].match(/^\s{2}ID:\s*(.+?)\s*$/);
    if (!idMatch) continue;
    let title = '';
    for (let back = i - 1; back >= 0; back--) {
      const candidate = lines[back].trim();
      if (candidate) { title = candidate; break; }
    }
    const block: string[] = [];
    for (let next = i + 1; next < lines.length; next++) {
      if (/^──\s+/.test(lines[next]) || /^\s{2}ID:\s*/.test(lines[next])) break;
      if (lines[next].trim() === '' && block.length && lines[next + 1]?.startsWith('  ') && !lines[next + 1]?.startsWith('    ')) break;
      block.push(lines[next]);
    }
    const time = block.find((line) => /^\s{2}(?:\d{2}:\d{2}\s+[–-]\s+\d{2}:\d{2}|All day)\s*$/.test(line))?.trim() ?? null;
    const attendeeLine = block.find((line) => /^\s{2}Attendees:\s*/.test(line))?.replace(/^\s{2}Attendees:\s*/, '') ?? '';
    const attendees: CalendarAttendee[] = [];
    const attendeePattern = /(?:<)?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})(?:>)?\s*(?:\((yes|no|maybe)\))?/gi;
    let attendeeMatch: RegExpExecArray | null;
    while ((attendeeMatch = attendeePattern.exec(attendeeLine)) !== null) {
      attendees.push({
        email: attendeeMatch[1].toLowerCase(),
        status: (attendeeMatch[2]?.toLowerCase() as CalendarAttendee['status']) || null,
      });
    }
    events.push({ id: idMatch[1], title, date, time, attendees });
  }
  return events;
}

export function createSparkEmailSource(run: SparkRunner = sparkRaw): EmailSource {
  return {
    kind: 'spark',
    isValidMessageId: (id) => /^\d+$/.test(id),
    async listRecent(opts = {}) {
      const args = ['emails'];
      if (opts.folder) args.push(opts.folder);
      const filter = [opts.newerThan ? `newer_than:${opts.newerThan}` : '', opts.query || ''].filter(Boolean).join(' ');
      if (filter) args.push('--filter', filter);
      if (opts.limit) args.push('--page-size', String(opts.limit));
      return parseSparkEmailList(assertOk(await run(args)));
    },
    async search(query, opts = {}) {
      const args = ['search', query];
      if (opts.newerThan) args.push('--filter', `newer_than:${opts.newerThan}`);
      const messages = parseSparkMessages(assertOk(await run(args)));
      return opts.limit ? messages.slice(0, opts.limit) : messages;
    },
    async readThread(messageId) {
      if (!/^\d+$/.test(messageId)) throw new Error(`Invalid Spark message ID: ${messageId}`);
      return parseSparkThread(assertOk(await run(['thread', messageId])));
    },
    async archive(messageIds) {
      if (!messageIds.length) return;
      assertOk(await run(['action', 'archive', ...messageIds]));
    },
    async createDraft(draft) {
      const args = ['draft'];
      for (const t of draft.to || []) args.push('--to', t);
      for (const c of draft.cc || []) args.push('--cc', c);
      if (draft.subject) args.push('--subject', draft.subject);
      args.push('--body', draft.body);
      if (draft.inReplyTo) args.push('--reply-to', draft.inReplyTo);
      const output = assertOk(await run(args));
      return { id: output.match(/\bID:\s*(\S+)/)?.[1] ?? '', detail: output };
    },
    async ownerEmails() {
      return parseSparkOwnerEmails(assertOk(await run(['accounts'])));
    },
    async calendarEvents(start, end) {
      const output = await run(['events', '--start', start, '--end', end]);
      if (output.startsWith('Spark error') || /^Error:/i.test(output)) return [];
      return parseSparkEvents(output);
    },
  };
}
