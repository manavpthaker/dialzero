import { existsSync, readdirSync, statSync } from 'fs';
import { onePasswordReady } from './lib/onepassword.js';
import { isBrowserConnected, browserBridgeStarted } from './browser-bridge.js';
import { chromeDownForMs } from './lib/chrome-health.js';
import { readRunningSha, currentHeadSha } from './lib/running-sha.js';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import db, { getBrainStats, getTaskStats, factsAbout, getMemory, getDailyLlmSpendMicros, getLlmModelsSince, outboundTallySince } from './db.js';
import { getBotName, getProfileConfig, type ProfileConfig } from './config.js';
import { automationsOff, automationAllowed } from './lib/automations-off.js';
import { OPENAI_ROUTER_MODEL, llmProvider } from './lib/openai.js';
import { tokenBudgetCaps } from './lib/token-budget.js';
import { modelsArePriced } from './lib/llm-usage.js';
import { formatUsd } from './lib/llm-pricing.js';
import { startOfTodayET } from './lib/time-et.js';
import { toSqliteDate } from './lib/dates.js';
import { arbiterConfig } from './cos-outbound.js';
import {
  MODULES, resolveModules, resolveModule, isModuleOn, isOwnedOn, moduleFor, unknownModuleIds,
  featureSwitchOn, launchdLabelPrefix,
  type ModuleSpec, type ModuleState, type SelectionInput,
} from './modules.js';
import cron from 'node-cron';

/**
 * Two modes, one file:
 *
 *   npm run doctor                     --health (default): is the running
 *                                      assistant alive and are its loops firing
 *   npm run doctor -- --setup          is this Mac ready to use: per enabled
 *                                      module, settings, installed tools and
 *                                      macOS permissions
 *   add --json to either for machine-readable output
 *
 * JSON shapes:
 *
 *   --health --json
 *   { "mode": "health", "healthy": boolean,
 *     "checks": [{ "name", "status": "ok"|"warn"|"disabled", "detail" }],
 *     "stats": { facts_active, people, open_tasks, overdue_tasks, messages_24h, ... } }
 *   exit 0 when no check is "warn", else 1.
 *
 *   --setup --json
 *   { "mode": "setup", "ready": boolean,           // true when no check is "fail"
 *     "summary": { "ok": n, "warn": n, "fail": n, "disabled": n },
 *     "modules": [{ "id", "title", "on": boolean, "source": "always"|"env-on"|"env-off"
 *                   |"profile"|"profile-groups"|"configured"|"default" }],
 *     "checks": [{ "module": "<id>"|"general", "name",
 *                  "status": "ok"|"warn"|"fail"|"disabled", "detail",
 *                  "fix"?: "one plain-English instruction" }] }
 *   exit 0 when no check is "fail", else 1. Switched-off modules appear only
 *   as "disabled" and never warn or fail.
 */

/**
 * Health check for the live second brain. One source of truth for "is everything
 * actually live and are the proactive loops firing", so a silent failure (a dead
 * cron, an un-run seed, a stalled backup) is visible without tailing logs.
 *
 * runHealthCheck() is pure data — it reads the DB + filesystem and returns a
 * structured report. It's consumed by:
 *   - scripts/doctor.ts (npm run doctor)  → full human-readable report + exit code
 *   - scheduler.ts daily alive-ping       → surfaces any issues in the DM
 */

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'disabled';

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  /** One plain-English instruction that fixes a warn/fail (setup mode). */
  fix?: string;
  /** Owning module id, or 'general' (setup mode). */
  module?: string;
}

const MODULE_OFF = (id: string) => `module "${id}" is off`;

export interface HealthReport {
  healthy: boolean;
  checks: Check[];
  issues: Check[]; // the subset with status !== 'ok'
  stats: ReturnType<typeof getBrainStats> & { overdue_tasks: number };
}

// Staleness thresholds, in hours. Each loop's cadence + a buffer.
const REFLECTION_STALE_H = 26; // nightly 22:00
const BACKUP_STALE_H = 30; // nightly 03:00
const DAEMON_TICK_STALE_H = 2; // KeepAlive daemons tick on the order of minutes
const SYNC_STALE_H = 1; // scripts/sync-repos.sh runs every 5 min; 1h = 12 missed clean runs
const AUDIT_STALE_H = 8 * 24; // memory audit rides the Monday hygiene cron; 8 days = a missed week

// Repo root, cwd-independent: this file compiles to dist/doctor.js, so ".." is
// the assistant checkout the 5-min sync pulls into.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Inner-circle people the seed guarantees; their absence means the seed never
// ran. Derived from the profile config so a new operator's people are checked.
const SEEDED_PEOPLE = getProfileConfig().people.map((p) => p.name);

// A canonical marker fact the seed always writes; its presence means the seed ran.
const SEED_MARKER = { subject: '__seed__', predicate: 'ran' };

const BACKUP_DIR = join(homedir(), 'assistant-backups');

function hoursSince(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return (Date.now() - t) / 3_600_000;
}

function fmtAge(hours: number | null): string {
  if (hours === null) return 'never';
  if (hours < 1) return `${Math.round(hours * 60)}m ago`;
  if (hours < 48) return `${hours.toFixed(1)}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function checkSeededPeople(): Check {
  // No people configured in the profile — nothing to verify, treat as healthy.
  if (SEEDED_PEOPLE.length === 0) {
    return { name: 'seeded people', status: 'ok', detail: 'no inner-circle people configured' };
  }
  const placeholders = SEEDED_PEOPLE.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT name FROM people WHERE name IN (${placeholders}) COLLATE NOCASE`)
    .all(...SEEDED_PEOPLE) as { name: string }[];
  const present = new Set(rows.map((r) => r.name.toLowerCase()));
  const missing = SEEDED_PEOPLE.filter((n) => !present.has(n.toLowerCase()));
  return missing.length === 0
    ? { name: 'seeded people', status: 'ok', detail: `all ${SEEDED_PEOPLE.length} inner-circle present` }
    : { name: 'seeded people', status: 'warn', detail: `missing: ${missing.join(', ')} — run npm run seed:facts` };
}

