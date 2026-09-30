import { google, tasks_v1 } from 'googleapis';
import {
  getTasksWithGoogleMapping,
  getTasksNeedingPush,
  getTaskByGoogleId,
  getTaskById,
  setTaskGoogleMapping,
  stampTaskSynced,
  clearTaskGoogleMapping,
  updateTaskStatus,
  updateTaskFields,
  createTask,
  type Task,
} from '../db.js';

/**
 * Bidirectional sync between SQLite tasks and Google Tasks.
 *
 * - SQLite is source of truth.
 * - Google Tasks is a mirror, keyed by `[bb:N]` in notes + stored google_task_id.
 * - Mutations push immediately (fire-and-forget); reconcile runs every 30 min.
 * - Conflict rule: completed-anywhere → completed-everywhere; SQLite wins on title/due/notes.
 */

const BB_TAG_RE = /\[bb:(\d+)\]/;
const TAG = (id: number) => `[bb:${id}]`;

const GROCERY_KEYWORDS = [
  'grocery', 'groceries', 'food', 'milk', 'eggs', 'bread', 'chicken', 'rice',
  'vegetables', 'fruit', 'snack', 'cereal', 'butter', 'cheese', 'yogurt',
  'produce', 'meat', 'fish', 'pasta', 'sauce', 'oil', 'spice', 'flour',
  'sugar', 'coffee', 'tea', 'juice', 'water', 'soda', 'beer', 'wine',
  'chips', 'crackers', 'nuts', 'frozen', 'canned', 'deli', 'bakery',
  'tortilla', 'avocado', 'tomato', 'onion', 'garlic', 'pepper', 'salt',
  'banana', 'apple', 'orange', 'lemon', 'lime', 'berries', 'mango',
  'shrimp', 'salmon', 'tofu', 'beans', 'lentils', 'oats', 'granola',
];

export function isGroceryRelated(text: string): boolean {
  const lower = text.toLowerCase();
  return GROCERY_KEYWORDS.some((kw) => lower.includes(kw));
}

let cachedClient: tasks_v1.Tasks | null = null;
function getClient(): tasks_v1.Tasks {
  if (cachedClient) return cachedClient;
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CALENDAR_CLIENT_ID,
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN });
  cachedClient = google.tasks({ version: 'v1', auth });
  return cachedClient;
}

let groceryListIdCache: string | null = null;
async function getGroceryListId(): Promise<string> {
  if (groceryListIdCache) return groceryListIdCache;
  const client = getClient();
  const res = await client.tasklists.list({ maxResults: 100 });
  const existing = (res.data.items || []).find((l) => l.title?.toLowerCase() === 'groceries');
  if (existing?.id) {
    groceryListIdCache = existing.id;
    return existing.id;
  }
  const created = await client.tasklists.insert({ requestBody: { title: 'Groceries' } });
  groceryListIdCache = created.data.id!;
  return created.data.id!;
}

async function pickListIdForTask(task: Task): Promise<string> {
  if (task.google_list_id) return task.google_list_id;
  const haystack = `${task.title} ${task.notes || ''}`;
  if (isGroceryRelated(haystack)) return getGroceryListId();
  return '@default';
}

function encodeNotes(task: Task): string {
  const tag = TAG(task.id);
  const body = (task.notes || task.description || '').trim();
  return body ? `${tag}\n${body}` : tag;
}

function decodeBbId(notes: string | null | undefined): number | null {
  if (!notes) return null;
  const m = notes.match(BB_TAG_RE);
  return m ? parseInt(m[1], 10) : null;
}

function dueIso(task: Task): string | undefined {
  if (!task.due_date) return undefined;
  // Google Tasks only stores date precision, but the API expects an RFC3339 timestamp.
  const datePart = task.due_date.split('T')[0];
  return `${datePart}T00:00:00.000Z`;
}

function bodyForGoogle(task: Task): tasks_v1.Schema$Task {
  const body: tasks_v1.Schema$Task = {
    title: task.title,
    notes: encodeNotes(task),
  };
  const due = dueIso(task);
  if (due) body.due = due;
  if (task.status === 'done' || task.status === 'cancelled') body.status = 'completed';
  else body.status = 'needsAction';
  return body;
}

export async function pushTaskToGoogle(task: Task): Promise<void> {
  if (!task.sync_to_google) return;
  if (task.status === 'cancelled') {
    await deleteGoogleTaskMirror(task);
    return;
  }

  const client = getClient();
  const listId = await pickListIdForTask(task);
  const requestBody = bodyForGoogle(task);

  // If we already have a mapping, try to patch; fall through to create on 404.
  if (task.google_task_id && task.google_list_id) {
    try {
      await client.tasks.patch({
        tasklist: task.google_list_id,
        task: task.google_task_id,
        requestBody,
      });
      stampTaskSynced(task.id);
      return;
    } catch (err: unknown) {
      const code = (err as { code?: number; response?: { status?: number } })?.code
        ?? (err as { response?: { status?: number } })?.response?.status;
      if (code !== 404) {
        console.error(`[sync] patch failed for task ${task.id}:`, err);
        return;
      }
      // 404 — Google task was deleted on phone; clear and recreate
      clearTaskGoogleMapping(task.id);
    }
  }

  try {
    const created = await client.tasks.insert({ tasklist: listId, requestBody });
    if (created.data.id) {
      setTaskGoogleMapping(task.id, created.data.id, listId);
    }
  } catch (err) {
    console.error(`[sync] insert failed for task ${task.id}:`, err);
  }
}

