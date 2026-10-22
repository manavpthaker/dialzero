// The watchdog: problems should find us, not the owner. Every 10 minutes it runs
// the doctor's checks plus a few live ones (disk, the public phone link, the AI
// service failing), and when something stays broken for 30 minutes the owner gets
// ONE plain text with the fix, then one when it's fixed.
//
// The phone tunnel (errands.ts#checkPhoneLink) and Chrome (lib/chrome-health)
// already alert on their own and aren't repeated here.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import dbh, { getMemory, setMemory } from './db.js';
import { sendInterrupt } from './cos-outbound.js';
import { todayET } from './lib/time-et.js';
import { launchdLabelPrefix } from './modules.js';
import type { Check } from './doctor.js';

const run = promisify(execFile);
const GROUP = 'watchdog';
const PERSIST_MS = 30 * 60_000;

/** What the owner (or the Mac) should do for each check, in plain words. */
function fixes(): Array<[RegExp, string]> {
  const prefix = launchdLabelPrefix();
  return [
    [/^disk$/, 'Free up space on this Mac (Downloads, old backups); under 5 GB things start failing.'],
    [/^phone link$/, 'Calls can\'t reach the assistant. Check that the public tunnel is up (e.g. tailscale funnel status should list /openai/webhook and /twilio/voice).'],
    [/^ai service$/, 'The assistant\'s AI calls are failing. Check your AI provider account (billing/credit and usage).'],
    [/^deploy sync$/, 'Code updates aren\'t deploying. Run git status in the assistant\'s folder (uncommitted changes block the sync).'],
    [/^nightly backup$/, `Nightly database backups stopped. Check the ${prefix}.backup background job (npm run install:service).`],
    [/^daemon: /, `A background worker stopped. Restart it: launchctl kickstart -k gui/$(id -u)/${prefix}.<name>, or run npm run install:service.`],
  ];
}
const fixFor = (name: string) => fixes().find(([re]) => re.test(name))?.[1];

async function diskCheck(): Promise<Check> {
  try {
    const { stdout } = await run('/bin/df', ['-k', '/']);
    const free = Number(stdout.trim().split('\n')[1].split(/\s+/)[3]) / 1024 / 1024;
    return { name: 'disk', status: free < 5 ? 'warn' : 'ok', detail: `${free.toFixed(1)} GB free` };
  } catch (err) { return { name: 'disk', status: 'ok', detail: `not checked (${(err as Error).message})` }; }
}

/** Tunnel + phone server up: an unsigned POST must be refused (4xx), not time out or 404. */
async function phoneLinkCheck(): Promise<Check | null> {
  const base = (process.env.PHONE_PUBLIC_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  try {
    const res = await fetch(`${base}/openai/webhook`, { method: 'POST', body: '{}', signal: AbortSignal.timeout(10_000) });
    return [400, 401, 403].includes(res.status)
      ? { name: 'phone link', status: 'ok', detail: `public webhook answers (${res.status})` }
      : { name: 'phone link', status: 'warn', detail: `public webhook returned ${res.status}` };
  } catch (err) { return { name: 'phone link', status: 'warn', detail: `public webhook unreachable (${(err as Error).message})` }; }
}

/** The AI service failing outright in the last 30 minutes: errors and no successes. */
function aiCheck(): Check {
  const db = dbh as unknown as { prepare: (s: string) => { get: () => unknown } };
  try {
    const r = db.prepare(`SELECT SUM(ok = 1) good, SUM(ok = 0 AND error_kind IN ('4xx','429','5xx')) bad FROM llm_usage WHERE created_at > datetime('now', '-30 minutes')`).get() as { good: number | null; bad: number | null };
    const good = r.good ?? 0; const bad = r.bad ?? 0;
    return bad >= 5 && good === 0
      ? { name: 'ai service', status: 'warn', detail: `${bad} failed calls, none worked, in 30 min` }
      : { name: 'ai service', status: 'ok', detail: `${good} ok, ${bad} failed in 30 min` };
  } catch (err) { return { name: 'ai service', status: 'ok', detail: `not checked (${(err as Error).message})` }; }
}

/**
 * The doctor's checks, run in a child process when the built file is there: they shell
 * out with execSync (git, curl, op…), and in-process every 10 minutes that froze the bot
 * for 1.5–3s, long enough to stall a live call (seen with the stall watch). Under tsx
 * (tests, scripts) there's no built file, so they run in-process as before.
 */
async function doctorChecks(): Promise<Check[]> {
  const built = fileURLToPath(new URL('./doctor-json.js', import.meta.url));
  if (existsSync(built)) {
    try {
      const { stdout } = await run(process.execPath, [built], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, cwd: dirname(dirname(built)) });
      return (JSON.parse(stdout) as { checks: Check[] }).checks;
    } catch (err) {
      return [{ name: 'doctor', status: 'warn', detail: `health check didn't run (${(err as Error).message.slice(0, 120)})` }];
    }
  }
  const { runHealthCheck } = await import('./doctor.js');
  return runHealthCheck().checks;
}

