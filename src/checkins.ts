import { scheduleCron } from './lib/cron.js';
import { getMemory, setMemory, deleteMemory, getRecentMemory, logOutbound } from './db.js';
import { openItems } from './jobs.js';
import { sendMessage, getDefaultRecipient } from './channels/imessage.js';
import { collectAmbientItems, clearAmbient, saveDetails, trimToLines } from './cos-outbound.js';
import { OPENAI_ROUTER_MODEL, openAIText } from './lib/openai.js';
import { withLlmContext } from './lib/llm-context.js';
import { toPlainText } from './lib/plaintext.js';
import { todayET } from './lib/time-et.js';
import { getTimezone } from './config.js';

// ============================================================
// CHECK-INS — the two times a day the bot talks to the owner
// without being asked (plus the few true interrupts that
// cos-outbound lets through).
//
// Everything non-urgent is staged here instead of texted: the
// 6:30 calendar prep, the inbox-zero pass, the evening wrap,
// weekly reports, and every nudge/decision the arbiter defers.
// At check-in time it is compressed into ONE short message with
// a fixed shape (headline, numbered items, reply hint). Nothing
// staged means nothing sent. The full text is kept so "more"
// can show it.
//
// Why: one iMessage thread is the only channel. A day of
// separate long messages from separate jobs read as a wall of
// text. The owner asked for fewer, shorter, scannable messages.
// ============================================================

const GROUP = 'cos-checkin';
const SECTION_PREFIX = 'section:';
const LAST_SENT_KEY = 'last_sent';
/** Hard ceiling on a delivered check-in, after composing. */
export const CHECKIN_MAX_CHARS = 700;
const MAX_ITEMS = 5;

export type CheckinSlot = 'morning' | 'evening';

interface Section { source: string; subject: string; text: string; at: string }

/**
 * Stage a full report (an agent brief, a weekly summary) for the next check-in.
 * Same subject replaces the earlier version, so a job that runs twice before a
 * check-in never shows up twice.
 */
export function stageSection(source: string, subject: string, text: string): void {
  const plain = toPlainText(text).trim();
  if (!plain) return;
  const section: Section = { source, subject, text: plain.slice(0, 8000), at: new Date().toISOString() };
  setMemory(GROUP, `${SECTION_PREFIX}${subject}`, JSON.stringify(section));
}

function collectSections(): { key: string; section: Section }[] {
  return getRecentMemory(GROUP, { prefix: SECTION_PREFIX, limit: 30 })
    .map((e) => {
      try { return { key: e.key, section: JSON.parse(e.value) as Section }; } catch { return null; }
    })
    .filter((x): x is { key: string; section: Section } => Boolean(x));
}

const FORMAT_RULES = `Format rules (the reader skims this on a phone lock screen):
- Plain text only. No markdown, no asterisks, no headers, no links unless essential.
- Line 1: one emoji + a headline of 8 words or fewer: the single most important thing.
- Blank line, then at most ${MAX_ITEMS} numbered items, most important first. Each item is ONE line, under 80 characters, starts with the topic emoji, and says what to do or know. Topic emoji: 📅 calendar, ✅ task, 📧 email, 💼 work/business, 💰 money, 👥 people, 🏠 home/family.
- Keep reference tags exactly as written (#686, #fact:12, #person:4, #action:25) on the items that have them, so replies like "done #fact:12" still work.
- Only include things that need the reader's attention or change what they do today/tomorrow. Drop status reports, counts, "all clear", "nothing new", and anything the machine already handled.
- Blank line, then one reply hint line, e.g.: ↩ "done 2" · "snooze 3" · "more"
- Whole message under ${CHECKIN_MAX_CHARS - 100} characters.
- If NOTHING needs attention, output exactly: NOTHING`;

export async function composeCheckin(slot: CheckinSlot, material: string): Promise<string | null> {
  const raw = await withLlmContext({ caller: `checkin:${slot}`, lane: 'ambient' }, () => openAIText({
    model: OPENAI_ROUTER_MODEL,
    system: `You write the owner's ${slot} check-in: one short text message that replaces a pile of separate reports.\n\n${FORMAT_RULES}`,
    prompt: `Today is ${todayET()}. Material staged since the last check-in:\n\n${material}`,
    maxOutputTokens: 1200,
    // Reasoning tokens count against the output cap; with it on, the message
    // was sometimes cut mid-item or came back empty.
    reasoningEffort: 'none',
  }));
  const text = toPlainText(raw).trim();
  if (!text || /^NOTHING\b/.test(text)) return null;
  return finishCheckin(text);
}

/** Drop a cut-off final item, guarantee the reply hint, enforce the length cap. */
export function finishCheckin(text: string): string {
  const lines = text.split('\n').map((l) => l.trimEnd());
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const last = lines[lines.length - 1] ?? '';
  const hasHint = /^↩/.test(last);
  // A numbered item that is only its number/emoji, or has no sentence-ish ending
  // while being the final line, is the tail of a truncated reply.
  if (!hasHint && lines.length > 1 && /^\d+\.\s*\S{0,3}\s*$/u.test(last)) lines.pop();
  if (!hasHint) lines.push('', '↩ "more"');
  const out = lines.join('\n');
  return out.length > CHECKIN_MAX_CHARS ? trimToLines(out, CHECKIN_MAX_CHARS) : out;
}

