// Phone calls, three ways:
//   1. The owner calls the bot's Twilio number and talks to it.
//   2. The bot rings the owner (callOwner), e.g. for a time-critical interrupt.
//   3. The bot calls a business or person for the owner (place_call action,
//      only after "go #action:N").
//   4. A business calls the bot's number back about a recent errand (callback).
//   5. A wake-up call the owner set (src/wakeup.ts): they have to talk to end it.
//
// Audio never touches the mini. Twilio bridges each call to OpenAI's SIP
// endpoint; OpenAI posts a signed `realtime.call.incoming` webhook here; we
// accept it with the session config and hold a control WebSocket to answer tool
// calls, collect the transcript, and hang up. Each call carries a one-time nonce
// in a SIP header, minted here, so a call we did not set up is rejected.
//
// Needs a public HTTPS URL for the two webhooks (Tailscale Funnel), unlike the
// Siri endpoint in voice.ts which stays on the tailnet.

import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import WebSocket from 'ws';
import { runAgent } from './agent.js';
import { ownerSession, SPOKEN_PREFIX } from './voice.js';
import { sendMessage } from './channels/imessage.js';
import { withLlmContext } from './lib/llm-context.js';
import { toPlainText } from './lib/plaintext.js';
import { normalizePhone } from './lib/phone.js';
import { isQuietHours, todayET } from './lib/time-et.js';
import { getBotName, getOwner, getTimezone, ownerRef } from './config.js';
import { addInteraction, getPersonHandles, setMemory, saveMessage, type Action } from './db.js';
import { resolvePerson } from './tools/outbound-send.js';
import { sendInterrupt } from './cos-outbound.js';
import {
  lookupCaller, connectDecision, deliverMessage, logConnected, logDeclined, type ReceptionCaller,
} from './reception.js';

const env = (k: string, d = '') => (process.env[k] ?? d).trim();
const PORT = Number(env('PHONE_PORT', '4011'));
const HOST = env('PHONE_HOST', '127.0.0.1');
const PUBLIC_URL = env('PHONE_PUBLIC_URL').replace(/\/+$/, '');
const TWILIO_SID = env('TWILIO_ACCOUNT_SID');
const TWILIO_TOKEN = env('TWILIO_AUTH_TOKEN');
const TWILIO_NUMBER = env('TWILIO_NUMBER');
const OPENAI_PROJECT_ID = env('OPENAI_PROJECT_ID');
const WEBHOOK_SECRET = env('OPENAI_WEBHOOK_SECRET');
const MODEL = env('OPENAI_REALTIME_MODEL', 'gpt-realtime');
const VOICE = env('PHONE_VOICE', 'marin');
const TRANSCRIBE_MODEL = env('PHONE_TRANSCRIBE_MODEL', 'gpt-4o-mini-transcribe');
const REQUIRE_VERIFIED_CALLER = env('PHONE_REQUIRE_VERIFIED_CALLER', 'true') !== 'false';
const MAX_CALL_MS = Number(env('PHONE_MAX_CALL_MIN', '15')) * 60_000;
const TOOL_TIMEOUT_MS = Number(env('PHONE_TOOL_TIMEOUT_MS', '40000'));
const RING_DAILY_CAP = Number(env('PHONE_RING_DAILY_CAP', '3'));
const API = 'https://api.openai.com/v1';
const MAX_BODY_BYTES = 64_000;
const NONCE_TTL_MS = 3 * 60_000;

// Emergency, crisis, and premium-rate numbers are never dialed by the bot.
const BLOCKED_PREFIXES = ['1911', '1988', '1900', '1976'];

/** A wake-up call (src/wakeup.ts). `attempt` lets a late result be told apart from the current one. */
export type WakeCallInfo = { id: number; attempt: number; timeLabel: string; note?: string; firstEvent?: string };
type OwnerCall = { kind: 'owner'; reason?: string; wake?: WakeCallInfo };
type ErrandCall = {
  kind: 'errand'; actionId: number; to: string; name: string | null;
  personId: number | null; goal: string; context: string;
  /** Owner chose to keep a word-for-word record of this call. Default: outcome only. */
  keepTranscript: boolean;
  /** Set when the call is one step of an errand (src/errands.ts); the result goes back to it. */
  errandId?: number;
  /**
   * Phone-menu keys pressed so far ("Pressed 3 (sanitation)"). Pressing a key
   * restarts the realtime session (see pressKeys), so this is how the next
   * session knows where it is.
   */
  menuLog?: string[];
  /** When the phone line first connected, so the max-length cap spans menu hops. */
  lineStartedAt?: number;
  /** Conference mode: the business and the assistant's voice share a Twilio conference, so key presses don't drop the session. */
  conf?: { token: string; name: string };
  /** The business called the bot's number back about this errand (inbound). */
  callback?: boolean;
  /** Callbacks only: what has happened on the errand so far, one line each. */
  history?: string[];
  /** Someone else called the assistant's number: it acts as the receptionist (src/reception.ts). */
  reception?: {
    caller: ReceptionCaller;
    /** The assistant tried to put them through and the owner didn't pick up; take a message now. */
    missed?: { name: string; reason: string };
  };
};

const MAX_KEY_PRESSES = 8;

/** What the callee-facing AI reports when it ends an errand call. */
export type CallStatus = 'done' | 'retry_later' | 'voicemail' | 'blocked' | 'failed';
export interface CallResult {
  status: CallStatus; outcome: string; followUp: string; transcriptTail: string;
  /** The bot's own words on the call. Always kept: it's our speech, not theirs. */
  botSaid?: string;
  /** The line ended before the bot called end_call (hung up on, dropped, voicemail cut off). */
  endedWithoutOutcome?: boolean;
  /** Phone-menu keys pressed on the way. */
  menuLog?: string[];
  /** Something was booked on the call (appointment, reservation): goes on the owner's calendar. */
  booking?: CallBooking;
  /** Who we spoke with and what they said, for the next call to this place. */
  notes?: CallNotes;
}

export interface CallNotes {
  /** Name and role, e.g. "Pat, front desk". */
  spokeWith?: string;
  /** What they told us, attributed: "registration is online only; walk-ins Saturday 10-2". */
  said?: string;
  /** Ticket, case, confirmation or work-order number. */
  reference?: string;
  /** A direct line, extension, or best time/way to reach them. */
  directLine?: string;
  /** What they said they'd do, and by when. */
  promised?: string;
}

export function parseCallNotes(raw: unknown): CallNotes | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : undefined);
  const n: CallNotes = { spokeWith: str(r.spoke_with), said: str(r.said), reference: str(r.reference), directLine: str(r.direct_line), promised: str(r.promised) };
  return Object.values(n).some(Boolean) ? n : undefined;
}

export interface CallBooking {
  title: string;
  /** ISO 8601 with offset, local timezone. */
  start: string;
  end?: string;
  location?: string;
  /** Confirmation number, or the name it's under. */
  confirmation?: string;
}

/** end_call's `booking` argument, or undefined when nothing usable was given. */
export function parseBooking(raw: unknown): CallBooking | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const b = raw as Record<string, unknown>;
  const s = (k: string) => String(b[k] ?? '').trim();
  if (!s('title') && !s('start')) return undefined;
  return {
    title: s('title'), start: s('start'),
    ...(s('end') ? { end: s('end') } : {}),
    ...(s('location') ? { location: s('location') } : {}),
    ...(s('confirmation') ? { confirmation: s('confirmation') } : {}),
  };
}

/** What phone.ts needs to answer a business calling back about an errand. */
export interface CallbackMatch {
  errandId: number; name: string; goal: string; share: string;
  notes: string[]; history: string[]; keepTranscript: boolean;
}

// errands.ts registers these at startup. A hook (not an import) because errands.ts
// already imports this module to place calls.
interface ErrandCallHooks {
  onConnected: (errandId: number) => void;
  onFinished: (errandId: number, result: CallResult) => void;
  /** Inbound caller → the errand they're calling back about, or null. */
  findCallback?: (phone: string) => CallbackMatch | null;
  /** A callback call ended. `caller` is the target's name. */
  onCallback?: (errandId: number, caller: string, result: CallResult) => void;
}
let errandHooks: ErrandCallHooks | null = null;
export function setErrandCallHooks(h: ErrandCallHooks): void { errandHooks = h; }

