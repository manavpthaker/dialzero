import 'dotenv/config';
import { createHash } from 'node:crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  getUnextractedIMessages,
  getUnextractedIMessagesSince,
  createIMessageExtractionDraft,
  markIMessagesExtracted,
  quarantineFamilyIMessages,
  quarantineIMessageChat,
  saveFact,
  upsertPerson,
  addInteraction,
  findPersonByPhone,
  findPersonByEmail,
  createTask,
  getTaskById,
  type IMessageLogRow,
} from '../src/db.js';
// Shared with any bulk pass over the imessage_log backlog — one implementation
// of the quarantine rule, not two that can drift apart.
import { partitionPrivateRows } from '../src/lib/imessage-privacy.js';
import { initUsers } from '../src/user-resolver.js';
import { pushTaskToGoogle } from '../src/sync/tasks-sync.js';
import { parseBoolEnv, parseStrEnv, parseNumEnv } from '../src/lib/env.js';
import { OPENAI_MODEL, OPENAI_ROUTER_MODEL, llmConfigured } from '../src/lib/openai.js';
import { extractFirstJson, extractionComplete, makeLogger, haikuPrefilter, runDaemon } from '../src/lib/daemon.js';
import { automationsOff, automationAllowed } from '../src/lib/automations-off.js';
import { isOwnedOn, moduleFor } from '../src/modules.js';
import { runIMessageHistoryBatch } from '../src/imessage-history.js';

// Phase 5: iMessage extraction daemon.
//
// Persistent loop (launchd KeepAlive). NOT a cron — it polls imessage_log on an
// interval the way meeting-daemon polls calendar/transcripts.
//
// Lifecycle (tick() every IMESSAGE_DAEMON_INTERVAL_MS):
//   1. getUnextractedIMessages(BATCH) — rows the channel logged but we haven't read.
//   2. Quarantine Family/private-member rows before any linking or model call.
//   3. Model pre-filter — classify which rows carry a commitment / date /
//      question / actionable signal. Shadow mode requires the local model.
//   4. Structured extraction over the candidates. Shadow mode requires the local model; shape
//      mirrors the meeting debrief: { commitments, deadlines, people, decisions }.
//   5. In shadow mode, write one review draft and stop. In write mode, brain write-back:
//        commitment → saveFact(fact_type:'commitment')  → Brain Pulse surfaces it
//        deadline   → createTask(source:'imessage-daemon') + Google push
//        person     → upsertPerson + addInteraction (bumps last_contact)
//        decision   → saveFact(fact_type:'decision')
//   6. markIMessagesExtracted(ALL safe pulled ids) — both extracted and filtered-out,
//      so the cursor always advances and nothing is reprocessed.
//
// There is no proactive surfacing layer here by design — once a commitment lands
// as a fact, getStaleCommitments() (brain-pulse) picks it up for free.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const LOG_PATH = join(REPO_ROOT, 'logs', 'imessage-daemon.log');

const INTERVAL_MS = parseNumEnv('IMESSAGE_DAEMON_INTERVAL_MS', 10 * 60 * 1000);
const BATCH = parseNumEnv('IMESSAGE_EXTRACT_BATCH', 100);
const PREFILTER_MODEL = parseStrEnv('OPENAI_ROUTER_MODEL', OPENAI_ROUTER_MODEL);
const EXTRACT_MODEL = parseStrEnv('OPENAI_MODEL', OPENAI_MODEL);
const MODE = parseStrEnv('IMESSAGE_EXTRACT_MODE', 'write').toLowerCase();
const SHADOW_MODE = MODE === 'shadow';
const NOT_BEFORE = parseStrEnv('IMESSAGE_EXTRACT_NOT_BEFORE', '');
const HISTORY_ENABLED = parseBoolEnv('IMESSAGE_HISTORY_ENABLED', false);
const HISTORY_BEFORE = parseStrEnv('IMESSAGE_HISTORY_BEFORE', NOT_BEFORE);
const HISTORY_AFTER = parseStrEnv('IMESSAGE_HISTORY_AFTER', '');
const HISTORY_MODEL = parseStrEnv('IMESSAGE_HISTORY_MODEL', '');
const HISTORY_BATCH = parseNumEnv('IMESSAGE_HISTORY_BATCH', 75);
const HISTORY_INTERVAL_MS = parseNumEnv('IMESSAGE_HISTORY_INTERVAL_MS', 10 * 60 * 1000);
const HISTORY_MAX_OBSERVATIONS = parseNumEnv('IMESSAGE_HISTORY_MAX_OBSERVATIONS', 12);

const TEST_MODE = process.argv.includes('--test');
const HISTORY_TEST_MODE = process.argv.includes('--history-test');
const log = makeLogger(LOG_PATH, TEST_MODE);

