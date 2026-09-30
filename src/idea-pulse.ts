import { scheduleCron } from './lib/cron.js';
import { IDEA_PULSE_GROUP } from './group-resolver.js';
import { runProactivePulse } from './lib/pulse.js';
import { parseBoolEnv } from './lib/env.js';
import {
  getOpenTasks,
  getDormantLeads,
  getFactsByType,
  getMemory,
  setMemory,
  type Fact,
  type Person,
  type Task,
} from './db.js';

interface IdeaPulseCtx {
  sections: string[];
  recentIdeas: string;
}

// Idea Pulse: once-daily (15:00) proactive ping where the assistant offers
// help and pitches ideas — grounded in the user's actual state, with room to be
// creative. Sibling to brain-pulse.ts, kept as its own module so the answer to
// "where do scheduled things live" stays scannable.
//
// Difference from brain-pulse: brain-pulse surfaces aging rows verbatim and asks
// for a status reply. Idea-pulse hands the agent a snapshot of current state and
// asks it to GENERATE 2-4 specific, in-voice offers/ideas inviting a reply.

// Proactive idea pitches are opt-in; the quiet baseline should not initiate DM traffic.
const ENABLED = parseBoolEnv('IDEA_PULSE_ENABLED', false);
const DEDUP_GROUP = 'idea-pulse';
const DEDUP_KEY = 'recent_ideas';
const CLEAR_SENTINEL = 'IDEA_CLEAR';

function formatTaskLine(t: Task): string {
  const due = t.due_date ? ` (due ${t.due_date.slice(0, 10)})` : '';
  const where = t.group_id ? ` [${t.group_id}]` : '';
  return `- ${t.title}${due}${where}`;
}

function formatFactLine(f: Fact): string {
  return `- ${f.subject} ${f.predicate} ${f.object}`;
}

function formatLeadLine(p: Person): string {
  const last = p.last_contact ? p.last_contact.slice(0, 10) : 'never';
  return `- ${p.name} @ ${p.company ?? '?'} (last contact ${last})`;
}

export async function runIdeaPulse(): Promise<void> {
  await runProactivePulse<IdeaPulseCtx>({
    name: 'IdeaPulse',
    enabled: ENABLED,
    group: IDEA_PULSE_GROUP,
    clearSentinel: CLEAR_SENTINEL,
    gather: () => {
      const tasks = getOpenTasks().slice(0, 12);
      const leads = getDormantLeads();
      const recentFacts = getFactsByType(['decision', 'commitment', 'preference'], 10);
      // Nothing to ground ideas in → skip rather than emit filler.
      if (tasks.length + leads.length + recentFacts.length === 0) return null;

      const sections: string[] = [];
      if (tasks.length > 0) sections.push(`Open tasks:\n${tasks.map(formatTaskLine).join('\n')}`);
      if (leads.length > 0) sections.push(`Dormant leads (60d+ silent):\n${leads.map(formatLeadLine).join('\n')}`);
      if (recentFacts.length > 0) sections.push(`Recent decisions / commitments / preferences:\n${recentFacts.map(formatFactLine).join('\n')}`);

      return { sections, recentIdeas: getMemory(DEDUP_GROUP, DEDUP_KEY) ?? '' };
    },
    buildPrompt: ({ sections, recentIdeas }) => `Idea pulse — a proactive ping. You're reaching out to the user unprompted to offer help and pitch ideas.

Below is a snapshot of their current state. Use it to compose a SHORT DM (2-4 lines). Mix:
- grounded offers tied to what's actually here ("3 JD analyses untouched since Tue — want me to draft the Acme outreach?")
- at least one creative idea you came up with (an angle to try, a thing worth building, a person to reconnect with)
Each line should invite a reply. End with a question or a clear "want me to?" so the user can volley back.
Check the calendar if it sharpens an idea. Don't pad — if only one thing is worth saying, say one thing.

${sections.join('\n\n')}

${recentIdeas ? `You recently pitched these — do NOT repeat them:\n${recentIdeas}\n` : ''}
If genuinely nothing here is worth interrupting the user for, reply exactly '${CLEAR_SENTINEL}' and nothing else.`,
    // Remember what we just pitched so the next pulse doesn't repeat it. Rolling
    // ~1500-char tail to bound the prompt. Only on a successful send.
    onSent: ({ recentIdeas }, response) => {
      const merged = `${recentIdeas}\n${response}`.trim();
      setMemory(DEDUP_GROUP, DEDUP_KEY, merged.slice(-1500));
    },
  });
}

export function startIdeaPulse(): void {
  if (!ENABLED) {
    console.log('[IdeaPulse] Disabled via IDEA_PULSE_ENABLED=false');
    return;
  }
  scheduleCron(
    '0 15 * * *',
    () => {
      console.log('[IdeaPulse] Tick');
      runIdeaPulse().catch((err) => console.error('[IdeaPulse] Tick failed:', err));
    },
  );
  console.log('[IdeaPulse] Registered cron: 15:00');
}
