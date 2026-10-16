// How the owner talks with people, from Omi ("use this to understand how I'm speaking
// and interacting with others to improve myself"). Every real conversation the Omi sync
// reads gets free, counted numbers (how much they talked, longest stretch, questions,
// fillers, hedges). Work calls of OMI_DEBRIEF_MIN+ minutes also get a short debrief in the
// next check-in, a Sunday summary compares the week with the one before, and
// review_my_speaking answers "how did I do in the call with Jordan?". Owner-only throughout.

import { scheduleCron } from './lib/cron.js';
import db from './db.js';
import { getMemory, setMemory } from './db.js';
import { stageSection } from './checkins.js';
import { getOwner, getTimezone } from './config.js';
import { OPENAI_MODEL, openAIText } from './lib/openai.js';
import { withLlmContext } from './lib/llm-context.js';
import { parseNumEnv, parseBoolEnv } from './lib/env.js';
import { extractFirstJson } from './lib/daemon.js';
import { compactTranscript, parseSegments, recordingQuality, wordCount, type Segment } from './lib/omi-transcript.js';
import type { ToolDef } from './tools/index.js';

export interface SpeakingMetrics {
  minutes: number;
  ownerWords: number;
  theirWords: number;
  talkShare: number;
  ownerTurns: number;
  theirTurns: number;
  longestTurnWords: number;
  longestTurnSecs: number;
  questions: number;
  theirQuestions: number;
  fillers: number;
  repeats: number;
  hedges: number;
  sorries: number;
  topFillers: Array<[string, number]>;
  wpm: number | null;
}
export interface Coaching { headline: string; went_well: string[]; moments: Array<{ quote: string; better: string; why?: string }>; habit: string }
export interface TalkInfo { real?: boolean; setting?: string; with?: string[] }
export interface ConvoRef { id: string; title: string; start?: string; end?: string; when?: string }

