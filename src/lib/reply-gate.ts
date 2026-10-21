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

  /** Their turn ended: answer after the beat, unless they keep going. */
  turnEnded(): void {
    this.cancel();
    if (this.waitMs <= 0) { this.fire(); return; }
    this.timer = this.timers.set(() => { this.timer = undefined; this.fire(); }, this.waitMs);
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
