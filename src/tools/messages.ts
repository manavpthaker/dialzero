import type { ToolDef } from './index.js';
import { searchIMessages, findPersonByPhone, findPersonByEmail, type IMessageLogRow } from '../db.js';
import { getOwner, getTimezone } from '../config.js';

function nameFor(handle: string): string {
  try {
    const p = handle.includes('@') ? findPersonByEmail(handle) : findPersonByPhone(handle);
    if (p?.name) return p.name;
  } catch { /* fall back to the handle */ }
  return handle;
}

function messageLine(m: IMessageLogRow): string {
  const d = new Date(m.ts);
  const when = Number.isNaN(d.getTime()) ? m.ts : d.toLocaleString('en-US', {
    timeZone: getTimezone(), year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const who = m.direction === 'out' ? getOwner().name : nameFor(m.sender);
  const chat = m.chat_name && m.chat_name !== who ? ` (${m.chat_name})` : '';
  return `  · ${when}${chat} ${who}: ${(m.text || '').slice(0, 240)}`;
}

export const messagesTools: ToolDef[] = [
  {
    definition: {
      name: 'search_messages',
      description: 'Search the owner\'s iMessage history by keyword, person, or an exact configured chat ID. USE WHEN: the owner asks "what did X say", "find the message about Y", "what did Sam and I talk about on Aug 12", "search my texts", or you need context on a conversation. A person\'s name matches all their numbers and emails. With since+until it returns that window in order; otherwise newest first. Times are in the owner\'s timezone. Coverage includes backfilled history plus everything observed live; if a search is empty, the topic may simply not be in the log.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Free-text to match against message body, sender, and chat name (e.g. "dinner", "invoice").' },
          person: { type: 'string', description: 'Narrow to a specific sender/chat — a name, phone, or chat title. Optional.' },
          chat_id: { type: 'string', description: 'Optional exact iMessage chat identifier when a configured group needs isolated search.' },
          since: { type: 'string', description: 'First day to include, YYYY-MM-DD (owner\'s timezone). For "on Aug 12" set since and until to the same day.' },
          until: { type: 'string', description: 'Last day to include, YYYY-MM-DD (owner\'s timezone), inclusive.' },
          limit: { type: 'number', description: 'Max messages to return (default 20, max 200). Use 100+ for a whole day.' },
        },
      },
    },
    handler: async (input) => {
      const { query, person, chat_id: chatId, limit, since, until } = input as { query?: string; person?: string; chat_id?: string; limit?: number; since?: string; until?: string };
      if (!query?.trim() && !person?.trim() && !chatId?.trim() && !since) {
        return 'Give me something to search for — a keyword, a person/chat name, or a date.';
      }
      const rows = searchIMessages({ query, handle: person, chatId, limit, since, until });
      if (rows.length === 0) {
        return `No messages found${query ? ` matching "${query}"` : ''}${person ? ` with ${person}` : ''}${since ? ` from ${since}${until && until !== since ? ` to ${until}` : ''}` : ''}.`;
      }
      const header = `Found ${rows.length} message(s)${query ? ` matching "${query}"` : ''}${person ? ` with ${person}` : ''}${chatId ? ` in chat ${chatId}` : ''}:`;
      return [header, ...rows.map(messageLine)].join('\n');
    },
  },
];