/** Deterministic fallback when the composer is unavailable. */
function fallback(slot: CheckinSlot, sections: Section[], ambient: string[]): string {
  const items = [
    ...sections.map((s) => s.text.split('\n').find((l) => l.trim().length > 0)?.trim() ?? ''),
    ...ambient,
  ].filter(Boolean).slice(0, MAX_ITEMS).map((l, i) => `${i + 1}. ${l.slice(0, 90)}`);
  return trimToLines(`📋 ${slot === 'morning' ? 'Morning' : 'Evening'} check-in\n\n${items.join('\n')}\n\n↩ "more"`, CHECKIN_MAX_CHARS);
}

export interface CheckinDeps {
  send: (to: string, text: string) => Promise<void>;
  target: () => string | null | undefined;
  compose: (slot: CheckinSlot, material: string) => Promise<string | null>;
}

const defaultDeps: CheckinDeps = { send: sendMessage, target: getDefaultRecipient, compose: composeCheckin };

/**
 * One line per job still open (src/jobs.ts), so nothing they asked for goes
 * quiet: waiting-on-you first, then what's being worked on. An errand waiting
 * on them is already staged as a decision, so it's skipped here.
 */
function openErrandLines(): string[] {
  try {
    return openItems()
      .filter((i) => !(i.key.startsWith('errand:') && i.status === 'waiting_on_you'))
      .slice(0, 5)
      .map((i) => `${i.status === 'waiting_on_you' ? '⏳' : i.status === 'watching' ? '👀' : '🔧'} ${i.line}`);
  } catch {
    return [];
  }
}

/** Compose and deliver one check-in. Returns what was sent, or null when there was nothing. */
export async function runCheckin(slot: CheckinSlot, deps: CheckinDeps = defaultDeps): Promise<string | null> {
  const to = deps.target();
  if (!to) return null;
  const sectionRows = collectSections();
  const sections = sectionRows.map((r) => r.section);
  const ambientItems = collectAmbientItems();
  const ambient = [...ambientItems.map((i) => i.line), ...openErrandLines()];
  if (!sections.length && !ambient.length) {
    console.log(`[checkin] ${slot}: nothing staged, staying quiet`);
    return null;
  }

  const material = [
    ...sections.map((s) => `### ${s.source} (${s.subject})\n${s.text}`),
    ...ambientItems.filter((i) => i.detail).map((i) => `### ${i.source} (${i.subject ?? 'queued'})\n${i.detail}`),
    ambientItems.some((i) => !i.detail)
      ? `### Queued one-liners\n${ambientItems.filter((i) => !i.detail).map((i) => `- ${i.line}`).join('\n')}`
      : '',
    openErrandLines().length ? `### Jobs in progress (waiting on them first)\n${openErrandLines().map((l) => `- ${l}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  let text: string | null;
  try {
    text = await deps.compose(slot, material);
  } catch (err) {
    console.error(`[checkin] ${slot} composer failed, using fallback:`, err);
    text = fallback(slot, sections, ambient);
  }

  // Whatever happens next, the staged material is consumed: a quiet check-in
  // means the composer judged none of it worth their attention, and re-offering
  // it at the next slot is how the old briefs piled up.
  saveDetails(material);
  for (const r of sectionRows) deleteMemory(GROUP, r.key);
  clearAmbient();

  const subjects = [...new Set([...sections.map((s) => s.subject), ...ambientItems.map((i) => i.subject ?? `ambient:${i.source}`)])];
  const log = (decision: 'sent' | 'held' | 'failed', reason: string | null, body: string) => {
    try {
      logOutbound({
        source: `checkin:${slot}`, subject: `checkin:${slot}:${todayET()}`, kind: 'status',
        target: to, decision, reason, would_hold: 0, bypass: null, mode: 'checkin',
        text_preview: `${body.slice(0, 300)} [covers: ${subjects.join(', ').slice(0, 90)}]`,
        text_hash: '', char_count: body.length,
      });
    } catch (err) {
      console.error('[checkin] outbound_log write failed:', err);
    }
  };

  if (!text) {
    console.log(`[checkin] ${slot}: composer found nothing worth sending`);
    log('held', 'nothing-actionable', '');
    return null;
  }
  try {
    await deps.send(to, text);
    setMemory(GROUP, LAST_SENT_KEY, JSON.stringify({ at: new Date().toISOString(), text }));
    log('sent', null, text);
    return text;
  } catch (err) {
    console.error(`[checkin] ${slot} send failed:`, err);
    log('failed', 'send-failed', text);
    return null;
  }
}

export function startCheckins(): void {
  const morning = process.env.COS_CHECKIN_MORNING_CRON || '30 8 * * *';
  const evening = process.env.COS_CHECKIN_EVENING_CRON || '0 18 * * *';
  scheduleCron(morning, () => { void runCheckin('morning'); });
  scheduleCron(evening, () => { void runCheckin('evening'); });
  console.log(`[checkin] scheduled morning "${morning}", evening "${evening}" (${getTimezone()})`);
}

/** The last check-in with when it went out, if within `hours`. */
export function getRecentCheckinMeta(hours = 12): { at: number; text: string } | null {
  const raw = getMemory(GROUP, LAST_SENT_KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { at: string; text: string };
    const at = new Date(d.at).getTime();
    return Date.now() - at < hours * 3600_000 ? { at, text: d.text } : null;
  } catch {
    return null;
  }
}

/** The last check-in text if sent within `hours`, so a terse reply ("done 2") can be resolved. */
export function getRecentCheckin(hours = 12): string | null {
  const raw = getMemory(GROUP, LAST_SENT_KEY);
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as { at: string; text: string };
    return Date.now() - new Date(d.at).getTime() < hours * 3600_000 ? d.text : null;
  } catch {
    return null;
  }
}
