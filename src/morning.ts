// What the wake-up call knows about the owner's day, so it can go through it with them instead
// of only asking what's for breakfast: today's schedule (with any clashes), the top of their
// task list, and what the assistant's jobs are waiting on them for. Each part is optional and
// time-boxed; the call works without any of it.

import { getTimezone } from './config.js';

export interface MorningEvent {
  title: string;
  start: string; // ISO time, or YYYY-MM-DD for an all-day event
  end?: string;
  allDay: boolean;
  where?: string;
}

const localDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: getTimezone() }).format(new Date(ms));
const localTime = (iso: string) => new Date(iso).toLocaleTimeString('en-US', { timeZone: getTimezone(), hour: 'numeric', minute: '2-digit' });

/** Give each source a few seconds; a slow one is left out, never waited on. */
async function within<T>(p: Promise<T>, ms = 6000): Promise<T | undefined> {
  let t: NodeJS.Timeout | undefined;
  try { return await Promise.race([p, new Promise<undefined>((r) => { t = setTimeout(() => r(undefined), ms); })]); }
  catch { return undefined; } finally { clearTimeout(t); }
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
const same = (a: string, b: string) => { const x = norm(a), y = norm(b); return !!x && !!y && (x.includes(y) || y.includes(x)); };

/** One entry per thing: the same event twice (or all-day plus timed) counts once. */
export function dedupe(events: MorningEvent[]): MorningEvent[] {
  const out: MorningEvent[] = [];
  for (const e of [...events].sort((a, b) => Number(a.allDay) - Number(b.allDay))) {
    if (out.some((o) => same(o.title, e.title) && (e.allDay || o.allDay || o.start === e.start))) continue;
    out.push(e);
  }
  return out.sort((a, b) => (a.allDay === b.allDay ? a.start.localeCompare(b.start) : a.allDay ? -1 : 1));
}

/** Meetings that overlap: "8:00 AM Dentist overlaps 8:15 AM Roof inspection". */
export function clashes(events: MorningEvent[]): string[] {
  // Long blocks (a delivery window, a work block) aren't meetings to clash with.
  const timed = events.filter((e) => !e.allDay && e.end).map((e) => ({ e, s: Date.parse(e.start), x: Date.parse(e.end!) }))
    .filter((t) => t.x - t.s <= 3 * 3_600_000).sort((a, b) => a.s - b.s);
  const out: string[] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length && timed[j].s < timed[i].x; j++) {
      if (same(timed[i].e.title, timed[j].e.title)) continue;
      out.push(`${localTime(timed[i].e.start)} ${timed[i].e.title} overlaps ${localTime(timed[j].e.start)} ${timed[j].e.title}`);
    }
  }
  return out.slice(0, 4);
}

export interface MorningParts {
  schedule: MorningEvent[];
  priorities: Array<{ title: string; why: string }>;
  waiting: Array<{ title: string; ask: string }>;
}

export function morningText(p: MorningParts): string {
  const lines: string[] = [];
  if (p.schedule.length) {
    lines.push("Today's schedule:");
    for (const e of p.schedule) lines.push(`- ${e.allDay ? 'All day' : localTime(e.start)}: ${e.title}${e.where ? ` (${e.where})` : ''}`);
    const c = clashes(p.schedule);
    if (c.length) lines.push(`Clashes to sort out: ${c.join('; ')}.`);
  } else lines.push('Nothing on the calendar today.');
  if (p.priorities.length) lines.push('', 'Top of the list:', ...p.priorities.map((x) => `- ${x.title} (${x.why})`));
  if (p.waiting.length) lines.push('', 'Waiting on the owner\'s answer:', ...p.waiting.map((x) => `- ${x.title}${x.ask && !x.title.toLowerCase().includes(x.ask.toLowerCase()) ? `: ${x.ask}` : ''}`));
  return lines.join('\n');
}

/** Everything the morning call should know, as plain lines for its instructions. */
export async function morningBriefing(now = new Date()): Promise<string> {
  const today = localDay(now.getTime());
  const parts: MorningParts = { schedule: [], priorities: [], waiting: [] };

  const raw = await within((async () => {
    const { listRawEvents } = await import('./tools/calendar.js');
    return listRawEvents(now.toISOString(), new Date(now.getTime() + 20 * 3_600_000).toISOString());
  })());
  if (raw) {
    const events: MorningEvent[] = raw.filter((e) => e.summary && (e.start?.dateTime || e.start?.date)).map((e) => ({
      title: e.summary!,
      start: e.start!.dateTime ?? e.start!.date!,
      end: e.end?.dateTime ?? undefined,
      allDay: !e.start!.dateTime,
      where: e.location?.split('\n')[0].slice(0, 80) || undefined,
    }));
    parts.schedule = dedupe(events.filter((e) => (e.allDay ? e.start.slice(0, 10) : localDay(Date.parse(e.start))) === today)).slice(0, 8);
  }

  try {
    const { getOverdueTasksAll, getTasksDueSoonAll } = await import('./db.js');
    const owners = (t: { assignee: string }) => t.assignee === 'owner';
    parts.priorities = [
      ...getOverdueTasksAll().filter(owners).map((t) => ({ title: t.title, why: 'overdue' })),
      ...getTasksDueSoonAll(16).filter(owners).map((t) => ({ title: t.title, why: 'due today' })),
    ].slice(0, 3);
  } catch { /* no tasks */ }

  // What the assistant's jobs are waiting on the owner for (an address, a code, a choice).
  try {
    const { openItems } = await import('./jobs.js');
    parts.waiting = openItems().filter((i) => i.status === 'waiting_on_you').slice(0, 4)
      .map((i) => ({ title: i.title.replace(/\.$/, '').slice(0, 80), ask: (i.ask ?? i.line).slice(0, 160) }));
  } catch { /* no jobs */ }

  if (!parts.schedule.length && !parts.priorities.length && !parts.waiting.length) return '';
  return morningText(parts);
}