// A short, model-friendly label for the chat a message came from.
function chatLabel(row: IMessageLogRow): string {
  return row.chat_name || row.chat_id;
}

// Render one message line for the LLM, tagged with index + direction + chat.
function renderLine(row: IMessageLogRow, idx: number): string {
  const who = row.direction === 'out' ? 'the owner (me)' : row.sender;
  return `[${idx}] (${chatLabel(row)}) ${who}: ${(row.text || '').slice(0, 500)}`;
}

// ── Step 2: model pre-filter ─────────────────────────────────────────────────
// Returns the subset of candidate rows worth the extraction call.
async function prefilterMessages(rows: IMessageLogRow[]): Promise<IMessageLogRow[]> {
  const withText = rows.filter((r) => (r.text || '').trim().length > 0);
  const criteria = `You are a fast classifier. Below are numbered iMessages (the owner's own messages are tagged "the owner (me)").

Return a JSON array of the indices of messages that contain ANY of:
- a commitment or promise (especially one the owner made: "I'll send…", "I'll get you…", "let me…")
- a date, deadline, or time reference ("by Friday", "next week", "tomorrow at 3")
- an explicit question awaiting a reply
- a clearly actionable to-do

Ignore greetings, reactions, logistics chatter, and emoji-only messages.`;
  return haikuPrefilter({
    items: withText,
    render: renderLine,
    model: PREFILTER_MODEL,
    log,
    caller: 'prefilter:imessage-daemon',
    provider: SHADOW_MODE ? 'local' : 'auto',
    criteria,
  });
}

// ── Step 3: OpenAI extraction ────────────────────────────────────────────────
interface ExtractJson {
  commitments?: Array<{ counterpart?: string; text: string }>;
  deadlines?: Array<{ title: string; due?: string | null }>;
  people?: Array<{ name: string }>;
  decisions?: Array<{ subject?: string; text: string }>;
  logistics?: Array<{ text: string }>;
}

async function extractFromMessages(rows: IMessageLogRow[]): Promise<ExtractJson | null> {
  const list = rows.map((r, i) => renderLine(r, i)).join('\n');
  const prompt = `Extract durable knowledge from these iMessages. the owner's own messages are tagged "the owner (me)". Reply with JSON only, no prose.

{
  "commitments": [{"counterpart": "who the owner promised (person name or chat)", "text": "what the owner committed to do"}],
  "deadlines": [{"title": "the to-do", "due": "YYYY-MM-DD or null"}],
  "people": [{"name": "a real person named in conversation"}],
  "decisions": [{"subject": "topic/person", "text": "the decision"}]
}

Rules:
- ONLY include commitments the owner themselves made (his "(me)" messages), not promises made TO him.
- deadlines = concrete things the owner must do by a date. Resolve relative dates against today (${new Date().toISOString().slice(0, 10)}); if no date is implied, use null.
- people = named humans (skip the owner themselves, skip group/chat names).
- Omit a section entirely if empty. Be conservative — skip anything ambiguous.

${list}`;

  try {
    const text = await extractionComplete({
      prompt,
      maxTokens: 1500,
      openaiModel: EXTRACT_MODEL,
      log,
      caller: 'imessage-daemon',
      provider: SHADOW_MODE ? 'local' : 'auto',
    });
    const json = extractFirstJson(text, '{', '}');
    if (!json) {
      log('extract: could not locate JSON in response');
      if (SHADOW_MODE) throw new Error('local extraction returned no JSON; source rows left unprocessed');
      return null;
    }
    return JSON.parse(json) as ExtractJson;
  } catch (err) {
    log(`extract failed: ${err instanceof Error ? err.message : err}`);
    if (SHADOW_MODE) throw err;
    return null;
  }
}

function writeShadowDraft(parsed: ExtractJson, rows: IMessageLogRow[]): number | null {
  const ids = rows.map((row) => row.id).sort((a, b) => a - b);
  const batchKey = createHash('sha256').update(ids.join(',')).digest('hex');
  const timestamps = rows.map((row) => row.ts).sort();
  return createIMessageExtractionDraft({
    batchKey,
    sourceRowIds: ids,
    sourceStart: timestamps[0],
    sourceEnd: timestamps[timestamps.length - 1],
    extraction: parsed,
  });
}

