import cron from 'node-cron';
import { getTimezone } from './config.js';

export const FAMILY_GROUP_KEY = 'family' as const;
export const FAMILY_TIME_ZONE: string = getTimezone();
export const FAMILY_DAILY_CRON = '0 7 * * *';
export const FAMILY_WEEKLY_CRON = '30 19 * * 0';

const DAILY_EVENT_LIMIT = 6;
const DAILY_ITEM_LIMIT = 5;
const DAILY_NOTE_LIMIT = 4;
const WEEKLY_EVENT_LIMIT = 12;
const WEEKLY_LIST_LIMIT = 6;
const WEEKLY_ITEMS_PER_LIST_LIMIT = 4;

type MaybePromise<T> = T | Promise<T>;
type FamilyGroupKey = typeof FAMILY_GROUP_KEY;
type Env = Readonly<Record<string, string | undefined>>;

export interface FamilyCalendarRange {
  groupId: FamilyGroupKey;
  startDate: string;
  endDateExclusive: string;
  timeZone: typeof FAMILY_TIME_ZONE;
}

export interface FamilyCalendarEvent {
  id?: string;
  title: string;
  /** ISO timestamp, or YYYY-MM-DD for an all-day event. */
  start: string;
  /** ISO timestamp, or exclusive YYYY-MM-DD end for an all-day event. */
  end?: string | null;
  allDay?: boolean;
  location?: string | null;
}

export interface FamilyListQuery {
  groupId: FamilyGroupKey;
  includeCompleted: false;
  includeArchived: false;
}

export interface FamilyListItem {
  id?: string | number;
  listName: string;
  text: string;
  quantity?: string | number | null;
  dueDate?: string | null;
  assignees?: string[] | null;
  status?: string | null;
  archived?: boolean;
}

export interface FamilyCoordinationQuery {
  groupId: FamilyGroupKey;
  unresolvedOnly: true;
}

export interface FamilyCoordinationNote {
  id?: string | number;
  text: string;
  resolved?: boolean;
  updatedAt?: string | null;
}

export interface FamilyWeatherSummary {
  summary: string;
}

/**
 * Adapters are deliberately family-specific. Integration code must bind these
 * to the dedicated Family calendar/list/note stores; this module has no route
 * to owner or global data.
 */
export interface FamilySchedulerDataSource {
  listFamilyCalendarEvents(range: FamilyCalendarRange): MaybePromise<FamilyCalendarEvent[]>;
  listOpenFamilyItems(query: FamilyListQuery): MaybePromise<FamilyListItem[]>;
  listOpenFamilyCoordinationNotes(query: FamilyCoordinationQuery): MaybePromise<FamilyCoordinationNote[]>;
  getFamilyWeather?(location: string): MaybePromise<FamilyWeatherSummary | null>;
}

export interface FamilySchedulerMemory {
  get(groupId: FamilyGroupKey, key: string): MaybePromise<string | undefined>;
  set(groupId: FamilyGroupKey, key: string, value: string): MaybePromise<void>;
  delete(groupId: FamilyGroupKey, key: string): MaybePromise<void>;
}

export interface FamilySchedulerDependencies {
  data: FamilySchedulerDataSource;
  memory: FamilySchedulerMemory;
  authorizeTarget?(recipient: string): MaybePromise<boolean>;
  sendMessage(recipient: string, text: string): MaybePromise<void>;
  env?: Env;
  now?: () => Date;
  logger?: Pick<Console, 'log' | 'error' | 'warn'>;
}

export interface FamilyDailySnapshot {
  date: string;
  events: FamilyCalendarEvent[];
  items: FamilyListItem[];
  coordinationNotes: FamilyCoordinationNote[];
  weather?: FamilyWeatherSummary | null;
}

export interface FamilyWeeklySnapshot {
  weekStartDate: string;
  weekEndDate: string;
  events: FamilyCalendarEvent[];
  items: FamilyListItem[];
  coordinationNotes: FamilyCoordinationNote[];
}