const FILLERS: Array<[string, RegExp]> = [
  ['um', /\bu+m+\b/gi],
  ['uh', /\bu+h+\b/gi],
  ['you know', /\byou know\b/gi],
  ['I mean', /\bI mean\b/gi],
  ['kind of', /\bkind of\b|\bkinda\b/gi],
  ['sort of', /\bsort of\b/gi],
  ['basically', /\bbasically\b/gi],
  ['literally', /\bliterally\b/gi],
  ['like', /,\s*like\b|\blike,/gi],
];
const HEDGES = /\b(I think|I guess|maybe|probably|I feel like|just)\b/gi;
const REPEAT = /\b([\p{L}']+)(\s+\1\b)+/giu;
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

/** Counted numbers for one conversation. Turns are back-to-back lines from the owner or from the others. */
export function speakingMetrics(segs: Segment[]): SpeakingMetrics {
  const turns: Array<{ own: boolean; text: string; start: number; end: number }> = [];
  for (const s of segs) {
    const last = turns[turns.length - 1];
    if (last && last.own === s.isUser) { last.text += ` ${s.text}`; last.end = Math.max(last.end, s.end); }
    else turns.push({ own: s.isUser, text: s.text, start: s.start, end: s.end });
  }
  const own = turns.filter((t) => t.own);
  const theirs = turns.filter((t) => !t.own);
  const ownerText = own.map((t) => t.text).join(' ');
  const ownerWords = wordCount(ownerText);
  const theirWords = wordCount(theirs.map((t) => t.text).join(' '));
  const fillerCounts = FILLERS.map(([name, re]) => [name, count(ownerText, re)] as [string, number]);
  const speakingSecs = segs.filter((s) => s.isUser && s.end > s.start && s.end - s.start < 90).reduce((n, s) => n + (s.end - s.start), 0);
  const times = segs.flatMap((s) => [s.start, s.end]).filter((t) => t > 0);
  const longest = own.reduce((best, t) => (wordCount(t.text) > wordCount(best?.text ?? '') ? t : best), own[0]);
  return {
    minutes: times.length ? Math.round(((Math.max(...times) - Math.min(...times)) / 60) * 10) / 10 : 0,
    ownerWords,
    theirWords,
    talkShare: ownerWords + theirWords ? ownerWords / (ownerWords + theirWords) : 0,
    ownerTurns: own.length,
    theirTurns: theirs.length,
    longestTurnWords: longest ? wordCount(longest.text) : 0,
    longestTurnSecs: longest ? Math.max(0, Math.round(longest.end - longest.start)) : 0,
    questions: own.filter((t) => t.text.includes('?')).length,
    theirQuestions: theirs.filter((t) => t.text.includes('?')).length,
    fillers: fillerCounts.reduce((n, [, c]) => n + c, 0),
    repeats: count(ownerText, REPEAT),
    hedges: count(ownerText, HEDGES),
    sorries: count(ownerText, /\bsorry\b/gi),
    topFillers: fillerCounts.filter(([, c]) => c > 0).sort((a, b) => b[1] - a[1]).slice(0, 3),
    wpm: speakingSecs >= 60 ? Math.round(ownerWords / (speakingSecs / 60)) : null,
  };
}

/** Worth coaching: the owner and someone else both really talked. */
export function isRealTalk(m: SpeakingMetrics): boolean {
  return m.ownerWords >= 60 && m.theirWords >= 40 && m.minutes >= 2;
}

const per100 = (n: number, words: number) => (words ? Math.round((n / words) * 1000) / 10 : 0);
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function numbersLine(m: SpeakingMetrics): string {
  const fillers = m.topFillers.length ? ` (mostly ${m.topFillers.map(([w]) => `"${w}"`).join(', ')})` : '';
  return [
    `you talked ${pct(m.talkShare)} of the time`,
    `longest stretch ${m.longestTurnSecs}s (${m.longestTurnWords} words)`,
    `you asked ${m.questions} question${m.questions === 1 ? '' : 's'}, they asked ${m.theirQuestions}`,
    `${per100(m.fillers, m.ownerWords)} fillers per 100 words${fillers}`,
  ].join(' · ');
}

// ── storage ──────────────────────────────────────────────────────────────────
db.exec(`CREATE TABLE IF NOT EXISTS speech_reviews (
  conversation_id TEXT PRIMARY KEY,
  started_at      TEXT,
  title           TEXT,
  setting         TEXT,
  with_names      TEXT,
  minutes         REAL,
  metrics_json    TEXT NOT NULL,
  coaching_json   TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
)`);

export interface SpeechRow { conversation_id: string; started_at: string | null; title: string; setting: string | null; with_names: string | null; minutes: number; metrics_json: string; coaching_json: string | null }

function saveRow(card: ConvoRef, talk: TalkInfo | undefined, m: SpeakingMetrics): void {
  db.prepare(`INSERT INTO speech_reviews (conversation_id, started_at, title, setting, with_names, minutes, metrics_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET metrics_json = excluded.metrics_json, setting = COALESCE(excluded.setting, setting), with_names = COALESCE(excluded.with_names, with_names)`)
    .run(card.id, card.start || card.when || null, card.title, talk?.setting ?? null, talk?.with?.length ? talk.with.join(', ') : null, m.minutes, JSON.stringify(m));
}
function saveCoaching(id: string, c: Coaching): void {
  db.prepare('UPDATE speech_reviews SET coaching_json = ? WHERE conversation_id = ?').run(JSON.stringify(c), id);
}
export function rowsBetween(fromIso: string, toIso: string): SpeechRow[] {
  return db.prepare('SELECT * FROM speech_reviews WHERE started_at >= ? AND started_at < ? ORDER BY started_at').all(fromIso, toIso) as SpeechRow[];
}
function rowById(id: string): SpeechRow | undefined {
  return db.prepare('SELECT * FROM speech_reviews WHERE conversation_id = ?').get(id) as SpeechRow | undefined;
}

// ── coaching (one model call per conversation) ───────────────────────────────
export interface CoachDeps {
  call: (tool: string, args: Record<string, unknown>) => Promise<string>;
  complete: (system: string, prompt: string) => Promise<string>;
  stage: typeof stageSection;
  now: () => number;
}
const defaultDeps: CoachDeps = {
  call: async (tool, args) => (await import('./omi-sync.js')).omiCall(tool, args),
  complete: (system, prompt) => withLlmContext({ caller: 'speech-coach', lane: 'batch' }, () =>
    openAIText({ model: OPENAI_MODEL, system, prompt, maxOutputTokens: 1400, reasoningEffort: 'low' })),
  stage: stageSection,
  now: () => Date.now(),
};
let deps = defaultDeps;
export function setCoachDeps(over: Partial<CoachDeps> | null): void { deps = over ? { ...defaultDeps, ...over } : defaultDeps; }

export function coachPrompt(card: ConvoRef, setting: string, withNames: string, m: SpeakingMetrics, transcript: string): { system: string; prompt: string } {
  const owner = getOwner().name;
  const system = `You coach ${owner} on how they talk with people, from the transcript of one real conversation. "You:" lines are ${owner}; "Speaker N" lines are the others (the labels can be wrong: if the "You" lines are clearly someone else, say so in the headline and leave the rest empty).
Be specific, kind and direct. Plain words, no jargon. Quote their exact words, short. Use only the numbers given; don't invent others. Never judge the other people.
For work: listening before pitching, asking about their goals, short clear answers, handling pushback, confident wording (hedges, apologies), fillers, a clear next step at the end.
For family and kids: patience, short clear instructions, praising effort, listening, warmth.
Reply with JSON only: {"headline": "one sentence on how it went", "went_well": ["1-2 specific things"], "moments": [{"quote": "their words", "better": "what to say instead", "why": "a few words"}], "habit": "one thing to practice next time"}. 2-3 moments.`;
  const prompt = `Conversation: "${card.title}"${card.start ? `, ${card.start.slice(0, 16).replace('T', ' ')} UTC` : ''}, ${m.minutes} min, setting: ${setting}${withNames ? `, with ${withNames}` : ''}.
Numbers: ${numbersLine(m)}; ${per100(m.repeats, m.ownerWords)} repeated words per 100; ${per100(m.hedges, m.ownerWords)} hedges per 100; "sorry" ${m.sorries} times${m.wpm ? `; about ${m.wpm} words a minute` : ''}.

TRANSCRIPT:
${transcript}`;
  return { system, prompt };
}

const unquote = (s: string) => String(s).trim().replace(/^["“”']+|["“”']+$/g, '').trim();

export function parseCoaching(raw: string): Coaching | null {
  const json = extractFirstJson(raw, '{', '}');
  if (!json) return null;
  try {
    const c = JSON.parse(json) as Partial<Coaching>;
    if (!c.headline) return null;
    return {
      headline: String(c.headline),
      went_well: (c.went_well ?? []).map(String).slice(0, 2),
      // The model often wraps quotes in its own quote marks ("\"I'll do…\"" came out doubled).
      moments: (c.moments ?? []).filter((x) => x?.quote && x?.better).slice(0, 3)
        .map((x) => ({ ...x, quote: unquote(x.quote), better: unquote(x.better) })),
      habit: String(c.habit ?? ''),
    };
  } catch { return null; }
}

export function formatReview(row: Pick<SpeechRow, 'title' | 'started_at' | 'with_names'>, m: SpeakingMetrics, c: Coaching | null): string {
  const day = row.started_at ? new Date(row.started_at).toLocaleDateString('en-US', { weekday: 'short', timeZone: getTimezone() }) : '';
  const lines = [`${row.title} (${[day, `${Math.round(m.minutes)} min`, row.with_names ? `with ${row.with_names}` : ''].filter(Boolean).join(', ')})`];
  if (c?.headline) lines.push(c.headline);
  lines.push(`Numbers: ${numbersLine(m)}.`);
  if (c?.went_well.length) lines.push(`Went well: ${c.went_well.join(' ')}`);
  if (c?.moments.length) {
    lines.push('Try instead:');
    for (const x of c.moments) lines.push(`- You said "${x.quote}" → "${x.better}"${x.why ? ` (${x.why})` : ''}`);
  }
  if (c?.habit) lines.push(`Practice next time: ${c.habit}`);
  return lines.join('\n');
}

async function coach(card: ConvoRef, setting: string, withNames: string, m: SpeakingMetrics, segs: Segment[]): Promise<Coaching | null> {
  const { system, prompt } = coachPrompt(card, setting, withNames, m, compactTranscript(segs, 30_000));
  const c = parseCoaching(await deps.complete(system, prompt));
  if (c) saveCoaching(card.id, c);
  return c;
}

/**
 * Called by the Omi sync for each conversation it reads. Saves the numbers for real
 * conversations; a long work call also gets a debrief staged for the next check-in.
 */
export async function recordConversation(card: ConvoRef, segs: Segment[], talk?: TalkInfo): Promise<SpeakingMetrics | null> {
  // Only what the reader called a real conversation: a show with two voices isn't one.
  if (talk?.real !== true || !segs.length) return null;
  const m = speakingMetrics(segs);
  if (!isRealTalk(m)) return null;
  saveRow(card, talk, m);
  const debriefMin = parseNumEnv('OMI_DEBRIEF_MIN', 15);
  if (!parseBoolEnv('SPEECH_DEBRIEF', true) || talk?.setting !== 'work' || m.minutes < debriefMin) return m;
  const dayKey = `debriefs:${new Date(deps.now()).toISOString().slice(0, 10)}`;
  const done = Number(getMemory('speech-coach', dayKey) ?? '0');
  if (done >= parseNumEnv('SPEECH_DEBRIEFS_PER_DAY', 3)) return m;
  setMemory('speech-coach', dayKey, String(done + 1));
  const c = await coach(card, 'work', talk?.with?.join(', ') ?? '', m, segs);
  const row = rowById(card.id);
  if (row) deps.stage('speech-coach', `speech-coach:call:${card.id}`, `🗣 How the "${card.title}" call went\n${formatReview(row, m, c)}`);
  return m;
}

// ── the week ─────────────────────────────────────────────────────────────────
interface Agg { convos: number; minutes: number; talkShare: number; fillers100: number; questions10: number; longest: number; longestTitle: string }
function aggregate(rows: SpeechRow[]): Agg | null {
  if (!rows.length) return null;
  const ms = rows.map((r) => JSON.parse(r.metrics_json) as SpeakingMetrics);
  const own = ms.reduce((n, m) => n + m.ownerWords, 0);
  const all = ms.reduce((n, m) => n + m.ownerWords + m.theirWords, 0);
  const minutes = ms.reduce((n, m) => n + m.minutes, 0);
  const longestIdx = ms.reduce((bi, m, i) => (m.longestTurnSecs > ms[bi].longestTurnSecs ? i : bi), 0);
  return {
    convos: rows.length,
    minutes,
    talkShare: all ? own / all : 0,
    fillers100: per100(ms.reduce((n, m) => n + m.fillers, 0), own),
    questions10: minutes ? Math.round((ms.reduce((n, m) => n + m.questions, 0) / minutes) * 100) / 10 : 0,
    longest: ms[longestIdx].longestTurnSecs,
    longestTitle: rows[longestIdx].title,
  };
}
const was = (before: number | undefined, fmt: (n: number) => string) => (before === undefined ? '' : ` (week before: ${fmt(before)})`);

export async function weeklySpeakingReport(days = 7): Promise<string | null> {
  const now = deps.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const rows = rowsBetween(iso(now - days * 86_400_000), iso(now + 60_000));
  if (!rows.length) return null;
  const prev = rowsBetween(iso(now - 2 * days * 86_400_000), iso(now - days * 86_400_000));
  const lines = [`${rows.length} real conversations, about ${Math.round(rows.reduce((n, r) => n + r.minutes, 0) / 6) / 10} hours.`];
  for (const setting of ['work', 'family', 'social']) {
    const a = aggregate(rows.filter((r) => (r.setting ?? 'other') === setting));
    if (!a) continue;
    const b = aggregate(prev.filter((r) => (r.setting ?? 'other') === setting)) ?? undefined;
    lines.push(`${setting[0].toUpperCase()}${setting.slice(1)} (${a.convos}): you talked ${pct(a.talkShare)}${was(b?.talkShare, pct)}, ${a.fillers100} fillers per 100 words${was(b?.fillers100, String)}, ${a.questions10} questions per 10 min${was(b?.questions10, String)}. Longest stretch: ${a.longest}s (${a.longestTitle}).`);
  }
  // Coaching for the biggest work call and the biggest family moment, reusing a debrief if one ran.
  const pick = (setting: string) => rows.filter((r) => r.setting === setting).sort((x, y) => y.minutes - x.minutes)[0];
  let habit = '';
  for (const r of [pick('work'), pick('family')].filter((x): x is SpeechRow => Boolean(x))) {
    const m = JSON.parse(r.metrics_json) as SpeakingMetrics;
    let c = r.coaching_json ? (JSON.parse(r.coaching_json) as Coaching) : null;
    if (!c) {
      const segs = parseSegments(await deps.call('get_conversation_by_id', { conversation_id: r.conversation_id, max_chars: 40_000, max_segments: 500 }));
      if (segs.length) c = await coach({ id: r.conversation_id, title: r.title, start: r.started_at ?? undefined }, r.setting ?? 'other', r.with_names ?? '', m, segs);
    }
    lines.push('', formatReview(r, m, c));
    if (!habit && c?.habit) habit = c.habit;
  }
  if (habit) lines.push('', `Focus this week: ${habit}`);
  return lines.join('\n');
}

export function startSpeechCoach(): void {
  if (!parseBoolEnv('SPEECH_COACH_ENABLED', true)) return;
  const expr = process.env.SPEECH_COACH_CRON || '50 6 * * 0'; // before Sunday's morning check-in
  scheduleCron(expr, () => {
    void weeklySpeakingReport()
      .then((report) => { if (report) stageSection('speech-coach', 'speech-coach:weekly', `🗣 How you talked this week\n${report}`); })
      .catch((err) => console.warn('[speech-coach] weekly report failed:', err instanceof Error ? err.message : err));
  });
  console.log(`[speech-coach] weekly report "${expr}" (local time)`);
}

// ── on demand ────────────────────────────────────────────────────────────────
interface Card { id: string; title: string; start: string; end: string }
function cardsFrom(text: string): Card[] {
  try {
    const list = (JSON.parse(text) as { conversations?: Array<Record<string, unknown>> }).conversations ?? [];
    return list.map((c) => ({
      id: String(c.id ?? ''),
      title: String((c.structured as { title?: string } | undefined)?.title ?? c.title ?? 'a conversation'),
      start: String(c.started_at ?? c.created_at ?? ''),
      end: String(c.finished_at ?? ''),
    })).filter((c) => c.id);
  } catch { return []; }
}
const length = (c: Card) => (Date.parse(c.end) || 0) - (Date.parse(c.start) || 0);

export async function reviewOnDemand(input: { about?: string; date?: string; days?: number }): Promise<string> {
  if (input.days) return (await weeklySpeakingReport(Math.min(Math.max(1, input.days), 31))) ?? 'No real conversations recorded in that stretch yet.';
  const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : undefined;
  const range = date ? { start_date: date, end_date: date } : {};
  const text = input.about
    ? await deps.call('search_conversations', { query: input.about, limit: 10, ...range })
    : await deps.call('get_conversations', { limit: 50, ...(date ? range : { start_date: new Date(deps.now() - 86_400_000).toISOString().slice(0, 10) }) });
  const cards = cardsFrom(text).sort((a, b) => length(b) - length(a)).slice(0, 4);
  const done = cards.map((c) => rowById(c.id)).find((r) => r?.coaching_json);
  if (done) return formatReview(done, JSON.parse(done.metrics_json), JSON.parse(done.coaching_json!));
  // The same call is often recorded twice: read the candidates, keep the cleanest real one.
  let best: { card: Card; segs: Segment[]; m: SpeakingMetrics; q: number } | null = null;
  for (const card of cards) {
    const segs = parseSegments(await deps.call('get_conversation_by_id', { conversation_id: card.id, max_chars: 40_000, max_segments: 500 }));
    const m = speakingMetrics(segs);
    if (!isRealTalk(m)) continue;
    const q = recordingQuality(segs);
    if (!best || q > best.q) best = { card, segs, m, q };
  }
  if (best) {
    const { card, segs, m } = best;
    const stored = rowById(card.id);
    const ref = { id: card.id, title: card.title, start: card.start };
    saveRow(ref, stored ? { setting: stored.setting ?? undefined, with: stored.with_names?.split(', ') } : undefined, m);
    const c = await coach(ref, stored?.setting ?? 'work', stored?.with_names ?? '', m, segs);
    return formatReview(rowById(card.id) ?? { title: card.title, started_at: card.start, with_names: null }, m, c);
  }
  return cards.length ? 'I found it, but there isn\'t enough two-way talk in the recording to review.' : 'I couldn\'t find that conversation in Omi.';
}

export const speechCoachTools: ToolDef[] = [{
  definition: {
    name: 'review_my_speaking',
    description: `Coach the owner on how they talk with people, from their Omi recordings: how much they talked vs listened, longest stretch, questions, fillers, and 2-3 specific "you said X, try Y" moments plus one habit. USE WHEN they ask "how did I do in the call with Jordan?", "how was I with the kids this morning?", "how am I talking this week?". Pass "about" (who or what the conversation was) and/or "date" (YYYY-MM-DD) for one conversation, or "days" for a summary over that many days. Read the result back in plain words.`,
    input_schema: {
      type: 'object' as const,
      properties: {
        about: { type: 'string', description: 'Who or what the conversation was about, e.g. "demo call with Jordan"' },
        date: { type: 'string', description: 'YYYY-MM-DD of the conversation (optional)' },
        days: { type: 'number', description: 'Summarize this many days instead of one conversation' },
      },
    },
  },
  handler: async (input, context) => {
    if (!context?.userId || context.userId !== getOwner().id) return 'This is private to the owner.';
    try {
      return await reviewOnDemand(input as { about?: string; date?: string; days?: number });
    } catch (err) {
      return `Couldn't review it: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
}];
