import 'dotenv/config';
import { google, tasks_v1 } from 'googleapis';
import { createTask, getTaskById, getTaskByGoogleId, setTaskGoogleMapping, stampTaskSynced } from '../src/db.js';

/**
 * One-time backfill: pull all existing Google Tasks and create matching SQLite rows
 * (or just link them if a `[bb:N]` tag points to an existing SQLite task).
 *
 * Idempotent — safe to re-run. After this, every Google Task carries a `[bb:N]` tag
 * in its notes, so future pulls always bind cleanly.
 *
 * Usage: npm run backfill:google-tasks
 */

const BB_TAG_RE = /\[bb:(\d+)\]/;
const TAG = (id: number) => `[bb:${id}]`;

function getClient(): tasks_v1.Tasks {
  const auth = new google.auth.OAuth2(
    process.env.GOOGLE_CALENDAR_CLIENT_ID,
    process.env.GOOGLE_CALENDAR_CLIENT_SECRET,
  );
  auth.setCredentials({ refresh_token: process.env.GOOGLE_CALENDAR_REFRESH_TOKEN });
  return google.tasks({ version: 'v1', auth });
}

function ensureTaggedNotes(notes: string | null | undefined, sqliteId: number): string {
  const tag = TAG(sqliteId);
  if (notes && BB_TAG_RE.test(notes)) {
    return notes.replace(BB_TAG_RE, tag);
  }
  if (!notes) return tag;
  return `${tag}\n${notes}`;
}

function stripBbTag(notes: string | null | undefined): string | undefined {
  if (!notes) return undefined;
  return notes.replace(BB_TAG_RE, '').trim() || undefined;
}

async function main() {
  const client = getClient();

  console.log('[backfill] Listing all task lists...');
  const lists = await client.tasklists.list({ maxResults: 100 });
  const listMeta = (lists.data.items || []).filter((l) => l.id) as Array<{ id: string; title?: string }>;
  console.log(`[backfill] Found ${listMeta.length} lists: ${listMeta.map((l) => l.title).join(', ')}`);

  let created = 0;
  let linked = 0;
  let alreadyLinked = 0;
  let retaggedRemote = 0;

  for (const list of listMeta) {
    console.log(`[backfill] Processing list "${list.title}" (${list.id})...`);
    const res = await client.tasks.list({
      tasklist: list.id,
      showCompleted: true,
      showHidden: true,
      maxResults: 100,
    });
    const items = res.data.items || [];
    console.log(`[backfill]   ${items.length} tasks`);

    for (const gt of items) {
      if (!gt.id) continue;

      // Step 1: is this Google task already mapped in SQLite?
      const byGoogle = getTaskByGoogleId(gt.id);
      if (byGoogle) {
        alreadyLinked++;
        continue;
      }

      // Step 2: does the notes carry a [bb:N] pointing to an existing SQLite row?
      const m = gt.notes?.match(BB_TAG_RE);
      if (m) {
        const sqliteId = parseInt(m[1], 10);
        const existing = getTaskById(sqliteId);
        if (existing) {
          setTaskGoogleMapping(sqliteId, gt.id, list.id);
          linked++;
          continue;
        }
      }

      // Step 3: New on Google side — create a SQLite row, then re-tag the Google Task
      const status = gt.status === 'completed' ? 'done' : 'open';
      const newId = createTask({
        title: gt.title || '(untitled)',
        group_id: 'home',
        assignee: 'owner',
        priority: 'medium',
        due_date: gt.due ? gt.due.split('T')[0] : undefined,
        source: 'backfill',
        notes: stripBbTag(gt.notes),
        sync_to_google: true,
        google_task_id: gt.id,
        google_list_id: list.id,
      });
      // For completed tasks, mark SQLite as done to match
      if (status === 'done') {
        // Update via the same code path
        const { updateTaskStatus } = await import('../src/db.js');
        updateTaskStatus(newId, 'done', 'imported from Google Tasks (already completed)');
      }
      stampTaskSynced(newId);
      created++;

      // Step 4: patch the Google Task to include the [bb:N] tag (so future pulls bind cleanly)
      const newNotes = ensureTaggedNotes(gt.notes, newId);
      try {
        await client.tasks.patch({
          tasklist: list.id,
          task: gt.id,
          requestBody: { notes: newNotes },
        });
        retaggedRemote++;
      } catch (err) {
        console.error(`[backfill]   failed to retag Google task ${gt.id}:`, err);
      }
    }
  }

  console.log('\n[backfill] Done.');
  console.log(`  Created SQLite rows: ${created}`);
  console.log(`  Linked via [bb:N] tag: ${linked}`);
  console.log(`  Already mapped: ${alreadyLinked}`);
  console.log(`  Re-tagged Google Tasks: ${retaggedRemote}`);
}

main().catch((err) => {
  console.error('[backfill] Fatal:', err);
  process.exit(1);
});
