import { scheduleCron } from './lib/cron.js';
import { getMemory, setMemory, deleteMemory, getRecentMemory } from './db.js';
import { sendMessage, getDefaultRecipient } from './channels/imessage.js';
import { parseBoolEnv, parseStrEnv, parseNumEnv } from './lib/env.js';
import {
  notionEnabled, createPage, appendBlocks, findPageByTitle,
  heading2, paragraph, labeled,
} from './lib/notion-client.js';
import { getBotName, getTimezone } from './config.js';

// ============================================================
// JOURNAL — the assistant's morning + evening reflection ritual.
// It is the SCRIBE, not the author: it PROMPTS one question at a time
// over iMessage, the owner writes the answers, and it files them
// into a Notion daily-note library (one page per day, morning +
// evening sections, the poem at night). Reflections are personal.
//
// Deterministic state machine (not the LLM): a session lives in
// the `memory` table; index.ts routes any reply that arrives while
// a session is active to handleJournalReply, so journal answers
// never hit the agent and the pacing is exact (one Q, wait, next).
// ============================================================

const ENABLED = parseBoolEnv('JOURNAL_ENABLED', false);
const MORNING_CRON = parseStrEnv('JOURNAL_MORNING_CRON', '45 7 * * *');
const EVENING_CRON = parseStrEnv('JOURNAL_EVENING_CRON', '30 20 * * *');
const EXPIRY_MS = parseNumEnv('JOURNAL_SESSION_EXPIRY_H', 4) * 3_600_000;
const JOURNAL_DB = parseStrEnv('NOTION_JOURNAL_DB', '');
const MEM_GROUP = 'journal';
const ACTIVE_KEY = 'active';
const CANCEL_WORDS = new Set(['stop', 'cancel', 'later', 'not now', 'pause', 'skip all']);

type Phase = 'morning' | 'evening';

const PROMPTS: Record<Phase, Array<{ key: string; q: string }>> = {
  morning: [
    { key: 'gratitude', q: 'Morning ☀️ What are you grateful for today?' },
    { key: 'focus', q: "What's the one thing you want to get done today?" },
    { key: 'help', q: 'Anything I can take off your plate?' },
  ],
  evening: [
    { key: 'gratitude', q: 'Evening 🌙 What are you grateful for tonight?' },
    { key: 'win', q: 'What did you get done today — a win?' },
    { key: 'notes', q: 'Anything on your mind? Happenings, notes.' },
    { key: 'poem', q: 'Last thing — your poem for today 📓 Write whatever comes.' },
  ],
};

interface Session {
  phase: Phase;
  step: number;
  answers: Record<string, string>;
  remoteJid: string;
  dateISO: string;
  startedAt: string;
}

// YYYY-MM-DD in the local timezone (en-CA renders ISO order).
function todayET(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: getTimezone() }).format(new Date());
}

function readSession(): Session | null {
  const raw = getMemory(MEM_GROUP, ACTIVE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    deleteMemory(MEM_GROUP, ACTIVE_KEY);
    return null;
  }
}

async function writeDailyNote(phase: Phase, dateISO: string, a: Record<string, string>): Promise<void> {
  let pageId = await findPageByTitle(JOURNAL_DB, dateISO);
  if (!pageId) {
    const page = await createPage(JOURNAL_DB, {
      Name: { title: [{ text: { content: dateISO } }] },
      Date: { date: { start: dateISO } },
    });
    pageId = page.id as string;
  }
  const blocks =
    phase === 'morning'
      ? [
          heading2('☀️ Morning'),
          labeled('Grateful for', a.gratitude),
          labeled("Today's focus", a.focus),
          labeled(`How ${getBotName()} can help`, a.help),
        ]
      : [
          heading2('🌙 Evening'),
          labeled('Grateful for', a.gratitude),
          labeled('Win', a.win),
          labeled('Notes', a.notes),
          heading2('📓 Poem'),
          paragraph(a.poem || '—'),
        ];
  await appendBlocks(pageId, blocks);
}

