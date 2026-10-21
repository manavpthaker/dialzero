// The practice line (call review step 2). Each call fix used to be judged on a
// handful of real calls, and the only practice call (the NIST time line) checks that
// the phone link works, not how the assistant behaves. This is a scripted
// "ABC Roofing" that answers the assistant's call one of six ways, so each change can
// be checked against the moments real calls die on:
//   hello      a person says "Hello?" and waits
//   greeting   a long greeting ("Thanks for calling ABC Roofing, this is Dana…")
//   menu       a phone menu; press 0 for the operator
//   hold       "please hold", music, then a person comes back
//   voicemail  a greeting, then a beep
//   hangup     they hang up halfway through the assistant's intro
// Twilio plays the scenes (TwiML on the /twilio/voice path phone.ts already serves);
// the "person" answers the assistant's turns from a short script. Each call is a
// silent practice errand, and the grade comes from call_log: one intro, silent on the
// menu, hold and greeting, the right key, the right result.
//
// The line is PRACTICE_LINE_NUMBER, or the assistant's own TWILIO_NUMBER when that's
// unset (it calls itself; scenes only answer while one is armed and the call comes
// from its number). `npm run practice` runs it; the morning check runs one scene a day.

import { createErrand, getErrand, getMemory, setMemory, getRecentMemory, updateErrand } from './db.js';
import { lastCallFor, type CallLogRow } from './call-log.js';
import { normalizePhone } from './lib/phone.js';
import { todayET } from './lib/time-et.js';
import { getBotName, getOwner } from './config.js';

export type Scene = 'hello' | 'greeting' | 'menu' | 'hold' | 'voicemail' | 'hangup';
export const SCENES: Scene[] = ['hello', 'greeting', 'menu', 'hold', 'voicemail', 'hangup'];
const GROUP = 'practice';
const VOICE = 'Polly.Joanna';
const HOLD_MUSIC = 'http://com.twilio.sounds.music.s3.amazonaws.com/MARKOVICHAMP-Borghestral.mp3';
/** How long the hold scene keeps the caller on hold before a person comes back. */
export const HOLD_MS = 25_000;
/**
 * The "person" answers this many seconds after the assistant stops talking. Twilio's
 * "auto" took ~10s, so every turn had a long dead gap.
 */
const PERSON_PAUSE_S = '1';
/**
 * After their goodbye the person stays on the line this long, so the assistant can say
 * bye and record the result. Hanging up at once cut off "you're all set" before the
 * assistant heard it, so a good call graded as a fail.
 */
const GOODBYE_WAIT_S = 6;

/** What the "person" says to each of the assistant's turns, in order; then goodbye. */
export const DIALOG = [
  'Sure, I can help with that. We have Thursday at 4, or Friday at 10. Which works better?',
  'Okay. And what name should I put that under?',
  "Perfect, you're all set. Thanks for calling, bye now.",
];

const env = (k: string) => (process.env[k] ?? '').trim();
/** The number the assistant dials for practice, E.164. */
export function practiceNumber(): string { return env('PRACTICE_LINE_NUMBER') || env('TWILIO_NUMBER'); }

// ── Arming: which scene answers the next practice call ──────────────────────
// Practice calls run one at a time, in this process, so one armed scene is enough.
let armed: { scene: Scene; until: number } | null = null;
export function armScene(scene: Scene, ms = 10 * 60_000): void { armed = { scene, until: Date.now() + ms }; }
export function disarm(): void { armed = null; }
export function armedScene(): Scene | null {
  if (armed && armed.until < Date.now()) armed = null;
  return armed?.scene ?? null;
}

/** An inbound Twilio call that is the assistant calling the practice line. */
export function isPracticeCall(params: URLSearchParams): boolean {
  if (!armedScene()) return false;
  const to = normalizePhone(params.get('To') || '');
  const from = normalizePhone(params.get('From') || '');
  const line = normalizePhone(practiceNumber());
  return !!line && to === line && from === normalizePhone(env('TWILIO_NUMBER'));
}