export type FamilyDeliveryStatus = 'sent' | 'duplicate' | 'in-flight' | 'disabled';

export interface FamilyDeliveryResult {
  status: FamilyDeliveryStatus;
  key: string;
  target?: string;
  text?: string;
}

const inFlightDeliveryKeys = new Set<string>();
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function envFor(deps: FamilySchedulerDependencies): Env {
  return deps.env ?? process.env;
}

function familyTarget(deps: FamilySchedulerDependencies): string | null {
  return envFor(deps).GROUP_FAMILY?.trim() || null;
}

function oneLine(value: unknown, max = 140): string {
  const cleaned = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function addDateDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + days, 12));
  return shifted.toISOString().slice(0, 10);
}

function dateOnlyAsUtcNoon(date: string): Date {
  return new Date(`${date}T12:00:00.000Z`);
}

/** Return YYYY-MM-DD for the supplied instant in the local timezone. */
export function familyDateET(at: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: FAMILY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

function weekdayIndexForDate(date: string): number {
  return dateOnlyAsUtcNoon(date).getUTCDay();
}

/** The next Monday-through-Sunday window, used by the Sunday evening review. */
export function upcomingFamilyWeekET(at: Date = new Date()): {
  weekStartDate: string;
  weekEndDate: string;
  endDateExclusive: string;
} {
  const today = familyDateET(at);
  const day = weekdayIndexForDate(today);
  const daysUntilMonday = day === 1 ? 7 : (8 - day) % 7;
  const weekStartDate = addDateDays(today, daysUntilMonday);
  return {
    weekStartDate,
    weekEndDate: addDateDays(weekStartDate, 6),
    endDateExclusive: addDateDays(weekStartDate, 7),
  };
}

export function familyDailyDeliveryKey(at: Date = new Date()): string {
  return `delivery_daily_${familyDateET(at)}`;
}

export function familyWeeklyDeliveryKey(at: Date = new Date()): string {
  return `delivery_weekly_${upcomingFamilyWeekET(at).weekStartDate}`;
}

function displayDate(date: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' })
    .format(dateOnlyAsUtcNoon(date));
}

function eventDateET(event: FamilyCalendarEvent): string | null {
  if (DATE_ONLY.test(event.start)) return event.start;
  const parsed = new Date(event.start);
  return Number.isNaN(parsed.getTime()) ? null : familyDateET(parsed);
}

function itemDueDateET(item: FamilyListItem): string | null {
  const value = item.dueDate?.trim();
  if (!value) return null;
  if (DATE_ONLY.test(value)) return value;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : familyDateET(parsed);
}

function isOpenItem(item: FamilyListItem): boolean {
  if (item.archived) return false;
  const status = item.status?.trim().toLowerCase();
  return status !== 'done' && status !== 'completed' && status !== 'archived' && status !== 'cancelled';
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, 'en', { sensitivity: 'base' });
}

function sortedEvents(events: FamilyCalendarEvent[]): FamilyCalendarEvent[] {
  return events
    .filter((event) => oneLine(event.title).length > 0)
    .slice()
    .sort((a, b) => a.start.localeCompare(b.start) || compareText(a.title, b.title));
}

function sortedItems(items: FamilyListItem[]): FamilyListItem[] {
  return items
    .filter((item) => isOpenItem(item) && oneLine(item.text).length > 0)
    .slice()
    .sort((a, b) => {
      const aDue = itemDueDateET(a) ?? '9999-12-31';
      const bDue = itemDueDateET(b) ?? '9999-12-31';
      return aDue.localeCompare(bDue)
        || compareText(a.listName, b.listName)
        || compareText(a.text, b.text)
        || String(a.id ?? '').localeCompare(String(b.id ?? ''));
    });
}

function sortedNotes(notes: FamilyCoordinationNote[]): FamilyCoordinationNote[] {
  return notes
    .filter((note) => !note.resolved && oneLine(note.text).length > 0)
    .slice()
    .sort((a, b) => (a.updatedAt ?? '').localeCompare(b.updatedAt ?? '') || compareText(a.text, b.text));
}

