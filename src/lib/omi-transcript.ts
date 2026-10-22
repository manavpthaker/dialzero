// Omi transcripts as data: the speaker-tagged lines, a compact "You: … / Them: …"
// form for prompts, and a fingerprint that spots the same audio recorded twice
// (phone + desktop both record a call: one call came in as two overlapping
// recordings and was extracted twice, with near-duplicate tasks).

import { createHash } from 'node:crypto';

export interface Segment { text: string; isUser: boolean; speaker: number; start: number; end: number }

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** transcript_segments from a get_conversation_by_id reply, wherever Omi nests them. */
export function parseSegments(text: string): Segment[] {
  let data: unknown;
  try { data = JSON.parse(text); } catch { return []; }
  const find = (v: unknown, depth = 0): unknown[] | null => {
    if (!v || typeof v !== 'object' || depth > 4) return null;
    const o = v as Record<string, unknown>;
    if (Array.isArray(o.transcript_segments)) return o.transcript_segments;
    if (Array.isArray(o.transcript)) return o.transcript;
    for (const k of Object.keys(o)) {
      const hit = find(o[k], depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return (find(data) ?? []).flatMap((raw) => {
    const s = raw as Record<string, unknown>;
    const t = typeof s.text === 'string' ? s.text.trim() : '';
    if (!t) return [];
    return [{ text: t, isUser: s.is_user === true, speaker: num(s.speaker_id), start: num(s.start), end: num(s.end) }];
  });
}

export const wordCount = (s: string) => (s.match(/[\p{L}\p{N}']+/gu) ?? []).length;

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * The same words said once. Phone transcripts repeat their own lines as they refine them
 * (69% of one call's segments were repeats), which spent the prompt budget twice.
 */
export function dedupeSegments(segs: Segment[]): Segment[] {
  const recent: string[] = [];
  const out: Segment[] = [];
  for (const s of segs) {
    const n = norm(s.text);
    if (!n) continue;
    const prev = recent[recent.length - 1] ?? '';
    // A line said again within a few lines (not a phrase someone uses all call long).
    if ((n.length > 15 && recent.includes(n)) || n === prev || (n.length > 20 && prev.includes(n))) continue;
    if (prev.length > 20 && n.includes(prev) && out.length) out.pop(); // a refined, longer version of the last line
    out.push(s);
    recent.push(n);
    if (recent.length > 6) recent.shift();
  }
  return out;
}

function lines(segs: Segment[]): string[] {
  const out: string[] = [];
  let who = '';
  for (const s of segs) {
    const label = s.isUser ? 'You' : `Speaker ${s.speaker}`;
    if (label === who && out.length) out[out.length - 1] += ` ${s.text}`;
    else { out.push(`${label}: ${s.text}`); who = label; }
  }
  return out;
}

/** "You: …" / "Speaker 2: …" lines, back-to-back lines from one speaker joined. */
export function compactTranscript(segs: Segment[], maxChars = 24_000): string {
  const out = lines(segs).join('\n');
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n…[transcript cut here]` : out;
}

/**
 * The whole transcript as parts of at most `maxChars`, split between lines, so a long
 * meeting is read to the end (a 24k cut stopped at minute 17 of a 37-minute meeting).
 */
export function transcriptParts(segs: Segment[], maxChars = 24_000, maxParts = 5): string[] {
  const parts: string[] = [];
  let cur = '';
  for (const raw of lines(segs)) {
    const line = raw.length > maxChars ? raw.slice(0, maxChars) : raw;
    if (cur && cur.length + line.length + 1 > maxChars) { parts.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) parts.push(cur);
  if (parts.length > maxParts) return [...parts.slice(0, maxParts - 1), `${parts[maxParts - 1]}\n…[transcript cut here]`];
  return parts;
}

/**
 * A sampled set of 5-word shingles (about 1 in 8 kept, chosen by hash so two copies of
 * the same audio keep the same ones). Small enough to store for a couple of days.
 */
export function fingerprint(segs: Segment[]): string[] {
  const words = segs.map((s) => s.text).join(' ').toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const kept = new Set<string>();
  for (let i = 0; i + 5 <= words.length; i++) {
    const h = createHash('sha1').update(words.slice(i, i + 5).join(' ')).digest('hex').slice(0, 10);
    if (parseInt(h.slice(0, 2), 16) % 8 === 0) kept.add(h);
  }
  return [...kept];
}

/** Share of the smaller fingerprint found in the other one (1 = one recording contains the other). */
export function overlap(a: string[], b: string[]): number {
  if (a.length < 4 || b.length < 4) return 0;
  const [small, big] = a.length <= b.length ? [a, new Set(b)] : [b, new Set(a)];
  return small.filter((h) => big.has(h)).length / small.length;
}

/**
 * Which of two copies of one recording to keep: the one that tags a single voice as
 * the owner (one copy of a call tagged three voices as "user"), then the fuller one.
 */
export function recordingQuality(segs: Segment[]): number {
  const userVoices = new Set(segs.filter((s) => s.isUser).map((s) => s.speaker)).size;
  const words = segs.reduce((n, s) => n + wordCount(s.text), 0);
  return (userVoices === 1 ? 1_000_000 : 0) + words;
}
