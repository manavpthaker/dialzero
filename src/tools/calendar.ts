import { google, type calendar_v3 } from 'googleapis';
import type { ToolDef, ToolContext } from './index.js';
import { upsertPerson, addInteraction, linkEmailOpenLoopCalendarByMessageId } from '../db.js';
import { isValidEmailMessageId } from '../email/source.js';
import { getTimezone } from '../config.js';

// Auto-attached to Home-group calendar events (e.g. a partner's email). Empty
// by default — set HOME_AUTO_ATTENDEE in .env (onboarding writes it).
const HOME_AUTO_ATTENDEE = process.env.HOME_AUTO_ATTENDEE || '';

function getCalendarClient() {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CALENDAR_CLIENT_ID,
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN });
  return google.calendar({ version: 'v3', auth });
}

/**
 * Tier 1 Phase 4 — raw events for the meeting daemon. Reuses the existing
 * private getCalendarClient(). The exported `list_events` tool returns
 * formatted text; the daemon needs the raw structure (attendee emails, exact
 * start/end, location) for external-attendee detection and timing math.
 */
export async function listRawEvents(
  timeMinISO: string,
  timeMaxISO: string,
): Promise<calendar_v3.Schema$Event[]> {
  const cal = getCalendarClient();
  const res = await cal.events.list({
    calendarId: 'primary',
    timeMin: timeMinISO,
    timeMax: timeMaxISO,
    timeZone: getTimezone(),
    singleEvents: true,
    orderBy: 'startTime',
    maxResults: 50,
  });
  return res.data.items ?? [];
}

/**
 * Raw calendar insert, shared by the `create_event` tool and background daemons
 * (e.g. inbox-signal-daemon) that have no ToolContext. Pass `allDay: true` for a
 * date-only event (uses { date } not { dateTime }); otherwise a timed event from
 * startTime–endTime. The Home-group auto-attendee is opt-in via `addHomeAttendee`
 * since daemons can't read context.groupKey.
 */
export async function createCalendarEventRaw(opts: {
  title: string;
  description?: string;
  date: string;                 // YYYY-MM-DD
  startTime?: string;           // HH:MM 24h (timed events)
  endTime?: string;             // HH:MM 24h (timed events)
  allDay?: boolean;             // date-only event
  endDate?: string;             // YYYY-MM-DD exclusive end for all-day (defaults to date+1)
  attendees?: string[];
  addHomeAttendee?: boolean;
  /** Exact upstream record, e.g. `email:169727`, for later reconciliation. */
  sourceRef?: string;
  location?: string;
}): Promise<{ eventId: string | null; htmlLink: string | null }> {
  const cal = getCalendarClient();

  const attendeeSet = new Set<string>((opts.attendees ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean));
  if (opts.addHomeAttendee && HOME_AUTO_ATTENDEE) {
    attendeeSet.add(HOME_AUTO_ATTENDEE.toLowerCase());
  }
  const attendeeList = Array.from(attendeeSet);

  let start: calendar_v3.Schema$EventDateTime;
  let end: calendar_v3.Schema$EventDateTime;
  if (opts.allDay) {
    // All-day events use { date }; Google treats `end.date` as exclusive.
    const endDate = opts.endDate || nextDay(opts.date);
    start = { date: opts.date };
    end = { date: endDate };
  } else {
    const startTime = opts.startTime || '09:00';
    const endTime = opts.endTime || addOneHour(startTime);
    start = { dateTime: `${opts.date}T${startTime}:00`, timeZone: getTimezone() };
    end = { dateTime: `${opts.date}T${endTime}:00`, timeZone: getTimezone() };
  }

  const res = await cal.events.insert({
    calendarId: 'primary',
    sendUpdates: attendeeList.length > 0 ? 'all' : 'none',
    requestBody: {
      summary: opts.title,
      description: opts.description || undefined,
      location: opts.location || undefined,
      start,
      end,
      attendees: attendeeList.length > 0 ? attendeeList.map((email) => ({ email })) : undefined,
      extendedProperties: opts.sourceRef
        ? { private: { assistant_source_ref: opts.sourceRef } }
        : undefined,
    },
  });

  return { eventId: res.data.id ?? null, htmlLink: res.data.htmlLink ?? null };
}

