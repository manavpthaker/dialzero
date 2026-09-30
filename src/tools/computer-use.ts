// Computer use — OS-level vision + control of the Mac mini desktop.
//
// One polymorphic `computer_use` tool (mirrors browser_action). Actions:
//   screenshot | click | type | key_press | scroll | open_app | switch_app
//
// Free (run inline): screenshot, open_app, switch_app. screenshot returns a
// base64 image the model can see. The free actions are audited in the
// computer_use_log table.
//
// Gated (propose → `go #action:N` → confirm): click, type, key_press, scroll.
// The handler does NOT run these; it stages them in the `actions` table via
// proposeAction and returns the dm string. confirm_action then runs
// runComputerUseAction (registered in actions.ts EXECUTORS, NOT in the tool
// registry — so the gate is unskippable, exactly like runBrowserReorder).
//
// Coordinate model: the model sees a downscaled JPEG (COMPUTER_USE_SCREENSHOT_PX
// wide). cliclick operates in logical points. screencapture is native pixels.
// We freeze the screen-points + image-px geometry into the action payload at
// propose time and scale image-px → points at execute time. See CLAUDE.md.

import { proposalText } from '../lib/proposal-text.js';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';
import { readFileSync, existsSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type Anthropic from '@anthropic-ai/sdk';
import type { ToolDef, ToolContext } from './index.js';
import { proposeAction, getAction, logComputerUseAction, type Action } from '../db.js';
import { sendImageMessage } from '../channels/imessage.js';
import { isBrowserConnected } from '../browser-bridge.js';

const exec = promisify(execFile);

// All pinned by absolute path — launchd's PATH excludes Homebrew. screencapture
// / sips / open / system_profiler ship with macOS; cliclick is `brew install cliclick`.
const SCREENCAPTURE_BIN = process.env.SCREENCAPTURE_BIN || '/usr/sbin/screencapture';
const SIPS_BIN = process.env.SIPS_BIN || '/usr/bin/sips';
const CLICLICK_BIN = process.env.CLICLICK_BIN || '/opt/homebrew/bin/cliclick';
const OPEN_BIN = process.env.OPEN_BIN || '/usr/bin/open';
const SYSTEM_PROFILER_BIN = process.env.SYSTEM_PROFILER_BIN || '/usr/sbin/system_profiler';

const GATE_ALL = (process.env.COMPUTER_USE_GATE_ALL || 'false').toLowerCase() === 'true';

function screenshotPx(): number {
  const n = parseInt(process.env.COMPUTER_USE_SCREENSHOT_PX || '1280', 10);
  return Number.isFinite(n) && n >= 256 && n <= 2576 ? n : 1280;
}

type ImageOrText = Anthropic.TextBlockParam | Anthropic.ImageBlockParam;
type Geometry = { screenW: number; screenH: number; imageW: number; imageH: number };

// cliclick is required for the input actions (click/type/key_press/scroll) but
// NOT for screenshot/open_app/switch_app. Checked per-action so a missing
// cliclick degrades gracefully instead of disabling the whole tool.
export function computerUseInputAvailable(): boolean {
  return existsSync(CLICLICK_BIN);
}

// Read the logical screen size in POINTS (not native pixels) for the main
// display, via `system_profiler SPDisplaysDataType`. "UI Looks like" is the
// effective logical resolution on scaled/Retina displays; "Resolution" is the
// native one otherwise. cliclick works in points, so we prefer "UI Looks like"
// when present. Returns null if it can't be parsed (clicks then unavailable).
//
// This deliberately AVOIDS the old `tell Finder to get bounds of window of
// desktop` AppleScript: that needed an Automation→Finder grant, prompted on
// first use (the prompt blocked the first screenshot with an AppleEvent -1712
// timeout), and could never be granted to an unattended launchd process.
// system_profiler needs no TCC grant and returns in ~0.1s.
function measureScreenPoints(): { w: number; h: number } | null {
  const LOOKS = /UI Looks like:\s*(\d+)\s*x\s*(\d+)/i;
  const RES = /Resolution:\s*(\d+)\s*x\s*(\d+)/i;
  const parse = (line: string, re: RegExp): { w: number; h: number } | null => {
    const m = line.match(re);
    if (!m) return null;
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    return w > 0 && h > 0 ? { w, h } : null;
  };
  try {
    const out = execFileSync(SYSTEM_PROFILER_BIN, ['SPDisplaysDataType'], { timeout: 8000 }).toString();
    // Walk per-display: "Resolution"/"UI Looks like" precede "Main Display: Yes"
    // within a block, so the values held when we reach the main-display marker
    // are that display's. Fall back to the first display if none is marked.
    let curLooks: { w: number; h: number } | null = null;
    let curRes: { w: number; h: number } | null = null;
    let firstLooks: { w: number; h: number } | null = null;
    let firstRes: { w: number; h: number } | null = null;
    for (const line of out.split('\n')) {
      const looks = parse(line, LOOKS);
      const res = parse(line, RES);
      if (looks) { curLooks = looks; if (!firstLooks) firstLooks = looks; }
      if (res) { curRes = res; if (!firstRes) firstRes = res; }
      if (/Main Display:\s*Yes/i.test(line)) {
        const pick = curLooks ?? curRes;
        if (pick) return pick;
      }
    }
    return firstLooks ?? firstRes;
  } catch {
    return null;
  }
}

// Derive the image dimensions a screenshot will have (sips -Z sets the longest
// edge to PX, preserving aspect). Single source of truth so the dims reported by
// the screenshot action exactly match the dims frozen into a click proposal.
function computeGeometry(): Geometry | null {
  const pts = measureScreenPoints();
  if (!pts) return null;
  const px = screenshotPx();
  const longest = Math.max(pts.w, pts.h);
  return {
    screenW: pts.w,
    screenH: pts.h,
    imageW: Math.round((pts.w / longest) * px),
    imageH: Math.round((pts.h / longest) * px),
  };
}

// screencapture -x (no sound) → temp PNG → sips resize+JPEG → base64. Mirrors
// convertImageToJpegBase64 in imessage.ts, but captures stderr so a Screen
// Recording permission failure surfaces instead of being swallowed.
function captureScreenshotBase64(): string {
  const tmpPng = join(tmpdir(), `assistant-screen-${Date.now()}.png`);
  const tmpJpg = join(tmpdir(), `assistant-screen-${Date.now()}.jpg`);
  try {
    execFileSync(SCREENCAPTURE_BIN, ['-x', tmpPng]);
    execFileSync(SIPS_BIN, ['-s', 'format', 'jpeg', '-Z', String(screenshotPx()), tmpPng, '--out', tmpJpg]);
    return readFileSync(tmpJpg).toString('base64');
  } finally {
    for (const p of [tmpPng, tmpJpg]) {
      try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
    }
  }
}

// Capture to a JPEG file on disk and return its path (the caller deletes it after
// sending). Used by send_screenshot, which needs a real file for the iMessage
// attachment — sendImageMessage takes a path, not base64.
function captureScreenshotToFile(): string {
  const tmpPng = join(tmpdir(), `assistant-shot-${Date.now()}.png`);
  const tmpJpg = join(tmpdir(), `assistant-shot-${Date.now()}.jpg`);
  try {
    execFileSync(SCREENCAPTURE_BIN, ['-x', tmpPng]);
    execFileSync(SIPS_BIN, ['-s', 'format', 'jpeg', '-Z', String(screenshotPx()), tmpPng, '--out', tmpJpg]);
    return tmpJpg;
  } finally {
    try { if (existsSync(tmpPng)) unlinkSync(tmpPng); } catch { /* best-effort */ }
  }
}

// ── input primitives (cliclick / open) ───────────────────────────────────────

async function cliclick(args: string[]): Promise<void> {
  // promisify(execFile) rejects on non-zero exit and includes stderr.
  await exec(CLICLICK_BIN, args);
}

// `open -a` launches the app if needed and brings it to the front. We use it for
// BOTH open_app and switch_app: it routes through Launch Services, so — unlike
// `osascript … to activate` — it needs no Automation/AppleEvents consent, which
// a headless launchd process can't grant.
async function openApp(app: string): Promise<void> {
  await exec(OPEN_BIN, ['-a', app]);
}

async function switchApp(app: string): Promise<void> {
  await exec(OPEN_BIN, ['-a', app]);
}

// ── gating ────────────────────────────────────────────────────────────────────

const INPUT_ACTIONS = new Set(['click', 'type', 'key_press', 'scroll']);

// screenshot is always free (it's pure observation — gating it would blind the
// assistant). open_app/switch_app are free unless COMPUTER_USE_GATE_ALL forces
// every side-effecting action through the confirm gate.
function isGated(action: string): boolean {
  if (action === 'screenshot') return false;
  if (action === 'open_app' || action === 'switch_app') return GATE_ALL;
  return INPUT_ACTIONS.has(action);
}

// ── task-level approval ───────────────────────────────────────────────────────
// A single `go #action:N` on a `start_task` proposal opens a time-boxed window in
// which the gated input actions (click/type/key_press/scroll) run INLINE instead
// of each needing its own confirmation — so the assistant can carry out a multi-step
// desktop task (re-screenshotting between steps) after ONE approval. Window is
// per-group, held in-process (lost on restart = fail-safe back to per-action gate).
const TASK_WINDOW_MS = (() => {
  const n = parseInt(process.env.COMPUTER_USE_TASK_WINDOW_MS || '300000', 10);
  return Number.isFinite(n) && n >= 30000 && n <= 1800000 ? n : 300000; // 30s–30m, default 5m
})();
const taskApprovalUntil = new Map<string, number>();

// Called by the computer_use_task executor (inside confirm_action) on approval.
export function approveComputerUseTask(group: string): void {
  taskApprovalUntil.set(group, Date.now() + TASK_WINDOW_MS);
}
// Re-gate immediately (used by trusted orchestrators like the content publisher
// when they're done driving a vision flow, so the window doesn't linger).
export function clearComputerUseTask(group: string): void {
  taskApprovalUntil.delete(group);
}
function taskApproved(group: string): boolean {
  return Date.now() < (taskApprovalUntil.get(group) || 0);
}
function taskSecondsLeft(group: string): number {
  return Math.max(0, Math.round(((taskApprovalUntil.get(group) || 0) - Date.now()) / 1000));
}

// Mirrors dmFormat in actions.ts (kept local to avoid a circular import:
// actions.ts already imports runComputerUseAction from here). No cost line —
// computer use never spends money.
function dmFormat(a: Action): string {
  return proposalText(a.id, a.summary);
}

const MAX_TYPE_LEN = 2000;

function sanitizeKey(key: string): string {
  // cliclick key names are lowercase alnum + dashes (return, esc, page-down, …).
  return key.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
}

const WEB_PLAN = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|ai|io|net|org|app|co|us)\b|\bweb ?(site|page|app)\b|\bsubscription\b|\bmembership\b|\bsign ?in\b|\blog ?in\b|\bin (the )?browser\b|\bin chrome\b|\baccount settings\b|\bcheckout\b)/i;
const DESKTOP_PLAN = /\b(lastpass|extension|finder|system settings|system preferences|restart chrome|quit chrome|dialog|permission)\b/i;