export async function watchdogChecks(): Promise<Check[]> {
  const doc = (await doctorChecks()).filter((c) => fixFor(c.name));
  const live = await Promise.all([diskCheck(), phoneLinkCheck()]);
  return [...doc, ...live.filter((c): c is Check => !!c), aiCheck()];
}

type Send = (text: string, subject: string) => Promise<void>;
const defaultSend: Send = async (text, subject) => { await sendInterrupt({ source: 'watchdog', subject, kind: 'reply', text }); };

/** One pass: alert on anything broken for 30+ minutes (once a day each), and say when it's fixed. */
export async function watchdogTick(send: Send = defaultSend, now = Date.now(), checks?: Check[]): Promise<string[]> {
  const sent: string[] = [];
  for (const c of checks ?? await watchdogChecks()) {
    const firstKey = `first_${c.name}`;
    const alertKey = `alerted_${c.name}`;
    if (c.status !== 'warn' && c.status !== 'fail') {
      if (getMemory(GROUP, firstKey)) setMemory(GROUP, firstKey, '');
      if (getMemory(GROUP, alertKey)) {
        setMemory(GROUP, alertKey, '');
        const t = `✅ Fixed: ${c.name} is working again.`;
        await send(t, `watchdog:${c.name}:ok`); sent.push(t);
      }
      continue;
    }
    const first = Number(getMemory(GROUP, firstKey) || 0);
    if (!first) { setMemory(GROUP, firstKey, String(now)); continue; }
    if (now - first < PERSIST_MS) continue;
    if (getMemory(GROUP, alertKey) === todayET()) continue; // once a day per problem
    setMemory(GROUP, alertKey, todayET());
    const t = `🔧 ${c.name} needs attention: ${c.detail}. ${fixFor(c.name) ?? ''}`.trim();
    await send(t, `watchdog:${c.name}`); sent.push(t);
  }
  return sent;
}

/** A business call is live: the watchdog's checks wait for the next tick. */
function callLive(): boolean {
  try {
    const db = dbh as unknown as { prepare: (s: string) => { get: () => unknown } };
    return ((db.prepare("SELECT COUNT(*) c FROM errands WHERE call_state IS NOT NULL AND call_started_at > datetime('now', '-20 minutes')").get() as { c: number }).c) > 0;
  } catch { return false; }
}

export function startWatchdog(): void {
  if (process.env.WATCHDOG_ENABLED === 'false') return;
  const every = Number(process.env.WATCHDOG_INTERVAL_MS || 10 * 60_000);
  setInterval(() => {
    if (callLive()) return;
    watchdogTick().catch((err) => console.error('[watchdog] tick failed:', err));
  }, every);
  console.log(`[watchdog] every ${Math.round(every / 60_000)} min`);
}
