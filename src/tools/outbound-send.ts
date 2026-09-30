// Outbound on the owner's behalf: text or email another person.
//
// Both run only as executors INSIDE confirm_action (see actions.ts), never as
// agent-callable tools. The agent proposes with propose_action; the prepare step
// below resolves the recipient and freezes the exact text into the payload, and
// the summary the owner confirms shows who gets it and the full message. What
// the owner approved is exactly what goes out.

import { google } from 'googleapis';
import {
  addInteraction, findPersonByEmail, findPersonByPhone, getPersonById,
  getPersonHandles, peopleSearch, type Action, type Person,
} from '../db.js';
import { sendMessage } from '../channels/imessage.js';

type Prepared = { payload: Record<string, unknown>; summary: string } | { error: string };
type ExecutorResult = { outcome: string; outcome_url?: string; actual_cost_cents: number };

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i;
const MAX_TEXT_CHARS = 2000;

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(str).filter(Boolean);
  const s = str(v);
  return s ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

// iMessage wants "+1XXXXXXXXXX"; person_phones stores the last 10 digits.
// Assumes US numbers when there is no country code.
function toIMessageHandle(raw: string): string | null {
  if (EMAIL_RE.test(raw)) return raw.toLowerCase();
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  if (raw.startsWith('+') && digits.length >= 8) return `+${digits}`;
  return null;
}

export function resolvePerson(input: { person_id?: unknown; person?: unknown }): Person | { error: string } | null {
  const id = Number(input.person_id);
  if (Number.isFinite(id) && id > 0) {
    return getPersonById(id) ?? { error: `No person with id ${id}.` };
  }
  const name = str(input.person);
  if (!name) return null;
  const hits = peopleSearch(name, 5);
  if (hits.length === 0) return { error: `No one named "${name}" in people. Pass "to" with their number or email.` };
  const exact = hits.filter((p) => p.name.toLowerCase() === name.toLowerCase());
  if (exact.length === 1) return exact[0];
  if (hits.length === 1) return hits[0];
  return { error: `"${name}" matches ${hits.length} people: ${hits.map((p) => `${p.name} (person_id ${p.id})`).join(', ')}. Ask which one, then pass person_id.` };
}

function preview(text: string, max = 600): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** Validate a send_imessage proposal and freeze {to, text, person_id, name}. */
export function prepareSendIMessage(p: Record<string, unknown>): Prepared {
  const text = str(p.text);
  if (!text) return { error: 'send_imessage needs "text".' };
  if (text.length > MAX_TEXT_CHARS) return { error: `Text is ${text.length} chars; keep it under ${MAX_TEXT_CHARS}.` };

  let handle = str(p.to) ? toIMessageHandle(str(p.to)) : null;
  if (str(p.to) && !handle) return { error: `"${str(p.to)}" is not a phone number or email.` };

  let person: Person | undefined;
  if (!handle) {
    const r = resolvePerson(p);
    if (!r) return { error: 'send_imessage needs "to" (phone or email) or "person" (a name in people).' };
    if ('error' in r) return r;
    person = r;
    const { phones, emails } = getPersonHandles(r.id);
    // Prefer a phone; fall back to an email only when there is no phone.
    const pool = (phones.length ? phones : emails).map(toIMessageHandle).filter((h): h is string => !!h);
    if (pool.length === 0) return { error: `${r.name} has no phone or email on file. Ask for their number.` };
    if (pool.length > 1) return { error: `${r.name} has several (${pool.join(', ')}). Ask which one, then pass "to".` };
    handle = pool[0];
  } else {
    person = handle.includes('@') ? findPersonByEmail(handle) : findPersonByPhone(handle);
  }

  const who = person ? `${person.name} (${handle})` : handle;
  return {
    payload: { to: handle, text, person_id: person?.id ?? null, name: person?.name ?? null },
    summary: `Text ${who}: "${preview(text)}"`,
  };
}