function checkSeedFacts(): Check {
  const hit = factsAbout(SEED_MARKER.subject, 200).some((f) => f.predicate === SEED_MARKER.predicate);
  return hit
    ? { name: 'seed facts', status: 'ok', detail: `profile facts loaded` }
    : { name: 'seed facts', status: 'warn', detail: `marker fact missing — seed never ran (npm run seed:facts)` };
}

function checkReflection(lastReflection: string | null): Check {
  if (!isOwnedOn('start', 'scheduler')) {
    return { name: 'nightly reflection', status: 'disabled', detail: MODULE_OFF(moduleFor('start', 'scheduler')!) };
  }
  if (!automationAllowed('scheduler')) {
    return { name: 'nightly reflection', status: 'disabled', detail: 'disabled by AUTOMATIONS_OFF/allowlist' };
  }
  const age = hoursSince(lastReflection);
  if (age === null) {
    return { name: 'nightly reflection', status: 'warn', detail: 'never run — 22:00 cron may not be firing' };
  }
  if (age > REFLECTION_STALE_H) {
    return { name: 'nightly reflection', status: 'warn', detail: `last ran ${fmtAge(age)} (>${REFLECTION_STALE_H}h) — 22:00 cron may be dead` };
  }
  return { name: 'nightly reflection', status: 'ok', detail: `last ran ${fmtAge(age)}` };
}

function checkBackup(): Check {
  if (!existsSync(BACKUP_DIR)) {
    return { name: 'nightly backup', status: 'warn', detail: `${BACKUP_DIR} missing — backup never ran` };
  }
  try {
    const files = readdirSync(BACKUP_DIR).filter((f) => f.includes('assistant.db'));
    if (files.length === 0) {
      return { name: 'nightly backup', status: 'warn', detail: 'no backup files found' };
    }
    const newest = Math.max(...files.map((f) => statSync(join(BACKUP_DIR, f)).mtimeMs));
    const age = (Date.now() - newest) / 3_600_000;
    return age > BACKUP_STALE_H
      ? { name: 'nightly backup', status: 'warn', detail: `newest ${fmtAge(age)} (>${BACKUP_STALE_H}h) — 03:00 backup may be dead` }
      : { name: 'nightly backup', status: 'ok', detail: `${files.length} backups, newest ${fmtAge(age)}` };
  } catch (err) {
    return { name: 'nightly backup', status: 'warn', detail: `unreadable: ${(err as Error).message}` };
  }
}

// Deploy freshness. The 5-min auto-sync (scripts/sync-repos.sh) is the only path
// that advances this checkout, and an uncommitted edit on this deploy target
// silently dead-locks its `git pull --ff-only`. Two independent signals catch it:
//   1. the sync stamps sync_last_success / sync_last_error into memory each run
//      (group_id='system'); an error newer than the last clean success, or a
//      stale success, means the sync is failing or has stopped running.
//   2. HEAD is behind its upstream — the most direct "deploy is stuck" signal.
//      `git pull` fetches before the ff it then rejects, so the remote-tracking
//      ref is fresh and this needs no network from the health check itself.
// Surfaces in the 09:00 alive-ping so a stuck deploy is seen by morning.
// 1Password for website-job sign-ins: set up or not (a bad token shows up as a
// failed fill, which the job reports as needing the owner).
function checkOnePassword(): Check {
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN) return { name: '1password', status: 'ok', detail: 'not set up (website jobs ask the owner to log in)' };
  return onePasswordReady()
    ? { name: '1password', status: 'ok', detail: `service account set, vault "${process.env.OP_VAULT || 'Assistant'}"` }
    : { name: '1password', status: 'warn', detail: 'OP_SERVICE_ACCOUNT_TOKEN is set but the op CLI is missing (brew install 1password-cli)' };
}

// Chrome bridge: only meaningful inside the bot process (the CLI has no bridge).
function checkChrome(): Check {
  if (!browserBridgeStarted()) return { name: 'chrome', status: 'ok', detail: 'not checked (bridge not running in this process)' };
  const down = chromeDownForMs();
  if (isBrowserConnected() && down === 0) return { name: 'chrome', status: 'ok', detail: 'extension connected' };
  return { name: 'chrome', status: 'warn', detail: `extension not connected${down ? ` for ${Math.round(down / 60_000)} min` : ''} — website jobs are paused` };
}