/** Registered by errands.ts: start a one-off call on the errand runner. */
type OneOffCall = { to: string; goal: string; name: string | null; share: string; keepTranscript: boolean; actionId: number | null };
let startOneOffCall: ((c: OneOffCall) => number) | null = null;
export function setOneOffCallStarter(fn: (c: OneOffCall) => number): void { startOneOffCall = fn; }

// wakeup.ts registers these, for the same import-cycle reason as errandHooks.
interface WakeCallHooks {
  onConnected: (id: number, attempt: number) => void;
  onFinished: (id: number, attempt: number, r: { awake: boolean; answers: number }) => void;
}
let wakeHooks: WakeCallHooks | null = null;
export function setWakeCallHooks(h: WakeCallHooks): void { wakeHooks = h; }
/** Real spoken answers needed (plus confirm_awake) before a wake-up call counts. */
const WAKE_MIN_ANSWERS = 2;
const WAKE_MAX_CALL_MS = Number(env('WAKEUP_MAX_CALL_MIN', '5')) * 60_000;
const WAKE_FILLER = new Set([
  'yeah', 'yea', 'yes', 'yep', 'yup', 'ok', 'okay', 'mhm', 'hmm', 'huh', 'hey', 'hello', 'nah', 'nope',
  'sure', 'fine', 'good', 'what', 'right', 'alright', 'thanks', 'awake', 'the', 'and', 'just', 'yah',
]);

/**
 * A spoken owner turn that shows they're actually talking, not mumbling "yeah".
 * Needs one word of 3+ letters outside the filler list ("coffee" counts; "yeah I'm up" does not).
 */
export function isRealWakeAnswer(text: string): boolean {
  const words = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  return words.some((w) => w.length >= 3 && !WAKE_FILLER.has(w));
}

/** twilioSid: set once Twilio accepts the outbound dial, so the leg can be ended from our side. */
type PendingCall = (OwnerCall | ErrandCall) & { expires: number; twilioSid?: string };

const pending = new Map<string, PendingCall>();
let ringDay = '';
let ringCount = 0;

export function isPhoneConfigured(): boolean {
  return !!(PUBLIC_URL && TWILIO_SID && TWILIO_TOKEN && TWILIO_NUMBER && OPENAI_PROJECT_ID && WEBHOOK_SECRET && process.env.OPENAI_API_KEY);
}

function ownerPhones(): string[] {
  const o = getOwner();
  const raw = [process.env[o.phoneEnv || `USER_${o.id.toUpperCase()}`], ...env('PHONE_OWNER_NUMBERS').split(',')];
  return raw.map((r) => normalizePhone(r || '')).filter((p) => p.length === 10);
}

/** Twilio's answering-machine verdict for a call (human, machine_start, fax, unknown…). */
async function answeredBy(sid: string): Promise<string | null> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls/${sid}.json`, {
    headers: { Authorization: `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')}` },
  });
  if (!res.ok) return null;
  const data = await res.json() as { answered_by?: string | null };
  return data.answered_by ?? null;
}

/** End the Twilio leg too. Closing the realtime socket alone can leave the phone line open. */
async function twilioHangup(sid: string): Promise<void> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls/${sid}.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ Status: 'completed' }),
  });
  if (!res.ok) throw new Error(`Twilio hangup ${res.status}`);
}

function mintNonce(call: OwnerCall | ErrandCall): string {
  const now = Date.now();
  for (const [k, v] of pending) if (v.expires < now) pending.delete(k);
  const nonce = randomBytes(18).toString('base64url');
  pending.set(nonce, { ...call, expires: now + NONCE_TTL_MS });
  return nonce;
}

function sipDial(nonce: string): string {
  const uri = `sip:${OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-Assistant-Nonce=${nonce}`;
  return `<Dial answerOnBridge="true"><Sip>${uri}</Sip></Dial>`;
}

function sipTwiml(nonce: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${sipDial(nonce)}</Response>`;
}

/**
 * Press keys on a phone menu. The realtime SIP API can't send key tones, so
 * Twilio does it: the business-facing call is redirected to play the tones and
 * then dial a fresh realtime session. The business side stays connected; our
 * old session ends and the new one picks up with the menu log.
 */
async function pressKeys(call: ErrandCall & { twilioSid?: string }, digits: string, reason: string): Promise<void> {
  if (!call.twilioSid) throw new Error('no Twilio call to press keys on');
  const next: ErrandCall = {
    ...call,
    menuLog: [...(call.menuLog ?? []), `Pressed ${digits}${reason ? ` (${reason})` : ''}`],
  };
  const nonce = mintNonce(next);
  const entry = pending.get(nonce);
  if (entry) entry.twilioSid = call.twilioSid;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Play digits="ww${digits}"/>${sipDial(nonce)}</Response>`;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls/${call.twilioSid}.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ Twiml: twiml }),
  });
  if (!res.ok) {
    pending.delete(nonce);
    throw new Error(`Twilio redirect ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

// ── Reception: ring the owner, announce, press 1 to take it ─────────────────

interface Transfer { call: ErrandCall & { twilioSid?: string }; name: string; reason: string; accepted: boolean; expires: number }
const transfers = new Map<string, Transfer>();
const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stepUrl = (step: string, token: string) => xml(`${PUBLIC_URL}/twilio/voice?step=${step}&t=${token}`);

/** Redirect the caller's line to ring the owner's cell; they hear who it is and press 1 to take it. */
async function connectOwner(call: ErrandCall & { twilioSid?: string }, name: string, reason: string): Promise<void> {
  if (!call.twilioSid) throw new Error('no caller line to transfer');
  const ownerCell = ownerPhones()[0];
  if (!ownerCell) throw new Error('no owner number');
  const now = Date.now();
  for (const [k, v] of transfers) if (v.expires < now) transfers.delete(k);
  const token = randomBytes(12).toString('base64url');
  transfers.set(token, { call, name, reason, accepted: false, expires: now + 10 * 60_000 });
  // The owner sees the caller's own number when there is one.
  const callerId = call.to || TWILIO_NUMBER;
  const twiml = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial timeout="25" callerId="${xml(callerId)}" action="${stepUrl('after', token)}"><Number url="${stepUrl('whisper', token)}">+1${ownerCell}</Number></Dial></Response>`;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls/${call.twilioSid}.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ Twiml: twiml }),
  });
  if (!res.ok) {
    transfers.delete(token);
    throw new Error(`Twilio redirect ${res.status}`);
  }
}

// ── Conference calls: key presses without dropping the assistant's voice ────
// OpenAI's realtime SIP can hear keypad tones but not send them, and pressKeys
// (redirect the call, play tones, dial a fresh session) left the business's menu
// talking to silence for several seconds; most menus then hung up. In conference
// mode the business leg and the assistant's SIP leg sit in one Twilio conference; a key
// press is a conference announcement of <Play digits>, and the session never ends.

interface Conf { nonce: string; name: string; sid?: string; sipStarted: boolean; expires: number }
const confs = new Map<string, Conf>();
const rawStepUrl = (step: string, token: string, extra = '') => `${PUBLIC_URL}/twilio/voice?step=${step}&t=${token}${extra}`;

export function conferenceMode(): boolean { return env('PHONE_CONFERENCE', 'true') !== 'false'; }

async function twilioPost(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  });
  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok) throw new Error(`Twilio ${path} ${res.status}: ${String(json.message ?? '').slice(0, 160)}`);
  return json;
}

