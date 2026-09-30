// Local-clock helpers. "Local" means the assistant's configured timezone
// (getTimezone() in config.ts), never the server process's zone.
//
// SQLite stores timestamps via datetime('now') = UTC. To bound a SUM by "today"
// or "this week" we need the UTC instant of local midnight. These return real
// Date objects; pass through toSqliteDate before comparing against stored rows.

import { getTimezone, getQuietHours } from '../config.js';

/** Current hour (0-23) on the local clock. */
export function localHour(at: Date = new Date()): number {
  const h = parseInt(
    at.toLocaleString('en-US', { timeZone: getTimezone(), hour: 'numeric', hour12: false }),
  );
  return h === 24 ? 0 : h;
}

/** True during the configured quiet hours (default 21:00 → 07:00 local). */
export function isQuietHours(at: Date = new Date()): boolean {
  const h = localHour(at);
  const { start, end } = getQuietHours();
  if (start === end) return false;
  return start > end ? h >= start || h < end : h >= start && h < end;
}

/** UTC offset like "-04:00" for the given instant on the local clock. */
export function localOffset(at: Date = new Date(), timeZone: string = getTimezone()): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
    .formatToParts(at)
    .find((p) => p.type === 'timeZoneName')?.value || 'GMT';
  const off = name.replace('GMT', '');
  return off || '+00:00';
}

/** Local calendar date (YYYY-MM-DD) for the given instant. */
export function localYmd(at: Date = new Date(), timeZone: string = getTimezone()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(at);
}

/** Today's local calendar date as YYYY-MM-DD. */
export function todayLocal(): string {
  return localYmd(new Date());
}

/** UTC instant of 00:00 local today. */
export function startOfTodayLocal(): Date {
  const now = new Date();
  return new Date(`${localYmd(now)}T00:00:00${localOffset(now)}`);
}

/** UTC instant of 00:00 local on the most recent Sunday (weeks start Sunday). */
export function startOfWeekLocal(): Date {
  const now = new Date();
  const wd = now.toLocaleDateString('en-US', { timeZone: getTimezone(), weekday: 'short' });
  const idx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wd);
  const daysBack = idx < 0 ? 0 : idx;
  const target = new Date(now.getTime() - daysBack * 86400000);
  return new Date(`${localYmd(target)}T00:00:00${localOffset(target)}`);
}

/** US zone families (label, abbreviations, IANA members). */
export const US_ZONE_FAMILIES: ReadonlyArray<{ key: string; label: string; short?: string; abbrevs: string[]; name: string; iana: string[] }> = [
  { key: 'eastern', label: 'Eastern Time', short: 'ET', abbrevs: ['EST', 'EDT'], name: 'eastern', iana: ['America/New_York', 'America/Detroit', 'America/Toronto', 'America/Indiana/Indianapolis', 'America/Kentucky/Louisville'] },
  { key: 'central', label: 'Central Time', short: 'CT', abbrevs: ['CST', 'CDT'], name: 'central', iana: ['America/Chicago', 'America/Winnipeg'] },
  { key: 'mountain', label: 'Mountain Time', short: 'MT', abbrevs: ['MST', 'MDT'], name: 'mountain', iana: ['America/Denver', 'America/Phoenix', 'America/Edmonton', 'America/Boise'] },
  { key: 'pacific', label: 'Pacific Time', short: 'PT', abbrevs: ['PST', 'PDT'], name: 'pacific', iana: ['America/Los_Angeles', 'America/Vancouver'] },
  { key: 'alaska', label: 'Alaska Time', short: 'AKT', abbrevs: ['AKT', 'AKST', 'AKDT'], name: 'alaska', iana: ['America/Anchorage'] },
  { key: 'hawaii', label: 'Hawaii Time', short: 'HT', abbrevs: ['HT', 'HST', 'HDT'], name: 'hawaii', iana: ['Pacific/Honolulu'] },
];
/** Short zone label for prompts: "ET", "PT", or the runtime's name ("GMT+1"). */
export function tzAbbrev(timeZone: string = getTimezone()): string {
  if (timeZone === 'UTC' || timeZone === 'Etc/UTC') return 'UTC';
  const family = US_ZONE_FAMILIES.find((f) => f.iana.includes(timeZone));
  if (family?.short) return family.short;
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value;
    return name || timeZone;
  } catch {
    return timeZone;
  }
}
