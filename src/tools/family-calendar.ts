import { createHash, randomBytes } from 'node:crypto';
import { google, type calendar_v3 } from 'googleapis';
import { getBotName, getProfileConfig, getTimezone } from '../config.js';
import { US_ZONE_FAMILIES } from '../lib/time.js';
import {
  claimFamilyCalendarActionDispatch,
  findRecentFamilyCalendarActionReceipt,
  getFamilyCalendarActionReceipt,
  markFamilyCalendarActionSendInDoubt,
  markFamilyCalendarActionSucceeded,
  releaseFamilyCalendarActionDispatch,
  reserveFamilyCalendarActionReceipt,
  type FamilyCalendarActionReceipt,
} from '../family-calendar-receipts.js';
import type { ToolContext, ToolDef } from './index.js';
import {
  familyActionSendInDoubt,
  getAuthorizedFamilyManifestEvidence,
  type AuthorizedFamilyManifestEvidence,
  type FamilyManifestSourceBinding,
} from '../family-turn-manifest.js';

export const FAMILY_CALENDAR_TIME_ZONE: string = getTimezone();
export const FAMILY_DELETE_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
export const FAMILY_CALENDAR_ACTION_PROPERTY = 'assistant_family_action';
export const FAMILY_CREATE_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

type FamilyCalendarClient = calendar_v3.Calendar;

interface PendingFamilyEventDeletion {
  code: string;
  calendarId: string;
  calendarAccount: string;
  eventId: string;
  eventTitle: string;
  requesterId: string;
  chatId: string;
  requestTurnId: string;
  requestedAtMs: number;
  expiresAtMs: number;
}

export interface FamilyCalendarToolDependencies {
  getCalendarClient: () => FamilyCalendarClient;
  getCalendarId: () => string;
  getCalendarAccount: () => string;
  now: () => number;
  createConfirmationCode: () => string;
}

export interface FamilyCalendarEventSummary {
  id: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location: string;
}

export interface FamilyCalendarRawReadOptions {
  startDate: string;
  endDateExclusive: string;
  timeZone: string;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

function defaultCalendarClient(): FamilyCalendarClient {
  const auth = new google.auth.OAuth2(
    requireEnv('GOOGLE_CALENDAR_CLIENT_ID'),
    requireEnv('GOOGLE_CALENDAR_CLIENT_SECRET'),
  );
  auth.setCredentials({ refresh_token: requireEnv('GOOGLE_CALENDAR_REFRESH_TOKEN') });
  return google.calendar({ version: 'v3', auth });
}

/**
 * Return the one configured Family calendar ID. `primary` is deliberately
 * rejected so a missing or unsafe setup can never fall through to the owner's
 * private calendar.
 */
export function getConfiguredFamilyCalendarId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return requireDedicatedFamilyCalendarId(env.FAMILY_CALENDAR_ID);
}

/** Exact primary calendar ID expected for the already authenticated account. */
export function getConfiguredFamilyCalendarAccount(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return requireFamilyCalendarAccount(env.FAMILY_CALENDAR_ACCOUNT);
}

function requireDedicatedFamilyCalendarId(value: unknown): string {
  const calendarId = typeof value === 'string' ? value.trim() : '';
  if (!calendarId) {
    throw new Error('Family calendar is unavailable: FAMILY_CALENDAR_ID is not configured.');
  }
  if (calendarId.toLowerCase() === 'primary') {
    throw new Error('Family calendar is unavailable: FAMILY_CALENDAR_ID cannot be "primary".');
  }
  if (/[\r\n\0]/.test(calendarId)) {
    throw new Error('Family calendar is unavailable: FAMILY_CALENDAR_ID is invalid.');
  }
  return calendarId;
}

function requireFamilyCalendarAccount(value: unknown): string {
  const account = typeof value === 'string' ? value.trim() : '';
  if (!account) {
    throw new Error('Family calendar is unavailable: FAMILY_CALENDAR_ACCOUNT is not configured.');
  }
  if (account.toLowerCase() === 'primary' || /[\s\r\n\0]/.test(account)) {
    throw new Error('Family calendar is unavailable: FAMILY_CALENDAR_ACCOUNT is invalid.');
  }
  return account;
}

function getFamilyCalendarBinding(
  deps: Pick<FamilyCalendarToolDependencies, 'getCalendarId' | 'getCalendarAccount'>,
): { calendarId: string; calendarAccount: string } {
  const calendarId = requireDedicatedFamilyCalendarId(deps.getCalendarId());
  const calendarAccount = requireFamilyCalendarAccount(deps.getCalendarAccount());
  if (calendarId === calendarAccount) {
    throw new Error('Family calendar is unavailable: the Family calendar cannot be the authenticated primary calendar.');
  }
  return { calendarId, calendarAccount };
}

function asRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

function asOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string.`);
  return value;
}

function asYmd(value: unknown, field: string): string {
  const date = asRequiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`${field} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`${field} is not a valid calendar date.`);
  }
  return date;
}

function asTime(value: unknown, field: string): string {
  const time = asRequiredString(value, field);
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`${field} must use HH:MM in 24-hour time.`);
  }
  return time;
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function familyDateAt(nowMs: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FAMILY_CALENDAR_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(nowMs));
}

function renderedWallTimeAt(
  instantMs: number,
  timeZone: string,
): { date: string; time: string; pseudoUtcMs: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  return {
    date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    time: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
    pseudoUtcMs: Date.UTC(year, month - 1, day, hour, minute, second),
  };
}

/** Return every real instant represented by one local wall time. Around DST,
 * the result can be empty (spring-forward gap) or contain two instants
 * (fall-back repetition). Sampling nearby offsets avoids hardcoding today's
 * fixed UTC offsets or host-timezone behavior. */
function possibleWallTimeInstants(date: string, time: string, timeZone: string): number[] {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const desiredPseudoUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offsets = new Set<number>();
  for (const dayDelta of [-370, -2, -1, 0, 1, 2, 370]) {
    const sample = desiredPseudoUtc + (dayDelta * 24 * 60 * 60 * 1000);
    offsets.add(renderedWallTimeAt(sample, timeZone).pseudoUtcMs - sample);
  }

  const candidates = new Set<number>();
  for (const offset of offsets) {
    const candidate = desiredPseudoUtc - offset;
    const rendered = renderedWallTimeAt(candidate, timeZone);
    if (rendered.date === date && rendered.time === time) candidates.add(candidate);
  }
  return [...candidates].sort((left, right) => left - right);
}

function assertUniqueFamilyWallTime(date: string, time: string, field: string): void {
  const candidates = possibleWallTimeInstants(date, time, FAMILY_CALENDAR_TIME_ZONE);
  if (candidates.length === 0) {
    throw new Error(
      `${field} ${time} does not exist in ${FAMILY_CALENDAR_TIME_ZONE} on ${date} because of the daylight-saving transition; choose another time.`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `${field} ${time} occurs twice in ${FAMILY_CALENDAR_TIME_ZONE} on ${date} because of the daylight-saving transition; choose an unambiguous time.`,
    );
  }
}

/** Convert a wall-clock time in the Family timezone into a real UTC instant. */
function wallTimeToIso(date: string, time: string, timeZone: string): string {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const desiredPseudoUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  let candidate = desiredPseudoUtc;

  // Two passes cover DST offset changes without relying on the host timezone.
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(candidate));
    const get = (type: Intl.DateTimeFormatPartTypes) =>
      Number(parts.find((part) => part.type === type)?.value);
    const renderedPseudoUtc = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour'),
      get('minute'),
      get('second'),
    );
    candidate += desiredPseudoUtc - renderedPseudoUtc;
  }

  return new Date(candidate).toISOString();
}

function asTimeZone(value: unknown): string {
  const timeZone = asRequiredString(value, 'timeZone');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date(0));
  } catch {
    throw new Error('timeZone must be a valid IANA timezone, such as America/Chicago.');
  }
  return timeZone;
}

const CALENDAR_TEXT_STOP_WORDS = new Set([
  'a', 'an', 'and', 'appointment', 'appointments', 'appt', 'at', 'calendar',
  'create', 'event', 'for', 'from', 'in', 'make', 'meeting', 'of', 'on',
  'please', 'put', 'schedule', 'set', 'the', 'to', 'with',
]);

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
});

const WEEKDAYS: Readonly<Record<string, number>> = Object.freeze({
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
});

function assertOnlyInputKeys(
  input: Record<string, unknown>,
  allowed: readonly string[],
  toolName: string,
): void {
  const allow = new Set(allowed);
  const extras = Object.keys(input).filter((key) => !allow.has(key));
  if (extras.length > 0) {
    throw new Error(`${toolName} received unsupported fields: ${extras.join(', ')}.`);
  }
}

function requireCalendarManifestEvidence(
  context: ToolContext | undefined,
  toolName: string,
  input: Record<string, unknown>,
): AuthorizedFamilyManifestEvidence {
  const evidence = getAuthorizedFamilyManifestEvidence(context, toolName, input);
  if (!evidence) {
    throw new Error(
      'This Family calendar change is not authorized by the exact source-bound intent for this turn.',
    );
  }
  return evidence;
}

function evidenceText(
  evidence: AuthorizedFamilyManifestEvidence,
  currentOnly = false,
): string {
  return evidence.sourceBindings
    .filter((binding) => !currentOnly || binding.current)
    .map((binding) => binding.quote)
    .join('\n');
}

