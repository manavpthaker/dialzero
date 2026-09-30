import type { ToolDef } from './index.js';
import {
  upsertPerson,
  findPersonByEmail,
  peopleSearch,
  getPersonById,
  getRecentInteractions,
  addInteraction,
  markPersonSurfaced,
  getStaleContacts,
  getDormantLeads,
  type Person,
  type Interaction,
} from '../db.js';

function profileLine(p: Person): string {
  const head = `**${p.name}**`;
  const work = [p.role, p.company].filter(Boolean).join(' at ');
  const tags: string[] = [];
  if (work) tags.push(work);
  if (p.relationship) tags.push(p.relationship);
  if (p.linkedin_url) tags.push(p.linkedin_url);
  if (p.last_contact) tags.push(`last contact ${p.last_contact.slice(0, 10)}`);
  return tags.length > 0 ? `${head} — ${tags.join(' · ')}` : head;
}

function interactionLine(i: Interaction): string {
  const when = (i.occurred_at || i.created_at || '').slice(0, 10);
  const channel = i.channel ? `[${i.channel}]` : '';
  const summary = i.summary || '(no summary)';
  return `  · ${when} ${channel} ${summary}`.trim();
}

function resolvePerson(query: string): Person | undefined {
  const q = query.trim();
  if (!q) return undefined;
  if (q.includes('@')) {
    const exact = findPersonByEmail(q);
    if (exact) return exact;
  }
  const hits = peopleSearch(q, 1);
  return hits[0];
}

