// When the assistant answers (call review step 3). On business calls the session
// doesn't answer on its own (create_response false); phone.ts decides. It used to
// answer the moment a turn ended, so a person who paused between sentences ("Sure, I
// can help with that. … We have Thursday at 4…") got talked over, and kept asking
// "Are you still there?". Now a finished turn waits a short beat (PHONE_YIELD_MS,
// 700ms) and the assistant holds back if they start talking again inside it; it
// answers after their next pause instead.

type Timers = {
  set: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear: (t: ReturnType<typeof setTimeout>) => void;
};
const realTimers: Timers = { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) };

export class ReplyGate {
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** Times they kept talking after a pause the assistant would have jumped into. */
  yields = 0;

  constructor(private fire: () => void, private waitMs: number, private timers: Timers = realTimers) {}

  /** Their turn ended: answer after the beat (or `waitMs`), unless they keep going. */
  turnEnded(waitMs = this.waitMs): void {
    this.cancel();
    if (waitMs <= 0) { this.fire(); return; }
    this.timer = this.timers.set(() => { this.timer = undefined; this.fire(); }, waitMs);
  }

  /** Their words show they handed the turn over: skip what's left of the beat. */
  now(): void {
    if (!this.timer) return;
    this.cancel();
    this.fire();
  }

  /** They started talking: if the assistant was about to answer, hold it for their next pause. */
  theyStarted(): void {
    if (!this.timer) return;
    this.cancel();
    this.yields++;
  }

  cancel(): void {
    if (this.timer) this.timers.clear(this.timer);
    this.timer = undefined;
  }

  get waiting(): boolean { return this.timer !== undefined; }
}

// Not "yes", "okay" or "sure": over the end of the assistant's question those are answers.
const FILLER = /^(hello|hi|hey|mhm|mm-?hmm|uh-?huh|hmm|um|uh)$/;
/**
 * "Hello?", "Hello? Can I help you?", "mhm": they're checking the line or just
 * listening. Said while the assistant is answering, that answer already covers it.
 */
export function isPresenceCheck(text: string): boolean {
  const t = text.toLowerCase().replace(/[^a-z'\- ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  const rest = t.replace(/^((hello|hi|hey|yes|yeah)\s*)+/, '').trim();
  if (/^((how )?(can|may) (i|we) help( you)?|are you (still )?there|you there|anyone there|who'?s (this|calling))$/.test(rest)) return true;
  const words = t.split(' ');
  return words.length <= 3 && words.every((w) => FILLER.test(w));
}

/**
 * Their turn hands the line back: a question, a greeting, or their name. The assistant answers
 * as soon as these words are in rather than waiting out the beat for more.
 */
export function endsTurn(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/\?\s*$/.test(t)) return true;
  if (isPresenceCheck(t)) return true;
  return /\b(how (can|may) (i|we) help( you)?( today)?|this is [a-z]+( speaking)?|speaking|go ahead)[.!]?\s*$/i.test(t);
}
