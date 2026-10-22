// The owner as the safety net on business calls. Human backup is what makes AI calling
// work reliably. Two things a live call can do:
//   ask    the assistant says "let me check, one moment", texts the owner the question
//          and waits (ASK_WAIT_MS) for the answer: the owner's next text, or answerCallAsk.
//   patch  the assistant rings the owner into the same conference with a one-line text,
//          and hands the call over when they pick up (the `bring_in_owner` tool, or
//          takeOverCall).
// This module holds the shared state; phone.ts does the call work. takeOverCall /
// answerCallAsk / canTakeOver / canAsk / setCallsChanged are hooks for a companion
// app or dashboard; nothing in this repo needs them.

export const ASK_WAIT_MS = () => Number(process.env.PHONE_ASK_WAIT_MS || 150_000);

export type CallsEvent =
  | { type: 'connected'; key: string; who: string }
  | { type: 'ended'; key: string; who: string }
  | { type: 'ask'; key: string; who: string; question: string }
  | { type: 'answered'; key: string; who: string }
  | { type: 'patching'; key: string; who: string };

let changed: ((e: CallsEvent) => void) | null = null;
/** A companion app can register this to show live calls and their questions. */
export function setCallsChanged(fn: ((e: CallsEvent) => void) | null): void { changed = fn; }
export function callsChanged(e: CallsEvent): void {
  try { changed?.(e); } catch (err) { console.warn('[safety-net] callsChanged hook failed:', err instanceof Error ? err.message : err); }
}

// ── Questions waiting on the owner ────────────────────────────────────────────────

interface Ask { key: string; who: string; question: string; at: number; resolve: (answer: string | null) => void; timer: ReturnType<typeof setTimeout> }
const asks = new Map<string, Ask>();

/** Wait for the owner's answer to a question from a live call; null when none comes in time. */
export function openAsk(key: string, who: string, question: string, waitMs = ASK_WAIT_MS()): Promise<string | null> {
  asks.get(key)?.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { if (asks.get(key)?.resolve === done) asks.delete(key); resolve(null); }, waitMs);
    const done = (answer: string | null) => { clearTimeout(timer); asks.delete(key); resolve(answer); };
    asks.set(key, { key, who, question, at: Date.now(), resolve: done, timer });
    callsChanged({ type: 'ask', key, who, question });
  });
}

/** An answer typed somewhere other than a text (a companion app's answer box). */
export function answerCallAsk(key: string, text: string): boolean {
  const a = asks.get(key);
  if (!a || !text.trim()) return false;
  a.resolve(text.trim());
  callsChanged({ type: 'answered', key, who: a.who });
  return true;
}

/** The owner's next text answers the oldest open question; false when none is waiting. */
export function takeAskAnswer(text: string): { who: string } | null {
  const oldest = [...asks.values()].sort((a, b) => a.at - b.at)[0];
  if (!oldest || !text.trim()) return null;
  answerCallAsk(oldest.key, text);
  return { who: oldest.who };
}

export function pendingAsk(key: string): string | null { return asks.get(key)?.question ?? null; }

// ── Live calls the owner can take over ─────────────────────────────────────────────

const live = new Map<string, { who: string; takeOver: () => Promise<string>; canAsk: boolean }>();

export function registerLiveCall(key: string, who: string, takeOver: () => Promise<string>, canAsk = true): void {
  live.set(key, { who, takeOver, canAsk });
  callsChanged({ type: 'connected', key, who });
}
export function unregisterLiveCall(key: string): void {
  const c = live.get(key);
  if (!c) return;
  live.delete(key);
  asks.get(key)?.resolve(null);
  callsChanged({ type: 'ended', key, who: c.who });
}

export function canTakeOver(key: string): boolean { return live.has(key); }
export function canAsk(key: string): boolean { return !!pendingAsk(key); }

/** "Take over": ring the owner into the call; the assistant hands over when they pick up. */
export async function takeOverCall(key: string): Promise<string> {
  const c = live.get(key);
  if (!c) return 'That call is over.';
  callsChanged({ type: 'patching', key, who: c.who });
  return c.takeOver();
}