// Entries stranded by a Notion outage live under unfiled_<date>_<phase>. Retried
// whenever the journal touches Notion again (session start + after a successful
// filing), bounded per call so a long outage can't stall a session start. The
// stash is deleted only on a successful write, so nothing double-files.
const RETRY_BATCH = 3;
async function retryUnfiled(): Promise<void> {
  if (!notionEnabled() || !JOURNAL_DB) return;
  const stashes = getRecentMemory(MEM_GROUP, { prefix: 'unfiled_', limit: RETRY_BATCH });
  for (const stash of stashes) {
    const m = stash.key.match(/^unfiled_(\d{4}-\d{2}-\d{2})_(morning|evening)$/);
    if (!m) continue;
    try {
      const answers = JSON.parse(stash.value) as Record<string, string>;
      await writeDailyNote(m[2] as Phase, m[1], answers);
      deleteMemory(MEM_GROUP, stash.key);
      console.log(`[Journal] retried and filed ${stash.key}`);
    } catch (err) {
      console.error(`[Journal] retry of ${stash.key} failed:`, err);
    }
  }
}

/**
 * If a journal session is active for this thread, treat `text` as the answer to
 * the current prompt: record it, advance, send the next prompt, or finish (write
 * to Notion). Returns true if the reply was consumed as a journal answer.
 */
export async function handleJournalReply(remoteJid: string, text: string): Promise<boolean> {
  const s = readSession();
  if (!s || s.remoteJid !== remoteJid) return false;
  if (Date.now() - new Date(s.startedAt).getTime() > EXPIRY_MS) {
    deleteMemory(MEM_GROUP, ACTIVE_KEY); // stale — let it fall through to normal handling
    return false;
  }

  const lower = text.trim().toLowerCase();
  if (CANCEL_WORDS.has(lower)) {
    deleteMemory(MEM_GROUP, ACTIVE_KEY);
    await sendMessage(remoteJid, 'No worries — paused. We can pick it up whenever.');
    return true;
  }

  const prompts = PROMPTS[s.phase];
  s.answers[prompts[s.step].key] = lower === 'skip' ? '' : text.trim();
  s.step += 1;

  if (s.step < prompts.length) {
    setMemory(MEM_GROUP, ACTIVE_KEY, JSON.stringify(s));
    await sendMessage(remoteJid, prompts[s.step].q);
    return true;
  }

  // Finished — file it and close out.
  deleteMemory(MEM_GROUP, ACTIVE_KEY);
  try {
    await writeDailyNote(s.phase, s.dateISO, s.answers);
    await sendMessage(remoteJid, s.phase === 'morning' ? 'Filed in your journal. Go get it ☀️' : 'Filed — poem and all. Night 🌙');
    void retryUnfiled(); // Notion is clearly up — drain any stranded entries too
  } catch (err) {
    console.error('[Journal] Notion write failed:', err);
    await sendMessage(remoteJid, "Got everything — but I couldn't file it to Notion just now. I've kept your answers; I'll retry.");
    // Re-stash so a later retry/inspection is possible without re-prompting.
    setMemory(MEM_GROUP, `unfiled_${s.dateISO}_${s.phase}`, JSON.stringify(s.answers));
  }
  return true;
}

/** Start a morning/evening session: send the first prompt and stash state. */
export async function startJournalSession(phase: Phase): Promise<void> {
  if (!ENABLED) return;
  if (!notionEnabled() || !JOURNAL_DB) {
    console.log('[Journal] skipped — Notion/journal DB not configured');
    return;
  }
  const target = getDefaultRecipient();
  if (!target) return;
  void retryUnfiled(); // fire-and-forget so a Notion outage never delays the first prompt
  if (getMemory(MEM_GROUP, ACTIVE_KEY)) {
    console.log(`[Journal] a session is already active — not starting ${phase}`);
    return;
  }
  const session: Session = {
    phase, step: 0, answers: {}, remoteJid: target, dateISO: todayET(), startedAt: new Date().toISOString(),
  };
  setMemory(MEM_GROUP, ACTIVE_KEY, JSON.stringify(session));
  await sendMessage(target, PROMPTS[phase][0].q);
  console.log(`[Journal] started ${phase} session`);
}

export function startJournal(): void {
  if (!ENABLED) {
    console.log('[Journal] disabled via JOURNAL_ENABLED=false');
    return;
  }
  scheduleCron(MORNING_CRON, () => { void startJournalSession('morning'); });
  scheduleCron(EVENING_CRON, () => { void startJournalSession('evening'); });
  console.log(`[Journal] Registered: morning ${MORNING_CRON}, evening ${EVENING_CRON} (local)`);
}