function formatTime(iso: string): string | null {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat('en-US', {
    timeZone: FAMILY_TIME_ZONE,
    hour: 'numeric',
    minute: '2-digit',
  }).format(parsed);
}

function formatEvent(event: FamilyCalendarEvent): string {
  const title = oneLine(event.title);
  const location = event.location ? ` @ ${oneLine(event.location, 60)}` : '';
  if (event.allDay || DATE_ONLY.test(event.start)) return `All day — ${title}${location}`;
  const start = formatTime(event.start) ?? 'Time TBD';
  const end = event.end ? formatTime(event.end) : null;
  const time = end && end !== start ? `${start}–${end}` : start;
  return `${time} — ${title}${location}`;
}

function formatQuantity(quantity: FamilyListItem['quantity']): string {
  const value = oneLine(quantity, 20);
  return value ? ` ×${value}` : '';
}

function formatAssignees(assignees: FamilyListItem['assignees']): string {
  const names = assignees?.map((name) => oneLine(name, 40)).filter(Boolean) ?? [];
  return names.length > 0 ? ` — ${names.join(' + ')}` : '';
}

function formatDue(dueDate: string | null, referenceDate: string): string {
  if (!dueDate) return '';
  if (dueDate < referenceDate) return ` (overdue ${displayDate(dueDate, { month: 'short', day: 'numeric' })})`;
  if (dueDate === referenceDate) return ' (due today)';
  return ` (due ${displayDate(dueDate, { weekday: 'short', month: 'short', day: 'numeric' })})`;
}

function formatItem(item: FamilyListItem, referenceDate: string, includeList = false): string {
  const prefix = includeList ? `${oneLine(item.listName, 40)}: ` : '';
  return `${prefix}${oneLine(item.text)}${formatQuantity(item.quantity)}${formatAssignees(item.assignees)}${formatDue(itemDueDateET(item), referenceDate)}`;
}

function cappedLines<T>(values: T[], limit: number, render: (value: T) => string): string[] {
  const shown = values.slice(0, limit).map((value) => `- ${render(value)}`);
  if (values.length > limit) shown.push(`- +${values.length - limit} more`);
  return shown;
}

function appendSection(lines: string[], heading: string, entries: string[]): void {
  if (entries.length === 0) return;
  if (lines.length > 1) lines.push('');
  lines.push(heading, ...entries);
}

/** Pure, deterministic daily iMessage formatter. */
export function formatFamilyDailyUpdate(snapshot: FamilyDailySnapshot): string {
  const lines = [`Family — ${displayDate(snapshot.date, { weekday: 'long', month: 'short', day: 'numeric' })}`];
  const weather = oneLine(snapshot.weather?.summary, 120);
  if (weather) lines.push(`Weather: ${weather}`);

  const events = sortedEvents(snapshot.events);
  appendSection(lines, 'Calendar', cappedLines(events, DAILY_EVENT_LIMIT, formatEvent));

  const items = sortedItems(snapshot.items);
  const due = items.filter((item) => {
    const date = itemDueDateET(item);
    return date !== null && date <= snapshot.date;
  });
  appendSection(lines, 'Due or overdue', cappedLines(due, DAILY_ITEM_LIMIT, (item) => formatItem(item, snapshot.date, true)));

  const dueIds = new Set(due.map((item) => `${item.listName}\u0000${item.id ?? item.text}`));
  for (const listName of ['Groceries', 'Errands']) {
    const highlights = items.filter((item) =>
      item.listName.localeCompare(listName, 'en', { sensitivity: 'base' }) === 0
      && !dueIds.has(`${item.listName}\u0000${item.id ?? item.text}`));
    appendSection(lines, listName, cappedLines(highlights, DAILY_ITEM_LIMIT, (item) => formatItem(item, snapshot.date)));
  }

  const notes = sortedNotes(snapshot.coordinationNotes);
  appendSection(lines, 'Needs coordination', cappedLines(notes, DAILY_NOTE_LIMIT, (note) => oneLine(note.text)));

  if (lines.length === 1 || (lines.length === 2 && weather)) {
    lines.push('', 'Nothing on the Family calendar or lists needs attention today.');
  }
  return lines.join('\n');
}

