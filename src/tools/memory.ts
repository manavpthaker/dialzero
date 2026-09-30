import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { setMemory, getMemory, createTask, saveFact, searchFacts, factsAbout, completeFact, extendFactValidity, getRecentHygieneActions, revertHygieneRun, factsForSubject, deleteFacts, type Fact } from '../db.js';
import type { ToolDef, ToolContext } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');

/**
 * Memory tools — inspired by OpenClaw's memory system.
 *
 * These give assistant persistent memory across conversations,
 * cross-group context reading (the "brain transplant" concept),
 * and the ability to assign tasks back to humans.
 */

function formatFact(f: Fact): string {
  const base = `  - ${f.subject} ${f.predicate} ${f.object}`;
  const tags: string[] = [];
  if (f.fact_type !== 'fact') tags.push(f.fact_type);
  if (f.source !== 'manual') tags.push(f.source);
  return tags.length > 0 ? `${base} [${tags.join(', ')}]` : base;
}

function mergeFacts(...lists: Fact[][]): Fact[] {
  const seen = new Set<number>();
  const merged: Fact[] = [];
  for (const list of lists) {
    for (const f of list) {
      if (!seen.has(f.id)) { seen.add(f.id); merged.push(f); }
    }
  }
  return merged;
}

export const memoryTools: ToolDef[] = [
  // --- Persistent Memory ---
  {
    definition: {
      name: 'remember',
      description: 'Save an important fact, preference, or decision to persistent memory. USE WHEN: user states a preference, makes a decision, mentions a recurring person/place/time, shares a fact you\'d otherwise have to ask about again, or names someone new (save their context under a key like "<name>"). Save proactively without asking permission.',
      input_schema: {
        type: 'object' as const,
        properties: {
          key: { type: 'string', description: 'A short, descriptive key (e.g., "owner_coffee_preference", "partner_school_pickup_time", "project_pricing_decision")' },
          value: { type: 'string', description: 'The information to remember' },
        },
        required: ['key', 'value'],
      },
    },
    handler: async (input, context) => {
      const { key, value } = input as { key: string; value: string };
      const groupKey = context?.groupKey || 'system';
      setMemory(groupKey, key, value);
      return `Remembered: ${key} = ${value}`;
    },
  },
  {
    definition: {
      name: 'recall',
      description: 'Retrieve a previously saved memory by key. USE WHEN: user mentions a person/place/event by name — check if you have prior context BEFORE asking them to explain. Try the bare name as the key first (e.g., recall("aniket")). Falls back to a fact search if the exact key misses.',
      input_schema: {
        type: 'object' as const,
        properties: {
          key: { type: 'string', description: 'The memory key to look up' },
          group: { type: 'string', description: 'Which group\'s memory to check (default: current group). Use "system" for cross-group memories.' },
        },
        required: ['key'],
      },
    },
    handler: async (input, context) => {
      const { key, group } = input as { key: string; group?: string };
      const groupKey = group || context?.groupKey || 'system';
      const value = getMemory(groupKey, key);
      if (value) return value;

      // FTS fallback: a recall("priya") that misses on the legacy memory table
      // should still find any facts where Priya appears as subject/predicate/object.
      const aboutHits = factsAbout(key, 6);
      const searchHits = searchFacts(key, 6);
      const merged = mergeFacts(aboutHits, searchHits);
      if (merged.length > 0) {
        return [
          `No memory found for key "${key}" in group "${groupKey}".`,
          `Related facts (${merged.length}):`,
          ...merged.map(formatFact),
        ].join('\n');
      }
      return `No memory found for key "${key}" in group "${groupKey}".`;
    },
  },

  // --- Structured Facts ---
  {
    definition: {
      name: 'save_fact',
      description: 'Save a structured atomic fact. PREFER over `remember` whenever the thing you\'re saving has a subject — a person, project, company, deadline, or recurring entity. Examples: save_fact({subject:"aniket", predicate:"works_at", object:"Acme", fact_type:"fact"}); save_fact({subject:"owner", predicate:"prefers", object:"oat milk lattes", fact_type:"preference"}). Facts with fact_type preference|decision|metric supersede prior rows on (subject, predicate); fact|commitment|feedback append.',
      input_schema: {
        type: 'object' as const,
        properties: {
          subject: { type: 'string', description: 'Who or what this fact is about (e.g., "owner", a project name, a company-role like "acme-principal-pm"). Normalized to lowercase on save.' },
          predicate: { type: 'string', description: 'The relation (e.g., "prefers", "deadline", "reports_to", "lives_in"). Normalized to lowercase on save.' },
          object: { type: 'string', description: 'The value — free text. Preserved as written.' },
          fact_type: { type: 'string', description: 'Type of fact. Defaults to "fact".', enum: ['fact', 'preference', 'decision', 'commitment', 'feedback', 'metric'] },
          source: { type: 'string', description: 'Where this fact came from. Defaults to "manual".', enum: ['manual', 'email', 'calendar', 'jd', 'finance', 'reflection', 'voice', 'clip'] },
          source_ref: { type: 'string', description: 'Optional pointer to the source (email id, event id, file path).' },
          valid_until: { type: 'string', description: 'Optional ISO timestamp after which this fact should auto-expire (e.g., a deadline, a weekly metric).' },
          mode: { type: 'string', description: 'Override the default per-type behavior.', enum: ['append', 'supersede'] },
        },
        required: ['subject', 'predicate', 'object'],
      },
    },
    handler: async (input, context) => {
      const f = input as {
        subject: string; predicate: string; object: string;
        fact_type?: string; source?: string; source_ref?: string;
        valid_until?: string; mode?: 'append' | 'supersede';
      };
      const groupKey = context?.groupKey || 'system';
      const id = saveFact({ ...f, group_id: groupKey });
      const ft = f.fact_type || 'fact';
      return `Saved fact #${id} [${ft}]: ${f.subject} ${f.predicate} ${f.object}`;
    },
  },
  {
    definition: {
      name: 'search_facts',
      description: 'Full-text search across the facts knowledge store. Returns facts whose subject/predicate/object match terms in the query. Already filters to active, unexpired facts. USE WHEN: you want to find what you know related to a topic, not just by exact key.',
      input_schema: {
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: 'A phrase or set of keywords. Will be tokenized — punctuation and common words are stripped automatically.' },
          limit: { type: 'number', description: 'Max facts to return (default 8).' },
        },
        required: ['query'],
      },
    },
    handler: async (input) => {
      const { query, limit } = input as { query: string; limit?: number };
      const hits = searchFacts(query, limit ?? 8);
      if (hits.length === 0) return `No facts matched "${query}".`;
      return [`Found ${hits.length} fact(s) for "${query}":`, ...hits.map(formatFact)].join('\n');
    },
  },
  {
    definition: {
      name: 'facts_about',
      description: 'List facts where a specific subject is the focus. USE WHEN: user mentions someone or something by name and you want their full profile — preferences, commitments, and relationships you\'ve saved.',
      input_schema: {
        type: 'object' as const,
        properties: {
          subject: { type: 'string', description: 'The subject to look up (e.g., a person or project name). Case-insensitive.' },
          limit: { type: 'number', description: 'Max facts to return (default 12).' },
        },
        required: ['subject'],
      },
    },
    handler: async (input) => {
      const { subject, limit } = input as { subject: string; limit?: number };
      const hits = factsAbout(subject, limit ?? 12);
      if (hits.length === 0) return `No facts on file for "${subject}".`;
      return [`Facts about "${subject}" (${hits.length}):`, ...hits.map(formatFact)].join('\n');
    },
  },

  {
    definition: {
      name: 'forget',
      description: 'Permanently delete things you remember, when the owner asks ("forget that", "delete what you know about Sam", "forget my old address"). Pass fact_ids for specific facts (find them with search_facts / facts_about / recall_memory first), or subject to delete every fact about that subject. First call with confirm=false to see exactly what would be deleted; if it matches what the owner asked, call again with confirm=true. Tell the owner what you deleted in one line. This cannot be undone.',
      input_schema: {
        type: 'object' as const,
        properties: {
          fact_ids: { type: 'array', items: { type: 'number' }, description: 'Specific fact ids to delete.' },
          subject: { type: 'string', description: 'Delete every fact whose subject is exactly this (e.g. "sam", "home address").' },
          confirm: { type: 'boolean', description: 'false = preview only (default); true = delete.' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const { fact_ids, subject, confirm } = input as { fact_ids?: number[]; subject?: string; confirm?: boolean };
      const rows = subject?.trim() ? factsForSubject(subject) : [];
      const ids = [...new Set([...(fact_ids ?? []).map(Number).filter((n) => n > 0), ...rows.map((r) => r.id)])];
      if (ids.length === 0) return subject ? `No facts with subject "${subject}". Try search_facts to find the right ones.` : 'Pass fact_ids or subject.';
      if (!confirm) {
        const preview = rows.length
          ? rows.slice(0, 20).map((r) => `#${r.id} ${r.subject} ${r.predicate}: ${r.object}`).join('\n')
          : ids.map((id) => `#${id}`).join(', ');
        return `Would delete ${ids.length} fact(s):\n${preview}\nCall forget again with confirm=true to delete them.`;
      }
      const n = deleteFacts(ids);
      return `Deleted ${n} fact(s). They're gone from memory.`;
    },
  },

  // --- Brain Pulse: closing the loop on commitment facts ---
  {
    definition: {
      name: 'complete_fact',
      description: 'Close a commitment-type fact (sets completed_at, active=0). USE WHEN: the user replies "done #fact:N" to a brain-pulse DM, or you confirm a commitment was fulfilled. Distinct from supersession — completion leaves superseded_at NULL so dashboards can tell "done" from "replaced."',
      input_schema: {
        type: 'object' as const,
        properties: {
          fact_id: { type: 'number', description: 'The fact id (the N in #fact:N).' },
          note: { type: 'string', description: 'Optional short note appended to source_ref (e.g. "shipped 2026-05-31").' },
        },
        required: ['fact_id'],
      },
    },
    handler: async (input) => {
      const { fact_id, note } = input as { fact_id: number; note?: string };
      completeFact(fact_id, note);
      return `Marked fact #${fact_id} completed.`;
    },
  },
  {
    definition: {
      name: 'extend_fact_validity',
      description: 'Push a fact\'s valid_until out by N days. USE WHEN: the user replies "extend #fact:N 30d" to a brain-pulse DM, signaling the commitment/expiry is still live but the existing horizon was too tight. If valid_until is NULL, the new value is anchored to now+N days.',
      input_schema: {
        type: 'object' as const,
        properties: {
          fact_id: { type: 'number', description: 'The fact id.' },
          days: { type: 'number', description: 'Days to extend (positive integer).' },
        },
        required: ['fact_id', 'days'],
      },
    },
    handler: async (input) => {
      const { fact_id, days } = input as { fact_id: number; days: number };
      extendFactValidity(fact_id, days);
      return `Extended fact #${fact_id} validity by ${days} day(s).`;
    },
  },
  {
    definition: {
      name: 'recent_hygiene',
      description: 'List recent hygiene_log actions — what the weekly hygiene cron deduped/expired/demoted/flagged. USE WHEN: the user asks "what did hygiene do last week" or "why is this fact inactive". Each row carries a run_id the user can revert.',
      input_schema: {
        type: 'object' as const,
        properties: {
          limit: { type: 'number', description: 'Max rows to return (default 20, oldest run trimmed first).' },
        },
        required: [],
      },
    },
    handler: async (input) => {
      const { limit } = input as { limit?: number };
      const rows = getRecentHygieneActions(limit ?? 20);
      if (rows.length === 0) return 'No hygiene actions on file.';
      const lines = rows.map((r) => {
        const idTag = r.fact_id !== null ? `#${r.fact_id}` : '—';
        return `[${r.created_at.slice(0, 16)}] ${r.run_id} · ${r.action} ${idTag}: ${r.rationale ?? ''}`.trim();
      });
      return [`Recent hygiene actions (${rows.length}):`, ...lines].join('\n');
    },
  },
  {
    definition: {
      name: 'revert_hygiene',
      description: 'Reverse all mutations from a hygiene run by run_id. USE WHEN: the user replies "revert hygiene <run_id>" to a hygiene summary DM. Refuses runs older than 14 days. Runs in a single transaction.',
      input_schema: {
        type: 'object' as const,
        properties: {
          run_id: { type: 'string', description: 'The hygiene run identifier (looks like "hygiene_2026-06-01-07-30-00").' },
        },
        required: ['run_id'],
      },
    },
    handler: async (input) => {
      const { run_id } = input as { run_id: string };
      try {
        const result = revertHygieneRun(run_id);
        if (result.reverted === 0 && result.skipped === 0) return `No hygiene_log rows found for run_id "${run_id}".`;
        return `Reverted ${result.reverted} row(s), skipped ${result.skipped} (no snapshot or unparseable).`;
      } catch (err) {
        return `Revert failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },

  // --- Cross-Group Context Reading ---
  {
    definition: {
      name: 'read_group_context',
      description: 'Read another group\'s CLAUDE.md context file. Use this when you need to understand what another group knows or how it operates. This is the "brain transplant" — sharing context across agent groups without merging them.',
      input_schema: {
        type: 'object' as const,
        properties: {
          group: {
            type: 'string',
            description: 'The group whose context to read',
            enum: ['admin', 'work', 'personal', 'health'],
          },
        },
        required: ['group'],
      },
    },
    handler: async (input) => {
      const { group } = input as { group: string };
      const contextMap: Record<string, string> = {
        admin: 'context/admin/CLAUDE.md',
        work: 'context/work/CLAUDE.md',
        personal: 'context/personal/CLAUDE.md',
        health: 'context/health/CLAUDE.md',
      };

      const path = contextMap[group];
      if (!path) return `Unknown group: ${group}`;

      const fullPath = join(ROOT, path);
      if (!existsSync(fullPath)) return `No context file found for group "${group}".`;

      return readFileSync(fullPath, 'utf-8');
    },
  },

  // --- Agent-to-Human Task Assignment ---
  {
    definition: {
      name: 'assign_human_task',
      description: 'Assign a task to the user when you hit a real-world limitation — something requires a phone call, physical action, login you don\'t have, a signature, etc. This creates a tracked follow-up that the heartbeat system will remind about.',
      input_schema: {
        type: 'object' as const,
        properties: {
          assignee: { type: 'string', description: 'Who should do this: "owner" or "partner"', enum: ['owner', 'partner'] },
          task: { type: 'string', description: 'Clear description of what needs to be done' },
          due: { type: 'string', description: 'When this should be done by (ISO date string, e.g., "2026-03-31T17:00:00")' },
          priority: { type: 'string', description: 'Priority level', enum: ['low', 'medium', 'high'] },
        },
        required: ['assignee', 'task', 'due'],
      },
    },
    handler: async (input, context) => {
      const { assignee, task, due, priority } = input as {
        assignee: string;
        task: string;
        due: string;
        priority?: string;
      };
      const groupKey = context?.groupKey || 'admin';

      const id = createTask({
        title: task,
        group_id: groupKey,
        assignee,
        priority: priority || 'medium',
        due_date: due,
        source: 'agent',
      });

      import('../sync/tasks-sync.js')
        .then(async (m) => {
          const { getTaskById } = await import('../db.js');
          const t = getTaskById(id);
          if (t) await m.pushTaskToGoogle(t);
        })
        .catch((err) => console.error('[sync] push failed:', err));

      return `Task #${id} assigned to ${assignee}: "${task}" — due by ${new Date(due).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    },
  },

  // --- Memory Checkpoint ---
  {
    definition: {
      name: 'memory_checkpoint',
      description: 'Save a summary of the current conversation\'s key decisions and outcomes to memory. Use this at the end of important discussions to ensure nothing is lost if conversation history gets compacted.',
      input_schema: {
        type: 'object' as const,
        properties: {
          summary: { type: 'string', description: 'A concise summary of key decisions, outcomes, and action items from this conversation' },
        },
        required: ['summary'],
      },
    },
    handler: async (input, context) => {
      const { summary } = input as { summary: string };
      const groupKey = context?.groupKey || 'system';
      const timestamp = new Date().toISOString();

      // Store as timestamped checkpoint
      const key = `checkpoint_${timestamp.split('T')[0]}_${Date.now()}`;
      setMemory(groupKey, key, summary);

      // Also update a rolling "latest_context" key for quick access
      setMemory(groupKey, 'latest_context', `[${timestamp}] ${summary}`);

      return `Checkpoint saved for ${groupKey}: ${summary.slice(0, 100)}...`;
    },
  },
];
