import { existsSync } from 'fs';
import { join } from 'path';

// Sentinel-file kill switch for proactive automations, with a per-module allowlist.
//
// If `AUTOMATIONS_OFF` exists at the repo root, index.ts skips every start*()
// automation call (scheduler / heartbeat / brain-pulse / idea-pulse / journal /
// hygiene / notion syncs / etc.)
// and each KeepAlive daemon (imessage / inbox-signal / meeting) exits immediately.
// Message replies still work; the bot stays responsive to iMessages.
//
// THE ALLOWLIST (added 2026-08-16). The sentinel used to be all-or-nothing, which
// made "run the content pipeline but stay quiet" impossible: the only way to start
// content-engine was to also start the heartbeat, both pulses, the hygiene loop and
// the flywheel. Only two of the eleven modules had their own env guard, so there was
// nothing finer to reach for. `AUTOMATIONS_ON` is a comma-separated list of module
// keys that run even while the sentinel is present, so the sentinel keeps its
// documented meaning (the bot stops *talking*) and the scheduled work is opt-in.
//
//   AUTOMATIONS_ON=hygiene,brain-pulse
//
// Precedence: no sentinel -> everything runs, allowlist ignored. Sentinel present
// -> only the allowlist runs. A module's own env guard still applies on top and
// still wins; this can permit a module, never force one on.
export function automationsOff(): boolean {
  return existsSync(join(process.cwd(), 'AUTOMATIONS_OFF'));
}

export function automationAllowed(key: string): boolean {
  if (!automationsOff()) return true;
  return (process.env.AUTOMATIONS_ON || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(key.toLowerCase());
}