function preferredListRank(name: string): number {
  const normalized = name.trim().toLowerCase();
  if (normalized === 'family tasks') return 0;
  if (normalized === 'groceries') return 1;
  if (normalized === 'errands') return 2;
  return 3;
}

/** Pure, deterministic Monday-through-Sunday iMessage formatter. */
export function formatFamilyWeeklyUpdate(snapshot: FamilyWeeklySnapshot): string {
  const range = `${displayDate(snapshot.weekStartDate, { month: 'short', day: 'numeric' })}–${displayDate(snapshot.weekEndDate, { month: 'short', day: 'numeric' })}`;
  const lines = [`Family week — ${range}`];
  const events = sortedEvents(snapshot.events).slice(0, WEEKLY_EVENT_LIMIT);
  const eventsByDate = new Map<string, FamilyCalendarEvent[]>();
  for (const event of events) {
    const date = eventDateET(event);
    if (!date || date < snapshot.weekStartDate || date > snapshot.weekEndDate) continue;
    const bucket = eventsByDate.get(date) ?? [];
    bucket.push(event);
    eventsByDate.set(date, bucket);
  }
  const eventLines: string[] = [];
  for (const [date, dateEvents] of [...eventsByDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    eventLines.push(displayDate(date, { weekday: 'short', month: 'short', day: 'numeric' }));
    eventLines.push(...dateEvents.map((event) => `- ${formatEvent(event)}`));
  }
  if (sortedEvents(snapshot.events).length > WEEKLY_EVENT_LIMIT) {
    eventLines.push(`- +${sortedEvents(snapshot.events).length - WEEKLY_EVENT_LIMIT} more events`);
  }
  appendSection(lines, 'Calendar', eventLines);

  const items = sortedItems(snapshot.items);
  const byList = new Map<string, FamilyListItem[]>();
  for (const item of items) {
    const key = oneLine(item.listName, 60) || 'Family Tasks';
    const bucket = byList.get(key) ?? [];
    bucket.push(item);
    byList.set(key, bucket);
  }
  const listGroups = [...byList.entries()].sort(([a], [b]) =>
    preferredListRank(a) - preferredListRank(b) || compareText(a, b));
  const listLines: string[] = [];
  for (const [listName, listItems] of listGroups.slice(0, WEEKLY_LIST_LIMIT)) {
    listLines.push(listName);
    listLines.push(...cappedLines(listItems, WEEKLY_ITEMS_PER_LIST_LIMIT, (item) => formatItem(item, snapshot.weekStartDate)));
  }
  if (listGroups.length > WEEKLY_LIST_LIMIT) listLines.push(`- +${listGroups.length - WEEKLY_LIST_LIMIT} more lists`);
  appendSection(lines, 'Open lists', listLines);

  const notes = sortedNotes(snapshot.coordinationNotes);
  appendSection(lines, 'Unresolved', cappedLines(notes, DAILY_NOTE_LIMIT, (note) => oneLine(note.text)));

  if (lines.length === 1) lines.push('', 'The Family calendar and lists are clear for the week ahead.');
  return lines.join('\n');
}

async function loadDailySnapshot(deps: FamilySchedulerDependencies, at: Date): Promise<FamilyDailySnapshot> {
  const date = familyDateET(at);
  const endDateExclusive = addDateDays(date, 1);
  const [events, items, coordinationNotes] = await Promise.all([
    deps.data.listFamilyCalendarEvents({
      groupId: FAMILY_GROUP_KEY,
      startDate: date,
      endDateExclusive,
      timeZone: FAMILY_TIME_ZONE,
    }),
    deps.data.listOpenFamilyItems({
      groupId: FAMILY_GROUP_KEY,
      includeCompleted: false,
      includeArchived: false,
    }),
    deps.data.listOpenFamilyCoordinationNotes({
      groupId: FAMILY_GROUP_KEY,
      unresolvedOnly: true,
    }),
  ]);

  let weather: FamilyWeatherSummary | null = null;
  const weatherLocation = envFor(deps).FAMILY_WEATHER_LOCATION?.trim();
  if (weatherLocation && deps.data.getFamilyWeather) {
    try {
      weather = await deps.data.getFamilyWeather(weatherLocation);
    } catch (err) {
      (deps.logger ?? console).warn('[FamilyScheduler] Optional weather lookup failed:', err);
    }
  }
  return { date, events, items, coordinationNotes, weather };
}

async function loadWeeklySnapshot(deps: FamilySchedulerDependencies, at: Date): Promise<FamilyWeeklySnapshot> {
  const { weekStartDate, weekEndDate, endDateExclusive } = upcomingFamilyWeekET(at);
  const [events, items, coordinationNotes] = await Promise.all([
    deps.data.listFamilyCalendarEvents({
      groupId: FAMILY_GROUP_KEY,
      startDate: weekStartDate,
      endDateExclusive,
      timeZone: FAMILY_TIME_ZONE,
    }),
    deps.data.listOpenFamilyItems({
      groupId: FAMILY_GROUP_KEY,
      includeCompleted: false,
      includeArchived: false,
    }),
    deps.data.listOpenFamilyCoordinationNotes({
      groupId: FAMILY_GROUP_KEY,
      unresolvedOnly: true,
    }),
  ]);
  return { weekStartDate, weekEndDate, events, items, coordinationNotes };
}

/** Build the daily message without sending it or touching dedup state. */
export async function previewFamilyDailyUpdate(
  deps: FamilySchedulerDependencies,
  at: Date = deps.now?.() ?? new Date(),
): Promise<string> {
  return formatFamilyDailyUpdate(await loadDailySnapshot(deps, at));
}

/** Build the weekly message without sending it or touching dedup state. */
export async function previewFamilyWeeklyUpdate(
  deps: FamilySchedulerDependencies,
  at: Date = deps.now?.() ?? new Date(),
): Promise<string> {
  return formatFamilyWeeklyUpdate(await loadWeeklySnapshot(deps, at));
}

async function deliverOnce(
  deps: FamilySchedulerDependencies,
  key: string,
  build: () => Promise<string>,
): Promise<FamilyDeliveryResult> {
  const target = familyTarget(deps);
  if (!target) return { status: 'disabled', key };
  if (!deps.authorizeTarget || !(await deps.authorizeTarget(target))) {
    return { status: 'disabled', key, target };
  }
  const lockKey = `${FAMILY_GROUP_KEY}:${key}`;
  if (inFlightDeliveryKeys.has(lockKey)) return { status: 'in-flight', key, target };

  inFlightDeliveryKeys.add(lockKey);
  let reserved = false;
  let sendDispatched = false;
  try {
    if (await deps.memory.get(FAMILY_GROUP_KEY, key)) {
      return { status: 'duplicate', key, target };
    }

    // Reserve before sending: if the process dies after Messages accepts the
    // send but before the final stamp, the restart still suppresses a replay.
    await deps.memory.set(FAMILY_GROUP_KEY, key, JSON.stringify({
      state: 'sending',
      claimedAt: new Date().toISOString(),
    }));
    reserved = true;

    const text = await build();
    // Membership may change while the snapshot is being assembled. This second
    // check is intentionally adjacent to the send to close that race.
    if (!(await deps.authorizeTarget(target))) {
      await deps.memory.delete(FAMILY_GROUP_KEY, key);
      reserved = false;
      return { status: 'disabled', key, target };
    }
    // From this point onward a transport error is send-in-doubt: Messages may
    // have accepted the iMessage before reporting failure. Keep the durable
    // reservation so a restart cannot replay the same Family update.
    sendDispatched = true;
    await deps.sendMessage(target, text);
    await deps.memory.set(FAMILY_GROUP_KEY, key, JSON.stringify({
      state: 'sent',
      sentAt: new Date().toISOString(),
    }));
    return { status: 'sent', key, target, text };
  } catch (err) {
    // Source failures before dispatch remain retryable. Once the send begins,
    // preserve the reservation and favor suppressing a duplicate over replay.
    if (reserved && !sendDispatched) {
      try {
        await deps.memory.delete(FAMILY_GROUP_KEY, key);
      } catch (cleanupErr) {
        (deps.logger ?? console).error('[FamilyScheduler] Failed to clear delivery reservation:', cleanupErr);
      }
    }
    throw err;
  } finally {
    inFlightDeliveryKeys.delete(lockKey);
  }
}

/** Manual/test entry point for the 07:00 daily Family update. */
export async function runFamilyDailyUpdate(
  deps: FamilySchedulerDependencies,
  at: Date = deps.now?.() ?? new Date(),
): Promise<FamilyDeliveryResult> {
  const key = familyDailyDeliveryKey(at);
  return deliverOnce(deps, key, () => previewFamilyDailyUpdate(deps, at));
}

/** Manual/test entry point for the Sunday 19:30 week-ahead review. */
export async function runFamilyWeeklyUpdate(
  deps: FamilySchedulerDependencies,
  at: Date = deps.now?.() ?? new Date(),
): Promise<FamilyDeliveryResult> {
  const key = familyWeeklyDeliveryKey(at);
  return deliverOnce(deps, key, () => previewFamilyWeeklyUpdate(deps, at));
}

export interface FamilySchedulerHandles {
  daily: ReturnType<typeof cron.schedule>;
  weekly: ReturnType<typeof cron.schedule>;
}

export interface FamilyScheduleExpressions {
  daily: string;
  weekly: string;
}

/** Resolve optional private overrides without weakening the configured timezone. */
export function familyScheduleExpressions(env: Env = process.env): FamilyScheduleExpressions {
  return {
    daily: env.FAMILY_DAILY_CRON?.trim() || FAMILY_DAILY_CRON,
    weekly: env.FAMILY_WEEKLY_CRON?.trim() || FAMILY_WEEKLY_CRON,
  };
}

/** Register the two Family-only schedules. No GROUP_FAMILY means no jobs. */
export function startFamilyScheduler(deps: FamilySchedulerDependencies): FamilySchedulerHandles | null {
  const logger = deps.logger ?? console;
  if (!familyTarget(deps)) {
    logger.log('[FamilyScheduler] Disabled: GROUP_FAMILY is not configured');
    return null;
  }

  const expressions = familyScheduleExpressions(envFor(deps));
  const invalid = [
    ['FAMILY_DAILY_CRON', expressions.daily],
    ['FAMILY_WEEKLY_CRON', expressions.weekly],
  ].filter(([, expression]) => !cron.validate(expression));
  if (invalid.length > 0) {
    logger.error(`[FamilyScheduler] Disabled: invalid ${invalid.map(([name]) => name).join(' and ')}`);
    return null;
  }

  const daily = cron.schedule(expressions.daily, () => {
    void runFamilyDailyUpdate(deps).catch((err) => logger.error('[FamilyScheduler] Daily update failed:', err));
  }, { timezone: FAMILY_TIME_ZONE });

  const weekly = cron.schedule(expressions.weekly, () => {
    void runFamilyWeeklyUpdate(deps).catch((err) => logger.error('[FamilyScheduler] Weekly review failed:', err));
  }, { timezone: FAMILY_TIME_ZONE });

  logger.log(`[FamilyScheduler] Registered daily (${expressions.daily}) and weekly (${expressions.weekly}) local-time updates`);
  return { daily, weekly };
}