export async function markGoogleTaskComplete(task: Task): Promise<void> {
  if (!task.sync_to_google || !task.google_task_id || !task.google_list_id) return;
  const client = getClient();
  try {
    await client.tasks.patch({
      tasklist: task.google_list_id,
      task: task.google_task_id,
      requestBody: { status: 'completed' },
    });
    stampTaskSynced(task.id);
  } catch (err: unknown) {
    const code = (err as { code?: number; response?: { status?: number } })?.code
      ?? (err as { response?: { status?: number } })?.response?.status;
    if (code === 404) {
      clearTaskGoogleMapping(task.id);
    } else {
      console.error(`[sync] complete failed for task ${task.id}:`, err);
    }
  }
}

/**
 * Returns true when the mirror is verifiably gone (deleted, or 404 = already
 * gone), false when the delete FAILED (quota, network) — in which case the
 * mapping is kept so a retry can still find the mirror. The 2026-07-29 wipe
 * reported "255 deleted, 0 errored" while every delete 403'd on quota because
 * this used to swallow all errors AND clear the mapping unconditionally.
 */
export async function deleteGoogleTaskMirror(task: Task): Promise<boolean> {
  if (!task.google_task_id || !task.google_list_id) return true; // nothing mirrored
  const client = getClient();
  try {
    await client.tasks.delete({ tasklist: task.google_list_id, task: task.google_task_id });
  } catch (err: unknown) {
    const code = (err as { code?: number; response?: { status?: number } })?.code
      ?? (err as { response?: { status?: number } })?.response?.status;
    if (code !== 404) {
      console.error(`[sync] delete failed for task ${task.id}:`, err);
      return false; // keep the mapping — the mirror still exists in Google
    }
  }
  clearTaskGoogleMapping(task.id);
  return true;
}

interface ListedGoogleTask {
  listId: string;
  task: tasks_v1.Schema$Task;
}

async function listAllGoogleTasks(): Promise<ListedGoogleTask[]> {
  const client = getClient();
  const lists = await client.tasklists.list({ maxResults: 100 });
  const allListIds: string[] = [];
  for (const l of lists.data.items || []) {
    if (l.id) allListIds.push(l.id);
  }
  const out: ListedGoogleTask[] = [];
  for (const listId of allListIds) {
    try {
      const res = await client.tasks.list({
        tasklist: listId,
        showCompleted: true,
        showHidden: true,
        maxResults: 100,
      });
      for (const t of res.data.items || []) {
        out.push({ listId, task: t });
      }
    } catch (err) {
      console.error(`[sync] list failed for ${listId}:`, err);
    }
  }
  return out;
}

export async function pullGoogleTasks(): Promise<{ pulled: number; conflicts: number }> {
  let pulled = 0;
  let conflicts = 0;

  const remote = await listAllGoogleTasks();
  const seenSqliteIds = new Set<number>();

  for (const { listId, task: gt } of remote) {
    if (!gt.id) continue;

    // Resolve SQLite row: prefer google_task_id, fall back to [bb:N] tag
    let local = getTaskByGoogleId(gt.id);
    if (!local) {
      const bbId = decodeBbId(gt.notes);
      if (bbId) {
        const byId = getTaskById(bbId);
        if (byId) {
          local = byId;
          setTaskGoogleMapping(local.id, gt.id, listId);
        }
      }
    }

    if (!local) {
      // New on Google → backfill
      const newId = createTask({
        title: gt.title || '(untitled)',
        group_id: 'home',
        assignee: 'owner',
        priority: 'medium',
        due_date: gt.due ? gt.due.split('T')[0] : undefined,
        source: 'google-pull',
        notes: stripBbTag(gt.notes),
        sync_to_google: true,
        google_task_id: gt.id,
        google_list_id: listId,
      });
      stampTaskSynced(newId);
      pulled++;
      seenSqliteIds.add(newId);
      continue;
    }

    seenSqliteIds.add(local.id);

    // Status reconciliation — completed-anywhere wins
    const remoteCompleted = gt.status === 'completed';
    const localCompleted = local.status === 'done' || local.status === 'cancelled';

    if (remoteCompleted && !localCompleted) {
      updateTaskStatus(local.id, 'done', 'completed via Google Tasks');
      stampTaskSynced(local.id);
      pulled++;
    } else if (!remoteCompleted && localCompleted) {
      // SQLite is done but Google still shows open — push completion
      await markGoogleTaskComplete({ ...local, google_task_id: gt.id, google_list_id: listId });
      conflicts++;
    }
  }

  // Detect tasks that have a google_task_id but disappeared from Google → treat as iPhone deletion
  const mapped = getTasksWithGoogleMapping();
  for (const t of mapped) {
    if (!t.google_task_id) continue;
    if (!seenSqliteIds.has(t.id) && (t.status === 'open' || t.status === 'in_progress')) {
      updateTaskStatus(t.id, 'cancelled', 'deleted in Google Tasks');
      clearTaskGoogleMapping(t.id);
      pulled++;
    }
  }

  return { pulled, conflicts };
}

function stripBbTag(notes: string | null | undefined): string | undefined {
  if (!notes) return undefined;
  return notes.replace(BB_TAG_RE, '').trim() || undefined;
}

export async function reconcile(): Promise<{ pushed: number; pulled: number; conflicts: number }> {
  let pushed = 0;

  // 1. Push outbound changes first so pull sees consistent state
  const toPush = getTasksNeedingPush();
  for (const t of toPush) {
    try {
      await pushTaskToGoogle(t);
      pushed++;
    } catch (err) {
      console.error(`[sync] push failed for task ${t.id}:`, err);
    }
  }

  // 2. Pull and reconcile inbound changes
  const { pulled, conflicts } = await pullGoogleTasks();

  return { pushed, pulled, conflicts };
}
