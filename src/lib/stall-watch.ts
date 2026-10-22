// Freezes of the bot's one thread. A blocked thread makes node-cron skip jobs ("missed
// execution … possible blocking IO"), makes Twilio webhooks time out, and delays a
// live call's realtime events, so the assistant goes quiet mid-call. Many jobs fire on
// timers, so which one blocks isn't guessable. This watches for freezes (a 250ms
// timer that fires late) and logs each one over STALL_LOG_MS with the log lines just
// before it, which name the job that was running. The last 30 are kept in memory
// (system/stalls) for `npm run stalls`.

const TICK_MS = 250;

export interface Stall { at: string; ms: number; duringCall: boolean; before: string[] }

const recent: Array<{ at: number; line: string }> = [];
const stalls: Stall[] = [];

/** Keep the last few tagged log lines ("[omi-sync] …") as context for a freeze. */
function remember(args: unknown[]): void {
  const line = args.map((a) => (typeof a === 'string' ? a : '')).join(' ').trim();
  if (!line.startsWith('[') || line.startsWith('[stall]')) return;
  recent.push({ at: Date.now(), line: line.slice(0, 160) });
  if (recent.length > 40) recent.shift();
}

export function startStallWatch(opts: {
  thresholdMs?: number;
  callLive?: () => boolean;
  save?: (s: Stall[]) => void;
} = {}): () => void {
  const threshold = opts.thresholdMs ?? Number(process.env.STALL_LOG_MS || 750);
  for (const k of ['log', 'warn', 'error'] as const) {
    const orig = console[k].bind(console);
    console[k] = (...args: unknown[]) => { remember(args); orig(...args); };
  }
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const late = now - last - TICK_MS;
    last = now;
    if (late < threshold) return;
    const since = now - late - 5_000;
    const before = recent.filter((r) => r.at >= since).map((r) => r.line).slice(-6);
    const s: Stall = { at: new Date(now).toISOString(), ms: late, duringCall: opts.callLive?.() ?? false, before };
    stalls.push(s);
    if (stalls.length > 30) stalls.shift();
    console.warn(`[stall] froze ${(late / 1000).toFixed(1)}s${s.duringCall ? ' DURING A CALL' : ''}; just before: ${before.join(' | ') || '(nothing logged)'}`);
    try { opts.save?.(stalls); } catch { /* best effort */ }
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

/** Tests only: feed a log line as if it had been logged. */
export function noteForTest(line: string): void { remember([line]); }