// ── The scenes (TwiML) ──────────────────────────────────────────────────────

const x = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const say = (t: string) => `<Say voice="${VOICE}">${x(t)}</Say>`;
const doc = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;

export interface SceneStep {
  twiml: string;
  /** Redirect the call to this step after `ms` (the hold scene: music, then a person). */
  redirect?: { ms: number; step: string };
}

/**
 * The TwiML for one step of a scene. `base` is the public /twilio/voice URL;
 * `step` is '' for the pickup, else the step name from our own action URLs.
 */
export function sceneStep(scene: Scene, step: string, params: URLSearchParams, base: string): SceneStep {
  const url = (s: string, extra = '') => x(`${base}?step=practice&scene=${scene}&p=${s}${extra}`);
  // The "person": listen for the assistant's turn, then answer it from the script.
  const listen = (turn: number) =>
    `<Gather input="speech" speechTimeout="${PERSON_PAUSE_S}" timeout="10" actionOnEmptyResult="true" action="${url('turn', `&n=${turn}`)}"/>`;
  if (step === 'turn') {
    const n = Number(params.get('n') || 0);
    const heard = (params.get('SpeechResult') || '').trim();
    if (!heard) {
      // Silence: a person asks once, then gives up.
      if (params.get('again')) return { twiml: doc(`${say("I can't hear you. Goodbye.")}<Hangup/>`) };
      return { twiml: doc(`${say('Hello? Are you still there?')}<Gather input="speech" speechTimeout="${PERSON_PAUSE_S}" timeout="8" actionOnEmptyResult="true" action="${url('turn', `&n=${n}&again=1`)}"/>`) };
    }
    if (n >= DIALOG.length - 1) return { twiml: doc(`${say(DIALOG[DIALOG.length - 1])}<Pause length="${GOODBYE_WAIT_S}"/><Hangup/>`) };
    return { twiml: doc(`${say(DIALOG[n])}${listen(n + 1)}`) };
  }
  switch (scene) {
    case 'hello':
      return { twiml: doc(`${say('Hello?')}${listen(0)}`) };
    case 'greeting':
      return { twiml: doc(`${say('Thanks for calling A B C Roofing, this is Dana speaking. How can I help you today?')}${listen(0)}`) };
    case 'menu': {
      if (step === 'choice') {
        const d = params.get('Digits') || '';
        if (d === '0') return { twiml: doc(`${say('Operator, this is Sam. How can I help?')}${listen(0)}`) };
        if (!d && !params.get('tries')) return { twiml: doc(`<Redirect method="POST">${url('', '&tries=1')}</Redirect>`) };
        return { twiml: doc(`${say(d ? 'Sorry, that department is closed right now. Please call back later. Goodbye.' : 'Goodbye.')}<Hangup/>`) };
      }
      const tries = params.get('tries') ? '&tries=1' : '';
      return {
        twiml: doc(`<Gather input="dtmf" numDigits="1" timeout="10" actionOnEmptyResult="true" action="${url('choice', tries)}">${say('Thank you for calling A B C Roofing. For sales, press 1. For billing, press 2. To speak with the operator, press 0.')}</Gather>`),
      };
    }
    case 'hold':
      if (step === 'back') return { twiml: doc(`${say('Thanks for holding, this is Dana. How can I help you?')}${listen(0)}`) };
      return {
        twiml: doc(`${say('Thanks for calling A B C Roofing. All of our team members are with other customers. Please hold.')}<Play loop="0">${HOLD_MUSIC}</Play>`),
        redirect: { ms: HOLD_MS, step: `${base}?step=practice&scene=hold&p=back` },
      };
    case 'voicemail':
      if (step === 'recorded') return { twiml: doc('<Hangup/>') };
      return {
        twiml: doc(`${say("Hi, you've reached A B C Roofing. We can't come to the phone right now. Please leave your name, number, and a brief message after the tone.")}<Record playBeep="true" maxLength="45" timeout="4" trim="trim-silence" action="${url('recorded')}"/>`),
      };
    case 'hangup':
      return { twiml: doc(`${say('Hello?')}<Pause length="4"/><Hangup/>`) };
  }
}