/** TwiML that puts the business into a fresh conference and tells us when they're in. */
function conferenceTwiml(token: string, name: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference beep="false" startConferenceOnEnter="true" endConferenceOnExit="true" waitUrl="" statusCallback="${xml(rawStepUrl('conf', token))}" statusCallbackEvent="join">${xml(name)}</Conference></Dial></Response>`;
}

/** Twilio status callbacks and announcements for conference calls. */
export async function conferenceStep(step: string, token: string, params: URLSearchParams): Promise<string> {
  const empty = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  const c = confs.get(token);
  if (!c) return empty;
  if (step === 'dtmf') {
    const d = (params.get('d') || '').replace(/[^0-9*#wW]/g, '').slice(0, 20);
    return d ? `<?xml version="1.0" encoding="UTF-8"?><Response><Play digits="w${d}"/></Response>` : empty;
  }
  if (step === 'conf' && params.get('StatusCallbackEvent') === 'participant-join' && !c.sipStarted) {
    // The business picked up and is in the conference: bring the assistant's voice in.
    c.sipStarted = true;
    c.sid = params.get('ConferenceSid') || undefined;
    const uri = `sip:${OPENAI_PROJECT_ID}@sip.api.openai.com;transport=tls?X-Assistant-Nonce=${c.nonce}`;
    const join = `<?xml version="1.0" encoding="UTF-8"?><Response><Dial><Conference beep="false" endConferenceOnExit="true">${xml(c.name)}</Conference></Dial></Response>`;
    twilioPost('Calls.json', { To: uri, From: TWILIO_NUMBER, Twiml: join }).catch((err) => console.error('[phone] conference: could not bring the assistant in:', err.message));
  }
  return empty;
}

/** Press keys inside a conference call: Twilio plays the tones to everyone, the session keeps going. */
async function pressKeysInConference(call: ErrandCall, digits: string): Promise<void> {
  const c = call.conf ? confs.get(call.conf.token) : undefined;
  if (!c?.sid) throw new Error('no conference to play the keys into');
  await twilioPost(`Conferences/${c.sid}.json`, { AnnounceUrl: rawStepUrl('dtmf', call.conf!.token, `&d=${encodeURIComponent(digits)}`), AnnounceMethod: 'POST' });
}

/** Tests only: stage a transfer as if connectOwner had redirected the caller. */
export function stageTransferForTest(token: string, name: string, reason: string, caller: ReceptionCaller): void {
  transfers.set(token, {
    call: { kind: 'errand', reception: { caller }, actionId: 0, to: caller.phone ? `+1${caller.phone}` : '', name, personId: null, goal: '', context: '', keepTranscript: false, twilioSid: 'CAtest' },
    name, reason, accepted: false, expires: Date.now() + 60_000,
  });
}

/** The extra steps of a reception transfer, all on /twilio/voice (the path the public URL already exposes). */
export function receptionStep(step: string, token: string, params: URLSearchParams): string {
  const t = transfers.get(token);
  const empty = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
  const hangup = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
  if (!t) return hangup;
  if (step === 'whisper') {
    // Played to the owner only. A voicemail never presses 1, so the caller comes back to the assistant.
    const say = `${t.name}${t.reason ? `, about ${t.reason}` : ''}. Press 1 to take it.`;
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather numDigits="1" timeout="8" action="${stepUrl('accept', token)}"><Say>${xml(say)}</Say></Gather><Hangup/></Response>`;
  }
  if (step === 'accept') {
    if (params.get('Digits') === '1') { t.accepted = true; return empty; }
    return hangup;
  }
  if (step === 'after') {
    const r = t.call.reception;
    transfers.delete(token);
    if (t.accepted) {
      if (r) logConnected(r.caller, t.name, t.reason);
      return hangup;
    }
    // The owner didn't take it: back to the assistant to take a message.
    const nonce = mintNonce({ ...t.call, reception: r ? { caller: r.caller, missed: { name: t.name, reason: t.reason } } : undefined, lineStartedAt: undefined });
    const entry = pending.get(nonce);
    if (entry) entry.twilioSid = params.get('CallSid') || t.call.twilioSid;
    return sipTwiml(nonce);
  }
  return hangup;
}

function sayTwiml(text: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>${esc}</Say><Hangup/></Response>`;
}

/** E.164 US number, or null. Rejects short codes, emergency, premium, and fictional numbers. */
export function toDialable(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '');
  const e164 = digits.length === 10 ? `1${digits}` : digits.length === 11 && digits.startsWith('1') ? digits : null;
  if (!e164) return null;
  if (BLOCKED_PREFIXES.some((p) => e164.startsWith(p))) return null;
  return `+${e164}`;
}

/**
 * 555-0100 through 555-0199 are reserved for fiction. A model that can't find a
 * real number invents one there, so seeing one means the lookup failed.
 */
export function isFictionalNumber(raw: string): boolean {
  return /555(01\d\d)$/.test(raw.replace(/[^0-9]/g, ''));
}

// ── Twilio ───────────────────────────────────────────────────────────────────

function twilioSignatureOk(req: IncomingMessage, params: URLSearchParams): boolean {
  const given = String(req.headers['x-twilio-signature'] || '');
  if (!given) return false;
  const keys = [...new Set(params.keys())].sort();
  const paramStr = keys.map((k) => k + params.getAll(k).join('')).join('');
  // Twilio may sign the URL with or without an explicit port (its own helper
  // libraries accept both), in case PHONE_PUBLIC_URL carries one.
  const bases = [PUBLIC_URL, PUBLIC_URL.replace(/:\d+$/, '')];
  const b = Buffer.from(given);
  return [...new Set(bases)].some((base) => {
    const expected = createHmac('sha1', TWILIO_TOKEN).update(base + (req.url || '') + paramStr).digest('base64');
    const a = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  });
}

async function twilioCall(to: string, nonce: string, extra: Record<string, string> = {}): Promise<string> {
  const body = new URLSearchParams({ To: to, From: TWILIO_NUMBER, Twiml: sipTwiml(nonce), Timeout: '30', ...extra });
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  const json = await res.json().catch(() => ({})) as { sid?: string; message?: string };
  if (!res.ok || !json.sid) throw new Error(`Twilio call failed (${res.status}): ${json.message || 'no call sid'}`);
  return json.sid;
}

/**
 * Twilio's webhook for calls TO the bot's number. The owner gets through, and so
 * does a business calling back about a recent errand. Everyone else is turned away.
 */
function handleInboundCall(req: IncomingMessage, params: URLSearchParams): string {
  if (!twilioSignatureOk(req, params)) throw Object.assign(new Error('bad twilio signature'), { status: 403 });
  const from = normalizePhone(params.get('From') || '');
  const verstat = params.get('StirVerstat') || '';
  if (!ownerPhones().includes(from)) {
    const match = from.length === 10 ? errandHooks?.findCallback?.(from) ?? null : null;
    // Carrier says the caller ID is forged: don't hand errand details to it.
    if (match && !verstat.startsWith('TN-Validation-Failed')) {
      console.log(`[phone] callback from …${from.slice(-4)} about errand #${match.errandId}`);
      const nonce = mintNonce({
        kind: 'errand', callback: true, actionId: 0, to: `+1${from}`, name: match.name, personId: null,
        goal: [match.goal, match.notes.length ? `Owner's latest instructions: ${match.notes.join(' ')}` : ''].filter(Boolean).join('\n'),
        context: match.share, keepTranscript: match.keepTranscript, errandId: match.errandId, history: match.history,
      });
      const entry = pending.get(nonce);
      const sid = params.get('CallSid');
      if (entry && sid) entry.twilioSid = sid;
      return sipTwiml(nonce);
    }
    if (env('RECEPTION_ENABLED', 'true') !== 'false') {
      const caller = lookupCaller(from, verstat);
      console.log(`[phone] reception: call from ${caller.name ?? `…${from.slice(-4) || 'blocked'}`}`);
      const nonce = mintNonce({
        kind: 'errand', reception: { caller }, actionId: 0, to: from.length === 10 ? `+1${from}` : '', name: caller.name,
        personId: caller.personId, goal: '', context: '', keepTranscript: false,
      });
      const entry = pending.get(nonce);
      const sid = params.get('CallSid');
      if (entry && sid) entry.twilioSid = sid;
      return sipTwiml(nonce);
    }
    console.warn(`[phone] rejected inbound call from …${from.slice(-4)}`);
    return sayTwiml('Sorry, this line only takes calls from its owner. Goodbye.');
  }
  // Caller ID alone can be spoofed. STIR/SHAKEN "A" means the carrier vouches
  // that this caller owns the number.
  if (REQUIRE_VERIFIED_CALLER && verstat !== 'TN-Validation-Passed-A') {
    console.warn(`[phone] owner number but unverified caller (StirVerstat=${verstat || 'none'})`);
    return sayTwiml("I couldn't verify this call came from your phone, so I can't pick up. Text me instead.");
  }
  return sipTwiml(mintNonce({ kind: 'owner' }));
}

// ── OpenAI webhook + call control ────────────────────────────────────────────