/** A plan that's really a website task (and not about Chrome's own menus or other apps). */
export function looksLikeWebTask(plan: string): boolean {
  return WEB_PLAN.test(plan) && !DESKTOP_PLAN.test(plan);
}

export const computerUseTools: ToolDef[] = [
  {
    definition: {
      name: 'computer_use',
      description: `See and control the Mac mini desktop (the whole machine, not just Chrome — use do_online / browser_action for ANY website work). Single main display, single cursor.

Workflow: take ONE screenshot, read it, then act — don't poll-screenshot in a loop. Click coordinates are in the pixel space of the screenshot image you were just shown (the text block reports its size).

Actions:
- screenshot: Capture the screen and return it as an image YOU (the model) can read — this is for your OWN vision so you can see the desktop and then control it. It does NOT send anything to the user. Free, read-only.
- send_screenshot: Capture the screen and SEND it to the user as an iMessage image attachment. Use this when the user asks you to "send me / show me a screenshot" of the desktop (the normal reply channel is text-only, so this is the only way to get an image to them). Free.
- open_app: Launch (or focus) an app by name, e.g. "Safari", "Finder", "Claude". Free.
- switch_app: Bring an already-running app to the front by name. Free.
- click: Click at image-pixel coordinates x,y. GATED — proposed for confirmation.
- type: Type a string of text into whatever is focused. GATED — the text is shown to the user before they approve.
- key_press: Press a key (e.g. "return", "esc", "tab", "space", "page-down"). GATED.
- scroll: Scroll the focused region up/down by a number of pages. GATED. (Keystroke-based — click into the scroll area first to focus it.)
- start_task: Propose a MULTI-STEP desktop task for one-shot approval. Pass a plain-English "plan" of what you'll do. The user approves the whole task once with "go #action:N"; for the next few minutes your click/type/key_press/scroll run WITHOUT per-action approval, so you can screenshot→act→screenshot→act through the task. Free (it only stages the approval).
- end_task: Close the task-approval window early once the task is done (gating returns to per-action). Free.

**Websites are NOT desktop work.** Anything on a website (cancel a subscription, export data, change a setting, fill a web form, read a page) goes through Chrome: do_online, book_online, or browser_action. Use computer_use only for things outside the web page: other Mac apps, LastPass or Chrome extension menus, system dialogs. start_task refuses a website plan while Chrome is connected.

**Choosing the flow:** for a SINGLE action (one click/type), just call it directly — it's individually gated. For anything multi-step on the desktop (navigate an app UI, "open X and do Y"), call start_task FIRST with the plan, wait for the user's "go #action:N", then carry out the steps (screenshot between them — coordinates change as the UI changes), and call end_task when finished. Do NOT propose dozens of separate clicks.

Gated single actions are NOT executed immediately: they're staged behind the confirmation gate and the user must reply "go #action:N" first.

You DO have this tool available — never tell the user you can't see or control the desktop, and never claim a screenshot was sent unless you called send_screenshot.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: ['screenshot', 'send_screenshot', 'click', 'type', 'key_press', 'scroll', 'open_app', 'switch_app', 'start_task', 'end_task'],
            description: 'The desktop action to perform',
          },
          plan: { type: 'string', description: 'Plain-English plan of the multi-step task you intend to carry out (for start_task) — this is what the user approves.' },
          x: { type: 'number', description: 'X coordinate in screenshot-image pixels (for click)' },
          y: { type: 'number', description: 'Y coordinate in screenshot-image pixels (for click)' },
          text: { type: 'string', description: 'Text to type (for type)' },
          key: { type: 'string', description: 'Key name to press, e.g. "return", "esc", "tab", "page-down" (for key_press)' },
          direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (for scroll)' },
          amount: { type: 'number', description: 'Number of pages to scroll, default 3 (for scroll)' },
          app: { type: 'string', description: 'Application name (for open_app / switch_app)' },
        },
        required: ['action'],
      },
    },
    handler: async (input, context?: ToolContext): Promise<string | ImageOrText[]> => {
      const action = String(input.action || '');
      const group = context?.groupKey || 'admin';
      if (!action) return 'computer_use: missing "action".';

      // ── Free, read-only: screenshot ──────────────────────────────────────
      if (action === 'screenshot') {
        const geo = computeGeometry();
        let b64: string;
        try {
          b64 = captureScreenshotBase64();
        } catch (err) {
          return `Screenshot failed: ${err instanceof Error ? err.message : String(err)}. If this is a black/empty image or a permission error, grant Screen Recording to the Assistant process in System Settings → Privacy & Security.`;
        }
        const text = geo
          ? `Screenshot captured — image is ${geo.imageW}×${geo.imageH}px (downscaled from a ${geo.screenW}×${geo.screenH}pt display). Give click coordinates in this image's pixel space.`
          : `Screenshot captured. (Could not measure the logical screen size, so click actions may be unavailable until that resolves.)`;
        logComputerUseAction({ action, summary: 'Took a screenshot of the desktop', outcome: text, group });
        return [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } },
          { type: 'text', text },
        ];
      }

      // ── Free: capture + SEND the image to the user as an iMessage attachment ─
      if (action === 'send_screenshot') {
        const recipient = context?.recipient;
        if (!recipient) {
          return 'send_screenshot: no recipient available (this only works in a live chat, not a scheduled run). Use screenshot if you just need to see the screen yourself.';
        }
        let path: string;
        try {
          path = captureScreenshotToFile();
        } catch (err) {
          return `send_screenshot: capture failed: ${err instanceof Error ? err.message : String(err)}. Grant Screen Recording to the Assistant process.`;
        }
        try {
          await sendImageMessage(recipient, path);
          logComputerUseAction({ action, summary: 'Captured and sent a desktop screenshot to the user', outcome: 'sent', group });
          return 'Screenshot captured and sent to the user as an iMessage attachment. Let them know it is on the way — do not describe it unless they ask.';
        } catch (err) {
          return `send_screenshot: send failed: ${err instanceof Error ? err.message : String(err)}`;
        } finally {
          try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
        }
      }

      // ── Free, side-effecting: open_app / switch_app (unless GATE_ALL) ─────
      if ((action === 'open_app' || action === 'switch_app') && !isGated(action)) {
        const app = String(input.app || '').trim();
        if (!app) return `computer_use ${action}: missing "app".`;
        try {
          if (action === 'open_app') await openApp(app);
          else await switchApp(app);
          const summary = action === 'open_app' ? `Opened app "${app}"` : `Switched to app "${app}"`;
          logComputerUseAction({ action, summary, payload: { app }, outcome: 'ok', group });
          return `${summary}.`;
        } catch (err) {
          return `${action} "${app}" failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // ── Free: task-level approval (start_task / end_task) ────────────────
      if (action === 'start_task') {
        const plan = String(input.plan || '').trim();
        if (!plan) return 'computer_use start_task: missing "plan" (describe the multi-step task you intend to carry out).';
        // Website work goes through Chrome (do_online / browser_action), not the
        // desktop. Desktop control is only for things outside the web page.
        if (isBrowserConnected() && looksLikeWebTask(plan)) {
          return 'Not started: this is a website task, so do it in Chrome, not by controlling the desktop. Use do_online (cancel, export, change a setting; pass owner_request if the owner asked) or browser_action for reading a page. Use computer_use only for things outside Chrome (other apps, LastPass or extension menus, system dialogs).';
        }
        const id = proposeAction({
          kind: 'computer_use_task',
          tool_name: 'computer_use_task',
          summary: plan,
          payload_json: JSON.stringify({ action: 'task', plan }),
          estimated_cost_cents: null,
          reversible: false,
          category: 'computer_use',
          created_by_group: group,
        });
        const mins = Math.round(TASK_WINDOW_MS / 60000);
        return proposalText(id, `${plan} (on the Mac, about ${mins} min)`);
      }
      if (action === 'end_task') {
        const wasActive = taskApproved(group);
        taskApprovalUntil.delete(group);
        logComputerUseAction({ action, summary: 'Closed the desktop task-approval window', outcome: wasActive ? 'closed' : 'noop', group });
        return wasActive ? 'Task window closed — desktop actions are back to per-action approval.' : 'No active task window to close.';
      }

      // ── Gated: stage behind the confirm gate ─────────────────────────────
      if (INPUT_ACTIONS.has(action) && !computerUseInputAvailable()) {
        return 'Computer input control unavailable — install cliclick (`brew install cliclick`) and grant Accessibility permission to the Assistant process.';
      }

      const payload: Record<string, unknown> = { action };
      let summary: string;

      switch (action) {
        case 'click': {
          const x = Number(input.x);
          const y = Number(input.y);
          if (!Number.isFinite(x) || !Number.isFinite(y)) return 'computer_use click: missing numeric "x"/"y".';
          const geo = computeGeometry();
          if (!geo) return 'computer_use click: could not measure the screen, so the click cannot be positioned. Take a screenshot first.';
          payload.x = x; payload.y = y; payload.geometry = geo;
          summary = `Click at (${Math.round(x)}, ${Math.round(y)}) on screen`;
          break;
        }
        case 'type': {
          const text = String(input.text ?? '');
          if (!text) return 'computer_use type: missing "text".';
          if (text.length > MAX_TYPE_LEN) return `computer_use type: text too long (${text.length} > ${MAX_TYPE_LEN}).`;
          payload.text = text;
          summary = `Type: "${text}"`;
          break;
        }
        case 'key_press': {
          const key = sanitizeKey(String(input.key ?? ''));
          if (!key) return 'computer_use key_press: missing/invalid "key".';
          payload.key = key;
          summary = `Press key: ${key}`;
          break;
        }
        case 'scroll': {
          const direction = input.direction === 'up' ? 'up' : 'down';
          const amount = Math.min(Math.max(parseInt(String(input.amount ?? 3), 10) || 3, 1), 20);
          payload.direction = direction; payload.amount = amount;
          summary = `Scroll ${direction} ${amount} page(s)`;
          break;
        }
        case 'open_app':
        case 'switch_app': {
          // Only reached when GATE_ALL is on.
          const app = String(input.app || '').trim();
          if (!app) return `computer_use ${action}: missing "app".`;
          payload.app = app;
          summary = action === 'open_app' ? `Open app "${app}"` : `Switch to app "${app}"`;
          break;
        }
        default:
          return `computer_use: unknown action "${action}".`;
      }

      // Task-approval window open → run inline (no per-action confirmation). The
      // model re-screenshots between steps, so this handles UIs that change.
      if (taskApproved(group)) {
        try {
          const res = await runComputerUseAction({ payload_json: JSON.stringify(payload) } as Action);
          logComputerUseAction({ action, summary: `[task] ${summary}`, payload, outcome: res.outcome, group });
          return `${res.outcome} (task mode, ~${taskSecondsLeft(group)}s left — call end_task when done).`;
        } catch (err) {
          return `${action} failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      }

      const id = proposeAction({
        kind: 'computer_use',
        tool_name: 'computer_use',
        summary,
        payload_json: JSON.stringify(payload),
        estimated_cost_cents: null,
        reversible: false,
        category: 'computer_use',
        created_by_group: group,
      });
      return dmFormat(getAction(id)!);
    },
  },
];

