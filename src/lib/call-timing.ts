// Per-call timing (call review step 1): how long the other side waited for the
// assistant after they stopped talking, and how often they started talking while it
// was. Nothing measured this before, so nobody knew whether businesses hung up on
// slow replies, talk-over, or something else.
//
// Fed from realtime events in phone.ts#runCall. "They stopped" is when voice
// detection reported the end of their speech, so the real wait is a little longer
// than what's measured here (detection itself takes a moment).

export interface TimelineLine { atMs: number; who: 'Them' | 'Bot'; text: string }

export interface CallTimingStats {
  /** The assistant's reply delays, in ms, one per reply to something they said. */
  replies: number[];
  medianReplyMs: number | null;
  maxReplyMs: number | null;
  /** Times they started talking while the assistant was talking. */
  talkOvers: number;
  /** From the start of the timeline (pickup) to the assistant's first sound. */
  firstWordsMs: number | null;
  /**
   * True when the session sent audio-playback events, so the assistant's start is when its
   * voice played. False: timed from when it started composing (response.created), a little early.
   */
  audioTimed: boolean;
}

export class CallTimeline {
  private start: number;
  private lines: TimelineLine[] = [];
  private replies: number[] = [];
  private talkOvers = 0;
  private theyStoppedAt: number | null = null;
  private botTalking = false;
  private firstBotAt: number | null = null;
  /** Set by phone.ts once the session sends output_audio_buffer events. */
  timedByAudio = false;

  constructor(private now: () => number = Date.now) { this.start = now(); }

  /** When the clock started (pickup, or the line connecting), epoch ms. */
  startedAt(): number { return this.start; }

  /** Restart the clock (the business picked up; ringing time isn't part of the call). */
  pickedUp(): void { if (!this.lines.length && this.firstBotAt === null) this.start = this.now(); }

  theyStarted(): void { if (this.botTalking) this.talkOvers++; this.theyStoppedAt = null; }

  theyStopped(): void { this.theyStoppedAt = this.now(); }

  /** The assistant's audio started. Counts as a reply only if they had just finished talking. */
  botStarted(): void {
    const t = this.now();
    if (this.botTalking) return;
    this.botTalking = true;
    if (this.firstBotAt === null) this.firstBotAt = t;
    if (this.theyStoppedAt !== null) this.replies.push(t - this.theyStoppedAt);
    this.theyStoppedAt = null;
  }

  botStopped(): void { this.botTalking = false; }

  line(who: 'Them' | 'Bot', text: string): void {
    const t = text.trim();
    if (t) this.lines.push({ atMs: this.now() - this.start, who, text: t });
  }

  stats(): CallTimingStats {
    const sorted = [...this.replies].sort((a, b) => a - b);
    const median = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null;
    return {
      replies: [...this.replies],
      medianReplyMs: median,
      maxReplyMs: sorted.length ? sorted[sorted.length - 1] : null,
      talkOvers: this.talkOvers,
      firstWordsMs: this.firstBotAt === null ? null : this.firstBotAt - this.start,
      audioTimed: this.timedByAudio,
    };
  }

  /** "[0:12] Them: Thanks for calling…", one line per turn. */
  text(): string {
    return this.lines.map((l) => `[${clock(l.atMs)}] ${l.who}: ${l.text}`).join('\n');
  }
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
