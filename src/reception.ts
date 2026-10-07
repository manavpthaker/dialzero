import { normalizePhone } from './lib/phone.js';
import { getOwner, getTimezone } from './config.js';
import { addCallNote, addInteraction, findPersonByPhone, getMemory, setMemory, peopleSearch, getPersonHandles } from './db.js';

/**
 * The assistant as the receptionist for calls to its own number. It answers,
 * asks who's calling and why, then either rings the owner (contacts, people
 * they marked "always ring", or everyone in "straight through" mode) or takes
 * a message the owner gets by text. phone.ts handles the call itself; this
 * module holds the rules and what happens after. It never imports phone.ts.
 *
 * Quiet hours for ringing the owner: RECEPTION_QUIET (default "19-8", 7pm–8am
 * local time). Only "always ring" people get through then; everyone else
 * leaves a message, and non-urgent messages wait for the next check-in.
 */

const GROUP = 'reception';

export type ReceptionMode = 'normal' | 'through' | 'messages';

export interface ReceptionCaller {
  /** Last 10 digits, '' when the caller ID is blocked. */
  phone: string;
  /** Contact name when the number is in the owner's people list. */
  name: string | null;
  personId: number | null;
  known: boolean;
  alwaysRing: boolean;
  /** Carrier said the caller ID is forged. */
  spoofed: boolean;
}

export interface ReceptionMessage {
  callerName: string;
  callback: string;
  reason: string;
  urgent: boolean;
}

function localHourNow(now = new Date()): number {
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: getTimezone(), hour: 'numeric', hour12: false }).format(now)) % 24;
}

/** True during the owner's no-ringing hours (default 7pm–8am local). */
export function inCallQuietHours(now = new Date()): boolean {
  const [start, end] = (process.env.RECEPTION_QUIET || '19-8').split('-').map(Number);
  const h = localHourNow(now);
  return start > end ? h >= start || h < end : h >= start && h < end;
}

export function getReceptionMode(now = Date.now()): { mode: ReceptionMode; until: number | null } {
  try {
    const raw = getMemory(GROUP, 'mode');
    if (raw) {
      const m = JSON.parse(raw) as { mode: ReceptionMode; until: number | null };
      if (!m.until || m.until > now) return m;
    }
  } catch { /* fall through to normal */ }
  return { mode: 'normal', until: null };
}

export function setReceptionMode(mode: ReceptionMode, until: number | null): void {
  setMemory(GROUP, 'mode', JSON.stringify({ mode, until }));
}

function alwaysRingPhones(): string[] {
  try { return JSON.parse(getMemory(GROUP, 'always_ring') ?? '[]') as string[]; } catch { return []; }
}

/** Add or remove people by name; returns who was matched. */
export function updateAlwaysRing(add: string[], remove: string[]): { added: string[]; removed: string[]; unknown: string[] } {
  const phones = new Set(alwaysRingPhones());
  const added: string[] = []; const removed: string[] = []; const unknown: string[] = [];
  const resolve = (name: string) => {
    const digits = name.replace(/\D/g, '');
    if (digits.length >= 10) return { label: name, phones: [digits.slice(-10)] };
    const n = name.trim().toLowerCase();
    const hits = peopleSearch(name, 8).filter((p) => p.name.toLowerCase().includes(n));
    const ph = hits.flatMap((p) => getPersonHandles(p.id).phones.map((x) => normalizePhone(x)).filter((x) => x.length === 10));
    return ph.length ? { label: hits[0].name, phones: [...new Set(ph)] } : null;
  };
  for (const name of add) {
    const r = resolve(name);
    if (!r) { unknown.push(name); continue; }
    r.phones.forEach((p) => phones.add(p));
    added.push(r.label);
  }
  for (const name of remove) {
    const r = resolve(name);
    if (!r) { unknown.push(name); continue; }
    r.phones.forEach((p) => phones.delete(p));
    removed.push(r.label);
  }
  setMemory(GROUP, 'always_ring', JSON.stringify([...phones]));
  return { added, removed, unknown };
}

export function lookupCaller(fromRaw: string, verstat: string): ReceptionCaller {
  const phone = normalizePhone(fromRaw || '');
  const person = phone.length === 10 ? findPersonByPhone(phone) : undefined;
  const name = person?.name && !person.name.includes('@') ? person.name : null;
  return {
    phone: phone.length === 10 ? phone : '',
    name, personId: person?.id ?? null,
    known: !!person,
    alwaysRing: phone.length === 10 && alwaysRingPhones().includes(phone),
    spoofed: verstat.startsWith('TN-Validation-Failed'),
  };
}