// YYYY-MM-DD + 1 day, in UTC-safe arithmetic (date-only, no TZ shift).
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// HH:MM + 1 hour, clamped to 23:59 so an event near midnight stays same-day.
function addOneHour(hhmm: string): string {
  const [h, m] = hhmm.split(':').map((n) => parseInt(n, 10));
  if (Number.isNaN(h) || Number.isNaN(m)) return '10:00';
  const nh = Math.min(h + 1, 23);
  const nm = h + 1 > 23 ? 59 : m;
  return `${String(nh).padStart(2, '0')}:${String(nm).padStart(2, '0')}`;
}

export const calendarTools: ToolDef[] = [
  {
    definition: {
      name: 'list_events',
      description: 'List upcoming Google Calendar events. Defaults to today. USE WHEN: user mentions a meeting, event, a person they\'re meeting with, "tomorrow", a day-of-week, "this afternoon", or asks "what\'s on my calendar/schedule". Check this BEFORE answering scheduling questions.',
      input_schema: {
        type: 'object' as const,
        properties: {
          date: { type: 'string', description: 'Date in YYYY-MM-DD format (default: today)' },
          days: { type: 'number', description: 'Number of days to look ahead (default: 1)' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const cal = getCalendarClient();
      const TZ = getTimezone();
      const date = (input.date as string) || new Date().toLocaleDateString('en-CA', { timeZone: TZ });
      const days = (input.days as number) || 1;

      // Build proper ISO timestamps — create Date in local context then convert
      const startDt = new Date(date + 'T00:00:00');
      const endDt = new Date(startDt.getTime() + days * 86400000);
      const timeMin = startDt.toISOString();
      const timeMax = endDt.toISOString();

      const res = await cal.events.list({
        calendarId: 'primary',
        timeMin,
        timeMax,
        timeZone: TZ,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20,
      });

      const events = res.data.items || [];
      if (events.length === 0) return 'No events found.';

      return events
        .map((e) => {
          const start = e.start?.dateTime || e.start?.date || '';
          const end = e.end?.dateTime || e.end?.date || '';
          const dt = new Date(start);
          const dayLabel = dt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: TZ });
          const time = start.includes('T')
            ? new Date(start).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ })
            : 'All day';
          const endTime = end.includes('T')
            ? new Date(end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: TZ })
            : '';
          const timeRange = endTime ? `${time}–${endTime}` : time;
          const location = e.location ? ` 📍 ${e.location}` : '';
          const externalAttendees = (e.attendees || []).filter((a) => !a.self && a.email);
          const attendees = externalAttendees.map((a) => a.displayName || a.email).join(', ');
          const attendeeStr = attendees ? ` [with ${attendees}]` : '';
          const evtId = e.id ? `[evt:${e.id}] ` : '';

          // Side effect: populate the people graph. Idempotent via email + (channel, ref) dedup.
          try {
            for (const a of externalAttendees) {
              if (!a.email) continue;
              const personId = upsertPerson({
                emails: [a.email],
                name: a.displayName || a.email,
              });
              addInteraction({
                person_id: personId,
                channel: 'calendar',
                ref: e.id || undefined,
                occurred_at: start || undefined,
                summary: e.summary || undefined,
              });
            }
          } catch { /* never let people-graph writes break calendar reads */ }

          return `${evtId}${dayLabel} ${timeRange} — ${e.summary || '(no title)'}${location}${attendeeStr}`;
        })
        .join('\n');
    },
  },
  {
    definition: {
      name: 'create_event',
      description: 'Create a Google Calendar event. USE WHEN: user says "schedule X for Tuesday", "book time for X", "put X on the calendar", or accepts a time you proposed. Also use to time-block tasks (set the calendar_event_id back on the task via link_task_to_event). When called from the Home group, the configured HOME_AUTO_ATTENDEE (if set) is auto-attached and an invite is sent.',
      input_schema: {
        type: 'object' as const,
        properties: {
          title: { type: 'string', description: 'Event title' },
          date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
          start_time: { type: 'string', description: 'Start time in HH:MM 24h format' },
          end_time: { type: 'string', description: 'End time in HH:MM 24h format' },
          description: { type: 'string', description: 'Event description (optional)' },
          attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to invite (optional). Sends calendar invites to anyone listed.' },
          source_message_id: { type: 'string', description: 'Email message ID (from the email tools) when this event carries an email obligation. Pass the exact ID for later reconciliation.' },
        },
        required: ['title', 'date', 'start_time', 'end_time'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      const { title, date, start_time, end_time, description, attendees, source_message_id } = input as {
        title: string; date: string; start_time: string; end_time: string;
        description?: string; attendees?: string[]; source_message_id?: string;
      };
      if (source_message_id && !isValidEmailMessageId(source_message_id)) {
        throw new Error(`Invalid email source_message_id: ${source_message_id}`);
      }

      const { eventId } = await createCalendarEventRaw({
        title,
        date,
        startTime: start_time,
        endTime: end_time,
        description,
        attendees,
        addHomeAttendee: context?.groupKey === 'home',
        sourceRef: source_message_id ? `email:${source_message_id}` : undefined,
      });
      if (source_message_id && eventId) linkEmailOpenLoopCalendarByMessageId(source_message_id, eventId);

      const homeAttendee = context?.groupKey === 'home' && HOME_AUTO_ATTENDEE ? [HOME_AUTO_ATTENDEE] : [];
      const allInvited = Array.from(new Set([...(attendees ?? []), ...homeAttendee].map((e) => e.trim().toLowerCase()).filter(Boolean)));
      const inviteNote = allInvited.length > 0 ? ` (invites sent to ${allInvited.join(', ')})` : '';
      return `Created event: "${title}" on ${date} ${start_time}–${end_time}${inviteNote} [event_id:${eventId}]`;
    },
  },
  {
    definition: {
      name: 'delete_event',
      description: 'Delete a Google Calendar event by its event ID.',
      input_schema: {
        type: 'object' as const,
        properties: {
          event_id: { type: 'string', description: 'Google Calendar event ID (from list_events or create_event output)' },
        },
        required: ['event_id'],
      },
    },
    handler: async (input) => {
      const cal = getCalendarClient();
      const eventId = input.event_id as string;
      await cal.events.delete({ calendarId: 'primary', eventId });
      return `Deleted event ${eventId}`;
    },
  },
  {
    definition: {
      name: 'update_event',
      description: 'Update an existing Google Calendar event (time, title, or description).',
      input_schema: {
        type: 'object' as const,
        properties: {
          event_id: { type: 'string', description: 'Google Calendar event ID' },
          title: { type: 'string', description: 'New title (optional)' },
          date: { type: 'string', description: 'New date YYYY-MM-DD (optional)' },
          start_time: { type: 'string', description: 'New start time HH:MM 24h (optional)' },
          end_time: { type: 'string', description: 'New end time HH:MM 24h (optional)' },
          description: { type: 'string', description: 'New description (optional)' },
        },
        required: ['event_id'],
      },
    },
    handler: async (input) => {
      const cal = getCalendarClient();
      const { event_id, title, date, start_time, end_time, description } = input as Record<string, string>;

      const body: Record<string, unknown> = {};
      if (title) body.summary = title;
      if (description) body.description = description;
      if (date && start_time) body.start = { dateTime: `${date}T${start_time}:00`, timeZone: getTimezone() };
      if (date && end_time) body.end = { dateTime: `${date}T${end_time}:00`, timeZone: getTimezone() };

      await cal.events.patch({ calendarId: 'primary', eventId: event_id, requestBody: body });
      return `Updated event ${event_id}`;
    },
  },
];