function checkSync(): Check {
  let behind: number | null = null;
  try {
    const out = execSync('git rev-list --count HEAD..@{upstream}', {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const n = Number(out);
    behind = Number.isNaN(n) ? null : n;
  } catch {
    behind = null; // not a repo / no upstream — don't false-alarm
  }

  const rows = db
    .prepare(
      "SELECT key, updated_at, value FROM memory WHERE group_id = 'system' AND key IN ('sync_last_success', 'sync_last_error')",
    )
    .all() as { key: string; updated_at: string; value: string }[];
  const success = rows.find((r) => r.key === 'sync_last_success');
  const error = rows.find((r) => r.key === 'sync_last_error');
  const okAge = hoursSince(success?.updated_at);
  const errAge = hoursSince(error?.updated_at);

  // The bot is running an older commit than the checkout (a commit made on the
  // mini, or a restart that never happened). The sync job fixes this within 5
  // minutes when it's alive, so a lasting mismatch means it isn't.
  const running = readRunningSha();
  const head = currentHeadSha();
  if (running && head && running !== head) {
    return { name: 'deploy sync', status: 'warn', detail: `running ${running.slice(0, 7)} but checkout is ${head.slice(0, 7)} — restart pending or sync agent not running` };
  }

  // HEAD behind origin is unambiguous — lead with it and attach the reason.
  if (behind !== null && behind > 0) {
    const why = error ? ` — last error: ${error.value}` : '';
    return { name: 'deploy sync', status: 'warn', detail: `HEAD ${behind} commit(s) behind origin — auto-sync stuck${why}` };
  }

  // Neither stamp yet (fresh DB, or sync hasn't run since this shipped): the
  // git check above already covers the real risk, so don't false-alarm here.
  if (!success && !error) {
    return { name: 'deploy sync', status: 'ok', detail: 'up to date (no sync stamps yet)' };
  }

  // Last run errored: error stamp is newer than the last clean success.
  if (error && (!success || (errAge !== null && okAge !== null && errAge < okAge))) {
    return { name: 'deploy sync', status: 'warn', detail: `last sync failed ${fmtAge(errAge)}: ${error.value}` };
  }

  // Clean — but has the sync stopped stamping entirely (agent died)?
  if (okAge !== null && okAge > SYNC_STALE_H) {
    return { name: 'deploy sync', status: 'warn', detail: `last clean sync ${fmtAge(okAge)} (>${SYNC_STALE_H}h) — 5-min sync may be dead` };
  }
  return { name: 'deploy sync', status: 'ok', detail: `up to date, last clean sync ${fmtAge(okAge)}` };
}

// Daemons are separate KeepAlive processes; the DB-reading alive-ping can't see
// them die. They surface here IF they write a `<name>_last_tick` ISO into the
// memory table each tick (see TIER1-PLAN). Until they do, we report that they're
// not yet instrumented rather than firing a false alarm.
function checkDaemonTicks(): Check[] {
  // [stamp name, module ownership kind, key, own env switch]
  const daemons: Array<{ name: string; kind: 'daemons' | 'start'; switchKey?: string }> = [
    { name: 'imessage-daemon', kind: 'daemons' },
    { name: 'inbox-signal-daemon', kind: 'daemons', switchKey: 'INBOX_SIGNAL_ENABLED' },
    { name: 'meeting-daemon', kind: 'daemons' },
    { name: 'email-reconciliation', kind: 'start', switchKey: 'EMAIL_RECONCILIATION_ENABLED' },
  ];
  const checks: Check[] = [];
  for (const d of daemons) {
    const label = `daemon: ${d.name}`;
    if (!isOwnedOn(d.kind, d.name)) {
      checks.push({ name: label, status: 'disabled', detail: MODULE_OFF(moduleFor(d.kind, d.name)!) });
      continue;
    }
    if (d.switchKey && !featureSwitchOn({ key: d.switchKey, description: '', featureSwitch: { defaultOn: false } })) {
      checks.push({ name: label, status: 'disabled', detail: `${d.switchKey} is off` });
      continue;
    }
    if (!automationAllowed(d.name)) {
      checks.push({ name: label, status: 'disabled', detail: 'disabled by AUTOMATIONS_OFF/allowlist' });
      continue;
    }
    // Every KeepAlive daemon stamps <name>_last_tick after each successful tick.
    const stamp = getMemory('system', `${d.name}_last_tick`);
    if (!stamp) {
      checks.push({ name: label, status: 'warn', detail: 'enabled but no heartbeat recorded (background service not running? try npm run install:service)' });
      continue;
    }
    const age = hoursSince(stamp);
    checks.push(age !== null && age > DAEMON_TICK_STALE_H
      ? { name: label, status: 'warn', detail: `last tick ${fmtAge(age)} (>${DAEMON_TICK_STALE_H}h) — process may be dead` }
      : { name: label, status: 'ok', detail: `last tick ${fmtAge(age)}` });
  }
  return checks;
}

// The two morning scheduler jobs you'd feel losing (inbox-zero 08:00, calendar
// prep 06:30) stamp *_last_run on success. Both are gated on a configured
// personal DM target, so a missing stamp reads as "not yet recorded" rather
// than a warn — false alarms on unconfigured deploys would train everyone to
// ignore the doctor. Once a stamp exists, staleness is a real signal.
function checkMorningJobs(): Check[] {
  if (!isOwnedOn('start', 'scheduler')) {
    const detail = MODULE_OFF(moduleFor('start', 'scheduler')!);
    return [
      { name: 'inbox-zero pass', status: 'disabled', detail },
      { name: 'calendar prep', status: 'disabled', detail },
    ];
  }
  if (!automationAllowed('scheduler')) {
    return [
      { name: 'inbox-zero pass', status: 'disabled', detail: 'disabled by AUTOMATIONS_OFF/allowlist' },
      { name: 'calendar prep', status: 'disabled', detail: 'disabled by AUTOMATIONS_OFF/allowlist' },
    ];
  }
  const jobs: Array<{ key: string; name: string; when: string }> = [
    { key: 'inbox_zero_last_run', name: 'inbox-zero pass', when: '08:00' },
    { key: 'calendar_prep_last_run', name: 'calendar prep', when: '06:30' },
  ];
  return jobs.map(({ key, name, when }) => {
    const age = hoursSince(getMemory('system', key));
    if (age === null) return { name, status: 'ok' as const, detail: `no run recorded yet (daily ${when})` };
    return age > REFLECTION_STALE_H
      ? { name, status: 'warn' as const, detail: `last ran ${fmtAge(age)} (>${REFLECTION_STALE_H}h) — daily ${when} cron may be dead` }
      : { name, status: 'ok' as const, detail: `last ran ${fmtAge(age)}` };
  });
}

// Memory audit liveness (Odysseus Experiment 1). The semantic audit rides the
// Monday hygiene cron and stamps memory_audit_last_run on every non-dry pass —
// including fingerprint-gated skips, so the stamp measures "the loop is firing",
// not "facts changed". Missing stamp reads as "not yet recorded" (the loop may
// simply not have seen a Monday since deploy), same convention as the morning
// jobs; once a stamp exists, >8 days means the hygiene cron is dead.
function checkMemoryAudit(): Check {
  if (!isOwnedOn('start', 'hygiene')) {
    return { name: 'memory audit', status: 'disabled', detail: MODULE_OFF(moduleFor('start', 'hygiene')!) };
  }
  if (!automationAllowed('hygiene')) {
    return { name: 'memory audit', status: 'disabled', detail: 'disabled by AUTOMATIONS_OFF/allowlist' };
  }
  if ((process.env.MEMORY_AUDIT_ENABLED || '').trim().toLowerCase() === 'false') {
    return { name: 'memory audit', status: 'ok', detail: 'disabled via MEMORY_AUDIT_ENABLED=false' };
  }
  const age = hoursSince(getMemory('system', 'memory_audit_last_run'));
  if (age === null) return { name: 'memory audit', status: 'ok', detail: 'no run recorded yet (Mondays 07:30 with hygiene)' };
  return age > AUDIT_STALE_H
    ? { name: 'memory audit', status: 'warn', detail: `last ran ${fmtAge(age)} (>${Math.round(AUDIT_STALE_H / 24)}d) — Monday hygiene cron may be dead` }
    : { name: 'memory audit', status: 'ok', detail: `last ran ${fmtAge(age)}` };
}

// Local-LLM provider health (Odysseus). When LOCAL_LLM_* is configured, the
// daemon extractions try Ollama first and silently fall back to OpenAI on any
// failure — so a dead Ollama looks healthy from daemon liveness alone (a
// fallback tick still stamps *_last_tick). This reads the extractionComplete
// telemetry blob (memory key `local_llm_stats`) and pings the server. curl via
// execSync keeps runHealthCheck synchronous; 2s cap bounds the stall.
/**
 * Today's model spend against the caps, plus two conditions that are otherwise
 * invisible: a budget that has already paused background work, and cost figures
 * that are estimates because no real price sheet is configured.
 *
 * An unpriced model is a `warn`, not a footnote. lib/llm-pricing.ts prices
 * unknown models at a deliberately high fallback so the meter never reads as
 * free, which means an unpriced setup will pause background work EARLY and for
 * the wrong reason. That is the safe direction to fail, but it is not a state to
 * sit in silently.
 */
/**
 * Interrupt pressure: is the arbiter holding back far more than it lets through,
 * and is one source responsible for most of it?
 *
 * Also states plainly when the arbiter is still in observe mode, because in that
 * state the held counts are counterfactual -- everything actually went out, and
 * reading them as "the bot is being quiet" would be exactly backwards.
 */
function checkInterrupts(): Check {
  const cfg = arbiterConfig();
  const today = toSqliteDate(startOfTodayET()) ?? '';
  const tally = outboundTallySince(today);
  if (!tally.length) {
    return { name: 'interrupts', status: 'ok', detail: `none today · ${cfg.mode} mode` };
  }

  const sent = tally.filter((t) => t.decision === 'sent' && t.would_hold === 0).reduce((n, t) => n + t.n, 0);
  const withheld = tally.filter((t) => t.decision !== 'sent' || t.would_hold === 1).reduce((n, t) => n + t.n, 0);
  const summary = `${sent}/${cfg.dailyBudget} sent · ${withheld} ${cfg.mode === 'observe' ? 'would be held' : 'held'} · ${cfg.mode} mode`;

  if (withheld > 2 * sent && withheld >= 4) {
    const bySource = new Map<string, number>();
    for (const t of tally) {
      if (t.decision !== 'sent' || t.would_hold === 1) bySource.set(t.source, (bySource.get(t.source) ?? 0) + t.n);
    }
    const loudest = [...bySource.entries()].sort((a, b) => b[1] - a[1])[0];
    return {
      name: 'interrupts',
      status: 'warn',
      detail: `${summary} — ${loudest[0]} accounts for ${loudest[1]} of them; it is over-firing`,
    };
  }
  return { name: 'interrupts', status: 'ok', detail: summary };
}

function checkLlmSpend(): Check {
  const caps = tokenBudgetCaps();
  const dayMicros = getDailyLlmSpendMicros();
  const ambientMicros = getDailyLlmSpendMicros('ambient');
  const models = getLlmModelsSince(startOfTodayET());
  const { unpriced } = modelsArePriced(models);

  const spend = `${formatUsd(dayMicros)}/${formatUsd(caps.dailyCapMicros)} today`
    + ` · background ${formatUsd(ambientMicros)}/${formatUsd(caps.ambientCapMicros)}`;

  let breach: { at?: string; lane?: string; reason?: string } = {};
  try {
    breach = JSON.parse(getMemory('system', 'llm_budget_breached_at') || '{}');
  } catch { /* ignore */ }
  const breachAge = hoursSince(breach.at);
  if (breachAge !== null && breachAge < 24) {
    return {
      name: 'llm spend',
      status: 'warn',
      detail: `${spend} — ${breach.lane} work was paused ${fmtAge(breachAge)} (${breach.reason} cap)`,
    };
  }

  if (!caps.enforced) {
    return { name: 'llm spend', status: 'warn', detail: `${spend} — caps are OBSERVE-ONLY (LLM_BUDGET_ENFORCED=false)` };
  }
  if (unpriced.length) {
    return {
      name: 'llm spend',
      status: 'warn',
      detail: `${spend} — ESTIMATED: no rate configured for ${unpriced.join(', ')}. `
        + 'Set LLM_PRICES_JSON and reconcile against the provider console, or background work will pause early.',
    };
  }
  return { name: 'llm spend', status: 'ok', detail: spend };
}

function checkLocalLlm(): Check | null {
  const base = (process.env.LOCAL_LLM_BASE_URL || '').replace(/\/+$/, '');
  const model = process.env.LOCAL_LLM_MODEL || '';
  if (!base || !model) return null; // not configured — all-OpenAI by design, nothing to report
  if (!isModuleOn('local-model')) return { name: 'local llm', status: 'disabled', detail: MODULE_OFF('local-model') };

  let stats: {
    local_count?: number;
    fallback_count?: number;
    last_local_at?: string;
    last_fallback_at?: string;
    last_fallback_reason?: string;
    last_fallback_caller?: string;
  } = {};
  try {
    stats = JSON.parse(getMemory('system', 'local_llm_stats') || '{}');
  } catch {
    stats = {};
  }
  const counts = `${stats.local_count || 0} local / ${stats.fallback_count || 0} fallback`;

  // Distinguish "refused" (nothing is listening — the server really is down)
  // from "timed out" (something IS listening but is busy). Ollama stalls its
  // HTTP responses while paging a model into VRAM, measured at ~20-35s for an
  // 8B on this box, so a flat short timeout reported a healthy-but-loading
  // server as down and claimed extractions were "silently falling back to
  // OpenAI" when nothing had fallen back at all. A monitor that cries wolf
  // during normal warm-up trains you to ignore it — and this is the same signal
  // the local-model circuit breaker keys on.
  // curl exit codes: 7 = couldn't connect, 28 = operation timeout.
  let probe: 'up' | 'refused' | 'busy' = 'up';
  try {
    execSync(`curl -sf --max-time 5 ${JSON.stringify(`${base}/api/version`)}`, { stdio: 'pipe' });
  } catch (err) {
    const code = (err as { status?: number }).status;
    probe = code === 7 ? 'refused' : 'busy';
  }
  if (probe === 'refused') {
    return { name: 'local llm', status: 'warn', detail: `${model} configured but nothing is listening on ${base} — extractions are falling back to OpenAI (${counts})` };
  }
  if (probe === 'busy') {
    return { name: 'local llm', status: 'ok', detail: `${model} reachable but slow to answer (likely loading into memory) · ${counts}` };
  }

  const localAge = hoursSince(stats.last_local_at);
  const fbAge = hoursSince(stats.last_fallback_at);
  // Most recent outcome was a fallback → the seam is failing even though the server pings.
  if (fbAge !== null && (localAge === null || fbAge < localAge)) {
    return {
      name: 'local llm',
      status: 'warn',
      detail: `last extraction (${stats.last_fallback_caller || '?'}) fell back to OpenAI ${fmtAge(fbAge)}: ${stats.last_fallback_reason || 'unknown'} (${counts})`,
    };
  }
  return {
    name: 'local llm',
    status: 'ok',
    detail: `${model} up · ${counts}${localAge !== null ? ` · last local ${fmtAge(localAge)}` : ' · no extraction traffic yet'}`,
  };
}

// OpenAI key liveness. Same silent-failure class as a dead backend: the env
// var existed but the key had been revoked, so every LLM call failed while the
// process looked healthy. One tiny low-cost call; only an
// auth-shaped failure (401/403) warns, so network blips don't false-alarm.
function checkOpenAIKey(): Check | null {
  const key = process.env.OPENAI_API_KEY || '';
  if (!key) return null; // absent key already degrades loudly at boot
  try {
    const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const body = JSON.stringify({ model: OPENAI_ROUTER_MODEL, input: 'hi', max_output_tokens: 16 });
    const code = execSync(
      `curl -s -o /dev/null -w '%{http_code}' --max-time 5 ${JSON.stringify(`${base}/responses`)} -H ${JSON.stringify(`Authorization: Bearer ${key}`)} -H 'content-type: application/json' -d ${JSON.stringify(body)}`,
      { stdio: 'pipe' },
    ).toString().trim();
    if (code === '401' || code === '403') {
      return { name: 'openai key', status: 'warn', detail: `API returned ${code} — key revoked/invalid; every LLM call is failing silently` };
    }
    return { name: 'openai key', status: 'ok', detail: `authenticated (HTTP ${code})` };
  } catch {
    return { name: 'openai key', status: 'ok', detail: 'probe skipped (network error)' };
  }
}

// Claude key liveness, same idea as the OpenAI probe: list models (no model
// call, nothing billed). Runs the Anthropic SDK in a short child process so the
// check stays synchronous like the rest of the doctor.
function checkAnthropicKey(): Check | null {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const script = [
    "import Anthropic from '@anthropic-ai/sdk';",
    'const c = new Anthropic({ timeout: 5000, maxRetries: 0 });',
    "try { await c.models.list({ limit: 1 }); console.log('200'); }",
    "catch (e) { console.log(e instanceof Anthropic.APIError && e.status ? String(e.status) : 'network'); }",
  ].join(' ');
  try {
    const code = execSync(`node --input-type=module -e ${JSON.stringify(script)}`, {
      stdio: 'pipe', cwd: REPO_ROOT, timeout: 10_000,
    }).toString().trim();
    if (code === '401' || code === '403') {
      return { name: 'claude key', status: 'warn', detail: `API returned ${code}; the key is revoked or invalid, so every reply will fail` };
    }
    if (code === 'network') return { name: 'claude key', status: 'ok', detail: 'probe skipped (network error)' };
    return { name: 'claude key', status: 'ok', detail: `authenticated (HTTP ${code})` };
  } catch {
    return { name: 'claude key', status: 'ok', detail: 'probe skipped' };
  }
}

/** The key check for whichever provider runs the assistant. */
function checkModelKey(): Check | null {
  return llmProvider() === 'claude' ? checkAnthropicKey() : checkOpenAIKey();
}

/**
 * Family is opt-in: a deployment with neither private binding is healthy and
 * simply has the feature disabled. Once either binding exists, fail closed
 * until the chat, secondary calendar, and restricted member profile agree.
 * Values are deliberately never included in the result text because the
 * doctor output is also sent over iMessage by the scheduler.
 */
export function checkFamilyConfig(
  env: NodeJS.ProcessEnv = process.env,
  profile: ProfileConfig = getProfileConfig(),
): Check {
  const groupId = env.GROUP_FAMILY?.trim() || '';
  const calendarId = env.FAMILY_CALENDAR_ID?.trim() || '';
  const calendarAccount = env.FAMILY_CALENDAR_ACCOUNT?.trim() || '';

  if (!groupId && !calendarId) {
    return { name: 'family setup', status: 'disabled', detail: 'not configured' };
  }
  if (!isModuleOn('family', { env, profile })) {
    return { name: 'family setup', status: 'disabled', detail: `${MODULE_OFF('family')} (Family chat settings are ignored)` };
  }
  if (!groupId || !calendarId) {
    const missing = !groupId ? 'family iMessage group mapping' : 'Family calendar binding';
    return { name: 'family setup', status: 'warn', detail: `partial setup — missing ${missing}` };
  }
  if (calendarId.toLowerCase() === 'primary') {
    return { name: 'family setup', status: 'warn', detail: 'calendar binding points at primary; a verified secondary calendar is required' };
  }
  if (!calendarAccount) {
    return { name: 'family setup', status: 'warn', detail: 'Family calendar account pin is missing — run npm run family:configure' };
  }
  if (calendarId.toLowerCase() === calendarAccount.toLowerCase()) {
    return { name: 'family setup', status: 'warn', detail: 'calendar binding matches the connected account primary calendar; a secondary calendar is required' };
  }

  const otherGroupIds = Object.entries(env)
    .filter(([key, value]) => key.startsWith('GROUP_') && key !== 'GROUP_FAMILY' && Boolean(value?.trim()))
    .map(([, value]) => value!.trim());
  if (otherGroupIds.includes(groupId)) {
    return { name: 'family setup', status: 'warn', detail: 'family chat mapping collides with another group' };
  }

  if (!profile.groupsEnabled.includes('family')) {
    return { name: 'family setup', status: 'warn', detail: 'family bindings exist but the family group is not enabled in the private profile' };
  }
  if (!profile.owner.allowedGroups.includes('family')) {
    return { name: 'family setup', status: 'warn', detail: 'family bindings exist but the profile owner is not permitted in family' };
  }

  const familyMembers = profile.members.filter((member) => member.allowedGroups.includes('family'));
  if (familyMembers.length === 0) {
    return { name: 'family setup', status: 'warn', detail: 'family bindings exist but no restricted family member is configured' };
  }
  const memberHasPrivateAccess = familyMembers.some((member) =>
    member.allowedGroups.length !== 1 || member.allowedGroups[0] !== 'family',
  );
  if (memberHasPrivateAccess) {
    return { name: 'family setup', status: 'warn', detail: 'a family member also has private-group access; restrict non-owner members to family' };
  }
  if (getMemory('family', 'security_membership_alert')) {
    return { name: 'family setup', status: 'warn', detail: 'suspended — live iMessage participants do not match the approved Family members' };
  }
  const dailyCron = env.FAMILY_DAILY_CRON?.trim() || '0 7 * * *';
  const weeklyCron = env.FAMILY_WEEKLY_CRON?.trim() || '30 19 * * 0';
  if (!cron.validate(dailyCron) || !cron.validate(weeklyCron)) {
    return { name: 'family setup', status: 'warn', detail: 'a Family update schedule is invalid; no Family schedule will start' };
  }
  if (!automationAllowed('family-scheduler')) {
    return { name: 'family setup', status: 'warn', detail: 'configured, but Family scheduled updates are held by AUTOMATIONS_OFF' };
  }

  return {
    name: 'family setup',
    status: 'ok',
    detail: `configured with owner plus ${familyMembers.length} restricted member${familyMembers.length === 1 ? '' : 's'}`,
  };
}

export function runHealthCheck(): HealthReport {
  const stats = getBrainStats();
  const { overdue } = getTaskStats();

  const checks: Check[] = [];

  // Data presence
  checks.push(
    stats.facts_active > 0
      ? { name: 'facts store', status: 'ok', detail: `${stats.facts_active} active facts` }
      : { name: 'facts store', status: 'warn', detail: 'no active facts — DB empty or unseeded' },
  );
  checks.push(checkSeededPeople());
  checks.push(checkSeedFacts());

  // Loop liveness
  checks.push(checkReflection(stats.last_reflection));
  checks.push(...checkMorningJobs());
  checks.push(checkMemoryAudit());
  checks.push(checkSync());
  checks.push(checkChrome());
  checks.push(checkOnePassword());
  checks.push(...checkDaemonTicks());
  const localLlm = checkLocalLlm();
  if (localLlm) checks.push(localLlm);
  checks.push(checkLlmSpend());
  checks.push(checkInterrupts());

  // Persistence
  checks.push(checkBackup());

  // External config
  checks.push(checkFamilyConfig());
  const modelKey = checkModelKey();
  if (modelKey) checks.push(modelKey);

  const issues = checks.filter((c) => c.status === 'warn');
  return {
    healthy: issues.length === 0,
    checks,
    issues,
    stats: { ...stats, overdue_tasks: overdue },
  };
}

/** Full multi-line report for the CLI. */
export function formatHealthReport(r: HealthReport): string {
  const lines: string[] = [];
  lines.push(r.healthy ? `✅ ${getBotName()} health: OK` : `⚠️  ${getBotName()} health: ${r.issues.length} issue(s)`);
  lines.push('');
  lines.push(
    `stats: ${r.stats.facts_active} facts · ${r.stats.people} people · ` +
    `${r.stats.open_tasks} open tasks (${r.stats.overdue_tasks} overdue) · ${r.stats.messages_24h} msgs/24h`,
  );
  lines.push('');
  for (const c of r.checks) {
    lines.push(`  ${SYMBOL[c.status]} ${c.name}: ${c.detail}`);
  }
  return lines.join('\n');
}

/** Compact alive-ping DM line + any issues appended. Used by the scheduler. */
export function formatAlivePing(r: HealthReport): string {
  const lastRefl = r.stats.last_reflection
    ? `last reflection ${r.stats.last_reflection.slice(0, 16).replace('T', ' ')}`
    : 'no reflection on file yet';
  const head = r.healthy ? `✅ ${getBotName()} alive` : `⚠️ ${getBotName()} alive (issues)`;
  const stat = `${r.stats.facts_active} facts · ${r.stats.people} people · ${r.stats.open_tasks} open tasks · ${r.stats.messages_24h} msgs/24h · ${lastRefl}`;
  if (r.healthy) return `${head} — ${stat}`;
  const issueLines = r.issues.map((i) => `· ${i.name}: ${i.detail}`).join('\n');
  return `${head} — ${stat}\n\nneeds attention:\n${issueLines}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Setup mode: "is this Mac ready to use". See the JSON shape at the top.
// ─────────────────────────────────────────────────────────────────────────────

export interface SetupReport {
  mode: 'setup';
  ready: boolean;
  summary: Record<CheckStatus, number>;
  modules: ModuleState[];
  checks: Check[];
}

/** Everything that touches the machine, injectable so tests never do. */
export interface SetupProbes {
  /** Live OpenAI key probe; null = skipped. */
  openaiKey: () => Check | null;
  /** Output of `launchctl list`, or null when launchctl is unavailable. */
  launchctlList: () => string | null;
  fileExists: (path: string) => boolean;
}

export interface SetupOptions extends SelectionInput {
  repoRoot?: string;
  probes?: Partial<SetupProbes>;
}

const CONTEXT_FILES = [
  'config/profile.json',
  'context/shared/identity.md',
  'context/shared/voice.md',
  'context/shared/profile.md',
  'context/admin/CLAUDE.md',
];

// Background services that should stay loaded (scheduled jobs like backup are
// loaded too, but only show up in `launchctl list` once bootstrapped).
function defaultLaunchctlList(): string | null {
  try {
    return execSync('/bin/launchctl list', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  } catch {
    return null;
  }
}

function envChecks(spec: ModuleSpec, env: NodeJS.ProcessEnv): Check[] {
  const checks: Check[] = [];
  const missing = spec.env.filter((e) => e.required && !env[e.key]?.trim() && !e.satisfiedBy?.(env));
  if (spec.env.some((e) => e.required)) {
    checks.push(missing.length === 0
      ? { name: 'settings', status: 'ok', detail: 'all required settings present' }
      : {
        name: 'settings',
        status: 'fail',
        detail: `missing ${missing.map((e) => e.key).join(', ')}`,
        fix: missing.length === 1
          ? `Add ${missing[0].key} to .env: ${missing[0].description}`
          : `Add ${missing.map((e) => e.key).join(', ')} to .env (.env.example explains each one).`,
      });
  }
  for (const e of spec.env) {
    if (!e.featureSwitch || featureSwitchOn(e, env)) continue;
    checks.push({
      name: e.key,
      status: 'warn',
      detail: `${e.key} is off, so this module stays quiet`,
      fix: `Set ${e.key}=true in .env (or turn the module off if you do not want it).`,
    });
  }
  return checks;
}

function depChecks(spec: ModuleSpec, env: NodeJS.ProcessEnv): Check[] {
  return spec.deps.map((dep) => {
    let ok = false;
    try { ok = dep.check(env); } catch { ok = false; }
    return ok
      ? { name: dep.name, status: 'ok' as const, detail: 'installed' }
      : { name: dep.name, status: 'fail' as const, detail: 'not found', fix: dep.installHint };
  });
}

function launchdChecks(spec: ModuleSpec, env: NodeJS.ProcessEnv, list: string | null): Check[] {
  const prefix = launchdLabelPrefix(env);
  return (spec.launchd ?? []).map((name) => {
    const label = `${prefix}.${name}`;
    if (list === null) return { name: `service ${label}`, status: 'warn' as const, detail: 'could not run launchctl', fix: 'Run npm run install:service from Terminal on this Mac.' };
    const loaded = list.split('\n').some((line) => line.trim().split(/\s+/).pop() === label);
    return loaded
      ? { name: `service ${label}`, status: 'ok' as const, detail: 'loaded in launchd' }
      : { name: `service ${label}`, status: 'warn' as const, detail: 'not installed as a background service', fix: 'Run npm run install:service to start it automatically at login.' };
  });
}

export function runSetupCheck(opts: SetupOptions = {}): SetupReport {
  const env = opts.env ?? process.env;
  const selection: SelectionInput = { env, profile: opts.profile, modules: opts.modules };
  const specs = opts.modules ?? MODULES;
  const root = opts.repoRoot ?? REPO_ROOT;
  const probes: SetupProbes = {
    openaiKey: () => ((env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY) ? checkModelKey() : null),
    launchctlList: defaultLaunchctlList,
    fileExists: existsSync,
    ...opts.probes,
  };

  const modules = resolveModules(selection);
  const checks: Check[] = [];
  const general = (c: Check) => checks.push({ ...c, module: 'general' });

  // General --------------------------------------------------------------
  const unknown = unknownModuleIds(selection);
  if (unknown.length) {
    general({
      name: 'module names',
      status: 'warn',
      detail: `unknown module id(s): ${unknown.join(', ')}`,
      fix: `Use only these ids in MODULES_ON/MODULES_OFF or profile.json modules: ${specs.map((m) => m.id).join(', ')}.`,
    });
  }
  const missingContext = CONTEXT_FILES.filter((f) => !probes.fileExists(join(root, f)));
  general(missingContext.length === 0
    ? { name: 'personal setup', status: 'ok', detail: 'profile and context files generated' }
    : { name: 'personal setup', status: 'warn', detail: `missing ${missingContext.join(', ')}`, fix: 'Run npm run onboard to answer a few questions and generate them.' });
  general(probes.fileExists(join(root, 'dist', 'index.js'))
    ? { name: 'app built', status: 'ok', detail: 'dist/index.js present' }
    : { name: 'app built', status: 'warn', detail: 'dist/index.js missing; the background service cannot start', fix: 'Run npm run build.' });
  if (probes.fileExists(join(root, 'AUTOMATIONS_OFF'))) {
    general({ name: 'paused', status: 'warn', detail: 'background features are paused (replies still work)', fix: 'Run npm run resume when you want them back.' });
  }
  const key = probes.openaiKey();
  if (key) {
    general(key.status === 'warn'
      ? { ...key, status: 'fail', fix: key.name === 'claude key'
        ? 'Create a new key at console.anthropic.com > API keys and put it in .env as ANTHROPIC_API_KEY.'
        : 'Create a new key at platform.openai.com > API keys and put it in .env as OPENAI_API_KEY.' }
      : key);
  }

  // Per module ------------------------------------------------------------
  let list: string | null | undefined;
  for (const spec of specs) {
    const state = resolveModule(spec, selection);
    if (!state.on) {
      checks.push({
        module: spec.id,
        name: spec.title,
        status: 'disabled',
        detail: state.source === 'env-off' ? 'switched off by MODULES_OFF' : state.source === 'profile' ? 'switched off in config/profile.json' : 'off by default',
        fix: `To turn it on, add "${spec.id}": true under "modules" in config/profile.json (or MODULES_ON=${spec.id} in .env).`,
      });
      continue;
    }
    const moduleChecks: Check[] = [...envChecks(spec, env), ...depChecks(spec, env)];
    if (spec.setupChecks) {
      try { moduleChecks.push(...spec.setupChecks(env)); }
      catch (err) { moduleChecks.push({ name: 'setup probe', status: 'warn', detail: (err as Error).message }); }
    }
    if (spec.launchd?.length) {
      if (list === undefined) list = probes.launchctlList();
      moduleChecks.push(...launchdChecks(spec, env, list));
    }
    if (moduleChecks.length === 0) moduleChecks.push({ name: spec.title, status: 'ok', detail: 'nothing to set up' });
    checks.push(...moduleChecks.map((c) => ({ ...c, module: spec.id })));
  }
  if (isModuleOn('family', selection)) {
    const family = checkFamilyConfig(env);
    checks.push({
      ...family,
      module: 'family',
      status: family.status === 'warn' ? 'fail' : family.status,
      ...(family.status === 'warn' || family.status === 'disabled' ? { fix: 'Follow docs/FAMILY.md, then run npm run family:configure.' } : {}),
    });
  }

  const summary: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0, disabled: 0 };
  for (const c of checks) summary[c.status]++;
  return { mode: 'setup', ready: summary.fail === 0, summary, modules, checks };
}

const SYMBOL: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗', disabled: '–' };

export function formatSetupReport(r: SetupReport): string {
  const lines: string[] = [];
  const problems = r.summary.fail + r.summary.warn;
  lines.push(r.ready
    ? `${getBotName()} setup: ready${r.summary.warn ? ` (${r.summary.warn} suggestion${r.summary.warn === 1 ? '' : 's'})` : ''}`
    : `${getBotName()} setup: ${r.summary.fail} thing${r.summary.fail === 1 ? '' : 's'} to fix before it works${problems > r.summary.fail ? `, ${r.summary.warn} suggestion(s)` : ''}`);
  const titles = new Map(r.modules.map((m) => [m.id, m.title]));
  const order = ['general', ...r.modules.filter((m) => m.on).map((m) => m.id)];
  for (const id of order) {
    const rows = r.checks.filter((c) => c.module === id && c.status !== 'disabled');
    if (!rows.length) continue;
    lines.push('');
    lines.push(id === 'general' ? 'General' : `${titles.get(id) ?? id}`);
    for (const c of rows) {
      lines.push(`  ${SYMBOL[c.status]} ${c.name}: ${c.detail}`);
      if (c.fix && (c.status === 'fail' || c.status === 'warn')) lines.push(`      fix: ${c.fix}`);
    }
  }
  const off = r.modules.filter((m) => !m.on).map((m) => m.title);
  if (off.length) {
    lines.push('');
    lines.push(`Off: ${off.join(', ')}`);
    lines.push('  (turn one on with "modules": { "<id>": true } in config/profile.json)');
  }
  return lines.join('\n');
}