function normalizeText(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, "'")
    .replace(/'s\b/gi, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function stemToken(token: string): string {
  if (token.length > 5 && token.endsWith('ies')) return `${token.slice(0, -3)}y`;
  if (token.length > 5 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

function meaningfulTokens(value: string): string[] {
  return normalizeText(value)
    .split(' ')
    .filter(Boolean)
    .filter((token) => !CALENDAR_TEXT_STOP_WORDS.has(token))
    .map(stemToken);
}

function isTextGroundedInBinding(
  value: string,
  binding: FamilyManifestSourceBinding,
): boolean {
  const normalizedValue = normalizeText(value);
  const normalizedBinding = normalizeText(binding.quote);
  const required = meaningfulTokens(value);
  const available = new Set(meaningfulTokens(binding.quote));
  return normalizedValue.length > 0
    && (normalizedBinding.includes(normalizedValue)
      || (required.length > 0 && required.every((token) => available.has(token))));
}

function assertTextGrounded(
  value: string,
  field: string,
  evidence: AuthorizedFamilyManifestEvidence,
): void {
  const normalizedValue = normalizeText(value);
  // A model may cite several messages for a continuation, but it may not
  // manufacture one field by stitching unrelated words across those messages.
  // Every text field must be supported in full by one trusted source binding.
  const grounded = normalizedValue.length > 0
    && evidence.sourceBindings.some((binding) => isTextGroundedInBinding(value, binding));
  if (!grounded) {
    throw new Error(`${field} is not grounded in the cited Family messages.`);
  }
}

/** A correction may repeat the rejected value: "Friday, not Thursday". The
 * repeated value is context, not authority. This check is intentionally local
 * to the candidate mention, so the positive replacement remains available. */
function isNegatedCorrectionMention(text: string, index: number): boolean {
  const prefix = text.slice(Math.max(0, index - 80), index);
  const negators = [...prefix.matchAll(/\b(?:not|instead\s+of|rather\s+than)\b/gi)];
  const latest = negators.at(-1);
  if (!latest) return false;
  const tail = prefix.slice((latest.index ?? 0) + latest[0].length);
  // A comma/semicolon/"but" starts the positive replacement in forms such as
  // "not Thursday, Friday" or "not 2pm but 3pm". Within the rejected phrase,
  // every nested mention remains non-authoritative ("not 5-6pm").
  return !/[;,]|\bbut\b/i.test(tail);
}

function sourceReferenceDate(binding: FamilyManifestSourceBinding): string {
  const raw = binding.createdAt.trim();
  const parsed = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(raw) ? raw : `${raw}Z`);
  if (!Number.isFinite(parsed)) {
    throw new Error('A cited Family calendar source has an invalid timestamp.');
  }
  return familyDateAt(parsed);
}

function makeYmd(year: number, month: number, day: number): string | undefined {
  const value = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

function inferYear(month: number, day: number, referenceDate: string): number {
  const year = Number(referenceDate.slice(0, 4));
  const sameYear = makeYmd(year, month, day);
  return sameYear && sameYear >= referenceDate ? year : year + 1;
}

function addNextWeekday(referenceDate: string, weekday: number): string {
  const parsed = new Date(`${referenceDate}T00:00:00Z`);
  const delta = ((weekday - parsed.getUTCDay() + 7) % 7) || 7;
  return addDays(referenceDate, delta);
}

function extractEvidenceDates(binding: FamilyManifestSourceBinding): Set<string> {
  const text = binding.quote;
  const referenceDate = sourceReferenceDate(binding);
  const found = new Set<string>();

  for (const match of text.matchAll(/\b(\d{4}-\d{2}-\d{2})\b/g)) {
    if (isNegatedCorrectionMention(text, match.index ?? 0)) continue;
    try { found.add(asYmd(match[1], 'date')); } catch { /* invalid source date is ignored */ }
  }

  const monthPattern = /\b(january|february|march|april|may|june|july|august|september|sept|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*(?:[-–—]|through|to|until)\s*(\d{1,2})(?:st|nd|rd|th)?)?(?:,?\s+(\d{4}))?\b/gi;
  for (const match of text.matchAll(monthPattern)) {
    if (isNegatedCorrectionMention(text, match.index ?? 0)) continue;
    const month = MONTHS[match[1].toLowerCase()];
    const firstDay = Number(match[2]);
    const year = match[4] ? Number(match[4]) : inferYear(month, firstDay, referenceDate);
    const first = makeYmd(year, month, firstDay);
    const last = match[3] ? makeYmd(year, month, Number(match[3])) : undefined;
    if (first) found.add(first);
    if (last) found.add(last);
  }

  for (const match of text.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g)) {
    if (isNegatedCorrectionMention(text, match.index ?? 0)) continue;
    const month = Number(match[1]);
    const day = Number(match[2]);
    let year = match[3] ? Number(match[3]) : inferYear(month, day, referenceDate);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    const value = makeYmd(year, month, day);
    if (value) found.add(value);
  }

  const dayAfterTomorrow = /\bday\s+after\s+tomorrow\b/gi.exec(text);
  if (dayAfterTomorrow) {
    if (!isNegatedCorrectionMention(text, dayAfterTomorrow.index)) {
      found.add(addDays(referenceDate, 2));
    }
  } else {
    for (const match of text.matchAll(/\btomorrow\b/gi)) {
      if (!isNegatedCorrectionMention(text, match.index ?? 0)) found.add(addDays(referenceDate, 1));
    }
  }
  for (const match of text.matchAll(/\btoday\b/gi)) {
    if (!isNegatedCorrectionMention(text, match.index ?? 0)) found.add(referenceDate);
  }

  // A weekday next to an explicit calendar date describes that date; it must
  // not also authorize an unrelated next-weekday calculation.
  if (found.size === 0) {
    const weekdayPattern = /\b(?:this\s+|next\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday|sun|mon|tue|tues|wed|thu|thurs|fri|sat)\b/gi;
    let priorRangeDate: string | undefined;
    let priorMatchEnd = -1;
    for (const match of text.matchAll(weekdayPattern)) {
      if (isNegatedCorrectionMention(text, match.index ?? 0)) continue;
      let candidate = addNextWeekday(referenceDate, WEEKDAYS[match[1].toLowerCase()]);
      const index = match.index ?? 0;
      const connector = priorMatchEnd >= 0 ? text.slice(priorMatchEnd, index) : '';
      const continuesRange = /(?:-|–|—|\bthrough\b|\bto\b|\buntil\b|\btill\b)/i.test(connector);
      if (continuesRange && priorRangeDate && candidate <= priorRangeDate) {
        candidate = addDays(candidate, 7);
      }
      found.add(candidate);
      priorRangeDate = candidate;
      priorMatchEnd = index + match[0].length;
    }
  }

  if (found.size === 0) {
    for (const match of text.matchAll(/\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi)) {
      if (isNegatedCorrectionMention(text, match.index ?? 0)) continue;
      const day = Number(match[1]);
      const [year, month] = referenceDate.split('-').map(Number);
      let candidate = makeYmd(year, month, day);
      if (!candidate || candidate <= referenceDate) {
        const nextMonth = month === 12 ? 1 : month + 1;
        const nextYear = month === 12 ? year + 1 : year;
        candidate = makeYmd(nextYear, nextMonth, day);
      }
      if (candidate) found.add(candidate);
    }
  }
  return found;
}

function collectedEvidenceDates(
  evidence: AuthorizedFamilyManifestEvidence,
  currentOnly: boolean,
): Set<string> {
  const dates = new Set<string>();
  for (const binding of evidence.sourceBindings) {
    if (currentOnly && !binding.current) continue;
    for (const value of extractEvidenceDates(binding)) dates.add(value);
  }
  return dates;
}

function nonEmptyDateSets(
  evidence: AuthorizedFamilyManifestEvidence,
  currentOnly: boolean,
): Set<string>[] {
  return evidence.sourceBindings
    .filter((binding) => !currentOnly || binding.current)
    .map((binding) => extractEvidenceDates(binding))
    .filter((dates) => dates.size > 0);
}

function assertNoConflictingHistoricalDates(evidence: AuthorizedFamilyManifestEvidence): void {
  if (nonEmptyDateSets(evidence, true).length > 0) return;
  const distinct = new Set(nonEmptyDateSets(evidence, false)
    .map((dates) => [...dates].sort().join(',')));
  if (distinct.size > 1) {
    throw new Error('The cited Family messages disagree on the event date; ask which date to use.');
  }
}

function assertDateGrounded(
  value: string,
  field: string,
  evidence: AuthorizedFamilyManifestEvidence,
  opts: { allDayExclusiveEnd?: boolean } = {},
): void {
  assertNoConflictingHistoricalDates(evidence);
  const currentDates = collectedEvidenceDates(evidence, true);
  const dates = currentDates.size > 0 ? currentDates : collectedEvidenceDates(evidence, false);
  const directlyGrounded = dates.has(value);
  const inclusiveNaturalEndGrounded = opts.allDayExclusiveEnd
    && dates.has(addDays(value, -1));
  const explicitlyExclusiveDirectEnd = opts.allDayExclusiveEnd
    && directlyGrounded
    && /\b(?:exclusive(?:ly)?|not\s+including|excluding|until\s+but\s+not\s+including)\b/i.test(evidenceText(evidence));
  const grounded = opts.allDayExclusiveEnd
    ? inclusiveNaturalEndGrounded || explicitlyExclusiveDirectEnd
    : directlyGrounded;
  if (dates.size === 0 || !grounded) {
    throw new Error(`${field} is not grounded in the cited Family messages.`);
  }
}

// ── Repeating events ─────────────────────────────────────────────────────────
// "Swim every Tuesday at 7", "Sam's birthday every year", "trash pickup
// every other Monday". Each part of the rule must be in someone's own words.
export interface FamilyRepeat { frequency: 'daily' | 'weekly' | 'monthly' | 'yearly'; interval?: number; weekdays?: string[]; until?: string; count?: number }
const DAY_CODES: Record<string, string> = { MO: 'mon', TU: 'tue', WE: 'wed', TH: 'thu', FR: 'fri', SA: 'sat', SU: 'sun' };
const NUMBER_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10, twelve: 12 };

function parseRepeat(value: unknown): FamilyRepeat {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('repeat must be an object.');
  const v = value as Record<string, unknown>;
  const extra = Object.keys(v).filter((k) => !['frequency', 'interval', 'weekdays', 'until', 'count'].includes(k));
  if (extra.length) throw new Error(`repeat has unsupported fields: ${extra.join(', ')}`);
  if (!['daily', 'weekly', 'monthly', 'yearly'].includes(String(v.frequency))) throw new Error('repeat.frequency must be daily, weekly, monthly or yearly.');
  const out: FamilyRepeat = { frequency: v.frequency as FamilyRepeat['frequency'] };
  if (v.interval !== undefined) {
    if (!Number.isInteger(v.interval) || (v.interval as number) < 1 || (v.interval as number) > 12) throw new Error('repeat.interval must be 1-12.');
    out.interval = v.interval as number;
  }
  if (v.weekdays !== undefined) {
    if (!Array.isArray(v.weekdays) || !v.weekdays.length || v.weekdays.some((d) => !(String(d) in DAY_CODES))) throw new Error('repeat.weekdays must be codes like MO, TU.');
    out.weekdays = [...new Set(v.weekdays.map(String))];
  }
  if (v.until !== undefined) out.until = asYmd(v.until, 'repeat.until');
  if (v.count !== undefined) {
    if (!Number.isInteger(v.count) || (v.count as number) < 1 || (v.count as number) > 200) throw new Error('repeat.count must be 1-200.');
    out.count = v.count as number;
  }
  if (out.until && out.count) throw new Error('Use repeat.until or repeat.count, not both.');
  return out;
}