// ── Step 4: brain write-back ─────────────────────────────────────────────────
function writeBackToBrain(parsed: ExtractJson, rows: IMessageLogRow[]): void {
  // Newest message timestamp in this batch — used for interaction recency.
  const latestTs = rows.reduce((acc, r) => (r.ts > acc ? r.ts : acc), rows[0]?.ts || new Date().toISOString());

  // Commitments the owner made → durable facts for brain-pulse to surface later.
  for (const c of parsed.commitments ?? []) {
    if (!c.text) continue;
    const subject = (c.counterpart || 'imessage').trim() || 'imessage';
    try {
      saveFact({
        subject,
        predicate: 'promised',
        object: c.text,
        fact_type: 'commitment',
        source: 'imessage-daemon',
        source_ref: `imessage:${latestTs}`,
      });
    } catch (err) {
      log(`writeback: saveFact(commitment) failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Deadlines → tasks (Google-synced, like meeting-daemon action items).
  for (const d of parsed.deadlines ?? []) {
    if (!d.title) continue;
    try {
      const id = createTask({
        title: d.title,
        group_id: 'admin',
        assignee: 'owner',
        due_date: d.due || undefined,
        source: 'imessage-daemon',
        sync_to_google: true,
        notes: 'Captured from iMessage',
      });
      const t = getTaskById(id);
      if (t) pushTaskToGoogle(t).catch((err) => log(`google task push failed: ${err}`));
    } catch (err) {
      log(`writeback: createTask failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // People → upsert + interaction (bumps last_contact → feeds dormant-leads).
  for (const p of parsed.people ?? []) {
    if (!p.name) continue;
    try {
      const personId = upsertPerson({ name: p.name });
      addInteraction({
        person_id: personId,
        channel: 'imessage',
        summary: 'Mentioned in iMessage',
        ref: `imessage:${latestTs}`,
        occurred_at: latestTs,
      });
    } catch (err) {
      log(`writeback: person upsert failed for ${p.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Decisions → durable facts.
  for (const dec of parsed.decisions ?? []) {
    if (!dec.text) continue;
    try {
      saveFact({
        subject: (dec.subject || 'imessage').trim() || 'imessage',
        predicate: 'decided',
        object: dec.text,
        fact_type: 'decision',
        source: 'imessage-daemon',
        source_ref: `imessage:${latestTs}`,
      });
    } catch (err) {
      log(`writeback: saveFact(decision) failed: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ── Sender linking ───────────────────────────────────────────────────────────
// Bind incoming iMessage activity to a *known* person by their handle. Once Apple
// Contacts seeds a person with both an email and a phone (see scripts/import-contacts.ts),
// the phone handle resolves here and the text lands as an interaction on the same row
// the email path already feeds — closing the phone↔people dedup gap. We deliberately do
// NOT create new nameless phone-only rows here; unknown handles are left for Contacts.
function linkIncomingSenders(rows: IMessageLogRow[]): void {
  // Distinct incoming sender handles → most-recent ts in this batch (one interaction each).
  const bySender = new Map<string, string>();
  for (const r of rows) {
    if (r.direction !== 'in') continue;
    const handle = (r.sender || '').trim();
    if (!handle || handle === 'me') continue;
    const prev = bySender.get(handle);
    if (!prev || r.ts > prev) bySender.set(handle, r.ts);
  }

  for (const [handle, ts] of bySender) {
    const person = handle.includes('@') ? findPersonByEmail(handle) : findPersonByPhone(handle);
    if (!person) continue; // unknown handle — leave for the Contacts importer to seed
    try {
      addInteraction({
        person_id: person.id,
        channel: 'imessage',
        summary: 'Texted the owner',
        ref: `imessage:sender:${handle}:${ts}`,
        occurred_at: ts,
      });
    } catch (err) {
      log(`link: addInteraction failed for ${handle}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

async function liveTick(): Promise<void> {
  // Close the startup/backlog window in one SQL statement on every tick. The
  // per-row partition below remains a second fail-closed check against races.
  const familyChatId = process.env.GROUP_FAMILY?.trim();
  if (familyChatId && !SHADOW_MODE) {
    const quarantinedBacklog = quarantineIMessageChat(familyChatId);
    if (quarantinedBacklog > 0) {
      log(`privacy: quarantined ${quarantinedBacklog} Family backlog row(s)`);
    }
  }

  const pulledRows = SHADOW_MODE
    ? getUnextractedIMessagesSince(NOT_BEFORE, BATCH)
    : getUnextractedIMessages(BATCH);
  if (!pulledRows.length) {
    if (TEST_MODE) log('tick: no unextracted messages');
    return;
  }

  const eligibleRows = pulledRows;

  const partition = partitionPrivateRows(eligibleRows);
  if (partition.quarantined.length > 0) {
    quarantineFamilyIMessages(partition.familyPrivate.map((row) => row.id));
    markIMessagesExtracted(partition.quarantined.map((row) => row.id));
    log(`privacy: quarantined ${partition.quarantined.length} row(s) before global extraction`);
  }

  const rows = partition.safe;
  if (!rows.length) return;

  if (!SHADOW_MODE && !llmConfigured()) {
    log('no model API key — safe rows left unextracted for next run');
    return;
  }

  log(`tick: ${rows.length} unextracted message(s)`);

  // Link incoming senders to known people by handle (cheap DB lookups, no LLM) over
  // ALL rows so recency/dormancy reflects every text, not just actionable ones.
  if (!SHADOW_MODE) linkIncomingSenders(rows);

  const candidates = await prefilterMessages(rows);
  log(`tick: ${candidates.length} candidate(s) after prefilter`);

  if (candidates.length) {
    const parsed = await extractFromMessages(candidates);
    if (parsed) {
      const counts = {
        commitments: parsed.commitments?.length ?? 0,
        deadlines: parsed.deadlines?.length ?? 0,
        people: parsed.people?.length ?? 0,
        decisions: parsed.decisions?.length ?? 0,
        logistics: parsed.logistics?.length ?? 0,
      };
      log(`tick: extracted ${JSON.stringify(counts)}`);
      if (SHADOW_MODE) {
        const draftId = writeShadowDraft(parsed, candidates);
        log(`shadow: ${draftId ? `created review draft #${draftId}` : 'review draft already existed'}; no facts/tasks/people/interactions were changed`);
      } else {
        writeBackToBrain(parsed, candidates);
      }
    }
  }

  // Mark ALL pulled rows (shadow-drafted or confidently filtered out) so the
  // live cursor advances. On any local/model failure the strict shadow path
  // throws before here, leaving every source row available for retry.
  markIMessagesExtracted(rows.map((r) => r.id));
  log(`tick: marked ${rows.length} row(s) extracted`);
}

let lastHistoryRunAt = 0;

async function historyTick(): Promise<void> {
  if (!HISTORY_ENABLED || (TEST_MODE && !HISTORY_TEST_MODE)) return;
  const now = Date.now();
  if (lastHistoryRunAt && now - lastHistoryRunAt < HISTORY_INTERVAL_MS) return;
  // Set before awaiting so a slow local call cannot overlap with the next timer
  // callback. A failure gets another bounded attempt on the next cadence.
  lastHistoryRunAt = now;
  const result = await runIMessageHistoryBatch({
    before: HISTORY_BEFORE,
    after: HISTORY_AFTER || undefined,
    model: HISTORY_MODEL || undefined,
    batchSize: HISTORY_BATCH,
    maxObservations: HISTORY_MAX_OBSERVATIONS,
    log,
  });
  if (result.batchId === null) log('history: archive mining complete; no rows remain');
}

async function tick(): Promise<void> {
  await liveTick();
  await historyTick();
}

// Feature switchboard (src/modules.ts): exit quietly when this daemon's module
// is off. launchd templates use KeepAlive SuccessfulExit=false, so a clean exit
// stays down instead of restarting. --test runs regardless.
if (!TEST_MODE && !isOwnedOn('daemons', 'imessage-daemon')) {
  console.log(`[imessage-daemon] module "${moduleFor('daemons', 'imessage-daemon')}" is off — exiting.`);
  process.exit(0);
}

if (SHADOW_MODE && !NOT_BEFORE) {
  console.error('[imessage-daemon] IMESSAGE_EXTRACT_MODE=shadow requires IMESSAGE_EXTRACT_NOT_BEFORE; refusing to touch the backlog.');
  process.exit(1);
}

if (HISTORY_ENABLED && (!HISTORY_BEFORE || !Number.isFinite(Date.parse(HISTORY_BEFORE)))) {
  console.error('[imessage-daemon] IMESSAGE_HISTORY_ENABLED requires a valid IMESSAGE_HISTORY_BEFORE cutoff; refusing to mine history.');
  process.exit(1);
}

if (MODE !== 'write' && MODE !== 'shadow') {
  console.error(`[imessage-daemon] invalid IMESSAGE_EXTRACT_MODE=${MODE}; expected write or shadow.`);
  process.exit(1);
}

if (automationsOff() && !automationAllowed('imessage-daemon')) {
  console.log('[imessage-daemon] AUTOMATIONS_OFF sentinel present — exiting.');
  process.exit(0);
}

if (SHADOW_MODE) {
  console.log(`[imessage-daemon] SHADOW mode: local-only, processing messages at/after ${NOT_BEFORE}; canonical writeback disabled.`);
}

if (HISTORY_ENABLED) {
  console.log(
    `[imessage-daemon] HISTORY mode: ${HISTORY_MODEL || 'local-only'}, ${HISTORY_BATCH} rows every ${Math.round(HISTORY_INTERVAL_MS / 60_000)} minute(s), `
    + `before ${HISTORY_BEFORE}${HISTORY_AFTER ? `, from ${HISTORY_AFTER}` : ''}; dated owner-private references only.`,
  );
}


initUsers();
runDaemon({ name: 'imessage-daemon', intervalMs: INTERVAL_MS, testMode: TEST_MODE, tick, log }).catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