/** May the assistant ring the owner for this caller right now? `why` is what the call AI is told when not. */
export function connectDecision(c: ReceptionCaller, now = new Date()): { ok: boolean; why: string } {
  if (c.spoofed) return { ok: false, why: 'The caller ID looks forged. Take a message instead; do not connect.' };
  if (c.alwaysRing) return { ok: true, why: '' };
  const { mode } = getReceptionMode(now.getTime());
  if (mode === 'messages') return { ok: false, why: `${getOwner().name} asked for messages only right now. Take a message.` };
  if (inCallQuietHours(now)) return { ok: false, why: `It's outside ${getOwner().name}'s hours for calls. Take a message; say ${getOwner().name} will get it and call back.` };
  if (mode === 'through') return { ok: true, why: '' };
  if (c.known) return { ok: true, why: '' };
  return { ok: false, why: `${getOwner().name} only takes calls from people they know through this line. Take a message; say ${getOwner().name} will get it right away.` };
}

function fmt(phone: string): string {
  return phone.length === 10 ? `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}` : 'no caller ID';
}

/** urgent = a contact said it's urgent: texted even at night (a text, never a ring). */
type Deliver = (text: string, subject: string, urgent: boolean, holdForBrief: boolean) => Promise<void>;
let deliverOverride: Deliver | null = null;
/** Tests capture the text instead of sending it. */
export function setReceptionDeliver(fn: Deliver | null): void { deliverOverride = fn; }

async function deliver(text: string, subject: string, urgent: boolean, holdForBrief: boolean): Promise<void> {
  if (deliverOverride) return deliverOverride(text, subject, urgent, holdForBrief);
  const { sendInterrupt, stageAmbient } = await import('./cos-outbound.js');
  if (holdForBrief) {
    stageAmbient('reception', text, { subject, detail: text });
    return;
  }
  await sendInterrupt({ source: 'reception', subject, kind: 'reply', text, ...(urgent ? { bypass: 'reception-urgent' as const } : {}) });
}

function record(c: ReceptionCaller, summary: string, said: string | null, spokeWith: string | null): void {
  try {
    addCallNote({
      phone: c.phone || null, business: spokeWith || c.name || (c.phone ? fmt(c.phone) : 'Unknown caller'),
      errand_id: null, direction: 'inbound', status: 'done', spoke_with: spokeWith, said, reference: null,
      direct_line: null, promised: null, summary,
    });
    if (c.personId) addInteraction({ person_id: c.personId, channel: 'phone', summary, ref: `reception:${Date.now()}`, occurred_at: new Date().toISOString() });
  } catch (err) {
    console.error('[reception] could not record the call:', err);
  }
}

/** A message the caller left. Texted now, or held for the next check-in during quiet hours unless urgent. */
export async function deliverMessage(c: ReceptionCaller, m: ReceptionMessage, opts: { triedToConnect?: boolean } = {}): Promise<string> {
  const who = m.callerName || c.name || 'Someone';
  const num = m.callback ? normalizePhone(m.callback) || m.callback : c.phone;
  const text = `📞 ${opts.triedToConnect ? `Tried to put ${who} through; you didn't pick up. ` : ''}${who} (${fmt(typeof num === 'string' ? num : '')}) called${m.reason ? `: ${m.reason}` : '.'}${m.urgent ? ' They said it\'s urgent.' : ''}`;
  const hold = inCallQuietHours() && !(m.urgent && (c.known || c.alwaysRing)) && !c.alwaysRing;
  // Only a known contact's "urgent" gets past the night hold; a stranger's waits for morning.
  await deliver(text, `reception:${c.phone || 'anon'}:${Date.now()}`, m.urgent && (c.known || c.alwaysRing), hold);
  record(c, `Called: ${m.reason || 'left a message'}`, m.reason || null, m.callerName || null);
  return text;
}

/** The owner took the call: log it (no text; they were on it). */
export function logConnected(c: ReceptionCaller, callerName: string, reason: string): void {
  record(c, `Put through to ${getOwner().name}${reason ? `: ${reason}` : ''}`, reason || null, callerName || null);
}

/** Spam, sales, or a hang-up: one line in the next check-in, no text. */
export async function logDeclined(c: ReceptionCaller, outcome: string): Promise<void> {
  const text = `📵 Screened a call from ${c.name || fmt(c.phone)}: ${outcome || 'no message left'}.`;
  await deliver(text, `reception:declined:${c.phone || 'anon'}`, false, true);
}