// ── Executor (runs INSIDE confirm_action, never agent-callable) ───────────────

type ComputerUsePayload = {
  action: string;
  x?: number; y?: number; geometry?: Geometry;
  text?: string; key?: string;
  direction?: 'up' | 'down'; amount?: number;
  app?: string;
};

export async function runComputerUseAction(action: Action): Promise<{ outcome: string; outcome_url?: string; actual_cost_cents: number }> {
  const p = JSON.parse(action.payload_json) as ComputerUsePayload;

  switch (p.action) {
    case 'click': {
      if (!computerUseInputAvailable()) {
        throw new Error('cliclick not installed — run `brew install cliclick` and grant Accessibility permission.');
      }
      const geo = p.geometry;
      if (!geo || typeof p.x !== 'number' || typeof p.y !== 'number') {
        throw new Error('click payload missing coordinates or geometry.');
      }
      // Stale-geometry guard: the screen may have changed since this was
      // proposed. Re-measure and bail rather than clicking a now-wrong spot.
      const live = measureScreenPoints();
      if (!live) throw new Error('could not re-measure the screen to verify the click position.');
      if (live.w !== geo.screenW || live.h !== geo.screenH) {
        throw new Error(`screen layout changed since this was proposed (was ${geo.screenW}×${geo.screenH}pt, now ${live.w}×${live.h}pt) — re-screenshot and propose again.`);
      }
      // image-pixels → logical points.
      const px = Math.round(p.x * (geo.screenW / geo.imageW));
      const py = Math.round(p.y * (geo.screenH / geo.imageH));
      if (px < 0 || py < 0 || px > geo.screenW || py > geo.screenH) {
        throw new Error(`click point (${px}, ${py})pt is outside the screen (${geo.screenW}×${geo.screenH}pt).`);
      }
      await cliclick([`c:${px},${py}`]);
      return { outcome: `clicked at (${px}, ${py})pt`, actual_cost_cents: 0 };
    }
    case 'type': {
      if (!computerUseInputAvailable()) throw new Error('cliclick not installed.');
      const text = p.text ?? '';
      if (!text) throw new Error('type payload has no text.');
      await cliclick([`t:${text}`]);
      return { outcome: `typed ${text.length} character(s)`, actual_cost_cents: 0 };
    }
    case 'key_press': {
      if (!computerUseInputAvailable()) throw new Error('cliclick not installed.');
      const key = sanitizeKey(p.key ?? '');
      if (!key) throw new Error('key_press payload has no valid key.');
      await cliclick([`kp:${key}`]);
      return { outcome: `pressed ${key}`, actual_cost_cents: 0 };
    }
    case 'scroll': {
      if (!computerUseInputAvailable()) throw new Error('cliclick not installed.');
      const amount = Math.min(Math.max(p.amount ?? 3, 1), 20);
      const keyName = p.direction === 'up' ? 'page-up' : 'page-down';
      await cliclick(Array(amount).fill(`kp:${keyName}`));
      return { outcome: `scrolled ${p.direction ?? 'down'} ${amount} page(s)`, actual_cost_cents: 0 };
    }
    case 'open_app': {
      const app = p.app ?? '';
      if (!app) throw new Error('open_app payload has no app.');
      await openApp(app);
      return { outcome: `opened ${app}`, actual_cost_cents: 0 };
    }
    case 'switch_app': {
      const app = p.app ?? '';
      if (!app) throw new Error('switch_app payload has no app.');
      await switchApp(app);
      return { outcome: `switched to ${app}`, actual_cost_cents: 0 };
    }
    default:
      throw new Error(`unknown computer_use action "${p.action}".`);
  }
}