/** Validate a send_email proposal and freeze {to, cc, subject, body, in_reply_to}. */
export function prepareSendEmail(p: Record<string, unknown>): Prepared {
  const subject = str(p.subject);
  const body = str(p.body);
  if (!subject) return { error: 'send_email needs "subject".' };
  if (!body) return { error: 'send_email needs "body".' };

  let to = strList(p.to);
  const cc = strList(p.cc);
  let person: Person | undefined;
  if (to.length === 0) {
    const r = resolvePerson(p);
    if (!r) return { error: 'send_email needs "to" (email addresses) or "person" (a name in people).' };
    if ('error' in r) return r;
    person = r;
    const { emails } = getPersonHandles(r.id);
    if (emails.length === 0) return { error: `${r.name} has no email on file. Ask for it.` };
    if (emails.length > 1) return { error: `${r.name} has several emails (${emails.join(', ')}). Ask which one, then pass "to".` };
    to = emails;
  }
  const bad = [...to, ...cc].filter((e) => !EMAIL_RE.test(e));
  if (bad.length) return { error: `Not valid email addresses: ${bad.join(', ')}.` };

  const inReplyTo = str(p.in_reply_to);
  const ccPart = cc.length ? ` cc ${cc.join(', ')}` : '';
  const toPart = person ? `${person.name} <${to[0]}>` : to.join(', ');
  return {
    payload: { to, cc, subject, body, in_reply_to: inReplyTo || null, person_id: person?.id ?? null },
    summary: `Email ${toPart}${ccPart}, subject "${subject}": "${preview(body)}"`,
  };
}

function logSent(personId: unknown, channel: string, text: string, ref: string): void {
  const id = Number(personId);
  if (!Number.isFinite(id) || id <= 0) return;
  try {
    addInteraction({ person_id: id, channel, summary: `Sent: ${preview(text, 200)}`, ref, occurred_at: new Date().toISOString() });
  } catch { /* people-graph writes never fail a send */ }
}

export async function runSendIMessage(action: Action): Promise<ExecutorResult> {
  const p = JSON.parse(action.payload_json) as Record<string, unknown>;
  const to = str(p.to);
  const text = str(p.text);
  // Re-check the frozen payload: only 1:1 handles, never a group chat id.
  if (!to || !toIMessageHandle(to) || !text) throw new Error('payload missing a valid "to" or "text"');
  await sendMessage(to, text);
  logSent(p.person_id, 'imessage', text, `action:${action.id}`);
  return { outcome: `Texted ${str(p.name) || to}`, actual_cost_cents: 0 };
}

function encodeHeader(v: string): string {
  return /^[\x20-\x7e]*$/.test(v) ? v : `=?UTF-8?B?${Buffer.from(v, 'utf8').toString('base64')}?=`;
}

function buildRawEmail(p: { to: string[]; cc: string[]; subject: string; body: string; in_reply_to: string | null }): string {
  const strip = (s: string) => s.replace(/[\r\n]+/g, ' ');
  const headers = [
    `To: ${p.to.map(strip).join(', ')}`,
    ...(p.cc.length ? [`Cc: ${p.cc.map(strip).join(', ')}`] : []),
    `Subject: ${encodeHeader(strip(p.subject))}`,
    ...(p.in_reply_to ? [`In-Reply-To: ${strip(p.in_reply_to)}`, `References: ${strip(p.in_reply_to)}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const body = Buffer.from(p.body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n');
  return Buffer.from(`${headers.join('\r\n')}\r\n\r\n${body}`, 'utf8').toString('base64url');
}

export async function runSendEmail(action: Action): Promise<ExecutorResult> {
  const p = JSON.parse(action.payload_json) as Record<string, unknown>;
  const to = strList(p.to);
  const cc = strList(p.cc);
  const subject = str(p.subject);
  const body = str(p.body);
  if (!to.length || !subject || !body) throw new Error('payload missing "to", "subject" or "body"');

  const auth = new google.auth.OAuth2(process.env.GOOGLE_CALENDAR_CLIENT_ID, process.env.GOOGLE_CALENDAR_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth });
  try {
    const res = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw: buildRawEmail({ to, cc, subject, body, in_reply_to: str(p.in_reply_to) || null }) },
    });
    logSent(p.person_id, 'email', body, `gmail:${res.data.id}`);
    return { outcome: `Emailed ${to.join(', ')} ("${subject}")`, actual_cost_cents: 0 };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/insufficient|scope|403/i.test(msg)) {
      throw new Error(`Gmail refused the send (${msg}). Run \`npm run auth:google\` once on the mini to grant the gmail.send permission`);
    }
    throw err;
  }
}
