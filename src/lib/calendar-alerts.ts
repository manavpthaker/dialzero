import { getTimezone } from '../config.js';

// The heartbeat's calendar check, in plain code. It used to run the agent every
// 30 minutes to answer two questions ("time to leave?", "a clash?"), which was
// a large share of all model spend and often failed. Neither question needs a
// model.

export interface CalEvent {
  id: string;
  title: string;
  start: string;          // ISO dateTime (timed events only)
  end: string;
  location?: string | null;
  declined?: boolean;     // the owner declined it
  free?: boolean;         // marked "free" (transparency: transparent)
}

export interface CalendarAlert { subject: string; text: string }

const VIRTUAL = /(zoom\.us|meet\.google|teams\.microsoft|webex|whereby|^https?:\/\/|\bphone\b|\bcall\b|\bonline\b|\bvirtual\b|\bremote\b|^\s*$)/i;
const LEAVE_MIN = 15;
const LEAVE_MAX = 25;

const clock = (iso: string, tz: string) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz });

/** "Time to leave" for an in-person event starting in 15-25 min, and clashes in the window. */
export function calendarAlerts(events: CalEvent[], nowMs: number, tz = getTimezone()): CalendarAlert[] {
  const live = events.filter((e) => !e.declined && !e.free && e.start && e.end);
  const out: CalendarAlert[] = [];
  for (const e of live) {
    const mins = (Date.parse(e.start) - nowMs) / 60_000;
    const place = (e.location ?? '').trim();
    if (mins >= LEAVE_MIN && mins <= LEAVE_MAX && place && !VIRTUAL.test(place)) {
      out.push({ subject: `heartbeat:leave:${e.id}`, text: `🚗 ${e.title} at ${clock(e.start, tz)}, ${place.split('\n')[0]}. Time to head out.` });
    }
  }
  const sorted = [...live].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i], b = sorted[j];
      if (Date.parse(b.start) >= Date.parse(a.end)) break;
      out.push({ subject: `heartbeat:conflict:${a.id}:${b.id}`, text: `⚠️ ${a.title} (${clock(a.start, tz)}) and ${b.title} (${clock(b.start, tz)}) overlap.` });
    }
  }
  return out;
}