function openaiSignatureOk(req: IncomingMessage, body: string): boolean {
  const id = String(req.headers['webhook-id'] || '');
  const ts = String(req.headers['webhook-timestamp'] || '');
  const sigs = String(req.headers['webhook-signature'] || '');
  if (!id || !ts || !sigs) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = Buffer.from(WEBHOOK_SECRET.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
  return sigs.split(' ').some((s) => {
    const v = s.split(',')[1] || '';
    return v.length === expected.length && timingSafeEqual(Buffer.from(v), Buffer.from(expected));
  });
}

async function callApi(callId: string, verb: 'accept' | 'reject' | 'hangup', body?: unknown): Promise<void> {
  const res = await fetch(`${API}/realtime/calls/${encodeURIComponent(callId)}/${verb}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) throw new Error(`realtime ${verb} ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

const HANG_UP_TOOL = {
  type: 'function', name: 'hang_up',
  description: 'End the call. Say goodbye first, then call this.',
  parameters: { type: 'object', properties: {}, required: [] },
};

function askAssistantTool() {
  return {
    type: 'function', name: 'ask_assistant',
    description: `Run a request through ${getBotName()}'s full brain and tools and get a short spoken answer.`,
    parameters: { type: 'object', properties: { request: { type: 'string', description: 'What they asked for, in their words' } }, required: ['request'] },
  };
}

function wakeSessionConfig(w: WakeCallInfo) {
  const bot = getBotName();
  const owner = getOwner().name;
  const { object: them, possessive: their } = ownerRef().pronouns;
  return {
    instructions: [
      `You are ${bot}, ${owner}'s personal assistant. This is the wake-up call ${owner} asked for instead of an alarm. It is ${w.timeLabel}.`,
      `Talking out loud is what wakes ${owner} up, so your job is to keep ${them} talking until ${owner} is clearly awake.`,
      'Open right away with a warm, upbeat "Good morning" and the time in one short sentence, then ask your first question.',
      [
        `Ask simple questions ${owner} has to answer out loud, one at a time. First: what is the first thing on ${their} plate today?`,
        w.firstEvent ? `Then mention the first thing on ${their} calendar (${w.firstEvent}) and ask ${them} about it, like whether ${owner} is ready for it.` : '',
        w.note ? `${owner} left a note for this morning: "${w.note}". Bring it up.` : '',
        'Then one more easy question, like how they slept or what is for breakfast.',
      ].filter(Boolean).join(' '),
      `If you hear a voicemail greeting, a recording, or a beep, that is NOT ${owner}: call hang_up right away without leaving a message.`,
      `A single "yeah", "ok", "I'm up", or a mumble does not count. If ${owner} gives one-word or sleepy answers, cheerfully ask again or ask something else. Do not take "I'm awake" on its own.`,
      `Once ${owner} has given at least ${WAKE_MIN_ANSWERS} real spoken answers and sounds awake, call confirm_awake. If it says not yet, keep going with another question.`,
      'After confirm_awake succeeds, say a short upbeat send-off and call hang_up.',
      `If ${owner} asks about ${their} day (calendar, tasks, email, anything), call ask_assistant with ${their} words and tell ${them} the answer. Say a short filler like "one sec" while it works.`,
      'Friendly, upbeat, short spoken sentences. No lists, no markdown.',
    ].join('\n'),
    tools: [
      askAssistantTool(),
      {
        type: 'function', name: 'confirm_awake',
        description: `Call when ${owner} has answered at least ${WAKE_MIN_ANSWERS} questions out loud with real answers and sounds awake. Returns whether that is confirmed.`,
        parameters: { type: 'object', properties: {}, required: [] },
      },
      HANG_UP_TOOL,
    ],
  };
}

function ownerSessionConfig(call: OwnerCall) {
  if (call.wake) return wakeSessionConfig(call.wake);
  const bot = getBotName();
  const owner = getOwner().name;
  const opening = call.reason
    ? `You are calling ${owner} because: ${call.reason}. When they answer, say that in one or two sentences, then help with whatever they need.`
    : `${owner} called you. Greet them in a few words.`;
  return {
    instructions: [
      `You are ${bot}, ${owner}'s personal assistant, on a phone call with ${owner}.`,
      opening,
      'Talk like a sharp human assistant: short, natural, spoken sentences. No lists, no markdown, no reading out links.',
      `For anything about ${owner}'s calendar, email, tasks, people, money, memory, or to take any action (reminders, texts, emails, calls, orders), call ask_assistant with the request in their own words, then say the answer naturally. Say a short filler like "one sec" while it works. Never make up an answer instead of asking.`,
      'Anything that spends money or messages someone comes back as a proposal they approve by text; tell them it is waiting in their messages.',
      'When they are done, say bye and call hang_up.',
    ].join('\n'),
    tools: [askAssistantTool(), HANG_UP_TOOL],
  };
}

// How the bot represents the owner on calls to other people: named, says it's
// an AI whenever asked, warm and brief, and it never pretends to be the owner
// or puts them on the line.
function receptionSessionConfig(call: ErrandCall) {
  const o = getOwner();
  const full = o.fullName || o.name;
  const bot = getBotName();
  const r = call.reception!;
  const c = r.caller;
  return {
    instructions: [
      `You are ${bot}, an AI assistant who answers the phone for ${full}. Someone called ${bot}'s number. You are the receptionist.`,
      r.missed
        ? `You just tried to put ${r.missed.name} through about "${r.missed.reason}" and ${o.name} couldn't pick up. Say so kindly ("${o.name} couldn't grab it right now") and take a message: what they'd like ${o.name} to know, and the best number to reach them.`
        : `Answer: "Hi, you've reached ${bot}, ${full}'s assistant. Who's calling, and what's it about?"`,
      c.name ? `Caller ID matches a contact: ${c.name}. Still confirm who you're speaking with; caller ID can be wrong.` : `Caller ID does not match anyone ${o.name} knows.`,
      `When they want to talk to ${o.name} (and it isn't a sales or spam call), call connect_owner with their name and what it's about. Tell them "One moment, let me see if ${o.name} is free" right before. If it says to take a message, do that instead without explaining ${o.name}'s rules.`,
      `To take a message: get their name, what it's about, the best callback number (confirm the number they're calling from, or the one they give), and whether it's urgent. Repeat it back briefly, call take_message, say ${o.name} will get it, say goodbye.`,
      `Sales calls, robocalls, surveys, "your car warranty", or anyone who won't say who they are: say ${o.name} isn't interested or available, goodbye, then end_call with status "failed" and the outcome "spam: <one line>".`,
      `Never share anything about ${o.name}: not their schedule, location, other numbers, email, family, or whether they're home. Never agree to anything for ${o.name}. You may say ${o.name} will call back.`,
      `If asked, say plainly you are an AI assistant working for ${o.name}.`,
      'Warm, brief, like a good front desk. Short spoken sentences.',
    ].join('\n'),
    tools: [
      {
        type: 'function', name: 'connect_owner',
        description: `Try to put the caller through to ${o.name}. Returns whether ${o.name} is being rung; if not, take a message.`,
        parameters: {
          type: 'object',
          properties: {
            caller_name: { type: 'string', description: 'Who is calling, as they said it (and company, if any).' },
            reason: { type: 'string', description: 'What it is about, in a few words.' },
          },
          required: ['caller_name', 'reason'],
        },
      },
      {
        type: 'function', name: 'take_message',
        description: `Record the message for ${o.name}. Say goodbye after; the call ends a few seconds later.`,
        parameters: {
          type: 'object',
          properties: {
            caller_name: { type: 'string' },
            callback_number: { type: 'string', description: 'Best number to call them back.' },
            reason: { type: 'string', description: 'The message, in their words, short.' },
            urgent: { type: 'boolean', description: 'They said it is urgent or time-sensitive.' },
          },
          required: ['caller_name', 'reason'],
        },
      },
      {
        type: 'function', name: 'end_call',
        description: 'End a call with no message (spam, sales, wrong number, they hung up on you). Say goodbye first.',
        parameters: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['failed', 'done'] },
            outcome: { type: 'string', description: 'One line: what it was.' },
          },
          required: ['status', 'outcome'],
        },
      },
    ],
  };
}