function assertRepeatGrounded(value: unknown, evidence: AuthorizedFamilyManifestEvidence): void {
  const rep = parseRepeat(value);
  const t = evidenceText(evidence).toLowerCase();
  const dayWord = '(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)[a-z]*';
  const said: Record<FamilyRepeat['frequency'], RegExp> = {
    daily: /\b(?:daily|every\s+(?:single\s+)?day|each\s+day|every\s+(?:morning|evening|night))\b/,
    weekly: new RegExp(`\\b(?:weekly|bi[- ]?weekly|fortnightly|every\\s+(?:other\\s+|\\w+\\s+)?week|(?:every|each)\\s+(?:other\\s+)?${dayWord}|${dayWord}s\\b|on\\s+weekdays|on\\s+weekends|weekdays|weekends)\\b`),
    monthly: /\b(?:monthly|every\s+(?:other\s+|\w+\s+)?month|each\s+month)\b/,
    yearly: /\b(?:yearly|annually|annual|every\s+year|each\s+year|birthday|anniversary)\b/,
  };
  if (!said[rep.frequency].test(t)) throw new Error(`repeat.frequency "${rep.frequency}" is not in the cited Family messages.`);
  const interval = rep.interval ?? 1;
  if (interval === 2 && !/\b(?:every\s+other|bi[- ]?weekly|fortnightly|every\s+(?:2|two)\s+\w+)\b/.test(t)) throw new Error('repeat.interval 2 needs "every other" (or similar) in their words.');
  if (interval > 2) {
    const m = t.match(/\bevery\s+(\d+|two|three|four|five|six|ten|twelve)\s+(?:days?|weeks?|months?|years?)\b/);
    const n = m ? (Number(m[1]) || NUMBER_WORDS[m[1]]) : 0;
    if (n !== interval) throw new Error(`repeat.interval ${interval} is not in the cited Family messages.`);
  }
  for (const d of rep.weekdays ?? []) {
    const name = DAY_CODES[d];
    const weekdaysPhrase = /\bweekdays\b/.test(t) && ['mon', 'tue', 'wed', 'thu', 'fri'].includes(name);
    const weekendsPhrase = /\bweekends\b/.test(t) && ['sat', 'sun'].includes(name);
    if (!weekdaysPhrase && !weekendsPhrase && !new RegExp(`\\b${name}`).test(t)) throw new Error(`repeat.weekdays ${d} is not in the cited Family messages.`);
  }
  if (rep.until && !isDateGroundedInFamilyManifestEvidence(rep.until, evidence)) throw new Error('repeat.until is not grounded in the cited Family messages.');
  if (rep.count && !new RegExp(`\\b${rep.count}\\s+(?:times|weeks|sessions|classes|lessons|months|days)\\b`).test(t)) throw new Error('repeat.count is not in the cited Family messages.');
}

/** RRULE for Google Calendar (UNTIL is the end of that day, UTC). */
export function familyRepeatRule(value: unknown): string {
  const rep = parseRepeat(value);
  const parts = [`FREQ=${rep.frequency.toUpperCase()}`];
  if (rep.interval && rep.interval > 1) parts.push(`INTERVAL=${rep.interval}`);
  if (rep.weekdays?.length) parts.push(`BYDAY=${rep.weekdays.join(',')}`);
  if (rep.until) parts.push(`UNTIL=${rep.until.replace(/-/g, '')}T235959Z`);
  if (rep.count) parts.push(`COUNT=${rep.count}`);
  return `RRULE:${parts.join(';')}`;
}

/** Use one date resolver for Family calendar dates and Family-list due dates. */
export function isDateGroundedInFamilyManifestEvidence(
  value: string,
  evidence: AuthorizedFamilyManifestEvidence,
): boolean {
  let date: string;
  try {
    date = asYmd(value, 'date');
  } catch {
    return false;
  }
  try {
    assertNoConflictingHistoricalDates(evidence);
  } catch {
    return false;
  }
  const currentDates = collectedEvidenceDates(evidence, true);
  const dates = currentDates.size > 0 ? currentDates : collectedEvidenceDates(evidence, false);
  return dates.has(date);
}

interface EvidenceTimeRange {
  start: string;
  end: string;
}

function clockValue(hourRaw: string, minuteRaw: string | undefined, meridiemRaw?: string): string | undefined {
  let hour = Number(hourRaw);
  const minute = minuteRaw === undefined ? 0 : Number(minuteRaw);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return undefined;
  const meridiem = meridiemRaw?.toLowerCase().replace(/\./g, '');
  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
  } else if (hour > 23) return undefined;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

const WORD_CLOCK_HOURS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

function wordClockValue(hourWord: string, meridiemOrDaypart: string): string | undefined {
  const hour = WORD_CLOCK_HOURS[hourWord.toLowerCase()];
  if (!hour) return undefined;
  const normalized = meridiemOrDaypart.toLowerCase().replace(/\./g, '');
  const meridiem = normalized === 'morning'
    ? 'am'
    : normalized === 'afternoon' || normalized === 'evening'
      ? 'pm'
      : normalized;
  return clockValue(String(hour), undefined, meridiem);
}

