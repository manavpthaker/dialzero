// One task per thing: the same to-do heard in several recordings (or asked for again)
// used to land on the list several times. Before a task is created, an open one that
// says the same thing is found and reused.

import { getOpenTasks, type Task } from '../db.js';

const STOP = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'her', 'his', 'him', 'she', 'our', 'your', 'their', 'them', 'they', 'about', 'before', 'after', 'into', 'onto', 'item', 'thing', 'stuff', 'make', 'sure', 'get', 'go', 'do']);

export function taskWords(title: string): Set<string> {
  return new Set(title.toLowerCase().replace(/[’']s\b/g, '').split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.replace(/(ing|es|s)$/, '')));
}

// Words every errand has: two tasks sharing only these ("pay … bill") aren't the same task.
const WEAK = new Set(['pay', 'bill', 'call', 'buy', 'send', 'email', 'book', 'return', 'pick', 'drop', 'check', 'review', 'reply', 'schedule', 'order', 'fix', 'payment', 'find', 'take', 'put', 'clean', 'today', 'tomorrow', 'week']);

/** An open task that says the same thing: most of the shorter title's words are in the other, including a specific one. */
export function similarOpenTask(title: string, open: Task[] = getOpenTasks()): Task | null {
  const a = taskWords(title);
  if (a.size === 0) return null;
  let best: { t: Task; score: number } | null = null;
  for (const t of open) {
    const b = taskWords(t.title);
    if (!b.size) continue;
    const sharedWords = [...a].filter((w) => b.has(w));
    const shared = sharedWords.length;
    const score = shared / Math.min(a.size, b.size);
    if (!sharedWords.some((w) => !WEAK.has(w))) continue;
    if (shared >= 2 && score >= 0.6 && (!best || score > best.score)) best = { t, score };
  }
  return best?.t ?? null;
}