function errandSessionConfig(call: ErrandCall) {
  if (call.reception) return receptionSessionConfig(call);
  const o = getOwner();
  const owner = o.name;
  const full = o.fullName || o.name;
  const bot = getBotName();
  const callback = env('PHONE_CALLBACK_NUMBER');
  const returning = call.callback
    ? [
      `${call.name || 'A business'} is calling you back: they are returning your earlier call on behalf of ${full}. Answer the phone first: "Hi, this is ${bot}, ${full}'s assistant. Thanks for calling back." Then pick up where things left off.`,
      call.history?.length ? `What has happened on this so far:\n${call.history.map((h) => `- ${h}`).join('\n')}` : '',
    ].filter(Boolean).join('\n')
    : '';
  return {
    instructions: [
      call.callback
        ? `You are ${bot}, an AI assistant working on behalf of ${full}, answering the phone.`
        : `You are ${bot}, an AI assistant, making a phone call on behalf of ${full}${call.name ? ` to ${call.name}` : ''}.`,
      `Your goal: ${call.goal}`,
      call.context ? `Details you may share: ${call.context}` : '',
      call.callback ? returning : call.menuLog?.length
        ? /message|voice ?mail|leave|record/i.test(call.menuLog.at(-1) ?? '')
          ? `This call is already in progress. You chose the option to leave a message (${call.menuLog.join('; ')}). After the beep, or as soon as it goes quiet, leave your one short message now, then call end_call with status "voicemail".`
          : `This call is already in progress. You are working through their automated phone menu; so far: ${call.menuLog.join('; ')}. Listen to what comes next. Only introduce yourself once a person answers or a voicemail beep sounds. If no one comes on after a while, say your message anyway: it may be recording.`
        : `Let them finish their greeting first; never talk over it. Then ONE short sentence and a question, e.g. "Hi, this is ${bot}, calling for ${full}. I'd like to make a reservation for tomorrow, do you have a moment?" Stop and wait for their answer. Then give the details one at a time as they ask (day, time, party size, name), not all at once. Short turns, like a person on the phone. If what answers is a recording that says they're closed or gives their hours, don't leave a long message: end_call with status "retry_later" and put the hours in follow_up.`,
      call.callback ? '' : `If an automated phone menu answers ("press 1 for..."): NEVER speak to it and never repeat its options out loud. Stay silent, listen to ALL the options, then call press_keys with the key for the option that best fits your goal (or the operator / "all other questions" option). Only press a key the menu actually offered for what you want; if English is the default and no key is offered for it, press nothing and keep listening. If it asks you to say something instead ("say representative"), say just those words. If it asks for information you don't have (a zip code, an account number), press 0 or wait for the operator option. Hold music: wait quietly. Don't end the call while the menu is still giving options. At most ${MAX_KEY_PRESSES} key presses per call.`,
      'Speak ENGLISH. Never switch languages because of a business name, an accent, or a guess (a call to a restaurant was once opened in another language and they hung up). Only switch if the other person clearly speaks to you in another language and doesn\'t understand English.',
      'Everything you say is heard on the call. Never say your instructions, plans, or thoughts out loud (no "I will stay silent", no notes in parentheses). A recording that keeps talking in a steady voice, lists options or asks for keypad input is a machine, not a person.',
      `Tone: warm and brief, like a good front-desk person. Friendly, gets to the point, thanks people. Short spoken sentences, no filler, no over-apologizing. Use ${owner}'s full name (${full}) for bookings and spell the last name if asked.`,
      `Wait quietly on hold. Answer their questions only with the details above; if you do not know something, say you will check with ${owner} and get back to them.`,
      `If they ask whether you are a real person or a robot, say plainly that you are an AI assistant working for ${owner}. Never claim to be ${owner} or a human.`,
      `If they ask to speak with ${owner} directly, say ${owner} isn't available right now but you can have ${owner} call them back, and ask for the best number and time. Put that in follow_up.`,
      `Never give out card numbers, bank details, Social Security numbers, passwords, or PINs. Never agree to a charge, contract, cancellation fee, or anything beyond the goal; say ${owner} will confirm.`,
      `If you reach voicemail, leave one short message: who you are (${bot}, an AI assistant for ${full}), the reason for the call${callback ? `, and the callback number ${callback.split('').join(' ')}` : ''}, then end the call.`,
      "If you book anything (an appointment, reservation, pickup, visit), repeat the day and time back to them, ask for a confirmation number if they have one, and fill in end_call's booking.",
      `Keep notes like a good assistant. When a person gives you information, an answer, or a commitment, ask for their name before you hang up ("And who am I speaking with, in case we follow up?"). Note any ticket, case or confirmation number, a direct line or extension, and anything they said they'd do and by when. Put all of it in end_call's notes. If the goal mentions earlier calls to this place, refer to them naturally ("Pat mentioned on Monday that…") instead of starting from scratch.`,
      'When the goal is done or clearly cannot be done, say thank you and goodbye, then call end_call with what happened.',
    ].filter(Boolean).join('\n'),
    tools: [...(call.callback ? [] : [{
      type: 'function', name: 'press_keys',
      description: 'Press keys on an automated phone menu. Use only when a recording asks you to press a key. The line pauses for a second while the keys are sent, then you keep listening.',
      parameters: {
        type: 'object',
        properties: {
          digits: { type: 'string', description: 'Keys to press: 0-9, * or #, e.g. "3" or "1#".' },
          reason: { type: 'string', description: 'Which option this picks, e.g. "sanitation" or "operator".' },
        },
        required: ['digits'],
      },
    }]), {
      type: 'function', name: 'end_call',
      description: 'Record the outcome and end the call. Say goodbye first.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['done', 'retry_later', 'voicemail', 'blocked', 'failed'],
            description: 'done = goal achieved or definitively answered (including: the goal was to leave a message, and you left it); retry_later = no one picked up, they asked you to call back, or they were busy; voicemail = you left a message but the goal still needs a live answer; blocked = they need something only the owner can decide or give (a price, payment, info you may not share); failed = it cannot be done here.',
          },
          outcome: { type: 'string', description: `One sentence: what happened (e.g. "Booked for Sat 7pm, party of 4, under ${full}").` },
          follow_up: { type: 'string', description: `Anything ${owner} needs to do or decide next (with any callback number and time they gave), or empty.` },
          notes: {
            type: 'object',
            description: 'What a good assistant writes down after a call. Fill whatever you learned; leave out what you did not.',
            properties: {
              spoke_with: { type: 'string', description: 'Name and role of who you spoke with, e.g. "Pat, front desk". "Automated system" or "voicemail" if no person.' },
              said: { type: 'string', description: 'What they told you, in their terms: prices, availability, rules, next steps.' },
              reference: { type: 'string', description: 'Ticket, case, confirmation or work-order number.' },
              direct_line: { type: 'string', description: 'A direct number, extension, or the best time/way to reach them.' },
              promised: { type: 'string', description: 'What they said they would do, and by when.' },
            },
          },
          booking: {
            type: 'object',
            description: `Fill this whenever something was booked (appointment, reservation). It goes on ${owner}'s calendar. Leave it out if nothing was booked.`,
            properties: {
              title: { type: 'string', description: 'Short name for the calendar, e.g. "Oil change".' },
              start: { type: 'string', description: 'Start time, ISO 8601 with the local UTC offset, e.g. "2026-10-01T16:00:00-04:00".' },
              end: { type: 'string', description: 'End time in the same format, if they gave one.' },
              location: { type: 'string', description: 'Address or place name.' },
              confirmation: { type: 'string', description: 'Confirmation number, or the name it is under.' },
            },
            required: ['title', 'start'],
          },
        },
        required: ['status', 'outcome'],
      },
    }],
  };
}

