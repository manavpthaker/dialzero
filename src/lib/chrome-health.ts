// Keeps the Chrome bridge alive so website jobs don't fail on a dead extension.
// Every minute:
//   - connected: ping `version` (a timeout = a half-open socket, counted as
//     down). If the extension is older than browser-extension/manifest.json,
//     ask it to reload itself, so extension updates deploy without a click.
//   - down 3+ min: open Chrome (it may have quit or crashed).
//   - down 10+ min while a website job is running: tell the owner once a day.

import { execFile } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isBrowserConnected, sendCommand } from '../browser-bridge.js';
import { getExecutingActions } from '../db.js';
import { todayET } from './time-et.js';

const TICK_MS = 60_000;
const OPEN_AFTER_MS = 3 * 60_000;
const ALERT_AFTER_MS = 10 * 60_000;
const REOPEN_GAP_MS = 10 * 60_000;
const RELOAD_GAP_MS = 30 * 60_000;
const OPEN_BIN = process.env.OPEN_BIN || '/usr/bin/open';

export interface ChromeHealthDeps {
  connected: () => boolean;
  version: () => Promise<string>;
  reload: () => Promise<void>;
  openChrome: () => Promise<void>;
  expectedVersion: () => string | null;
  jobsWaiting: () => string[];
  alert: (text: string) => Promise<void>;
  now: () => number;
}

function manifestVersion(): string | null {
  try {
    return JSON.parse(readFileSync(join(process.cwd(), 'browser-extension', 'manifest.json'), 'utf8')).version ?? null;
  } catch { return null; }
}

const defaultDeps: ChromeHealthDeps = {
  connected: isBrowserConnected,
  version: async () => String(((await sendCommand('version', {}, 5000, true)) as { version?: string })?.version ?? ''),
  reload: async () => { await sendCommand('reload_extension', {}, 5000, true); },
  openChrome: () => new Promise((resolve) => execFile(OPEN_BIN, ['-a', 'Google Chrome'], () => resolve())),
  expectedVersion: manifestVersion,
  jobsWaiting: () => [...getExecutingActions('web_task'), ...getExecutingActions('booking')].map((a) => a.summary),
  alert: async (text) => {
    const { sendInterrupt } = await import('../cos-outbound.js');
    await sendInterrupt({ source: 'chrome-health', subject: 'chrome-down', kind: 'reply', text });
  },
  now: () => Date.now(),
};

let deps = defaultDeps;
export function setChromeHealthDeps(over: Partial<ChromeHealthDeps> | null): void {
  deps = over ? { ...defaultDeps, ...over } : defaultDeps;
  state = { downSince: null, lastOpenAt: -Infinity, lastReloadAt: -Infinity, alertedOn: "" };
}

let state = { downSince: null as number | null, lastOpenAt: -Infinity, lastReloadAt: -Infinity, alertedOn: "" };

/** Semver-ish compare: is `have` older than `want`? */
function older(have: string, want: string): boolean {
  const a = have.split('.').map(Number);
  const b = want.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** One health check. Returns what it did, for logs and tests. */
export async function chromeHealthTick(): Promise<'ok' | 'reloaded' | 'down' | 'opened' | 'alerted'> {
  const d = deps;
  const now = d.now();
  let healthy = false;
  if (d.connected()) {
    try {
      const v = await d.version();
      healthy = true;
      const want = d.expectedVersion();
      if (v && want && older(v, want) && now - state.lastReloadAt > RELOAD_GAP_MS) {
        state.lastReloadAt = now;
        console.log(`[chrome-health] extension ${v} is older than ${want}; reloading it`);
        await d.reload().catch(() => {});
        return 'reloaded';
      }
    } catch (err) {
      // An extension from before `version` existed answers "Unknown action":
      // it's alive, just old (it can't reload itself; a manual reload fixes it).
      healthy = /Unknown action/i.test(err instanceof Error ? err.message : String(err));
    }
  }
  if (healthy) {
    state.downSince = null;
    return 'ok';
  }
  state.downSince ??= now;
  const down = now - state.downSince;
  const waiting = d.jobsWaiting();
  if (down >= ALERT_AFTER_MS && waiting.length && state.alertedOn !== todayET()) {
    state.alertedOn = todayET();
    await d.alert(`Chrome on the mini isn't connected, so I've paused: ${waiting[0]}${waiting.length > 1 ? ` (+${waiting.length - 1} more)` : ''}. Open Chrome on the mini and I'll pick it back up.`).catch(() => {});
    return 'alerted';
  }
  if (down >= OPEN_AFTER_MS && now - state.lastOpenAt > REOPEN_GAP_MS) {
    state.lastOpenAt = now;
    console.log('[chrome-health] extension down 3+ min; opening Chrome');
    await d.openChrome();
    return 'opened';
  }
  return 'down';
}

export function chromeDownForMs(): number {
  return state.downSince ? deps.now() - state.downSince : 0;
}

export function startChromeHealth(): void {
  setInterval(() => { void chromeHealthTick().catch((err) => console.error('[chrome-health] tick failed:', err)); }, TICK_MS);
}
