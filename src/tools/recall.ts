import type { ToolDef } from './index.js';
import {
  searchFactsBroad, factsAbout, getFactsByType, getAllFacts,
  peopleSearch, getRecentInteractions,
  getOpenTasks, getOverdueTasksAll, getTaskStats,
  getRecentMemory, searchIMessages,
  type Fact, type Person, type Task, type Interaction, type IMessageLogRow, type MemoryEntry,
} from '../db.js';
import { getOwner } from '../config.js';

function dedupeFacts(facts: Fact[]): Fact[] {
  const seen = new Set<number>();
  const out: Fact[] = [];
  for (const f of facts) {
    if (seen.has(f.id)) continue;
    seen.add(f.id);
    out.push(f);
  }
  return out;
}

function factLine(f: Fact): string {
  const obj = (f.object || '').slice(0, 180);
  return `  · [${f.fact_type}] ${f.subject} — ${f.predicate}: ${obj}`;
}

function taskLine(t: Task): string {
  const due = t.due_date ? ` — due ${t.due_date.slice(0, 16).replace('T', ' ')}` : '';
  const overdue = t.due_date && t.due_date < new Date().toISOString() ? ' ⚠️overdue' : '';
  return `  · #${t.id} [${t.priority}] ${t.title}${due}${overdue}`;
}

function personBlock(p: Person): string {
  const head = [p.role, p.company].filter(Boolean).join(' at ');
  const rel = p.relationship ? ` [${p.relationship}]` : '';
  const last = p.last_contact ? `, last contact ${p.last_contact.slice(0, 10)}` : '';
  const lines = [`  · ${p.name}${head ? ` — ${head}` : ''}${rel}${last}`];
  const interactions: Interaction[] = getRecentInteractions(p.id, 2);
  for (const i of interactions) {
    const when = (i.occurred_at || i.created_at || '').slice(0, 10);
    lines.push(`      ↳ ${i.channel || 'note'}: ${(i.summary || '').slice(0, 120)}${when ? ` (${when})` : ''}`);
  }
  return lines.join('\n');
}

function messageLine(m: IMessageLogRow): string {
  const when = (m.ts || '').slice(0, 16).replace('T', ' ');
  const who = m.direction === 'out' ? getOwner().name : (m.chat_name || m.sender);
  return `  · ${when} ${who}: ${(m.text || '').slice(0, 160)}`;
}

// Subject mode — pull everything across stores about one subject.
function recallSubject(subject: string): string {
  const facts = dedupeFacts([...searchFactsBroad(subject, 12), ...factsAbout(subject, 12)]).slice(0, 12);
  const people = peopleSearch(subject, 5);
  const subjLower = subject.toLowerCase();
  const tasks = getOpenTasks().filter(
    (t) => t.title.toLowerCase().includes(subjLower) || (t.notes || '').toLowerCase().includes(subjLower)
  ).slice(0, 10);
  const messages = searchIMessages({ query: subject, limit: 5 });

  const sections: string[] = [];
  if (facts.length) sections.push(`FACTS (${facts.length}):\n${facts.map(factLine).join('\n')}`);
  if (people.length) sections.push(`PEOPLE (${people.length}):\n${people.map(personBlock).join('\n')}`);
  if (tasks.length) sections.push(`TASKS (${tasks.length}):\n${tasks.map(taskLine).join('\n')}`);
  if (messages.length) sections.push(`MESSAGES (${messages.length}):\n${messages.map(messageLine).join('\n')}`);

  if (sections.length === 0) {
    return `Nothing stored about "${subject}" — no facts, people, open tasks, or messages match. This is an exhaustive check, so it's safe to tell the user you genuinely have nothing on this.`;
  }
  return `Everything I have on "${subject}":\n\n${sections.join('\n\n')}`;
}

// Overview mode — a snapshot of what's being tracked, no query.
function recallOverview(): string {
  const stats = getTaskStats();
  const open = getOpenTasks().slice(0, 15);
  const overdue = getOverdueTasksAll();
  const commitments = getFactsByType(['commitment'], 8);
  const decisions = getFactsByType(['decision'], 8);
  const prefs = getFactsByType(['preference'], 8);
  const notes = getRecentMemory('admin', { limit: 8 });

  const sections: string[] = [];
  sections.push(`TASKS: ${stats.open} open (${stats.overdue} overdue), ${stats.done} done in last 7d`);
  if (open.length) sections.push(`Open tasks:\n${open.map(taskLine).join('\n')}`);
  if (overdue.length) sections.push(`Overdue:\n${overdue.slice(0, 10).map(taskLine).join('\n')}`);
  if (commitments.length) sections.push(`COMMITMENTS (${commitments.length}):\n${commitments.map(factLine).join('\n')}`);
  if (decisions.length) sections.push(`DECISIONS (${decisions.length}):\n${decisions.map(factLine).join('\n')}`);
  if (prefs.length) sections.push(`PREFERENCES (${prefs.length}):\n${prefs.map(factLine).join('\n')}`);
  if (notes.length) {
    const noteLines = notes
      .map((n: MemoryEntry) => `  · ${n.key}: ${(n.value || '').slice(0, 140)} (${(n.updated_at || '').slice(0, 10)})`)
      .join('\n');
    sections.push(`RECENT NOTES (${notes.length}):\n${noteLines}`);
  }
  const totalFacts = getAllFacts({ limit: 1000 }).length;
  sections.push(`(${totalFacts} active facts total — ask me about a specific subject to pull them.)`);

  return `Here's a snapshot of what I'm actively tracking:\n\n${sections.join('\n\n')}`;
}

export const recallTools: ToolDef[] = [
  {
    definition: {
      name: 'recall_memory',
      description:
        'Exhaustively pull everything stored about a subject (facts, people + interactions, open tasks, and messages) in ONE call. ' +
        'USE WHEN: the user asks "what do you have on X", "what did I tell you about Y", "do you remember Z", "what are you tracking", "what reminders/notes do you have" — ' +
        'OR before you would ever tell them you don\'t have a note/fact/reminder/person on something. This bypasses the limited context budget, so it sees data the prompt blocks may have dropped. ' +
        'Pass `subject` to focus on one thing, or omit it for a snapshot of everything being tracked. Never claim you have nothing without calling this first.',
      input_schema: {
        type: 'object' as const,
        properties: {
          subject: {
            type: 'string',
            description: 'The thing to recall — a person, project, topic, or keyword (e.g. "garage code", a contact name, a project name). Omit for an overview of everything tracked.',
          },
        },
      },
    },
    handler: async (input) => {
      const { subject } = input as { subject?: string };
      const s = subject?.trim();
      return s ? recallSubject(s) : recallOverview();
    },
  },
];