async function askAssistant(request: string): Promise<string> {
  const owner = ownerSession();
  if (!owner) return 'I am not set up to look that up right now.';
  const { ownerHandle, user, group } = owner;
  const ctx = { caller: `phone:${group.key}`, lane: 'interactive' as const, groupKey: group.key };
  const run = withLlmContext(ctx, () => runAgent(group, user, SPOKEN_PREFIX + request, undefined, undefined, undefined, ownerHandle));
  let timer: NodeJS.Timeout | undefined;
  const late = Symbol('late');
  const first = await Promise.race([
    run.then((r) => r, (e: unknown) => `That failed: ${e instanceof Error ? e.message : String(e)}`),
    new Promise<typeof late>((r) => { timer = setTimeout(() => r(late), TOOL_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);
  if (first === late) {
    run.then((r) => sendMessage(ownerHandle, r)).catch((err) => console.error('[phone] late answer send failed:', err));
    return 'Still working on it. The answer will come by text.';
  }
  return toPlainText(first).replace(/https?:\/\/\S+/g, 'a link');
}

function runCall(callId: string, call: PendingCall): void {
  const ws = new WebSocket(`wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(callId)}`, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });
  const transcript: string[] = [];
  let outcome = '';
  let followUp = '';
  let status: CallStatus | '' = '';
  let booking: CallBooking | undefined;
  let notes: CallNotes | undefined;
  let receptionMessage: { callerName: string; callback: string; reason: string; urgent: boolean } | undefined;
  let ended = false;
  // Set when press_keys hands the line to a new realtime session: this session
  // closing is then expected, and must not end the call or report a result.
  let handedOff = false;
  const onMenu = call.kind === 'errand' && !!call.menuLog?.length;
  // Someone calling in (the owner, a business calling back) hears us first.
  const inbound = call.kind === 'owner' ? !call.reason : !!(call.callback || call.reception);
  if (call.kind === 'errand' && !call.lineStartedAt) call.lineStartedAt = Date.now();
  const hangup = (delayMs: number) => {
    if (ended) return;
    ended = true;
    setTimeout(() => callApi(callId, 'hangup').catch((e) => console.warn('[phone] hangup:', e.message)), delayMs);
  };
  const elapsed = call.kind === 'errand' && call.lineStartedAt ? Date.now() - call.lineStartedAt : 0;
  const wake = call.kind === 'owner' ? call.wake : undefined;
  // A receptionist call is short; a robocaller shouldn't run the meter for 15 minutes.
  const maxMs = wake ? WAKE_MAX_CALL_MS : call.kind === 'errand' && call.reception ? 5 * 60_000 : MAX_CALL_MS;
  const cap = setTimeout(() => { console.warn(`[phone] ${callId} hit max length`); hangup(0); }, Math.max(30_000, maxMs - elapsed));
  // Wake-up calls: real spoken owner answers, and whether the model asked to confirm.
  let wakeAnswers = 0;
  let wakeConfirmAsked = false;
  let wakeHangUpRefused = false;
  let wakeMachine = false; // voicemail answered: nothing on this call can count
  const isAwake = () => !wakeMachine && wakeConfirmAsked && wakeAnswers >= WAKE_MIN_ANSWERS;
  const send = (ev: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(ev)); };
  // Outbound calls wait for the other side to talk first, but a phone menu,
  // hold music, or a long recording never gives voice detection a turn to end.
  // On 2026-09-29 that left a call silent for 5 minutes. So: speak first after
  // a short wait, and give up on a line where nothing happens.
  let botSpoke = false;
  // After a menu key press what follows is often hold music or another menu,
  // so wait longer. But after choosing "leave a message", the line goes quiet
  // after the beep: a beep isn't speech, so nothing ever prompts us. On
  // 2026-10-01 three calls pressed "deliver message" and then sat in
  // silence until the line dropped. There, start the message after a few
  // seconds.
  const lastPress = call.kind === 'errand' ? call.menuLog?.at(-1) ?? '' : '';
  const toMessage = onMenu && /message|voice ?mail|leave|record/i.test(lastPress);
  // After a key press, 45s of waiting lost calls: some lines beep into voicemail
  // and hang up on silence after ~20s. Speak at 15s;
  // if it's hold music the message just repeats when a person picks up.
  const speakAfterMs = !onMenu ? 10_000 : toMessage ? 5_000 : 15_000;
  const speakFirst = call.kind === 'errand' && !inbound
    ? setTimeout(() => { if (!botSpoke && !ended) send({ type: 'response.create' }); }, speakAfterMs)
    : undefined;
  const deadAir = call.kind === 'errand' && !inbound
    ? setTimeout(() => {
      if (!botSpoke && !ended) { console.warn(`[phone] ${callId}: nothing happened on the line, hanging up`); hangup(0); }
    }, onMenu ? 120_000 : 75_000)
    : undefined;

  ws.on('open', () => {
    console.log(`[phone] control socket open for ${call.kind} call ${callId}`);
    // A wake-up call answered by voicemail doesn't count as the owner talking back.
    if (wake && call.twilioSid) {
      answeredBy(call.twilioSid).then((who) => {
        if (who && /^(machine|fax)/.test(who)) {
          console.log(`[phone] wake-up call ${callId} reached ${who}, hanging up`);
          wakeMachine = true;
          hangup(0);
        }
      }).catch(() => {});
    }
    // Inbound callers hear a greeting at once. On outbound calls the other
    // side says hello first and voice activity detection takes it. A wake-up
    // call opens at once too: they may be too groggy to say hello.
    if (inbound || (call.kind === 'owner' && call.wake)) send({ type: 'response.create' });
  });

  ws.on('message', async (raw) => {
    let ev: Record<string, any>;
    try { ev = JSON.parse(String(raw)); } catch { return; }
    if (ev.type === 'conversation.item.input_audio_transcription.completed' && ev.transcript) {
      transcript.push(`${call.kind === 'owner' ? 'You' : 'Them'}: ${String(ev.transcript).trim()}`);
      if (wake && isRealWakeAnswer(String(ev.transcript))) wakeAnswers++;
    } else if (ev.type === 'response.created' || ev.type === 'input_audio_buffer.speech_started') {
      // A response is already coming (or they're talking): the speak-first timer must
      // not start a second one. That race made the assistant say its intro twice.
      botSpoke = true;
    } else if (ev.type === 'response.output_audio_transcript.done' && ev.transcript) {
      botSpoke = true;
      transcript.push(`Bot: ${String(ev.transcript).trim()}`);
    } else if (ev.type === 'response.function_call_arguments.done') {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(ev.arguments || '{}'); } catch { /* empty args */ }
      let output = 'ok';
      if (ev.name === 'ask_assistant' && call.kind === 'owner') {
        output = await askAssistant(String(args.request || ''));
      } else if (ev.name === 'press_keys' && call.kind === 'errand') {
        const digits = String(args.digits || '').replace(/\s+/g, '');
        if (!/^[0-9*#]{1,10}$/.test(digits)) {
          output = 'Only 0-9, * and # can be pressed.';
        } else if ((call.menuLog?.length ?? 0) >= MAX_KEY_PRESSES) {
          output = 'Too many key presses on this call. End the call with retry_later and say the menu could not be navigated.';
        } else if (call.conf) {
          // Conference call: the tones play into the call and this session keeps listening.
          try {
            await pressKeysInConference(call, digits);
            call.menuLog = [...(call.menuLog ?? []), `Pressed ${digits}${args.reason ? ` (${String(args.reason)})` : ''}`];
            console.log(`[phone] ${callId}: pressed ${digits} (conference)`);
            output = `Pressed ${digits}. Stay quiet and listen to what comes next: another menu (press again), hold music (wait), a person (introduce yourself briefly), or a beep (leave your short message).`;
          } catch (err) {
            output = `Could not press keys: ${err instanceof Error ? err.message : String(err)}`;
          }
        } else {
          try {
            handedOff = true;
            await pressKeys(call, digits, String(args.reason || ''));
            console.log(`[phone] ${callId}: pressing ${digits} on the phone menu`);
            return; // this session ends; the next one picks up after the tones
          } catch (err) {
            handedOff = false;
            output = `Could not press keys: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
      } else if (ev.name === 'connect_owner' && call.kind === 'errand' && call.reception) {
        const decision = connectDecision(call.reception.caller);
        if (!decision.ok) {
          output = decision.why;
        } else {
          try {
            handedOff = true;
            await connectOwner(call, String(args.caller_name || call.reception.caller.name || 'Someone'), String(args.reason || ''));
            console.log(`[phone] ${callId}: reception ringing the owner`);
            return; // the caller's line is now ringing the owner; this session ends
          } catch (err) {
            handedOff = false;
            output = `Couldn't ring the owner (${err instanceof Error ? err.message : String(err)}). Take a message.`;
          }
        }
      } else if (ev.name === 'take_message' && call.kind === 'errand' && call.reception) {
        receptionMessage = {
          callerName: String(args.caller_name || ''), callback: String(args.callback_number || ''),
          reason: String(args.reason || ''), urgent: args.urgent === true,
        };
        output = `Saved. Tell them ${getOwner().name} will get it, say goodbye.`;
        hangup(6000);
      } else if (ev.name === 'confirm_awake' && wake) {
        wakeConfirmAsked = true;
        // Transcription can trail the audio by a turn; the count is rechecked when the call ends.
        output = isAwake()
          ? 'Confirmed awake. Say a quick upbeat send-off, then call hang_up.'
          : `Not yet: ${wakeAnswers} real spoken answer(s) so far, ${WAKE_MIN_ANSWERS} needed. Ask another simple question the owner has to answer out loud.`;
      } else if (ev.name === 'hang_up' && wake && !isAwake() && !wakeHangUpRefused) {
        // Refused once only, so a voicemail or a determined owner can still end it.
        wakeHangUpRefused = true;
        output = 'The owner is not confirmed awake yet. Do not hang up: ask another question the owner has to answer out loud, then call confirm_awake.';
      } else if (ev.name === 'end_call' || ev.name === 'hang_up') {
        outcome = String(args.outcome || '');
        followUp = String(args.follow_up || '');
        const st = String(args.status || '');
        if (['done', 'retry_later', 'voicemail', 'blocked', 'failed'].includes(st)) status = st as CallStatus;
        booking = parseBooking(args.booking);
        notes = parseCallNotes(args.notes);
        // Give the goodbye time to finish playing before the line drops.
        hangup(4000);
      }
      send({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: ev.call_id, output } });
      if (!ended) send({ type: 'response.create' });
    } else if (ev.type === 'error') {
      console.warn('[phone] realtime error:', JSON.stringify(ev.error || ev).slice(0, 300));
    }
  });

  ws.on('error', (err) => console.warn(`[phone] socket error on ${callId}:`, err.message));
  ws.on('close', () => {
    clearTimeout(cap);
    if (speakFirst) clearTimeout(speakFirst);
    if (deadAir) clearTimeout(deadAir);
    if (handedOff) {
      console.log(`[phone] ${callId} handed off to the next menu step`);
      return;
    }
    // However the socket ended, make sure both legs of the call are down.
    if (!ended) { ended = true; callApi(callId, 'hangup').catch(() => {}); }
    if (call.twilioSid) twilioHangup(call.twilioSid).catch((e) => console.warn('[phone] twilio hangup:', e.message));
    console.log(`[phone] call ${callId} ended (${transcript.length} turns)`);
    if (wake) {
      try { wakeHooks?.onFinished(wake.id, wake.attempt, { awake: isAwake(), answers: wakeAnswers }); } catch (err) { console.error('[phone] wake hook failed:', err); }
    }
    finishCall(callId, call, transcript, outcome, followUp, status, booking, notes, receptionMessage).catch((err) => console.error('[phone] wrap-up failed:', err));
  });
}

async function finishCall(
  callId: string, call: PendingCall, transcript: string[], outcome: string, followUp: string, status: CallStatus | '',
  booking?: CallBooking,
  notes?: CallNotes,
  receptionMessage?: { callerName: string; callback: string; reason: string; urgent: boolean },
): Promise<void> {
  if (call.kind === 'errand' && call.reception) {
    // Reception calls never reach errands or the one-off path.
    const r = call.reception;
    if (receptionMessage) await deliverMessage(r.caller, receptionMessage, { triedToConnect: !!r.missed });
    else if (r.missed) await deliverMessage(r.caller, { callerName: r.missed.name, callback: '', reason: r.missed.reason, urgent: false }, { triedToConnect: true });
    else if (transcript.length) await logDeclined(r.caller, outcome);
    return;
  }
  const keep = call.kind === 'owner' || call.keepTranscript;
  if (keep && transcript.length) setMemory('phone', `call_${todayET()}_${callId.slice(-8)}`, transcript.join('\n').slice(0, 20_000));
  // A call with the assistant continues by text: the conversation goes into the
  // owner's thread (wake-up calls excluded; they're just "good morning").
  if (call.kind === 'owner' && !call.wake && transcript.length >= 2) {
    try {
      const at = new Date().toLocaleTimeString('en-US', { timeZone: getTimezone(), hour: 'numeric', minute: '2-digit' });
      const lines = transcript.slice(-40).join('\n').replace(/^Bot:/gm, `${getBotName()}:`);
      saveMessage('admin', 'assistant', 'assistant', `[Phone call with you, ended ${at}]\n${lines.slice(-3000)}`);
    } catch { /* history is best-effort */ }
  }
  if (call.kind !== 'errand') return;
  // Last lines of the call (their side included), so a dropped call says what happened.
  const tail = keep ? transcript.slice(-6).join('\n') : transcript.slice(-8).join('\n').slice(-1200);
  if (call.personId) {
    try {
      addInteraction({ person_id: call.personId, channel: 'phone', summary: outcome || call.goal, ref: `call:${callId}`, occurred_at: new Date().toISOString() });
    } catch { /* people-graph writes never fail a call */ }
  }
  const spoke = transcript.length > 0;
  const result: CallResult = {
    // No end_call means the line dropped or nothing engaged (a phone menu, hold
    // music, silence): worth another try. Only the call AI can declare "failed".
    status: status || 'retry_later',
    outcome: outcome || (spoke ? 'The call ended without a recorded outcome.' : 'Connected, but no one engaged (likely a phone menu, hold music, or silence).'),
    followUp,
    transcriptTail: tail,
    botSaid: transcript.filter((l) => l.startsWith('Bot: ')).map((l) => l.slice(5)).join(' ').slice(0, 600),
    endedWithoutOutcome: !status,
    menuLog: call.menuLog,
    ...(booking ? { booking } : {}),
    ...(notes ? { notes } : {}),
  };
  if (call.callback) {
    if (call.errandId && errandHooks?.onCallback) errandHooks.onCallback(call.errandId, call.name || call.to, result);
    return;
  }
  if (call.errandId && errandHooks) {
    // The errand decides what, if anything, the owner hears about this step.
    errandHooks.onFinished(call.errandId, result);
    return;
  }
  // A one-off call the owner asked for: the result answers their request.
  const who = call.name ? `${call.name} (${call.to})` : call.to;
  const lines = [`📞 ${who}: ${result.outcome}`];
  if (followUp) lines.push(`Your move: ${followUp}`);
  if (tail) lines.push(`\n${tail}`);
  lines.push(`(action #${call.actionId})`);
  await sendInterrupt({ source: 'phone', subject: `call:${call.actionId}`, kind: 'reply', text: lines.join('\n') });
}

async function handleOpenAiWebhook(req: IncomingMessage, body: string): Promise<void> {
  if (!openaiSignatureOk(req, body)) throw Object.assign(new Error('bad webhook signature'), { status: 401 });
  const ev = JSON.parse(body) as { type?: string; data?: { call_id?: string; sip_headers?: Array<{ name: string; value: string }> } };
  // One line per delivered event, so "is OpenAI reaching us?" is answerable from the log.
  console.log(`[phone] webhook received: ${ev.type ?? 'unknown'}`);
  setMemory('phone', 'last_webhook_at', new Date().toISOString());
  if (ev.type !== 'realtime.call.incoming') return;
  const callId = ev.data?.call_id;
  if (!callId) return;
  const nonce = ev.data?.sip_headers?.find((h) => h.name.toLowerCase() === 'x-assistant-nonce')?.value || '';
  const call = pending.get(nonce);
  pending.delete(nonce);
  if (!call || call.expires < Date.now()) {
    console.warn(`[phone] rejecting SIP call ${callId}: unknown or expired nonce`);
    await callApi(callId, 'reject', { status_code: 403 }).catch(() => {});
    return;
  }
  const session = call.kind === 'owner' ? ownerSessionConfig(call) : errandSessionConfig(call);
  // A callback isn't one of the runner's own dials, so it leaves call_state alone.
  if (call.kind === 'errand' && call.errandId && errandHooks && !call.callback) errandHooks.onConnected(call.errandId);
  if (call.kind === 'owner' && call.wake) wakeHooks?.onConnected(call.wake.id, call.wake.attempt);
  // Their side is transcribed too, so a dropped call can say why. The full transcript
  // is still only stored when the owner asks ("keep transcript"); otherwise just the last few lines go into the call log.
  const transcribeThem = call.kind === 'owner' || call.keepTranscript || (call.kind === 'errand' && env('PHONE_TRANSCRIBE_THEM', 'true') !== 'false');
  await callApi(callId, 'accept', {
    type: 'realtime',
    model: MODEL,
    instructions: session.instructions,
    tools: session.tools,
    tool_choice: 'auto',
    audio: {
      input: { ...(transcribeThem ? { transcription: { model: TRANSCRIBE_MODEL } } : {}), turn_detection: { type: 'semantic_vad' } },
      output: { voice: VOICE },
    },
  });
  runCall(callId, call);
}

// ── Entry points used elsewhere ──────────────────────────────────────────────

/**
 * Ring the owner and open with `reason`. Used for time-critical interrupts
 * (cos-outbound) when PHONE_RING_ON_CRITICAL=true. Never rings in quiet hours,
 * and at most PHONE_RING_DAILY_CAP times a day.
 */
export async function callOwner(reason: string): Promise<boolean> {
  if (!isPhoneConfigured() || isQuietHours()) return false;
  const today = todayET();
  if (ringDay !== today) { ringDay = today; ringCount = 0; }
  if (ringCount >= RING_DAILY_CAP) return false;
  const to = ownerPhones()[0];
  if (!to) return false;
  ringCount++;
  await twilioCall(`+1${to}`, mintNonce({ kind: 'owner', reason: toPlainText(reason).slice(0, 600) }));
  return true;
}

/**
 * Ring the owner for a wake-up call they set. Unlike callOwner, this ignores quiet
 * hours and the daily ring cap: they asked for it. The outcome comes back through
 * setWakeCallHooks; a call nobody answers reports nothing (wakeup.ts times it out).
 */
export async function callOwnerWakeUp(w: WakeCallInfo): Promise<void> {
  if (!isPhoneConfigured()) throw new Error('phone calling is not configured');
  const to = ownerPhones()[0];
  if (!to) throw new Error('no owner phone number configured');
  const nonce = mintNonce({ kind: 'owner', reason: 'wake-up call', wake: w });
  const entry = pending.get(nonce);
  // Answering-machine detection: the owner's voicemail greeting would otherwise be
  // transcribed as the owner "talking back". Synchronous, so Twilio decides before
  // the bot is connected; runCall checks answered_by and hangs up on a machine.
  const sid = await twilioCall(`+1${to}`, nonce, { MachineDetection: 'Enable' });
  if (entry) entry.twilioSid = sid;
}

type Prepared = { payload: Record<string, unknown>; summary: string } | { error: string };

/** Validate a place_call proposal and freeze {to, goal, context, name, person_id}. */
export function preparePlaceCall(p: Record<string, unknown>): Prepared {
  const goal = String(p.goal ?? '').trim();
  const context = String(p.context ?? '').trim();
  if (!goal) return { error: 'place_call needs "goal": what the call should get done.' };
  let to = String(p.to ?? '').trim();
  let name = String(p.name ?? '').trim() || null;
  let personId: number | null = null;
  if (!to) {
    const r = resolvePerson(p);
    if (!r) return { error: 'place_call needs "to" (a phone number) or "person" (a name in people).' };
    if ('error' in r) return r;
    const { phones } = getPersonHandles(r.id);
    if (phones.length === 0) return { error: `${r.name} has no phone number on file. Ask for it.` };
    if (phones.length > 1) return { error: `${r.name} has several numbers (${phones.join(', ')}). Ask which one, then pass "to".` };
    to = phones[0];
    name = r.name;
    personId = r.id;
  }
  const dial = toDialable(to);
  if (!dial) return { error: `"${to}" is not a US number the bot can call (emergency, premium, and short numbers are blocked).` };
  if (isFictionalNumber(dial)) return { error: `${to} is a made-up 555-01xx number. Find the real number (web_search / fetch_url) or ask the owner for it; never guess.` };
  if (ownerPhones().includes(normalizePhone(dial))) return { error: 'That is your own number. To have the bot ring you, just call its number.' };
  const keepTranscript = p.keep_transcript === true || p.keep_transcript === 'true';
  const d = dial.slice(-10);
  return {
    payload: { to: dial, goal, context, name, person_id: personId, keep_transcript: keepTranscript },
    summary: [
      `📞 ${name || 'Call'} ${d.slice(0, 3)}-${d.slice(3, 6)}-${d.slice(6)}: ${goal}`,
      context ? `Shares: ${context}` : '',
      keepTranscript ? 'Keeping a transcript' : 'No transcript ("keep transcript" to record)',
    ].filter(Boolean).join('\n'),
  };
}

export async function runPlaceCall(action: Action): Promise<{ outcome: string; actual_cost_cents: number }> {
  if (!isPhoneConfigured()) throw new Error('phone calling is not configured (see PHONE_* and TWILIO_* in .env.example)');
  if (!startOneOffCall) throw new Error('call runner is not started');
  const p = JSON.parse(action.payload_json) as Record<string, unknown>;
  const to = toDialable(String(p.to ?? ''));
  const goal = String(p.goal ?? '').trim();
  if (!to || !goal) throw new Error('payload missing a valid "to" or "goal"');
  // One-off calls ride the errand runner too, so a dial that never connects is
  // noticed and reported instead of going silent.
  startOneOffCall({
    to, goal, name: (p.name as string) || null, share: String(p.context ?? ''),
    keepTranscript: p.keep_transcript === true, actionId: action.id,
  });
  return { outcome: `Calling ${(p.name as string) || to} now. I'll tell you how it went.`, actual_cost_cents: 0 };
}

/** Dial one errand step. The result comes back through setErrandCallHooks. */
export async function placeErrandCall(c: {
  errandId: number; actionId: number; to: string; name: string | null; goal: string; context: string; keepTranscript: boolean;
}): Promise<string> {
  if (!isPhoneConfigured()) throw new Error('phone calling is not configured');
  const to = toDialable(c.to);
  if (!to) throw new Error(`"${c.to}" is not a dialable US number`);
  const nonce = mintNonce({
    kind: 'errand', actionId: c.actionId, to, goal: c.goal, context: c.context,
    name: c.name, personId: null, keepTranscript: c.keepTranscript, errandId: c.errandId,
  });
  const entry = pending.get(nonce);
  let extra: Record<string, string> = {};
  if (conferenceMode() && entry && entry.kind === 'errand') {
    const token = randomBytes(12).toString('base64url');
    const name = `call-${token.slice(0, 12)}`;
    confs.set(token, { nonce, name, sipStarted: false, expires: Date.now() + 30 * 60_000 });
    for (const [k, v] of confs) if (v.expires < Date.now()) confs.delete(k);
    entry.conf = { token, name };
    extra = { Twiml: conferenceTwiml(token, name) };
  }
  const sid = await twilioCall(to, nonce, extra);
  // Same object runCall gets, even if the webhook already consumed the nonce.
  if (entry) entry.twilioSid = sid;
  return sid;
}

/** Twilio's view of a call leg: status (queued|ringing|in-progress|completed|busy|no-answer|failed|canceled) and seconds. */
export async function twilioCallInfo(sid: string): Promise<{ status: string; duration: number } | null> {
  if (!TWILIO_SID || !TWILIO_TOKEN || !sid) return null;
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Calls/${sid}.json`, {
      headers: { Authorization: `Basic ${Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString('base64')}` },
    });
    if (!res.ok) return null;
    const d = await res.json() as { status?: string; duration?: string | null };
    return { status: d.status ?? '', duration: Number(d.duration ?? 0) || 0 };
  } catch { return null; }
}

// ── HTTP server ──────────────────────────────────────────────────────────────

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = req.url?.split('?')[0];
  if (req.method !== 'POST') { res.writeHead(404).end(); return; }
  const body = await readBody(req);
  if (path === '/twilio/voice') {
    const query = new URLSearchParams(req.url?.split('?')[1] ?? '');
    const params = new URLSearchParams(body);
    const step = query.get('step');
    if (step) {
      if (!twilioSignatureOk(req, params)) throw Object.assign(new Error('bad twilio signature'), { status: 403 });
      const allParams = new URLSearchParams([...params, ...query]);
      const out = step === 'conf' || step === 'dtmf'
        ? await conferenceStep(step, query.get('t') || '', allParams)
        : receptionStep(step, query.get('t') || '', params);
      res.writeHead(200, { 'Content-Type': 'text/xml' }).end(out);
      return;
    }
    const twiml = handleInboundCall(req, params);
    res.writeHead(200, { 'Content-Type': 'text/xml' }).end(twiml);
    return;
  }
  if (path === '/openai/webhook') {
    // Answer the webhook right away; accept + control run on their own.
    await handleOpenAiWebhook(req, body);
    res.writeHead(200).end();
    return;
  }
  res.writeHead(404).end();
}

export function startPhone(): void {
  if (!isPhoneConfigured()) {
    console.log('[phone] not configured (PHONE_PUBLIC_URL / TWILIO_* / OPENAI_PROJECT_ID / OPENAI_WEBHOOK_SECRET); calling disabled');
    return;
  }
  const server = createServer((req, res) => {
    handle(req, res).catch((err: Error & { status?: number }) => {
      console.error(`[phone] ${req.url}:`, err.message);
      if (!res.headersSent) res.writeHead(err.status || 500).end();
    });
  });
  server.on('error', (err) => console.error('[phone] server error:', err));
  server.listen(PORT, HOST, () => console.log(`[phone] listening on http://${HOST}:${PORT} (public ${PUBLIC_URL})`));
}
