// The morning check: one practice call and (optionally) one read-only website visit
// every day, so a broken phone link or an expired sign-in shows up before the owner
// needs it, not when a real job fails. The owner is texted only when something is broken.
//
// Call: a silent practice errand to a recorded time announcement (always answers with
// a voice), through the real path (Twilio, OpenAI SIP, assistant-first conference).
// Passing means the call ended "done" and the checker heard the time.
// Website: a practice web task (no texts, never waits on the owner) on one signed-in
// site from CANARY_SITES, rotating by day. Passing means the page showed them signed in.
//
// Opt-in (CANARY_ENABLED=true): the practice call is a real call and costs a little each day.

import { scheduleCron } from './lib/cron.js';
import { createErrand, getErrand, getErrandEvents, getMemory, setMemory } from './db.js';
import { sendInterrupt } from './cos-outbound.js';
import { todayET } from './lib/time-et.js';
import { getBotName } from './config.js';

const GROUP = 'canary';
const TIME_LINE = () => process.env.CANARY_CALL_NUMBER || '+13034997111'; // NIST WWV time, always answers

export interface CanarySite { name: string; url: string; signedIn: string }

/** CANARY_SITES: "Name|https://url|what signed in looks like" entries separated by ";". */
export function canarySites(raw = process.env.CANARY_SITES || ''): CanarySite[] {
  return raw.split(';').map((s) => s.trim()).filter(Boolean).flatMap((entry) => {
    const [name, url, signedIn] = entry.split('|').map((x) => x.trim());
    return name && /^https?:\/\//.test(url ?? '') ? [{ name, url, signedIn: signedIn || 'the account page loads without a sign-in form' }] : [];
  });
}

type Result = { ok: boolean; detail: string };

async function alert(kind: 'call' | 'web', text: string): Promise<void> {
  const key = `alerted_${kind}_${todayET()}`;
  if (getMemory(GROUP, key)) return;
  setMemory(GROUP, key, '1');
  await sendInterrupt({ source: 'canary', subject: `canary:${kind}`, kind: 'reply', text });
}

export async function callCheck(waitMs = 6 * 60_000): Promise<Result> {
  const id = createErrand({
    action_id: null, deadline: null,
    goal: 'CANARY practice call: hear the current time from the recorded time announcement.',
    envelope_json: JSON.stringify({
      goal: 'CANARY practice call', deadline: null, targets: [{ name: 'Time announcement line', phone: TIME_LINE() }],
      share: '', window: '', max_calls: 1, keep_transcript: false, reply_mode: true, silent: true,
      notes: ['It is a recording, not a person: say nothing, listen until you hear the time, then end_call with status "done" and the time as the outcome.'],
    }),
  });
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 20_000));
    const row = getErrand(id);
    if (row && row.status !== 'active') {
      const last = getErrandEvents(id, 10).find((e) => e.type === 'call_result' || e.type === 'phone_down' || e.type === 'blocked');
      return row.status === 'done' ? { ok: true, detail: row.outcome ?? 'done' } : { ok: false, detail: last?.detail ?? row.outcome ?? row.status };
    }
  }
  return { ok: false, detail: 'no result within 6 minutes (the call never started or never ended)' };
}

export async function webCheck(dayIndex = Math.floor(Date.now() / 86_400_000)): Promise<(Result & { site: string }) | null> {
  const sites = canarySites();
  if (!sites.length) return null;
  const site = sites[dayIndex % sites.length];
  const { startWebTask } = await import('./web-task.js');
  const { done } = startWebTask({
    task: `Practice check, read only: open ${site.url} and see whether the owner is signed in (${site.signedIn}). If a sign-in page appears, try fill_login once. Do not click anything else, change nothing. "done" = signed in; otherwise "blocked" saying what you saw.`,
    site: site.url, practice: true,
  }, `Practice: is ${site.name} still signed in`, 'canary');
  const r = await Promise.race([done, new Promise<null>((res) => setTimeout(() => res(null), 25 * 60_000))]);
  if (!r) return { ok: false, detail: 'no result in 25 minutes', site: site.name };
  return { ok: r.status === 'done', detail: r.summary, site: site.name };
}

export async function runMorningCheck(): Promise<{ call: Result | null; web: (Result & { site: string }) | null }> {
  const call = process.env.PHONE_PUBLIC_URL
    ? await callCheck().catch((err) => ({ ok: false, detail: `check crashed: ${err instanceof Error ? err.message : err}` }))
    : null;
  const web = await webCheck().catch((err) => ({ ok: false, detail: `check crashed: ${err instanceof Error ? err.message : err}`, site: '?' }));
  setMemory(GROUP, 'last', JSON.stringify({ at: new Date().toISOString(), call, web }));
  console.log(`[canary] call ${call ? (call.ok ? 'ok' : 'FAILED') : 'skipped'}: ${call?.detail.slice(0, 160) ?? ''} | web ${web ? `(${web.site}) ${web.ok ? 'ok' : 'FAILED'}: ${web.detail.slice(0, 160)}` : 'skipped (no CANARY_SITES)'}`);
  if (call && !call.ok) await alert('call', `🔧 Morning check: ${getBotName()}'s practice call didn't work, so business calls may fail today. ${call.detail.replace(/\s+/g, ' ').slice(0, 180)}`);
  if (web && !web.ok) await alert('web', `🔧 Morning check: ${web.site} isn't signed in on the Mac anymore (${web.detail.replace(/\s+/g, ' ').slice(0, 140)}). Sign in there in Chrome when you can.`);
  return { call, web };
}

export function startCanary(): void {
  if (process.env.CANARY_ENABLED !== 'true') return;
  const expr = process.env.CANARY_CRON || '20 8 * * *';
  scheduleCron(expr, () => { runMorningCheck().catch((err) => console.error('[canary] failed:', err)); });
  // `npm run canary` sets this flag; the check runs here, in the process that owns
  // the browser bridge and the phone webhooks.
  setInterval(() => {
    if (getMemory(GROUP, 'run_now') !== '1') return;
    setMemory(GROUP, 'run_now', '');
    runMorningCheck().catch((err) => console.error('[canary] failed:', err));
  }, 60_000);
  console.log(`[canary] morning check: "${expr}" (local time)`);
}
