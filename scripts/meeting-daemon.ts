import 'dotenv/config';
import { promises as fs, existsSync, mkdirSync, renameSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { makeLogger, extractionComplete } from '../src/lib/daemon.js';
import { OPENAI_MODEL, openAIText } from '../src/lib/openai.js';
import { automationsOff, automationAllowed } from '../src/lib/automations-off.js';
import { isOwnedOn, moduleFor } from '../src/modules.js';
import { listRawEvents } from '../src/tools/calendar.js';
import { EMAIL_NOT_CONNECTED, formatEmailMessage, getEmailSource } from '../src/email/source.js';
import { getDefaultRecipient } from '../src/channels/imessage.js';
import { sendInterrupt } from '../src/cos-outbound.js';
import {
  findPersonByEmail,
  upsertPerson,
  factsAbout,
  getRecentInteractions,
  addInteraction,
  saveFact,
  createTask,
  getTaskById,
  setMemory,
} from '../src/db.js';
import { pushTaskToGoogle } from '../src/sync/tasks-sync.js';

// Tier 1 Phase 4: Meeting Prep + Debrief Daemon.
//
// Persistent loop (launchd KeepAlive). NOT a cron — the 2-min transcript poll
// and the 30-min-before prep window need a long-running process.
//
// Lifecycle:
//   tick() every 5 min
//     - list next 24h of external events; upsert into state
//     - for each event:
//       - 30 min before start AND !prep_sent → runPrep()
//       - >=10 min after end AND !debrief_triggered → mark
//         debrief_triggered = true, debrief_poll_started_at = now
//   pollTranscripts() every 2 min
//     - for each meeting with debrief_triggered && !debrief_sent:
//       - if >30 min since debrief_poll_started_at → timed out, log
//       - else search email for the Google Meet transcript → runDebrief()
//
// State lives in data/meeting-state.json (atomic write: temp + rename).
// Gitignored so sync-repos.sh git pull doesn't fight us.
//
// On debrief, we write back into the brain:
//   - per action item → createTask({ source: 'meeting-daemon' }) + fireAndForgetPush
//   - per attendee → addInteraction() to bump last_contact (so dormant-leads
//     doesn't nag about someone you just met)
//   - per decision → saveFact({ fact_type: 'decision' })
//   - per commitment made → saveFact({ fact_type: 'commitment' })

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const STATE_PATH = join(REPO_ROOT, 'data', 'meeting-state.json');
const LOG_PATH = join(REPO_ROOT, 'logs', 'meeting-daemon.log');

const INTERNAL_DOMAINS = (
  process.env.INTERNAL_DOMAINS || 'gmail.com'
)
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const TICK_INTERVAL_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const PREP_LEAD_MS = 30 * 60 * 1000;
const PREP_WINDOW_MS = 5 * 60 * 1000; // fire if start - now ∈ [30, 35] min
const DEBRIEF_DELAY_MS = 10 * 60 * 1000;
const DEBRIEF_TIMEOUT_MS = 30 * 60 * 1000;

const TEST_MODE = process.argv.includes('--test');
const TEST_DEBRIEF = process.argv.includes('--test-debrief');

interface MeetingState {
  event_id: string;
  summary: string;
  start: string;
  end: string;
  attendees: string[];
  external_attendees: string[];
  location?: string | null;
  prep_sent: boolean;
  prep_sent_at?: string;
  debrief_triggered: boolean;
  debrief_poll_started_at?: string;
  debrief_sent: boolean;
  debrief_sent_at?: string;
  debrief_timed_out?: boolean;
  transcript_found?: boolean;
  action_items_created?: number[];
}

interface DaemonState {
  meetings: Record<string, MeetingState>;
}

function ensureDirs(): void {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
}

const log = makeLogger(LOG_PATH, TEST_MODE);

async function loadState(): Promise<DaemonState> {
  if (!existsSync(STATE_PATH)) return { meetings: {} };
  try {
    const raw = await fs.readFile(STATE_PATH, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.meetings) {
      return { meetings: {} };
    }
    return parsed as DaemonState;
  } catch (err) {
    log(`loadState failed, starting fresh: ${err instanceof Error ? err.message : err}`);
    return { meetings: {} };
  }
}

async function saveState(state: DaemonState): Promise<void> {
  if (TEST_MODE) {
    log('saveState skipped (TEST MODE)');
    return;
  }
  const tmp = STATE_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  renameSync(tmp, STATE_PATH);
}

function isExternal(email: string | null | undefined): boolean {
  if (!email) return false;
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return !INTERNAL_DOMAINS.some((d) => domain === d || domain.includes(d));
}

function getAdminTarget(): string | null {
  return process.env.GROUP_ADMIN || getDefaultRecipient() || null;
}


async function gatherAttendeeContext(emails: string[]): Promise<string> {
  if (TEST_MODE) {
    return emails.map((e) => `## stub for ${e}\nFacts:\n  (test mode — no DB lookup)\nRecent:\n  (none)`).join('\n\n');
  }
  const blocks: string[] = [];
  for (const email of emails) {
    let person = findPersonByEmail(email);
    if (!person) {
      // Auto-create a stub so subsequent lookups have a stable id.
      upsertPerson({ emails: [email], name: email });
      person = findPersonByEmail(email);
      if (!person) continue;
    }
    const facts = factsAbout(person.name, 6);
    const interactions = getRecentInteractions(person.id, 3);
    const factLines = facts.length
      ? facts.map((f) => `  - ${f.subject} ${f.predicate} ${f.object}`).join('\n')
      : '  (no facts)';
    const interactionLines = interactions.length
      ? interactions
          .map((i) => `  - [${(i.occurred_at || i.created_at || '').slice(0, 10)}] ${i.channel || '-'}: ${i.summary || ''}`)
          .join('\n')
      : '  (no prior interactions)';
    blocks.push(
      `## ${person.name} <${email}>${person.company ? ' @ ' + person.company : ''}\nFacts:\n${factLines}\nRecent:\n${interactionLines}`,
    );
  }
  return blocks.join('\n\n');
}

async function gatherRecentEmails(emails: string[]): Promise<string> {
  if (TEST_MODE) {
    return '(test mode — email search skipped)';
  }
  const source = await getEmailSource();
  if (!source) return `(${EMAIL_NOT_CONNECTED})`;
  const queries = emails.map((e) => `from:${e} OR to:${e}`).join(' OR ');
  if (!queries) return '(no attendee emails)';
  try {
    const messages = await source.search(queries, { limit: 5 });
    if (!messages.length) return '(no recent emails with these attendees)';
    return messages.map((m) => formatEmailMessage(m, { body: true, maxBody: 1500 })).join('\n\n---\n\n');
  } catch (err) {
    return `(email search failed: ${err instanceof Error ? err.message : err})`;
  }
}

async function runPrep(meeting: MeetingState, state: DaemonState): Promise<void> {
  log(`prep start event=${meeting.event_id} (${meeting.summary})`);
  const attendeeContext = await gatherAttendeeContext(meeting.external_attendees);
  const recentEmails = await gatherRecentEmails(meeting.external_attendees);

  const prompt = `You are composing a meeting prep brief for the owner. He has an external meeting starting at ${meeting.start}.

Meeting: ${meeting.summary}
${meeting.location ? `Location: ${meeting.location}\n` : ''}External attendees: ${meeting.external_attendees.join(', ')}

Attendee context from the second brain:
${attendeeContext || '(none on file)'}

Recent email threads with these attendees:
${recentEmails}

Compose a SHORT prep text: plain text, at most 4 lines, under 260 characters total
(it is read in a phone notification; keep it skimmable):
- Line 1: who's in the room and why it matters
- Lines 2-3: the one or two specific things to remember (a commitment, a decision, the last interaction)
- Line 4: a sharp opening question
- No markdown, no preamble, no sign-off`;

  if (TEST_MODE) {
    process.stdout.write(`\n=== PREP BRIEF (TEST MODE — not sent) ===\n${prompt}\n=== END ===\n`);
    return;
  }

  const target = getAdminTarget();
  if (!target) {
    log('prep: no admin target configured — skipping send');
    return;
  }

  try {
    const text = await openAIText({
      model: process.env.OPENAI_MODEL || OPENAI_MODEL,
      prompt,
      maxOutputTokens: 800,
      reasoningEffort: 'low',
    });
    if (!text) {
      log(`prep: empty response from OpenAI for event=${meeting.event_id}`);
      return;
    }
    const decision = await sendInterrupt({
      source: 'meeting-daemon',
      subject: `meeting:${meeting.event_id}:prep`,
      kind: 'time-critical',
      text: `📅 Prep: ${meeting.summary}\n${text}`,
      target,
    });
    // prep_sent is a permanent latch: once true this meeting is never prepped
    // again. Setting it for a message the arbiter held would lose the prep
    // outright -- and prep is time-critical, so there is no later run to catch
    // it. Only a real send closes the latch.
    if (!decision.sent) {
      log(`prep held event=${meeting.event_id} (${decision.sent === false ? decision.reason : ''}) — will retry next tick`);
      return;
    }
    meeting.prep_sent = true;
    meeting.prep_sent_at = new Date().toISOString();
    await saveState(state);
    log(`prep sent event=${meeting.event_id}`);
  } catch (err) {
    log(`prep failed event=${meeting.event_id}: ${err instanceof Error ? err.message : err}`);
  }
}

interface DebriefJson {
  decisions?: string[];
  action_items?: Array<{ owner?: string; title: string }>;
  open_questions?: string[];
  strategic_read?: string;
}

function parseDebriefJson(text: string): DebriefJson | null {
  // Extract the first { ... } block — the model may wrap in prose.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function runDebrief(meeting: MeetingState, transcript: string, state: DaemonState): Promise<void> {
  log(`debrief start event=${meeting.event_id}`);
  const prompt = `Extract structured debrief from this Google Meet transcript. Reply with JSON only, no prose.

{
  "decisions": ["string", ...],
  "action_items": [{"owner": "string", "title": "string"}, ...],
  "open_questions": ["string", ...],
  "strategic_read": "one-paragraph strategic read"
}

Meeting: ${meeting.summary}
Attendees: ${meeting.attendees.join(', ')}
Transcript:
${transcript.slice(0, 30000)}`;

  // Structured extraction — same shape as the imessage/inbox daemons, so it
  // rides the local-model seam. The prep brief above deliberately does NOT:
  // it's user-facing prose in the assistant's voice, which stays on Claude.
  let parsed: DebriefJson | null = null;
  try {
    const text = await extractionComplete({
      prompt,
      maxTokens: 2000,
      openaiModel: process.env.OPENAI_MODEL || OPENAI_MODEL,
      log,
      caller: 'meeting-daemon',
    });
    parsed = parseDebriefJson(text);
    if (!parsed) {
      log(`debrief: could not parse JSON for event=${meeting.event_id}`);
      return;
    }
  } catch (err) {
    log(`debrief extraction failed event=${meeting.event_id}: ${err instanceof Error ? err.message : err}`);
    return;
  }

  // Brain write-back (fix #3): tasks, interactions, decisions, commitments.
  const taskIds: number[] = [];
  for (const ai of parsed.action_items ?? []) {
    if (!ai.title) continue;
    const isOwner = !ai.owner || ai.owner.toLowerCase().includes('owner');
    try {
      const id = createTask({
        title: ai.title,
        group_id: 'admin',
        assignee: isOwner ? 'owner' : (ai.owner ?? 'owner'),
        source: 'meeting-daemon',
        sync_to_google: isOwner,
        notes: `From meeting "${meeting.summary}" (${meeting.event_id})`,
      });
      taskIds.push(id);
      if (isOwner) {
        const t = getTaskById(id);
        if (t) pushTaskToGoogle(t).catch((err) => log(`google task push failed: ${err}`));
      }
    } catch (err) {
      log(`debrief: createTask failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  meeting.action_items_created = taskIds;

  // Bump last_contact for each attendee — fix #3.
  for (const email of meeting.attendees) {
    const person = findPersonByEmail(email);
    if (!person) continue;
    try {
      addInteraction({
        person_id: person.id,
        channel: 'calendar',
        summary: `Meeting: ${meeting.summary}`,
        ref: meeting.event_id,
        occurred_at: meeting.end,
      });
    } catch (err) {
      log(`debrief: addInteraction failed for ${email}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Decisions → durable facts.
  const decisionSubject = meeting.external_attendees[0]?.split('@')[1]?.split('.')[0] || meeting.summary.slice(0, 32);
  for (const decision of parsed.decisions ?? []) {
    try {
      saveFact({
        subject: decisionSubject,
        predicate: 'decided',
        object: decision,
        fact_type: 'decision',
        source: 'meeting-daemon',
        source_ref: meeting.event_id,
      });
    } catch (err) {
      log(`debrief: saveFact(decision) failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  // Commitments the owner made → durable facts for brain-pulse to surface later.
  for (const ai of parsed.action_items ?? []) {
    const isOwner = !ai.owner || ai.owner.toLowerCase().includes('owner');
    if (!isOwner || !ai.title) continue;
    try {
      saveFact({
        subject: decisionSubject,
        predicate: 'promised',
        object: ai.title,
        fact_type: 'commitment',
        source: 'meeting-daemon',
        source_ref: meeting.event_id,
      });
    } catch (err) {
      log(`debrief: saveFact(commitment) failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Format and DM the debrief.
  const target = getAdminTarget();
  if (target) {
    const decisionsBlock = (parsed.decisions ?? []).map((d) => `• ${d}`).join('\n') || '(none)';
    const actionsBlock = (parsed.action_items ?? [])
      .map((ai, i) => `${i + 1}. ${ai.title}${ai.owner ? ` — ${ai.owner}` : ''}`)
      .join('\n') || '(none)';
    const questionsBlock = (parsed.open_questions ?? []).map((q) => `? ${q}`).join('\n') || '(none)';
    const body = `Debrief — ${meeting.summary}

Decisions:
${decisionsBlock}

Action items (created ${taskIds.length} task${taskIds.length === 1 ? '' : 's'}):
${actionsBlock}

Open questions:
${questionsBlock}

Strategic read:
${parsed.strategic_read ?? '(none)'}`;
    try {
      // nudge, not time-critical: the tasks and facts were already written to
      // the brain above, so this rides the next check-in (its action items and
      // open questions still deserve a look; pure status would be dropped).
      await sendInterrupt({
        source: 'meeting-daemon',
        subject: `meeting:${meeting.event_id}:debrief`,
        kind: 'nudge',
        text: body,
        target,
      });
    } catch (err) {
      log(`debrief send failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  meeting.debrief_sent = true;
  meeting.debrief_sent_at = new Date().toISOString();
  meeting.transcript_found = true;
  await saveState(state);
  log(`debrief sent event=${meeting.event_id} tasks=${taskIds.length}`);
}

async function findTranscript(meeting: MeetingState): Promise<string | null> {
  const source = await getEmailSource();
  if (!source) return null;

  const queries = [
    'from:meet-recordings-noreply@google.com newer_than:1d',
    `subject:"${meeting.summary}" transcript`,
  ];
  for (const q of queries) {
    try {
      const [hit] = await source.search(q, { limit: 5 });
      if (!hit) continue;
      const thread = await source.readThread(hit.id);
      const bodyText = thread.messages.map((m) => formatEmailMessage(m, { body: true, maxBody: 20000 })).join('\n\n');
      if (bodyText.length > 200) return bodyText;
    } catch (err) {
      log(`findTranscript query="${q}" failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return null;
}

async function tick(): Promise<void> {
  const state = await loadState();
  const now = Date.now();
  let events: Awaited<ReturnType<typeof listRawEvents>>;

  if (TEST_MODE) {
    // Synthesize one fake external event 25 min out — inside the 30-min
    // prep window so runPrep actually fires for the test.
    events = [
      {
        id: 'test-event-1',
        summary: 'Test sync with Jane Doe',
        start: { dateTime: new Date(now + 25 * 60 * 1000).toISOString() },
        end: { dateTime: new Date(now + 85 * 60 * 1000).toISOString() },
        attendees: [{ email: 'jane@acme.com' }, { email: process.env.USER_OWNER_EMAIL || 'owner@gmail.com' }],
        location: null,
      } as never,
    ];
  } else {
    try {
      events = await listRawEvents(
        new Date(now).toISOString(),
        new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      );
    } catch (err) {
      log(`tick: listRawEvents failed: ${err instanceof Error ? err.message : err}`);
      return;
    }
  }

  for (const ev of events) {
    if (!ev.id) continue;
    const attendees = (ev.attendees ?? []).map((a) => a.email).filter((e): e is string => !!e);
    const external = attendees.filter(isExternal);
    if (external.length === 0) continue;

    const startStr = ev.start?.dateTime || ev.start?.date;
    const endStr = ev.end?.dateTime || ev.end?.date;
    if (!startStr || !endStr) continue;

    let meeting = state.meetings[ev.id];
    if (!meeting) {
      meeting = {
        event_id: ev.id,
        summary: ev.summary ?? '(no title)',
        start: startStr,
        end: endStr,
        attendees,
        external_attendees: external,
        location: ev.location ?? null,
        prep_sent: false,
        debrief_triggered: false,
        debrief_sent: false,
      };
      state.meetings[ev.id] = meeting;
      log(`upserted event=${ev.id} (${meeting.summary}); external=${external.join(',')}`);
    } else {
      // Refresh mutable fields in case the event got rescheduled.
      meeting.start = startStr;
      meeting.end = endStr;
      meeting.attendees = attendees;
      meeting.external_attendees = external;
      meeting.location = ev.location ?? null;
    }

    const startMs = new Date(startStr).getTime();
    const endMs = new Date(endStr).getTime();
    const msUntilStart = startMs - now;

    if (!meeting.prep_sent && msUntilStart <= PREP_LEAD_MS && msUntilStart > PREP_LEAD_MS - PREP_WINDOW_MS - TICK_INTERVAL_MS) {
      await runPrep(meeting, state);
    } else if (!meeting.prep_sent && msUntilStart <= PREP_LEAD_MS) {
      // We're inside the lead window (e.g. process restarted mid-window).
      await runPrep(meeting, state);
    }

    const msSinceEnd = now - endMs;
    if (!meeting.debrief_triggered && msSinceEnd >= DEBRIEF_DELAY_MS) {
      meeting.debrief_triggered = true;
      meeting.debrief_poll_started_at = new Date().toISOString();
      log(`debrief_triggered event=${ev.id}`);
    }
  }

  await saveState(state);
}

async function pollTranscripts(): Promise<void> {
  const state = await loadState();
  const now = Date.now();

  for (const ev of Object.values(state.meetings)) {
    if (!ev.debrief_triggered || ev.debrief_sent || ev.debrief_timed_out) continue;
    const startMs = ev.debrief_poll_started_at ? new Date(ev.debrief_poll_started_at).getTime() : now;
    if (now - startMs > DEBRIEF_TIMEOUT_MS) {
      ev.debrief_timed_out = true;
      log(`debrief timed out event=${ev.event_id} (no transcript within 30 min)`);
      continue;
    }
    if (TEST_MODE && !TEST_DEBRIEF) continue;

    const transcript = TEST_MODE
      ? 'Stub transcript: Jane and the owner agreed to ship the v2 dashboard by Friday. the owner to send draft Wednesday. Open question: pricing tier for enterprise.'
      : await findTranscript(ev);
    if (!transcript) continue;
    await runDebrief(ev, transcript, state);
  }

  await saveState(state);
}

async function mainLoop(): Promise<void> {
  ensureDirs();
  log(`meeting-daemon starting${TEST_MODE ? ' (TEST MODE)' : ''}`);

  if (TEST_MODE) {
    await tick();
    if (TEST_DEBRIEF) {
      // Force one debrief cycle with stub transcript.
      const state = await loadState();
      for (const m of Object.values(state.meetings)) {
        m.debrief_triggered = true;
        m.debrief_poll_started_at = new Date().toISOString();
      }
      await saveState(state);
      await pollTranscripts();
    }
    log('test run complete; exiting');
    return;
  }

  // Liveness heartbeat: stamp after each successful tick so the doctor
  // (src/doctor.ts) can flag this process if it dies. Matches the runDaemon
  // helper the other two daemons use (this one has its own loop).
  const markTick = () => {
    try {
      setMemory('system', 'meeting-daemon_last_tick', new Date().toISOString());
    } catch {
      /* heartbeat stamp must never break the loop */
    }
  };

  // Persistent loop.
  setInterval(() => {
    tick().then(markTick).catch((err) => log(`tick threw: ${err instanceof Error ? err.message : err}`));
  }, TICK_INTERVAL_MS);
  setInterval(() => {
    pollTranscripts().catch((err) => log(`pollTranscripts threw: ${err instanceof Error ? err.message : err}`));
  }, POLL_INTERVAL_MS);
  // Kick off immediately too.
  tick().then(markTick).catch((err) => log(`initial tick threw: ${err instanceof Error ? err.message : err}`));
}

// Feature switchboard (src/modules.ts): exit quietly when this daemon's module
// is off. launchd templates use KeepAlive SuccessfulExit=false, so a clean exit
// stays down instead of restarting. --test runs regardless.
if (!TEST_MODE && !isOwnedOn('daemons', 'meeting-daemon')) {
  console.log(`[meeting-daemon] module "${moduleFor('daemons', 'meeting-daemon')}" is off — exiting.`);
  process.exit(0);
}

if (automationsOff() && !automationAllowed('meeting-daemon')) {
  console.log('[meeting-daemon] AUTOMATIONS_OFF sentinel present — exiting.');
  process.exit(0);
}

mainLoop().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