// ── Grading, from the call log ──────────────────────────────────────────────

export interface Grade { scene: Scene; pass: boolean; problems: string[]; detail: string }

interface Line { atMs: number; who: 'Them' | 'Bot'; text: string }
export function parseTimedTranscript(t: string | null): Line[] {
  const out: Line[] = [];
  for (const raw of (t ?? '').split('\n')) {
    const m = raw.match(/^\[(\d+):(\d{2})\] (Them|Bot): (.*)$/);
    if (m) out.push({ atMs: (Number(m[1]) * 60 + Number(m[2])) * 1000, who: m[3] as 'Them' | 'Bot', text: m[4] });
  }
  return out;
}

/** The assistant saying who it is ("this is <name>", "I'm <name>"). */
function introRe(): RegExp {
  const b = getBotName().toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  return new RegExp(`\\b(this is ${b}|i'?m ${b}|${b} here|my name is ${b})\\b`, 'i');
}
/** The line the assistant must wait for before it says anything. */
const WAIT_FOR: Partial<Record<Scene, RegExp>> = {
  greeting: /how can i help/i,
  menu: /operator, this is sam/i,
  hold: /thanks for holding/i,
  voicemail: /after the tone/i,
};

/** Did the assistant behave on this scene? Judged from what happened on the line, not from its own claim. */
export function gradeScene(scene: Scene, row: CallLogRow | null): Grade {
  if (!row) return { scene, pass: false, problems: ['no call was logged (the call never started, or never ended)'], detail: '' };
  const lines = parseTimedTranscript(row.transcript);
  const bot = lines.filter((l) => l.who === 'Bot');
  const them = lines.filter((l) => l.who === 'Them');
  const problems: string[] = [];
  const intro = introRe();
  const intros = bot.filter((l) => intro.test(l.text)).length;

  const anchor = WAIT_FOR[scene];
  if (anchor) {
    const at = them.find((l) => anchor.test(l.text));
    if (!at) problems.push(`never got to "${anchor.source.replace(/\\b|\//g, '')}"`);
    else {
      const early = bot.filter((l) => l.atMs < at.atMs);
      if (early.length) problems.push(`spoke before "${at.text.slice(0, 40)}": "${early[0].text.slice(0, 80)}"`);
    }
  }
  if (scene === 'menu' && !/Pressed 0\b/.test(row.menu ?? '')) problems.push(`didn't press 0 for the operator${row.menu ? ` (${row.menu})` : ''}`);
  if (scene === 'hangup') {
    if (row.end_reason !== 'they_hung_up') problems.push(`end reason was "${row.end_reason}", not "they hung up"`);
    if (row.bot_status === 'done') problems.push('reported the call as done');
  } else {
    if (intros !== 1) problems.push(intros ? `introduced itself ${intros} times` : 'never introduced itself');
    if (scene === 'voicemail') {
      if (row.bot_status !== 'voicemail' && row.verdict !== 'voicemail_left') problems.push(`ended as "${row.bot_status ?? row.verdict ?? 'nothing'}", not a voicemail`);
    } else {
      if (!them.some((l) => /you're all set|you are all set/i.test(l.text))) problems.push("didn't get to \"you're all set\"");
      if (row.bot_status !== 'done') problems.push(`ended as "${row.bot_status ?? row.end_reason}", not done`);
    }
  }
  const timing = row.median_reply_ms !== null ? `reply ${(row.median_reply_ms / 1000).toFixed(1)}s median` : '';
  const detail = [timing, row.talk_overs ? `talked over ${row.talk_overs}x` : ''].filter(Boolean).join(', ');
  return { scene, pass: problems.length === 0, problems, detail };
}

// ── Running scenes ──────────────────────────────────────────────────────────

const ownerName = () => { const o = getOwner(); return o.fullName || o.name; };
const goal = () => `PRACTICE call to a scripted test line (not a real business): book a roof inspection at ABC Roofing for Thursday or Friday, under the name ${ownerName()}. If you reach voicemail, leave one short message asking them to call back.`;

export interface SceneDeps {
  /** Waits for the errand to finish; tests swap in a stub. */
  wait?: (errandId: number, ms: number) => Promise<void>;
}

async function waitForErrand(id: number, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10_000));
    const row = getErrand(id);
    if (row && row.status !== 'active') {
      // The call log is written a moment after the errand result.
      await new Promise((r) => setTimeout(r, 3_000));
      return;
    }
  }
}