function extractTimeEvidence(text: string): { times: Set<string>; ranges: EvidenceTimeRange[] } {
  const times = new Set<string>();
  const ranges: EvidenceTimeRange[] = [];
  const rangePattern = /\b(?:from\s+|between\s+)?(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\s*(?:-|–|—|to|until|till|through|and)\s*(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b/gi;
  for (const match of text.matchAll(rangePattern)) {
    if (isNegatedCorrectionMention(text, match.index ?? 0)) continue;
    if (!match[3] && !match[6]
      && Number(match[1]) <= 12 && Number(match[4]) <= 12) continue;
    let inferredStartMeridiem = match[3] || match[6];
    // A compact range often writes the meridiem once. "11-1pm" means
    // 11am-1pm, while "8-10pm" means 8pm-10pm and "11-12pm" ends at noon.
    if (!match[3] && /^p/i.test(match[6] || '')) {
      const startHour = Number(match[1]);
      const endHour = Number(match[4]);
      if ((startHour > endHour && startHour !== 12) || endHour === 12) {
        inferredStartMeridiem = 'am';
      }
    }
    const inferredEndMeridiem = match[6] || match[3];
    const start = clockValue(match[1], match[2], inferredStartMeridiem);
    const end = clockValue(match[4], match[5], inferredEndMeridiem);
    if (start && end) {
      times.add(start);
      times.add(end);
      ranges.push({ start, end });
    }
  }
  for (const match of text.matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)\b/gi)) {
    if (isNegatedCorrectionMention(text, match.index ?? 0)) continue;
    const value = clockValue(match[1], match[2], match[3]);
    if (value) times.add(value);
  }
  for (const match of text.matchAll(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g)) {
    if (isNegatedCorrectionMention(text, match.index ?? 0)) continue;
    const value = clockValue(match[1], match[2]);
    if (value) times.add(value);
  }
  const wordHour = '(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
  const wordMeridiemPattern = new RegExp(
    `\\b${wordHour}(?:\\s+o[’']?clock)?\\s*(a\\.?m\\.?|p\\.?m\\.?)\\b`,
    'gi',
  );
  for (const match of text.matchAll(wordMeridiemPattern)) {
    if (isNegatedCorrectionMention(text, match.index ?? 0)) continue;
    const value = wordClockValue(match[1], match[2]);
    if (value) times.add(value);
  }
  const wordDaypartPattern = new RegExp(
    `\\bat\\s+${wordHour}(?:\\s+o[’']?clock)?\\s+in\\s+the\\s+(morning|afternoon|evening)\\b`,
    'gi',
  );
  for (const match of text.matchAll(wordDaypartPattern)) {
    if (isNegatedCorrectionMention(text, match.index ?? 0)) continue;
    const value = wordClockValue(match[1], match[2]);
    if (value) times.add(value);
  }
  for (const match of text.matchAll(/\bnoon\b/gi)) {
    if (!isNegatedCorrectionMention(text, match.index ?? 0)) times.add('12:00');
  }
  for (const match of text.matchAll(/\bmidnight\b/gi)) {
    if (!isNegatedCorrectionMention(text, match.index ?? 0)) times.add('00:00');
  }

  const duration = /\bfor\s+(?:(a|an|one|two|three|four|five|six|seven|eight)\s+)?(\d+(?:\.\d+)?)?\s*(hours?|hrs?|minutes?|mins?)\b/i.exec(text);
  if (duration && times.size === 1 && ranges.length === 0) {
    const start = [...times][0];
    const words: Readonly<Record<string, number>> = {
      a: 1, an: 1, one: 1, two: 2, three: 3, four: 4,
      five: 5, six: 6, seven: 7, eight: 8,
    };
    const numeric = duration[2]
      ? Number(duration[2])
      : words[duration[1]?.toLowerCase()] ?? 1;
    const minutes = /^(?:minute|min)/i.test(duration[3]) ? numeric : numeric * 60;
    const [hour, minute] = start.split(':').map(Number);
    const total = hour * 60 + minute + minutes;
    const end = `${String(Math.floor((total % 1440) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    times.add(end);
    ranges.push({ start, end });
  }
  return { times, ranges };
}

function mergedTimeEvidence(
  evidence: AuthorizedFamilyManifestEvidence,
  currentOnly: boolean,
): { times: Set<string>; ranges: EvidenceTimeRange[] } {
  const times = new Set<string>();
  const ranges: EvidenceTimeRange[] = [];
  for (const binding of evidence.sourceBindings) {
    if (currentOnly && !binding.current) continue;
    const extracted = extractTimeEvidence(binding.quote);
    for (const value of extracted.times) times.add(value);
    ranges.push(...extracted.ranges);
  }
  return { times, ranges };
}

function nonEmptyTimeSets(
  evidence: AuthorizedFamilyManifestEvidence,
  currentOnly: boolean,
): Array<{ times: Set<string>; ranges: EvidenceTimeRange[] }> {
  return evidence.sourceBindings
    .filter((binding) => !currentOnly || binding.current)
    .map((binding) => extractTimeEvidence(binding.quote))
    .filter((entry) => entry.times.size > 0 || entry.ranges.length > 0);
}

function assertNoConflictingHistoricalTimes(evidence: AuthorizedFamilyManifestEvidence): void {
  if (nonEmptyTimeSets(evidence, true).length > 0) return;
  const distinct = new Set(nonEmptyTimeSets(evidence, false).map((entry) => {
    const times = [...entry.times].sort().join(',');
    const ranges = entry.ranges
      .map((range) => `${range.start}-${range.end}`)
      .sort()
      .join(',');
    return `${times}|${ranges}`;
  }));
  if (distinct.size > 1) {
    throw new Error('The cited Family messages disagree on the event time; ask which time to use.');
  }
}

function extractDurationMinutes(text: string): number | undefined {
  const numeric = /\b(?:for\s+)?(\d+(?:\.\d+)?)\s*(hours?|hrs?|minutes?|mins?)\b/i.exec(text);
  if (numeric) {
    const value = Number(numeric[1]);
    return /^(?:minute|min)/i.test(numeric[2]) ? value : value * 60;
  }
  const words = /\b(?:for\s+)?(an?|one|two|three|four|five|six|half)\s+(hours?|hrs?|minutes?|mins?)\b/i.exec(text);
  if (!words) return undefined;
  const values: Readonly<Record<string, number>> = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, half: 0.5,
  };
  const value = values[words[1].toLowerCase()];
  return /^(?:minute|min)/i.test(words[2]) ? value : value * 60;
}

function addMinutesToTime(start: string, minutes: number): string {
  const [hour, minute] = start.split(':').map(Number);
  const total = hour * 60 + minute + minutes;
  return `${String(Math.floor((total % 1440) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

function dateGroundedInBinding(
  value: string,
  binding: FamilyManifestSourceBinding,
  allDayExclusiveEnd = false,
): boolean {
  const dates = extractEvidenceDates(binding);
  if (!allDayExclusiveEnd) return dates.has(value);
  if (dates.has(addDays(value, -1))) return true;
  return dates.has(value)
    && /\b(?:exclusive(?:ly)?|not\s+including|excluding|until\s+but\s+not\s+including)\b/i.test(binding.quote);
}

function timeGroundedInBinding(
  value: string,
  binding: FamilyManifestSourceBinding,
  startTime?: string,
): boolean {
  const extracted = extractTimeEvidence(binding.quote);
  if (extracted.times.has(value)) return true;
  if (!startTime) return false;
  const duration = extractDurationMinutes(binding.quote);
  return Boolean(duration && addMinutesToTime(startTime, duration) === value);
}

/** A create must describe one coherent pending event. Current follow-up details
 * may supplement the source that names the event, but unrelated historical
 * messages may not donate dates/times to a different title. */
function assertCoherentCreateLineage(
  input: Record<string, unknown>,
  evidence: AuthorizedFamilyManifestEvidence,
): void {
  const title = asRequiredString(input.title, 'title');
  // A photo the requester attached (role "photo") can supply the details; the
  // request itself was already checked to come from a person's own words.
  const detailRole = (binding: FamilyManifestSourceBinding) => binding.sourceRole === 'user' || binding.sourceRole === 'photo';
  const titleBindings = evidence.sourceBindings.filter((binding) =>
    detailRole(binding) && isTextGroundedInBinding(title, binding));
  const currentBindings = evidence.sourceBindings.filter((binding) =>
    detailRole(binding) && binding.current);
  const groundedInLineage = (
    predicate: (binding: FamilyManifestSourceBinding) => boolean,
  ) => titleBindings.some(predicate) || currentBindings.some(predicate);

  const date = asYmd(input.date, 'date');
  if (!groundedInLineage((binding) => dateGroundedInBinding(date, binding))) {
    throw new Error('The event date is not grounded in the same pending request as the title.');
  }

  const allDay = input.all_day === true;
  if (!allDay) {
    const start = asTime(input.start_time, 'start_time');
    if (!groundedInLineage((binding) => timeGroundedInBinding(start, binding))) {
      throw new Error('The event start time is not grounded in the same pending request as the title.');
    }
    if (input.end_time !== undefined) {
      const end = asTime(input.end_time, 'end_time');
      if (!groundedInLineage((binding) => timeGroundedInBinding(end, binding, start))) {
        throw new Error('The event end time is not grounded in the same pending request as the title.');
      }
    }
  }
  if (input.end_date !== undefined) {
    const endDate = asYmd(input.end_date, 'end_date');
    if (!groundedInLineage((binding) => dateGroundedInBinding(endDate, binding, allDay))) {
      throw new Error('The event end date is not grounded in the same pending request as the title.');
    }
  }
}

function assertTimesGrounded(
  input: Record<string, unknown>,
  evidence: AuthorizedFamilyManifestEvidence,
): void {
  assertNoConflictingHistoricalTimes(evidence);
  const current = mergedTimeEvidence(evidence, true);
  const all = current.times.size > 0 ? current : mergedTimeEvidence(evidence, false);
  const start = asTime(input.start_time, 'start_time');
  const end = input.end_time === undefined ? undefined : asTime(input.end_time, 'end_time');
  if (!all.times.has(start)) {
    throw new Error('start_time is not grounded in the cited Family messages.');
  }
  if (end && !all.times.has(end)) {
    const durationMinutes = extractDurationMinutes(evidenceText(evidence));
    if (!durationMinutes || addMinutesToTime(start, durationMinutes) !== end) {
      throw new Error('end_time is not grounded in the cited Family messages.');
    }
  }
  if (all.ranges.length > 0) {
    const matching = all.ranges.find((range) => range.start === start);
    if (!matching || !end || matching.end !== end) {
      throw new Error('The event time range does not match the cited Family messages.');
    }
  }
}

// US zone families. The one the Family calendar lives in is allowed; every
// other explicit zone mention needs clarification instead of silently being
// read as local time.
const OTHER_ZONE_ABBREVS = ['UTC', 'GMT', 'CET', 'CEST', 'EET', 'EEST', 'BST', 'IST', 'JST', 'KST', 'AEST', 'AEDT', 'ACST', 'ACDT', 'AWST', 'NZST', 'NZDT'];

function foreignZoneLabels(): { shortUs: string[]; abbrevs: string[]; names: string[]; longNames: string[]; localLabel: string } {
  const tz = FAMILY_CALENDAR_TIME_ZONE;
  const local = US_ZONE_FAMILIES.find((family) => family.iana.includes(tz));
  const foreign = US_ZONE_FAMILIES.filter((family) => family !== local);
  const localShort = new Set<string>();
  if (!local) {
    for (const month of [0, 6]) {
      const name = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' })
        .formatToParts(new Date(Date.UTC(2026, month, 15)))
        .find((part) => part.type === 'timeZoneName')?.value;
      if (name) localShort.add(name.toUpperCase());
    }
    if (tz === 'UTC' || tz === 'Etc/UTC') { localShort.add('UTC'); localShort.add('GMT'); }
  }
  const abbrevs = [
    ...OTHER_ZONE_ABBREVS.slice(0, 2),
    ...foreign.flatMap((family) => family.abbrevs),
    ...OTHER_ZONE_ABBREVS.slice(2),
  ].filter((abbrev) => !localShort.has(abbrev));
  const names = [...foreign.map((family) => family.name), 'atlantic'];
  return {
    shortUs: foreign.map((family) => family.short).filter((short): short is string => !!short),
    abbrevs,
    names,
    longNames: [...names, 'greenwich'],
    localLabel: local?.label || `the ${tz} timezone`,
  };
}

function assertSupportedCalendarLanguage(evidence: AuthorizedFamilyManifestEvidence, opts: { allowRecurrence?: boolean } = {}): void {
  const text = evidenceText(evidence);
  // Changing a whole series ("all future events", "this series") stays unsupported.
  if (/\ball\s+(?:future|following|subsequent)\b/i.test(text)
    || /\b(?:future|following|subsequent)\s+(?:events?|occurrences?|appointments?|meetings?)\b/i.test(text)
    || /\b(?:this|the|entire)\s+series\b/i.test(text)) {
    throw new Error('Changing a whole recurring series is not supported yet; nothing was changed.');
  }
  if (!opts.allowRecurrence && (/\b(?:daily|weekly|bi[- ]?weekly|fortnightly|monthly|quarterly|yearly|annually|recurrence|recurring|repeats?|repeating)\b/i.test(text)
    || /\b(?:every|each)\s+(?:(?:other|second|third|fourth|\d+(?:st|nd|rd|th)?)\s+)?(?:day|week|month|year|weekday|weekend|morning|afternoon|evening|night|sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)s?\b/i.test(text)
    || /\b(?:on\s+)?(?:weekdays|weekends|sundays|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays)\b/i.test(text)
    || /\b(?:once|twice|three|four|\d+)\s+(?:times?\s+)?(?:a|per)\s+(?:day|week|month|year)\b/i.test(text)
    || /\ball\s+(?:future|following|subsequent)\b/i.test(text)
    || /\b(?:future|following|subsequent)\s+(?:events?|occurrences?|appointments?|meetings?)\b/i.test(text)
    || /\b(?:this|the|entire)\s+series\b|\bseries\s+of\s+(?:events?|appointments?|meetings?)\b/i.test(text))) {
    throw new Error('That sounds like a repeating event: create it with "repeat" set from their words (it was not created as a one-time event).');
  }
  const namedIanaZones = [...text.matchAll(/\b[A-Za-z_]+\/[A-Za-z_]+\b/g)]
    .map((match) => match[0].toLowerCase());
  const zones = foreignZoneLabels();
  const clockToken = '(?:\\d{1,2}(?::\\d{2})?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\\s*(?:a\\.?m\\.?|p\\.?m\\.?)';
  const shortZones = zones.shortUs.join('|');
  const shortUsZoneNearClock = shortZones ? new RegExp(
    `(?:\\b${clockToken}\\s*(?:${shortZones})\\b|\\b(?:${shortZones})\\s*(?:time\\b|${clockToken}\\b)|\\b(?:in|using)\\s+(?:${shortZones})\\b)`,
    'i',
  ) : null;
  const names = zones.names.join('|');
  const namedZoneNearClock = new RegExp(
    `(?:\\b${clockToken}[^.\\n]{0,12}\\b(?:${names})\\b|\\b(?:${names})\\b[^.\\n]{0,12}\\b${clockToken})`,
    'i',
  );
  if (new RegExp(`\\b(?:${zones.abbrevs.join('|')})\\b`, 'i').test(text)
    || (shortUsZoneNearClock?.test(text) ?? false)
    || new RegExp(`\\b(?:${zones.longNames.join('|')})(?:\\s+(?:standard|daylight|prevailing))?\\s+time\\b`, 'i').test(text)
    || namedZoneNearClock.test(text)
    || namedIanaZones.some((zone) => zone !== FAMILY_CALENDAR_TIME_ZONE.toLowerCase())) {
    throw new Error(`Family calendar writes use ${zones.localLabel}; an explicitly different timezone needs clarification.`);
  }
  // "11-1am" does not establish whether the start is 11am (backwards) or
  // 11pm (overnight). Never invent the missing meridiem/end-date semantics.
  if (/\b(?:from\s+|between\s+)?(?:10|11|12)(?::\d{2})?\s*(?:-|–|—|to|until|till|through)\s*(?:1|2|3|4|5|6|7|8|9)(?::\d{2})?\s*a\.?m\.?\b/i.test(text)) {
    throw new Error('That compact overnight time range is ambiguous; include both meridiems and the ending date.');
  }
}

function assertCalendarPayloadGrounded(
  input: Record<string, unknown>,
  evidence: AuthorizedFamilyManifestEvidence,
  mode: 'create' | 'update',
): void {
  assertSupportedCalendarLanguage(evidence, { allowRecurrence: mode === 'create' && input.repeat !== undefined });
  if (input.repeat !== undefined) {
    if (mode !== 'create') throw new Error('Repeating can only be set when creating a Family event.');
    assertRepeatGrounded(input.repeat, evidence);
  }
  const allDay = input.all_day === true;
  if (Object.prototype.hasOwnProperty.call(input, 'all_day') && typeof input.all_day !== 'boolean') {
    throw new Error('all_day must be a boolean.');
  }
  if (allDay && !/\ball[- ]?day\b/i.test(evidenceText(evidence))) {
    throw new Error('all_day is not grounded in the cited Family messages.');
  }
  if (Object.prototype.hasOwnProperty.call(input, 'title')) {
    assertTextGrounded(asRequiredString(input.title, 'title'), 'title', evidence);
  }
  for (const field of ['description', 'location'] as const) {
    if (!Object.prototype.hasOwnProperty.call(input, field)) continue;
    const value = asOptionalString(input[field], field) ?? '';
    if (value.trim()) {
      assertTextGrounded(value, field, evidence);
    } else if (mode === 'update'
      && !new RegExp(`\\b(?:clear|remove|delete|drop|no)\\b[^.\\n]{0,40}\\b${field}\\b|\\b${field}\\b[^.\\n]{0,40}\\b(?:clear|remove|delete|drop|none)\\b`, 'i').test(evidenceText(evidence))) {
      throw new Error(`Clearing ${field} is not grounded in the cited Family messages.`);
    }
  }
  if (Object.prototype.hasOwnProperty.call(input, 'date')) {
    const date = asYmd(input.date, 'date');
    assertDateGrounded(date, 'date', evidence);
  }
  if (Object.prototype.hasOwnProperty.call(input, 'end_date')) {
    const endDate = asYmd(input.end_date, 'end_date');
    assertDateGrounded(endDate, 'end_date', evidence, { allDayExclusiveEnd: allDay });
  }
  if (!allDay && (mode === 'create'
    || ['start_time', 'end_time'].some((field) => Object.prototype.hasOwnProperty.call(input, field)))) {
    assertTimesGrounded(input, evidence);
  }
  if (mode === 'create') assertCoherentCreateLineage(input, evidence);
}

function extractEventIds(text: string): Set<string> {
  const ids = new Set<string>();
  for (const match of text.matchAll(/\bevent_id:([^\]\s]+)/gi)) ids.add(match[1]);
  return ids;
}

function eventIdentityTokens(value: string): string[] {
  const ignored = new Set([
    'add', 'all', 'appointment', 'archive', 'calendar', 'change', 'confirm',
    'day', 'delete', 'description', 'event', 'friday', 'location', 'make',
    'meeting', 'monday', 'move', 'remove', 'reschedule', 'saturday', 'shift',
    'sunday', 'that', 'this', 'thursday', 'time', 'tuesday', 'update',
    'wednesday', 'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december', 'it',
  ]);
  return meaningfulTokens(value).filter((token) => !ignored.has(token) && !/^\d+$/.test(token));
}

function titleIsNamedInCurrentMessage(title: string, currentMessage: string): boolean {
  const titleTokens = eventIdentityTokens(title);
  const currentTokens = new Set(eventIdentityTokens(currentMessage));
  if (titleTokens.length === 0) return normalizeText(currentMessage).includes(normalizeText(title));
  const matches = titleTokens.filter((token) => currentTokens.has(token));
  return matches.length >= Math.min(2, titleTokens.length);
}

function idsNamedInAssistantResult(message: string, currentMessage: string): Set<string> {
  const currentTokens = new Set(eventIdentityTokens(currentMessage));
  const named = new Set<string>();
  if (currentTokens.size === 0) return named;
  for (const line of message.split(/\r?\n/)) {
    const ids = extractEventIds(line);
    if (ids.size === 0) continue;
    const lineTokens = eventIdentityTokens(line);
    if (lineTokens.some((token) => currentTokens.has(token))) {
      for (const id of ids) named.add(id);
    }
  }
  return named;
}

function assertUnambiguousEventIdentity(
  eventId: string,
  event: calendar_v3.Schema$Event,
  context: ToolContext | undefined,
): void {
  const currentMessage = context?.currentMessage || '';
  const explicitIds = extractEventIds(currentMessage);
  if (explicitIds.has(eventId)) return;
  if (explicitIds.size > 0) {
    throw new Error('The selected Family event ID does not match the event ID in the current message.');
  }

  // A title establishes which event the sender means, but not which opaque ID
  // the model may mutate. Bind it to trusted assistant results and require one
  // matching candidate. Two same-title IDs remain ambiguous.
  const recent = context?.recentMessages || [];
  const candidates = new Set<string>();
  const named = new Set<string>();
  const cutoff = Date.now() - (30 * 60 * 1000);
  for (const message of recent) {
    if (message.role !== 'assistant') continue;
    const createdAt = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(message.created_at)
      ? message.created_at
      : `${message.created_at}Z`);
    if (Number.isFinite(createdAt) && createdAt < cutoff) continue;
    const ids = extractEventIds(message.content);
    for (const id of ids) candidates.add(id);
    for (const id of idsNamedInAssistantResult(message.content, currentMessage)) named.add(id);
  }
  if (named.size === 1) {
    if (named.has(eventId)) return;
    throw new Error('The selected Family event ID does not match the event named in the current message.');
  }
  if (named.size > 1) {
    throw new Error('More than one recent Family event matches that title; use the event ID or clarify which one.');
  }
  if (candidates.size === 1 && candidates.has(eventId)
    && (!event.summary || titleIsNamedInCurrentMessage(event.summary, currentMessage)
      || eventIdentityTokens(currentMessage).length === 0)) return;
  if (candidates.size > 1) {
    throw new Error('The Family event reference is ambiguous; name the event before changing it.');
  }
  throw new Error('The Family event ID is not unambiguously grounded in the current conversation.');
}

function assertNoExternalEventAttendees(event: calendar_v3.Schema$Event): void {
  if ((event.attendees?.length ?? 0) > 0) {
    throw new Error(
      `This Family event has external attendees. ${getBotName()} will not silently update or delete an attendee-bearing event.`,
    );
  }
}

async function fetchFamilyCalendarEvents(
  opts: FamilyCalendarRawReadOptions,
  deps: Pick<FamilyCalendarToolDependencies, 'getCalendarClient' | 'getCalendarId' | 'getCalendarAccount'>,
): Promise<calendar_v3.Schema$Event[]> {
  const startDate = asYmd(opts.startDate, 'startDate');
  const endDateExclusive = asYmd(opts.endDateExclusive, 'endDateExclusive');
  if (endDateExclusive <= startDate) {
    throw new Error('endDateExclusive must be after startDate.');
  }
  const timeZone = asTimeZone(opts.timeZone);
  const { calendarId, calendarAccount } = getFamilyCalendarBinding(deps);
  const cal = deps.getCalendarClient();
  await verifyDedicatedFamilyCalendar(cal, calendarId, calendarAccount);
  const response = await cal.events.list({
    calendarId,
    timeMin: wallTimeToIso(startDate, '00:00', timeZone),
    timeMax: wallTimeToIso(endDateExclusive, '00:00', timeZone),
    timeZone,
    singleEvents: true,
    orderBy: 'startTime',
    showDeleted: false,
    maxResults: 2500,
  });
  return response.data.items ?? [];
}

/** Defense in depth for a mistyped private setting. Google primary calendar IDs
 * are usually the account email, not the literal string "primary", so verify
 * the bound entry itself before every read or write. */
async function verifyDedicatedFamilyCalendar(
  cal: FamilyCalendarClient,
  calendarId: string,
  calendarAccount: string,
): Promise<void> {
  let primaryEntry: calendar_v3.Schema$CalendarListEntry;
  try {
    const response = await cal.calendarList.get({ calendarId: calendarAccount });
    primaryEntry = response.data;
  } catch {
    throw new Error('The authenticated Google Calendar primary account could not be verified.');
  }
  if (
    primaryEntry.id?.trim() !== calendarAccount
    || primaryEntry.primary !== true
    || primaryEntry.deleted === true
    || primaryEntry.accessRole !== 'owner'
  ) {
    throw new Error('The authenticated Google Calendar primary does not match FAMILY_CALENDAR_ACCOUNT.');
  }

  let entry: calendar_v3.Schema$CalendarListEntry;
  try {
    const response = await cal.calendarList.get({ calendarId });
    entry = response.data;
  } catch {
    throw new Error('The configured Family calendar could not be verified.');
  }
  if (
    entry.id?.trim() !== calendarId
    || entry.primary === true
    || entry.deleted === true
    || entry.summary !== 'Family'
    || entry.accessRole !== 'owner'
  ) {
    throw new Error('The configured calendar is not the verified owned secondary Family calendar.');
  }
}

/**
 * Scheduler-safe reader for the dedicated Family calendar. It deliberately
 * returns a narrow event shape and has no ToolContext because scheduled Family
 * briefs are system-authored. The calendar ID remains fixed and fail-closed.
 */
export async function listFamilyCalendarEventsRaw(
  opts: FamilyCalendarRawReadOptions,
): Promise<FamilyCalendarEventSummary[]> {
  const events = await fetchFamilyCalendarEvents(opts, {
    getCalendarClient: defaultCalendarClient,
    getCalendarId: getConfiguredFamilyCalendarId,
    getCalendarAccount: getConfiguredFamilyCalendarAccount,
  });
  return events.map((event) => ({
    id: event.id || '',
    title: event.summary || '(no title)',
    start: event.start?.dateTime || event.start?.date || '',
    end: event.end?.dateTime || event.end?.date || '',
    allDay: Boolean(event.start?.date),
    location: event.location || '',
  }));
}

function buildEventTimes(input: Record<string, unknown>): {
  start: calendar_v3.Schema$EventDateTime;
  end: calendar_v3.Schema$EventDateTime;
  allDay: boolean;
} {
  const date = asYmd(input.date, 'date');
  const allDay = input.all_day === true;
  const rawEndDate = input.end_date;
  const endDate = rawEndDate === undefined ? undefined : asYmd(rawEndDate, 'end_date');

  if (allDay) {
    const exclusiveEnd = endDate ?? addDays(date, 1);
    if (exclusiveEnd <= date) throw new Error('end_date must be after date for an all-day event.');
    return {
      start: { date },
      end: { date: exclusiveEnd },
      allDay: true,
    };
  }

  const startTime = asTime(input.start_time, 'start_time');
  assertUniqueFamilyWallTime(date, startTime, 'start_time');
  let timedEndDate = endDate ?? date;
  let endTime: string;
  if (input.end_time === undefined) {
    const [hour, minute] = startTime.split(':').map(Number);
    const total = hour * 60 + minute + 60;
    endTime = `${String(Math.floor((total % 1440) / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    if (total >= 1440) timedEndDate = addDays(date, 1);
  } else {
    endTime = asTime(input.end_time, 'end_time');
  }
  if (`${timedEndDate}T${endTime}` <= `${date}T${startTime}`) {
    throw new Error('Event end must be after its start. Use end_date for an overnight event.');
  }
  assertUniqueFamilyWallTime(timedEndDate, endTime, 'end_time');
  return {
    start: {
      dateTime: `${date}T${startTime}:00`,
      timeZone: FAMILY_CALENDAR_TIME_ZONE,
    },
    end: {
      dateTime: `${timedEndDate}T${endTime}:00`,
      timeZone: FAMILY_CALENDAR_TIME_ZONE,
    },
    allDay: false,
  };
}

type ExistingTimedBoundary = {
  date: string;
  time: string;
  instantMs: number;
};

function existingTimedBoundary(
  value: calendar_v3.Schema$EventDateTime | undefined,
  field: 'start' | 'end',
): ExistingTimedBoundary {
  const dateTime = value?.dateTime?.trim() || '';
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(dateTime);
  if (!match) throw new Error(`The existing Family event has no usable timed ${field}.`);
  const date = asYmd(match[1], `${field}.date`);
  const time = asTime(match[2], `${field}.time`);
  const hasOffset = /(?:Z|[+-]\d{2}:\d{2})$/i.test(dateTime);
  const instantMs = Date.parse(
    hasOffset
      ? dateTime
      : wallTimeToIso(date, time, value?.timeZone || FAMILY_CALENDAR_TIME_ZONE),
  );
  if (!Number.isFinite(instantMs)) {
    throw new Error(`The existing Family event has an invalid timed ${field}.`);
  }
  return { date, time, instantMs };
}

function familyWallTimeAt(instantMs: number): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: FAMILY_CALENDAR_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(instantMs));
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value || '';
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  };
}

function calendarDaySpan(startDate: string, exclusiveEndDate: string): number {
  const span = (
    Date.parse(`${exclusiveEndDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)
  ) / (24 * 60 * 60 * 1000);
  if (!Number.isInteger(span) || span < 1) {
    throw new Error('The existing Family all-day event has an invalid date range.');
  }
  return span;
}

/** Merge an authorized partial reschedule with the live event. Omitted end
 * fields mean "keep its duration", not "replace its duration with one hour". */
function buildUpdatedEventTimes(
  input: Record<string, unknown>,
  existing: calendar_v3.Schema$Event,
): {
  start: calendar_v3.Schema$EventDateTime;
  end: calendar_v3.Schema$EventDateTime;
  allDay: boolean;
} {
  const has = (field: string) => Object.prototype.hasOwnProperty.call(input, field);
  const existingAllDay = Boolean(existing.start?.date);
  if (existingAllDay !== Boolean(existing.end?.date)) {
    throw new Error('The existing Family event has an inconsistent start/end type.');
  }
  const allDay = has('all_day') ? input.all_day === true : existingAllDay;

  if (allDay) {
    if (has('start_time') || has('end_time')) {
      throw new Error('An all-day Family event update cannot include start_time or end_time.');
    }
    const existingStartDate = existingAllDay
      ? asYmd(existing.start?.date, 'existing start date')
      : existingTimedBoundary(existing.start, 'start').date;
    const date = has('date') ? asYmd(input.date, 'date') : existingStartDate;
    let exclusiveEnd: string;
    if (has('end_date')) {
      exclusiveEnd = asYmd(input.end_date, 'end_date');
    } else if (existingAllDay) {
      const existingEndDate = asYmd(existing.end?.date, 'existing end date');
      exclusiveEnd = addDays(date, calendarDaySpan(existingStartDate, existingEndDate));
    } else {
      // Converting a timed event to all-day has no meaningful timed duration to
      // carry forward, so use the ordinary one-day all-day event default.
      exclusiveEnd = addDays(date, 1);
    }
    if (exclusiveEnd <= date) {
      throw new Error('end_date must be after date for an all-day event.');
    }
    return {
      start: { date },
      end: { date: exclusiveEnd },
      allDay: true,
    };
  }

  if (existingAllDay) {
    const date = has('date')
      ? asYmd(input.date, 'date')
      : asYmd(existing.start?.date, 'existing start date');
    if (!has('start_time')) {
      throw new Error('start_time is required when changing an all-day Family event to a timed event.');
    }
    const timedInput: Record<string, unknown> = {
      date,
      start_time: input.start_time,
      all_day: false,
    };
    if (has('end_time')) timedInput.end_time = input.end_time;
    if (has('end_date')) timedInput.end_date = input.end_date;
    return buildEventTimes(timedInput);
  }

  const existingStart = existingTimedBoundary(existing.start, 'start');
  const existingEnd = existingTimedBoundary(existing.end, 'end');
  if (existingEnd.instantMs <= existingStart.instantMs) {
    throw new Error('The existing Family event has an invalid timed range.');
  }
  const date = has('date') ? asYmd(input.date, 'date') : existingStart.date;
  const startTime = has('start_time')
    ? asTime(input.start_time, 'start_time')
    : existingStart.time;
  assertUniqueFamilyWallTime(date, startTime, 'start_time');
  const explicitEndChange = has('end_time') || has('end_date');

  if (!explicitEndChange) {
    const newStartMs = Date.parse(
      wallTimeToIso(date, startTime, FAMILY_CALENDAR_TIME_ZONE),
    );
    const durationMs = existingEnd.instantMs - existingStart.instantMs;
    const preservedEnd = familyWallTimeAt(newStartMs + durationMs);
    assertUniqueFamilyWallTime(preservedEnd.date, preservedEnd.time, 'end_time');
    return {
      start: {
        dateTime: `${date}T${startTime}:00`,
        timeZone: FAMILY_CALENDAR_TIME_ZONE,
      },
      end: {
        dateTime: `${preservedEnd.date}T${preservedEnd.time}:00`,
        timeZone: FAMILY_CALENDAR_TIME_ZONE,
      },
      allDay: false,
    };
  }

  const existingEndDayOffset = Math.max(0, Math.round((
    Date.parse(`${existingEnd.date}T00:00:00Z`) - Date.parse(`${existingStart.date}T00:00:00Z`)
  ) / (24 * 60 * 60 * 1000)));
  const endDate = has('end_date')
    ? asYmd(input.end_date, 'end_date')
    : addDays(date, existingEndDayOffset);
  const endTime = has('end_time')
    ? asTime(input.end_time, 'end_time')
    : existingEnd.time;
  if (`${endDate}T${endTime}` <= `${date}T${startTime}`) {
    throw new Error('Event end must be after its start. Use end_date for an overnight event.');
  }
  assertUniqueFamilyWallTime(endDate, endTime, 'end_time');
  return {
    start: {
      dateTime: `${date}T${startTime}:00`,
      timeZone: FAMILY_CALENDAR_TIME_ZONE,
    },
    end: {
      dateTime: `${endDate}T${endTime}:00`,
      timeZone: FAMILY_CALENDAR_TIME_ZONE,
    },
    allDay: false,
  };
}

function requireFamilyContext(context?: ToolContext): {
  requesterId: string;
  chatId: string;
} {
  if (context?.groupKey !== 'family') {
    throw new Error('Family calendar tools are available only inside the Family group.');
  }
  const configuredChatId = process.env.GROUP_FAMILY?.trim();
  const requesterId = context.userId?.trim();
  const chatId = context.chatId?.trim();
  const recipient = context.recipient?.trim();
  const profile = getProfileConfig();
  const approvedUser = [profile.owner, ...profile.members].some(
    (user) => user.id === requesterId && user.allowedGroups.includes('family'),
  );
  if (
    !configuredChatId
    || !requesterId
    || !chatId
    || chatId !== configuredChatId
    || (recipient !== undefined && recipient !== chatId)
    || !approvedUser
  ) {
    throw new Error('Family calendar tools require an authenticated participant in the configured Family group chat.');
  }
  return { requesterId, chatId };
}

function requireLiveFamilyContext(context?: ToolContext): {
  requesterId: string;
  chatId: string;
} {
  return requireFamilyContext(context);
}

async function reverifyFamilyAudienceBeforeMutation(context?: ToolContext): Promise<void> {
  if (!context?.reverifyFamilyAudience) {
    throw new Error('The live Family participant set cannot be re-verified for this calendar change.');
  }
  let allowed = false;
  try {
    allowed = await context.reverifyFamilyAudience();
  } catch {
    allowed = false;
  }
  if (!allowed) {
    throw new Error('The live Family participant set changed or could not be re-verified; no calendar change was sent.');
  }
}

function requireInboundFamilyTurn(context?: ToolContext): {
  requesterId: string;
  chatId: string;
  turnId: string;
  currentMessage: string;
} {
  const live = requireLiveFamilyContext(context);
  const turnId = context?.turnId?.trim();
  const currentMessage = context?.currentMessage;
  if (!turnId || typeof currentMessage !== 'string' || !currentMessage.trim()) {
    throw new Error('This Family deletion step requires a distinct authenticated inbound message.');
  }
  return { ...live, turnId, currentMessage };
}

function isExactDeleteConfirmation(message: string, code: string): boolean {
  const normalized = message.trim().replace(/\s+/g, ' ').toUpperCase();
  return normalized === `CONFIRM DELETE ${code}`;
}

function formatEvent(event: calendar_v3.Schema$Event): string {
  const eventId = event.id ? `[event_id:${event.id}] ` : '';
  const title = event.summary || '(no title)';
  const location = event.location ? ` — ${event.location}` : '';
  if (event.start?.date) {
    const end = event.end?.date && event.end.date !== addDays(event.start.date, 1)
      ? ` through ${addDays(event.end.date, -1)}`
      : '';
    return `${eventId}${event.start.date}${end}, all day — ${title}${location}`;
  }

  const start = event.start?.dateTime;
  const end = event.end?.dateTime;
  if (!start) return `${eventId}${title}${location}`;
  const day = new Date(start).toLocaleDateString('en-US', {
    timeZone: FAMILY_CALENDAR_TIME_ZONE,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
  const startLabel = new Date(start).toLocaleTimeString('en-US', {
    timeZone: FAMILY_CALENDAR_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  });
  const endLabel = end
    ? new Date(end).toLocaleTimeString('en-US', {
        timeZone: FAMILY_CALENDAR_TIME_ZONE,
        hour: 'numeric',
        minute: '2-digit',
      })
    : '';
  return `${eventId}${day} ${startLabel}${endLabel ? `–${endLabel}` : ''} — ${title}${location}`;
}

function clearExpiredDeletes(
  pendingDeletes: Map<string, PendingFamilyEventDeletion>,
  nowMs: number,
): void {
  for (const [code, pending] of pendingDeletes) {
    if (pending.expiresAtMs <= nowMs) pendingDeletes.delete(code);
  }
}

function defaultConfirmationCode(): string {
  return randomBytes(4).toString('hex').toUpperCase();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function familyCreatePayloadHash(input: {
  calendarId: string;
  title: string;
  description?: string;
  location?: string;
  start: calendar_v3.Schema$EventDateTime;
  end: calendar_v3.Schema$EventDateTime;
  recurrence?: string[];
}): string {
  return sha256(JSON.stringify({
    version: 1,
    calendar_id: input.calendarId,
    title: input.title,
    description: input.description ?? null,
    location: input.location ?? null,
    start: input.start,
    end: input.end,
    // Only present for repeating events, so one-time hashes are unchanged.
    ...(input.recurrence ? { recurrence: input.recurrence } : {}),
  }));
}

function familyCreateActionKey(input: {
  calendarId: string;
  payloadHash: string;
  sourceMessageKey: string;
}): string {
  return sha256(JSON.stringify({
    version: 1,
    operation: 'family_create_event',
    calendar_id: input.calendarId,
    payload_hash: input.payloadHash,
    source_message_key: input.sourceMessageKey,
  }));
}

function explicitDuplicateCreateRequested(
  evidence: AuthorizedFamilyManifestEvidence,
): boolean {
  return evidence.sourceBindings.some((binding) =>
    binding.sourceRole === 'user'
    && /\b(?:another|one\s+more|duplicate)\b/i.test(binding.quote));
}

function formatFamilyCreateResult(input: {
  title: string;
  start: calendar_v3.Schema$EventDateTime;
  end: calendar_v3.Schema$EventDateTime;
  allDay: boolean;
  eventId: string;
  existing?: boolean;
}): string {
  const timing = input.allDay
    ? `${input.start.date} (all day)`
    : `${input.start.dateTime?.slice(0, 16).replace('T', ' ')}–${input.end.dateTime?.slice(0, 16).replace('T', ' ')}`;
  const prefix = input.existing ? 'Family event already created' : 'Created Family event';
  return `${prefix}: "${input.title}" on ${timing} [event_id:${input.eventId}]`;
}

async function reconcileFamilyCalendarCreate(
  cal: FamilyCalendarClient,
  calendarId: string,
  receipt: FamilyCalendarActionReceipt,
  nowIso: string,
): Promise<calendar_v3.Schema$Event | null> {
  if (receipt.provider_event_id) {
    try {
      const response = await cal.events.get({
        calendarId,
        eventId: receipt.provider_event_id,
      });
      const event = response.data;
      if (
        event.id === receipt.provider_event_id
        && event.status !== 'cancelled'
        && event.extendedProperties?.private?.[FAMILY_CALENDAR_ACTION_PROPERTY]
          === receipt.action_key
      ) {
        markFamilyCalendarActionSucceeded(receipt.action_key, event.id, nowIso);
        return event;
      }
    } catch {
      // The exact-ID check is an optimization. The private-property query below
      // is the authoritative reconciliation path after a timeout or restart.
    }
  }

  let items: calendar_v3.Schema$Event[];
  try {
    const response = await cal.events.list({
      calendarId,
      privateExtendedProperty: [
        `${FAMILY_CALENDAR_ACTION_PROPERTY}=${receipt.action_key}`,
      ],
      showDeleted: false,
      maxResults: 2,
    });
    items = (response.data.items ?? []).filter((event) =>
      Boolean(event.id)
      && event.status !== 'cancelled'
      && event.extendedProperties?.private?.[FAMILY_CALENDAR_ACTION_PROPERTY]
        === receipt.action_key);
  } catch {
    throw familyActionSendInDoubt(
      'The prior Family event request could not be reconciled with Google. Nothing was retried; check the Family calendar before trying again.',
    );
  }

  if (items.length > 1) {
    markFamilyCalendarActionSendInDoubt(receipt.action_key, nowIso);
    throw familyActionSendInDoubt(
      'More than one Google event carries the same Family action receipt. Nothing was retried; resolve the duplicate on the Family calendar.',
    );
  }
  const event = items[0];
  if (!event?.id) return null;
  markFamilyCalendarActionSucceeded(receipt.action_key, event.id, nowIso);
  return event;
}

export function createFamilyCalendarTools(
  overrides: Partial<FamilyCalendarToolDependencies> = {},
): ToolDef[] {
  const deps: FamilyCalendarToolDependencies = {
    getCalendarClient: defaultCalendarClient,
    getCalendarId: getConfiguredFamilyCalendarId,
    getCalendarAccount: getConfiguredFamilyCalendarAccount,
    now: Date.now,
    createConfirmationCode: defaultConfirmationCode,
    ...overrides,
  };
  const pendingDeletes = new Map<string, PendingFamilyEventDeletion>();

  return [
    {
      definition: {
        name: 'family_list_events',
        description: 'List events only from the dedicated Family Google Calendar. Use for Family schedule questions and Family daily/weekly updates. Never reads the primary or any other calendar.',
        input_schema: {
          type: 'object' as const,
          properties: {
            date: { type: 'string', description: 'Start date in YYYY-MM-DD format. Defaults to today in the local timezone.' },
            days: { type: 'number', description: 'Whole number of days to include, from 1 to 31. Defaults to 1.' },
          },
          required: [],
        },
      },
      handler: async (input, context) => {
        requireFamilyContext(context);
        const date = input.date === undefined
          ? familyDateAt(deps.now())
          : asYmd(input.date, 'date');
        const days = input.days === undefined ? 1 : Number(input.days);
        if (!Number.isInteger(days) || days < 1 || days > 31) {
          throw new Error('days must be a whole number from 1 to 31.');
        }

        const events = await fetchFamilyCalendarEvents({
          startDate: date,
          endDateExclusive: addDays(date, days),
          timeZone: FAMILY_CALENDAR_TIME_ZONE,
        }, {
          getCalendarClient: deps.getCalendarClient,
          getCalendarId: deps.getCalendarId,
          getCalendarAccount: deps.getCalendarAccount,
        });
        if (events.length === 0) return 'No Family calendar events found.';
        return events.map(formatEvent).join('\n');
      },
    },
    {
      definition: {
        name: 'family_create_event',
        description: 'Create an event only on the dedicated Family calendar. Requires an explicit request in the live Family chat; details gathered over the last few messages count, and a plain "yes", "ok", or "yes, confirmed" agreeing to an event you just described is a valid go-ahead — call this tool on it rather than asking again. Never ask the sender to rephrase, re-send, or confirm with a sentence you quote for them; if something is missing, ask only for that detail. This tool cannot invite attendees, create calendars, or change sharing.',
        input_schema: {
          type: 'object' as const,
          properties: {
            title: { type: 'string', description: 'Event title.' },
            date: { type: 'string', description: 'Start date in YYYY-MM-DD format.' },
            start_time: { type: 'string', description: 'Start time in HH:MM 24-hour format. Required unless all_day is true.' },
            end_time: { type: 'string', description: 'Optional end time in HH:MM 24-hour format. Defaults to one hour after start_time.' },
            end_date: { type: 'string', description: 'For all-day events, the exclusive end date. For overnight timed events, the date on which the event ends.' },
            all_day: { type: 'boolean', description: 'Set true for an all-day event. Defaults to false.' },
            description: { type: 'string', description: 'Optional Family-safe event description.' },
            location: { type: 'string', description: 'Optional event location.' },
            repeat: {
              type: 'object',
              description: 'Only when their words say it repeats ("every Tuesday", "weekly", "every other Monday", "her birthday every year", "until December 12", "for 10 weeks"). Omit for one-time events.',
              properties: {
                frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly'] },
                interval: { type: 'number', description: '2 for "every other"; default 1.' },
                weekdays: { type: 'array', items: { type: 'string', enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] } },
                until: { type: 'string', description: 'Last date, YYYY-MM-DD, if they gave one.' },
                count: { type: 'number', description: 'Number of times, if they gave one.' },
              },
              required: ['frequency'],
            },
          },
          required: ['title', 'date'],
        },
      },
      handler: async (input, context) => {
        requireLiveFamilyContext(context);
        assertOnlyInputKeys(
          input,
          ['title', 'date', 'start_time', 'end_time', 'end_date', 'all_day', 'description', 'location', 'repeat'],
          'family_create_event',
        );
        const evidence = requireCalendarManifestEvidence(
          context,
          'family_create_event',
          input,
        );
        assertCalendarPayloadGrounded(input, evidence, 'create');
        const { calendarId, calendarAccount } = getFamilyCalendarBinding(deps);
        const title = asRequiredString(input.title, 'title');
        const description = asOptionalString(input.description, 'description');
        const location = asOptionalString(input.location, 'location');
        const { start, end, allDay } = buildEventTimes(input);
        const recurrence = input.repeat !== undefined ? [familyRepeatRule(input.repeat)] : undefined;
        const sourceMessageKey = context?.sourceMessageKey?.trim();
        if (!sourceMessageKey || !/^[a-f0-9]{64}$/i.test(sourceMessageKey)) {
          throw new Error('The Family event request is missing its durable iMessage identity; nothing was created.');
        }
        const payloadHash = familyCreatePayloadHash({
          calendarId,
          title,
          description,
          location,
          start,
          end,
          recurrence,
        });
        const requestedActionKey = familyCreateActionKey({
          calendarId,
          payloadHash,
          sourceMessageKey,
        });
        const duplicateRequested = explicitDuplicateCreateRequested(evidence);
        const nowMs = deps.now();
        const nowIso = new Date(nowMs).toISOString();
        const cal = deps.getCalendarClient();
        await verifyDedicatedFamilyCalendar(cal, calendarId, calendarAccount);
        // Do not even reconcile a prior household write after the shared-chat
        // audience has changed. A second check remains immediately before a new
        // provider mutation to close the verification-to-dispatch race.
        await reverifyFamilyAudienceBeforeMutation(context);

        // Exact source replays always reuse their receipt. A new source with the
        // same payload also reuses a recent receipt unless the sender explicitly
        // asked for another/one more/duplicate event.
        let receipt = getFamilyCalendarActionReceipt(requestedActionKey);
        if (!receipt && !duplicateRequested) {
          receipt = findRecentFamilyCalendarActionReceipt({
            calendarId,
            payloadHash,
            notBefore: new Date(nowMs - FAMILY_CREATE_DEDUPE_WINDOW_MS).toISOString(),
          });
        }

        if (receipt && receipt.state !== 'reserved') {
          const reconciled = await reconcileFamilyCalendarCreate(
            cal,
            calendarId,
            receipt,
            nowIso,
          );
          if (reconciled?.id) {
            return formatFamilyCreateResult({
              title,
              start,
              end,
              allDay,
              eventId: reconciled.id,
              existing: true,
            });
          }
          if (receipt.state !== 'succeeded') {
            markFamilyCalendarActionSendInDoubt(receipt.action_key, nowIso);
          }
          throw familyActionSendInDoubt(
            'A recent matching Family event request has a durable receipt, but Google does not yet show a conclusive result. Nothing was retried; check the Family calendar before asking for another event.',
          );
        }

        if (!receipt) {
          receipt = reserveFamilyCalendarActionReceipt({
            actionKey: requestedActionKey,
            calendarId,
            sourceMessageKey,
            payloadHash,
            dedupeEligible: !duplicateRequested,
            now: nowIso,
          });
        }

        if (!claimFamilyCalendarActionDispatch(receipt.action_key, nowIso)) {
          const latest = getFamilyCalendarActionReceipt(receipt.action_key);
          if (!latest) {
            throw new Error('The Family calendar action receipt disappeared before dispatch; nothing was created.');
          }
          const reconciled = await reconcileFamilyCalendarCreate(
            cal,
            calendarId,
            latest,
            nowIso,
          );
          if (reconciled?.id) {
            return formatFamilyCreateResult({
              title,
              start,
              end,
              allDay,
              eventId: reconciled.id,
              existing: true,
            });
          }
          throw familyActionSendInDoubt(
            'This Family event request is already being processed or has an uncertain provider result. Nothing was retried.',
          );
        }

        // The durable receipt is in `dispatched` before the network call. If the
        // process dies on either side of the insert, recovery reconciles the
        // private event property and never performs a blind second insert.
        try {
          await reverifyFamilyAudienceBeforeMutation(context);
        } catch (error) {
          releaseFamilyCalendarActionDispatch(
            receipt.action_key,
            new Date(deps.now()).toISOString(),
          );
          throw error;
        }
        let response;
        try {
          response = await cal.events.insert({
            calendarId,
            sendUpdates: 'none',
            requestBody: {
              summary: title,
              description,
              location,
              start,
              end,
              ...(recurrence ? { recurrence } : {}),
              extendedProperties: {
                private: {
                  [FAMILY_CALENDAR_ACTION_PROPERTY]: receipt.action_key,
                },
              },
            },
          });
        } catch {
          markFamilyCalendarActionSendInDoubt(
            receipt.action_key,
            new Date(deps.now()).toISOString(),
          );
          throw familyActionSendInDoubt(
            'Google did not conclusively report whether the Family event was created. Check the Family calendar before trying again.',
          );
        }
        const eventId = response.data.id;
        if (!eventId) {
          markFamilyCalendarActionSendInDoubt(
            receipt.action_key,
            new Date(deps.now()).toISOString(),
          );
          throw familyActionSendInDoubt(
            'Google accepted the Family event request without a usable event ID. Check the Family calendar before trying again.',
          );
        }
        markFamilyCalendarActionSucceeded(
          receipt.action_key,
          eventId,
          new Date(deps.now()).toISOString(),
        );
        return formatFamilyCreateResult({ title, start, end, allDay, eventId });
      },
    },
    {
      definition: {
        name: 'family_update_event',
        description: 'Update an event only on the dedicated Family calendar. Requires an explicit request in the live Family chat. Date-only and start-time-only moves preserve the event\'s existing duration; supply end_time or end_date only when the sender explicitly changes the end.',
        input_schema: {
          type: 'object' as const,
          properties: {
            event_id: { type: 'string', description: 'Family calendar event ID returned by a Family calendar tool.' },
            title: { type: 'string', description: 'New event title.' },
            description: { type: 'string', description: 'New description. Use an empty string to clear it.' },
            location: { type: 'string', description: 'New location. Use an empty string to clear it.' },
            date: { type: 'string', description: 'Complete new start date in YYYY-MM-DD format.' },
            start_time: { type: 'string', description: 'Complete new start time in HH:MM 24-hour format.' },
            end_time: { type: 'string', description: 'Complete new end time in HH:MM 24-hour format.' },
            end_date: { type: 'string', description: 'Exclusive end date for all-day events, or ending date for an overnight timed event.' },
            all_day: { type: 'boolean', description: 'Set true when changing the event to all-day; false for a timed event.' },
          },
          required: ['event_id'],
        },
      },
      handler: async (input, context) => {
        requireLiveFamilyContext(context);
        assertOnlyInputKeys(
          input,
          ['event_id', 'title', 'description', 'location', 'date', 'start_time', 'end_time', 'end_date', 'all_day'],
          'family_update_event',
        );
        const evidence = requireCalendarManifestEvidence(
          context,
          'family_update_event',
          input,
        );
        assertCalendarPayloadGrounded(input, evidence, 'update');
        const { calendarId, calendarAccount } = getFamilyCalendarBinding(deps);
        const eventId = asRequiredString(input.event_id, 'event_id');
        const body: calendar_v3.Schema$Event = {};

        if (Object.prototype.hasOwnProperty.call(input, 'title')) {
          body.summary = asRequiredString(input.title, 'title');
        }
        if (Object.prototype.hasOwnProperty.call(input, 'description')) {
          body.description = asOptionalString(input.description, 'description') ?? '';
        }
        if (Object.prototype.hasOwnProperty.call(input, 'location')) {
          body.location = asOptionalString(input.location, 'location') ?? '';
        }

        const scheduleFields = ['date', 'start_time', 'end_time', 'end_date', 'all_day'];
        const hasScheduleUpdate = scheduleFields.some((field) =>
          Object.prototype.hasOwnProperty.call(input, field));
        if (Object.keys(body).length === 0 && !hasScheduleUpdate) {
          throw new Error('Provide at least one Family event field to update.');
        }

        const cal = deps.getCalendarClient();
        await verifyDedicatedFamilyCalendar(cal, calendarId, calendarAccount);
        const existing = await cal.events.get({ calendarId, eventId });
        if (!existing.data.id || existing.data.status === 'cancelled') {
          throw new Error('That event is not an active event on the Family calendar.');
        }
        assertNoExternalEventAttendees(existing.data);
        assertUnambiguousEventIdentity(eventId, existing.data, context);
        if (hasScheduleUpdate) {
          const { start, end } = buildUpdatedEventTimes(input, existing.data);
          body.start = start;
          body.end = end;
        }
        await reverifyFamilyAudienceBeforeMutation(context);
        try {
          await cal.events.patch({
            calendarId,
            eventId,
            sendUpdates: 'none',
            requestBody: body,
          });
        } catch {
          throw familyActionSendInDoubt(
            'Google did not conclusively report whether the Family event was updated. Check the Family calendar before trying again.',
          );
        }
        return `Updated Family event ${eventId}.`;
      },
    },
    {
      definition: {
        name: 'family_request_event_delete',
        description: 'Request deletion of a Family calendar event. This never deletes immediately: it returns a confirmation code that the same user must explicitly send back in the same Family chat within 10 minutes. After calling this tool, stop and ask for confirmation; never call the confirmation tool in the same agent run.',
        input_schema: {
          type: 'object' as const,
          properties: {
            event_id: { type: 'string', description: 'Family calendar event ID returned by a Family calendar tool.' },
          },
          required: ['event_id'],
        },
      },
      handler: async (input, context) => {
        const { requesterId, chatId, turnId } = requireInboundFamilyTurn(context);
        assertOnlyInputKeys(input, ['event_id'], 'family_request_event_delete');
        requireCalendarManifestEvidence(context, 'family_request_event_delete', input);
        const { calendarId, calendarAccount } = getFamilyCalendarBinding(deps);
        const eventId = asRequiredString(input.event_id, 'event_id');
        const cal = deps.getCalendarClient();
        await verifyDedicatedFamilyCalendar(cal, calendarId, calendarAccount);

        // Looking up the ID on the fixed calendar proves the proposal cannot be
        // used to reveal or delete an event from any other connected calendar.
        const response = await cal.events.get({ calendarId, eventId });
        if (!response.data.id || response.data.status === 'cancelled') {
          throw new Error('That event is not an active event on the Family calendar.');
        }
        assertNoExternalEventAttendees(response.data);
        assertUnambiguousEventIdentity(eventId, response.data, context);

        const nowMs = deps.now();
        clearExpiredDeletes(pendingDeletes, nowMs);
        for (const [code, pending] of pendingDeletes) {
          if (
            pending.requesterId === requesterId
            && pending.chatId === chatId
            && pending.eventId === eventId
          ) {
            pendingDeletes.delete(code);
          }
        }

        let code = deps.createConfirmationCode().trim().toUpperCase();
        if (!/^[A-Z0-9_-]{4,64}$/.test(code)) {
          throw new Error('Could not create a safe Family deletion confirmation code.');
        }
        while (pendingDeletes.has(code)) {
          code = defaultConfirmationCode();
        }
        const eventTitle = response.data.summary || '(untitled event)';
        pendingDeletes.set(code, {
          code,
          calendarId,
          calendarAccount,
          eventId,
          eventTitle,
          requesterId,
          chatId,
          requestTurnId: turnId,
          requestedAtMs: nowMs,
          expiresAtMs: nowMs + FAMILY_DELETE_CONFIRMATION_TTL_MS,
        });

        return `Nothing has been deleted. To delete "${eventTitle}", reply exactly: confirm delete ${code}\nThis confirmation expires in 10 minutes and only you can use it in this Family chat.`;
      },
    },
    {
      definition: {
        name: 'family_confirm_event_delete',
        description: 'Delete a Family event only after the user explicitly replies with the confirmation code from family_request_event_delete. Call only when a later inbound message is exactly "confirm delete <code>"; never call in the same agent run as the request.',
        input_schema: {
          type: 'object' as const,
          properties: {
            confirmation_code: { type: 'string', description: 'The code the same user explicitly sent back after the deletion request.' },
          },
          required: ['confirmation_code'],
        },
      },
      handler: async (input, context) => {
        const { requesterId, chatId, turnId, currentMessage } = requireInboundFamilyTurn(context);
        assertOnlyInputKeys(input, ['confirmation_code'], 'family_confirm_event_delete');
        requireCalendarManifestEvidence(context, 'family_confirm_event_delete', input);
        const { calendarId, calendarAccount } = getFamilyCalendarBinding(deps);
        const code = asRequiredString(input.confirmation_code, 'confirmation_code').toUpperCase();
        const nowMs = deps.now();
        const pending = pendingDeletes.get(code);
        if (!pending) {
          clearExpiredDeletes(pendingDeletes, nowMs);
          throw new Error('No pending Family event deletion matches that confirmation code.');
        }
        if (pending.expiresAtMs <= nowMs) {
          pendingDeletes.delete(code);
          throw new Error('That Family event deletion confirmation expired. Request deletion again.');
        }
        if (pending.requesterId !== requesterId || pending.chatId !== chatId) {
          throw new Error('Only the original requester can confirm this deletion in the same Family chat.');
        }
        if (pending.requestTurnId === turnId) {
          throw new Error('Deletion must be confirmed from a later inbound message, not the deletion-request turn.');
        }
        if (!isExactDeleteConfirmation(currentMessage, code)) {
          throw new Error(`To confirm this deletion, send exactly: confirm delete ${code}`);
        }
        if (pending.calendarId !== calendarId || pending.calendarAccount !== calendarAccount) {
          pendingDeletes.delete(code);
          throw new Error('The configured Family calendar binding changed; request deletion again.');
        }

        // Consume before the network call so concurrent confirmations cannot
        // issue duplicate deletes. Restore only if no delete request reached
        // Google; once dispatched, an error is send-in-doubt and the code stays
        // consumed because Google may already have accepted the deletion.
        pendingDeletes.delete(code);
        let deleteDispatched = false;
        try {
          const cal = deps.getCalendarClient();
          await verifyDedicatedFamilyCalendar(cal, calendarId, calendarAccount);
          // The event can change during the ten-minute confirmation window.
          // Recheck immediately before dispatch so a newly added attendee or
          // cancelled/replaced event is never deleted from stale request data.
          const live = await cal.events.get({ calendarId, eventId: pending.eventId });
          if (live.data.id !== pending.eventId || live.data.status === 'cancelled') {
            throw new Error('That event is no longer active on the Family calendar.');
          }
          assertNoExternalEventAttendees(live.data);
          await reverifyFamilyAudienceBeforeMutation(context);
          deleteDispatched = true;
          await cal.events.delete({
            calendarId,
            eventId: pending.eventId,
            sendUpdates: 'none',
          });
        } catch (error) {
          if (!deleteDispatched && deps.now() < pending.expiresAtMs) {
            pendingDeletes.set(code, pending);
          }
          if (deleteDispatched) {
            throw familyActionSendInDoubt(
              'Google did not conclusively report whether the Family event was deleted. The confirmation was consumed; check the Family calendar before requesting another deletion.',
            );
          }
          throw error;
        }
        return `Deleted Family event "${pending.eventTitle}".`;
      },
    },
  ];
}

export const familyCalendarTools: ToolDef[] = createFamilyCalendarTools();
