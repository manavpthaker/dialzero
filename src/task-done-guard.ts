// The owner texts "laundry attic done" and the assistant answers "Laundry and attic are
// done" without calling complete_task, so both stayed open and the next check-in listed
// them again. After a reply to the owner's own message, if they said something is
// finished and no task tool ran, a cheap model matches their words to open tasks and
// closes them.

import { getOpenTasks, type Task } from './db.js';
import { OPENAI_ROUTER_MODEL, openAIText } from './lib/openai.js';
import { withLlmContext } from './lib/llm-context.js';
import { markTaskDone } from './tools/tasks.js';

const DONE_WORDS = /\b(done|did|finished|finish(ed)?|complete(d)?|handled|took care|taken care|knocked out|wrapped up|all set|sent|packed|paid|cleaned|put away)\b/i;
const TASK_TOOLS = new Set(['complete_task', 'cancel_task', 'update_task']);
const DAY = 24 * 3600 * 1000;

/** Open tasks the owner could plausibly mean today: due in the last 2 weeks or next 3 days, or new this week. */
export function candidateTasks(all: Task[], now = Date.now()): Task[] {
  return all.filter((t) => {
    if (t.assignee && t.assignee !== 'owner') return false;
    const due = t.due_date ? Date.parse(t.due_date) : NaN;
    if (Number.isFinite(due)) return due >= now - 14 * DAY && due <= now + 3 * DAY;
    const created = Date.parse(`${t.created_at.replace(' ', 'T')}Z`);
    return Number.isFinite(created) && created >= now - 7 * DAY;
  }).slice(0, 60);
}

/** Task ids from the model's answer that are really in the list. */
export function parseDoneIds(raw: string, allowed: Set<number>): number[] {
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const ids = (JSON.parse(m[0]) as { done?: unknown }).done;
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.map(Number).filter((n) => allowed.has(n)))];
  } catch {
    return [];
  }
}

/** Which of these tasks the owner's message says are finished (model call; changes nothing). */
export async function pickTasksOwnerSaidAreDone(text: string, reply: string, tasks: Task[]): Promise<number[]> {
  const list = tasks.map((t) => `#${t.id}: ${t.title}`).join('\n');
  const raw = await withLlmContext({ caller: 'done-guard', lane: 'batch', groupKey: 'admin' }, () => openAIText({
    model: OPENAI_ROUTER_MODEL,
    system: 'You match what a person says they finished to their open tasks. Include a task only if their message clearly says that task is now finished (typos are fine: "glaundry" is laundry). Questions, plans, "about to", "should I", "almost", or "done with part of it" do not count. Reply with JSON only: {"done": [ids]}.',
    prompt: `Their message: "${text}"\nAssistant's reply: "${reply.slice(0, 400)}"\n\nOpen tasks:\n${list}`,
    maxOutputTokens: 200,
    reasoningEffort: 'low',
  }));
  return parseDoneIds(raw, new Set(tasks.map((t) => t.id)));
}

export async function closeTasksOwnerSaidAreDone(message: string, reply: string, toolsCalled: Set<string>): Promise<number[]> {
  const text = message.trim();
  if (!text || text.length > 600 || !DONE_WORDS.test(text)) return [];
  if ([...toolsCalled].some((t) => TASK_TOOLS.has(t))) return [];
  const tasks = candidateTasks(getOpenTasks());
  if (!tasks.length) return [];
  const ids = await pickTasksOwnerSaidAreDone(text, reply, tasks);
  for (const id of ids) markTaskDone(id, 'The owner said it was done (closed from their text).');
  if (ids.length) console.log(`[done-guard] closed ${ids.map((i) => `#${i}`).join(', ')} from "${text.slice(0, 80)}"`);
  return ids;
}