export const peopleTools: ToolDef[] = [
  {
    definition: {
      name: 'find_person',
      description: 'Look up a person by name, email, or company. Returns their profile plus the last 3 interactions. USE WHEN: user mentions someone by name and you want context — instead of asking them to re-explain who Priya is.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Name, email, or company name to search' },
          limit: { type: 'number', description: 'Max people to return (default 3)' },
        },
        required: ['query'],
      },
    },
    handler: async (input) => {
      const { query, limit } = input as { query: string; limit?: number };
      const q = query.trim();
      if (!q) return 'Need a name, email, or company to search.';

      let people: Person[] = [];
      if (q.includes('@')) {
        const exact = findPersonByEmail(q);
        if (exact) people = [exact];
      }
      if (people.length === 0) people = peopleSearch(q, limit ?? 3);
      if (people.length === 0) return `No people on file matching "${q}".`;

      return people
        .map((p) => {
          const interactions = getRecentInteractions(p.id, 3);
          const block = interactions.length === 0
            ? '  (no interactions on file)'
            : interactions.map(interactionLine).join('\n');
          const notes = p.notes ? `\n  Notes: ${p.notes}` : '';
          return `${profileLine(p)}${notes}\n${block}`;
        })
        .join('\n\n');
    },
  },
  {
    definition: {
      name: 'note_about_person',
      description: 'Save or update a person record — their company, role, LinkedIn, relationship, or free-text notes. USE WHEN: user shares something durable about someone (job change, you owe them a follow-up, etc.). Identifies the person by email if given, otherwise creates/finds by name.',
      input_schema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Person\'s name (required if no email is provided)' },
          email: { type: 'string', description: 'Email address — used to identify or link the person' },
          company: { type: 'string', description: 'Where they work' },
          role: { type: 'string', description: 'Their role / title' },
          linkedin_url: { type: 'string', description: 'LinkedIn profile URL' },
          relationship: { type: 'string', description: 'How you know them', enum: ['recruiter', 'colleague', 'friend', 'family', 'investor', 'lead', 'other'] },
          notes: { type: 'string', description: 'Free-text notes. Overwrites prior notes.' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const f = input as {
        name?: string; email?: string; company?: string; role?: string;
        linkedin_url?: string; relationship?: string; notes?: string;
      };
      if (!f.name && !f.email) return 'Need at least a name or email to save a person.';

      const id = upsertPerson({
        name: f.name,
        emails: f.email ? [f.email] : [],
        company: f.company,
        role: f.role,
        linkedin_url: f.linkedin_url,
        relationship: f.relationship,
        notes: f.notes,
      });
      const p = getPersonById(id);
      return p ? `Saved person #${id}: ${profileLine(p)}` : `Saved person #${id}`;
    },
  },
  {
    definition: {
      name: 'recent_interactions',
      description: 'List recent interactions with a specific person (emails, calendar events, etc.), sorted newest first.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'Person\'s name or email' },
          limit: { type: 'number', description: 'Max interactions to return (default 5)' },
        },
        required: ['query'],
      },
    },
    handler: async (input) => {
      const { query, limit } = input as { query: string; limit?: number };
      const person = resolvePerson(query);
      if (!person) return `No person on file matching "${query}".`;
      const interactions = getRecentInteractions(person.id, limit ?? 5);
      if (interactions.length === 0) return `${person.name}: no interactions on file.`;
      return [`Recent interactions with ${person.name}:`, ...interactions.map(interactionLine)].join('\n');
    },
  },
  {
    definition: {
      name: 'log_interaction',
      description: 'Record an interaction with a known person — bumps their last_contact and appends to the interactions log. USE WHEN: the user replies "reached out #person:N" or "messaged #person:N" to a brain-pulse DM, or you confirm a back-and-forth happened. The person_id comes from #person:N namespacing or from a prior find_person lookup.',
      input_schema: {
        type: 'object' as const,
        properties: {
          person_id: { type: 'number', description: 'Canonical person id (the N in #person:N).' },
          summary: { type: 'string', description: 'Short description of what happened (e.g. "sent intro email", "reached out on LinkedIn").' },
          channel: { type: 'string', description: 'Communication channel — e.g. "email", "linkedin", "imessage", "calendar". Optional.' },
        },
        required: ['person_id', 'summary'],
      },
    },
    handler: async (input) => {
      const { person_id, summary, channel } = input as { person_id: number; summary: string; channel?: string };
      const person = getPersonById(person_id);
      if (!person) return `No person on file with id ${person_id}.`;
      addInteraction({
        person_id,
        summary,
        channel: channel ?? 'manual',
        occurred_at: new Date().toISOString(),
      });
      // Also reset the brain-pulse dedup window so we don't immediately re-nag.
      markPersonSurfaced(person_id);
      return `Logged interaction with ${person.name} (#person:${person_id}).`;
    },
  },
  {
    definition: {
      name: 'who_to_reach_out_to',
      description: 'Surface people the user should reconnect with — contacts gone quiet (interacted before, now cold) plus dormant leads (prospects with no recent contact). USE WHEN: the user asks "who do I need to reach out to", "who have I been neglecting", "go through my contacts", or wants relationship maintenance suggestions. Returns names with how long since last contact so you can prioritize.',
      input_schema: {
        type: 'object' as const,
        properties: {
          days: { type: 'number', description: 'How many days of silence counts as "cold" for prior contacts (default 30).' },
          limit: { type: 'number', description: 'Max people to return (default 15).' },
        },
      },
    },
    handler: async (input) => {
      const { days, limit } = input as { days?: number; limit?: number };
      const cap = limit ?? 15;
      const stale = getStaleContacts(days ?? 30, cap);
      const leads = getDormantLeads(60, cap);
      // Merge, de-dup by id, keep leads that aren't already in the stale list.
      const seen = new Set(stale.map((p) => p.id));
      const dormantLeads = leads.filter((p) => !seen.has(p.id));
      if (stale.length === 0 && dormantLeads.length === 0) {
        return 'No one is overdue right now — your contacts are reasonably warm, or there isn\'t enough interaction history yet to tell.';
      }
      const out: string[] = [];
      if (stale.length > 0) {
        out.push('**Gone quiet (talked before, now cold):**');
        out.push(...stale.map((p) => `• ${profileLine(p)} (#person:${p.id})`));
      }
      if (dormantLeads.length > 0) {
        if (out.length) out.push('');
        out.push('**Dormant leads (prospects to warm up):**');
        out.push(...dormantLeads.map((p) => `• ${profileLine(p)} (#person:${p.id})`));
      }
      return out.join('\n');
    },
  },
];