/** Dial the practice line once with `scene` armed, then grade what happened. */
export async function runScene(scene: Scene, deps: SceneDeps = {}, waitMs = 6 * 60_000): Promise<Grade> {
  const line = practiceNumber();
  if (!line) return { scene, pass: false, problems: ['no practice line (PRACTICE_LINE_NUMBER or TWILIO_NUMBER)'], detail: '' };
  armScene(scene, waitMs + 60_000);
  const GOAL = goal();
  const id = createErrand({
    action_id: null, deadline: null, goal: GOAL,
    envelope_json: JSON.stringify({
      goal: GOAL, deadline: null, targets: [{ name: 'ABC Roofing (practice)', phone: line }],
      share: `Name: ${ownerName()}`, window: 'Thursday or Friday', max_calls: 1, keep_transcript: false,
      reply_mode: true, silent: true, notes: [],
    }),
  });
  try {
    await (deps.wait ?? waitForErrand)(id, waitMs);
  } finally {
    disarm();
  }
  const grade = gradeScene(scene, lastCallFor(id));
  // A practice errand is over once it's graded, however the call went: a failed scene
  // left "waiting" would sit in the owner's open jobs.
  updateErrand(id, {
    status: 'done', call_state: null, call_started_at: null,
    outcome: `Practice ${scene}: ${grade.pass ? 'pass' : `fail (${grade.problems.join('; ')})`}`.slice(0, 500),
    finished_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  });
  setMemory(GROUP, `result_${todayET()}_${scene}`, JSON.stringify({ ...grade, errandId: id, at: new Date().toISOString() }));
  console.log(`[practice] ${scene}: ${grade.pass ? 'pass' : `FAIL (${grade.problems.join('; ')})`}${grade.detail ? ` | ${grade.detail}` : ''}`);
  return grade;
}

export async function runScenes(scenes: Scene[], deps: SceneDeps = {}): Promise<Grade[]> {
  const out: Grade[] = [];
  for (const s of scenes) out.push(await runScene(s, deps));
  return out;
}

/** The morning check's scene for a day: one a day, in turn. */
export function sceneForDay(dayIndex = Math.floor(Date.now() / 86_400_000)): Scene {
  return SCENES[dayIndex % SCENES.length];
}

/** Recent results, newest first: for `npm run practice -- --results` and the scorecard. */
export function recentResults(limit = 30): Array<Grade & { at: string }> {
  return getRecentMemory(GROUP, { prefix: 'result_', limit })
    .map((m) => { try { return JSON.parse(m.value) as Grade & { at: string }; } catch { return null; } })
    .filter((g): g is Grade & { at: string } => !!g);
}

/** `npm run practice` asks the running bot (which owns the phone webhooks) to run scenes. */
export function requestRun(scenes: Scene[]): void { setMemory(GROUP, 'run_now', scenes.join(',')); }
export function takeRunRequest(): Scene[] {
  const raw = getMemory(GROUP, 'run_now');
  if (!raw) return [];
  setMemory(GROUP, 'run_now', '');
  return raw.split(',').filter((s): s is Scene => (SCENES as string[]).includes(s));
}
