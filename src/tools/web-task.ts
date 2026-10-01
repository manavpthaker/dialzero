// do_online (registered under `actions`, admin/DM only): website tasks in the
// owner's Chrome (cancel a subscription, export data, change a setting).
// Logic: src/web-task.ts. The sub-agent reuses the booking-browser tools.

import { proposalText } from '../lib/proposal-text.js';
import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import type { ToolDef, ToolContext } from './index.js';
import { getTimezone } from '../config.js';
import { proposeAction, getAction } from '../db.js';
import { checkActionsEnabled } from '../lib/spend-cap.js';
import { ownerAskedForWebTask } from '../lib/owner-request.js';
import { bookingDeps, looksLikeCardNumber } from '../web-booking.js';
import { prepareWebTask, startWebTask, activeWebTaskRun, WEB_TASK_NOT_CONNECTED, type WebTaskPayload } from '../web-task.js';
import { takeCode, takeLink, matchItem, answerItem } from '../jobs.js';
import { bookingWindowOpen } from '../web-booking.js';
import { browserTools } from './browser.js';

export const webTaskTools: ToolDef[] = [
  {
    definition: {
      name: 'do_online',
      description: `Get something done on a WEBSITE in the owner's Chrome, where they're signed in and their password manager fills logins: cancel a subscription, export or download their data, change an account setting, start a return. USE THIS for any website task, never computer_use (computer_use is only for things outside Chrome). Bookings use book_online; orders use propose_action.
- owner_request: the owner's exact words asking for it, copied from their message (this one or one in the last 30 minutes). With it, it runs now, no "go". Omit it when it's YOUR idea; then it's staged as #action:N for their "go".
- task: the whole job in order, in plain words, e.g. "export all recordings as audio, then cancel the subscription". Put must-do-first steps first; it stops before cancelling if an earlier step fails.
- site: the URL or the service name.
It never pays and always turns down offers to stay on its own, so never tell it to stop or ask at a retention offer. It pauses for them only for a login, a code, or a real decision. The result comes back by text. If a site only lets you cancel by phone, offer call_now.
After calling this, tell the owner the returned line in one short sentence (for a proposal, DM the exact text returned).`,
      input_schema: {
        type: 'object' as const,
        properties: {
          owner_request: { type: 'string', description: "The owner's exact words asking for this. Omit if it's your idea." },
          task: { type: 'string', description: 'What to get done, in order, e.g. "export all recordings as audio, then cancel the PLAUD subscription".' },
          site: { type: 'string', description: 'URL or service name, e.g. "https://web.plaud.ai" or "PLAUD".' },
          share: { type: 'string', description: 'Details it may enter, with values (e.g. a reason for cancelling). Never card, bank, ID, or passwords. Optional.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Absolute paths of files it may upload (a receipt, a photo, a form), from their Downloads, Desktop or Documents. Optional.' },
          notes: { type: 'string', description: 'Anything else, e.g. "take the free month if offered". Optional.' },
        },
        required: ['task', 'site'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      const enabled = checkActionsEnabled();
      if (!enabled.ok) return enabled.reason!;
      const prepared = prepareWebTask(input);
      if ('error' in prepared) return `Not started: ${prepared.error}`;
      if (!bookingDeps().isConnected()) return `Not started: ${WEB_TASK_NOT_CONNECTED} (Tell the owner that in one line.)`;
      const group = context?.groupKey || 'admin';
      const quote = String(input.owner_request ?? '').trim();
      const payload = prepared.payload as unknown as WebTaskPayload;
      // Already on it? A second job on the same site would fight the first for
      // the browser. Waiting on them → their words are the answer; running → say so.
      const site = (() => { try { return new URL(payload.site).hostname.replace(/^(www|web|app)\./, '').split('.')[0]; } catch { return payload.site; } })();
      const same = matchItem(`${site} ${payload.task}`, (i) => i.key.startsWith('job:') && (i.status === 'working' || i.status === 'waiting_on_you') && i.title.toLowerCase().includes(site.toLowerCase()));
      if ('item' in same) {
        if (same.item.status === 'waiting_on_you') return answerItem(same.item.title, quote || payload.task);
        return `Already working on that (${same.item.title.replace(/\.$/, '')}). Tell them in one line; don't start another.`;
      }
      if (quote && ownerAskedForWebTask(quote, context)) {
        const { id, done } = startWebTask(payload, prepared.summary, group);
        void done;
        return `Started [action #${id}]. Tell the owner in one short line, e.g. "🌐 On it in Chrome. I'll text you when it's done."`;
      }
      const id = proposeAction({
        kind: 'web_task', tool_name: 'web_task', summary: prepared.summary,
        payload_json: JSON.stringify(prepared.payload), estimated_cost_cents: null,
        reversible: false, category: 'web_task', created_by_group: group,
      });
      const note = quote ? '(owner_request didn\'t match their recent messages, so this needs their "go".)\n' : '';
      return note + proposalText(id, getAction(id)!.summary);
    },
  },
];

// For the web-task sub-agent: proof that an export or download actually landed.
const DOWNLOADS = process.env.DOWNLOADS_DIR || join(process.env.HOME || '', 'Downloads');
export const checkDownloadsTool: ToolDef = {
  definition: {
    name: 'check_downloads',
    description: 'List files that recently landed in the Mac\'s Downloads folder (name, size, time), newest first. Use it to confirm an export or download actually finished before moving on.',
    input_schema: {
      type: 'object' as const,
      properties: {
        hours: { type: 'number', description: 'How far back to look (default 6).' },
        name_contains: { type: 'string', description: 'Only files whose name contains this. Optional.' },
      },
    },
  },
  handler: async (input) => {
    const since = Date.now() - (Number(input.hours) || 6) * 3_600_000;
    const want = String(input.name_contains ?? '').toLowerCase();
    let rows: Array<{ name: string; size: number; at: number }> = [];
    try {
      for (const name of readdirSync(DOWNLOADS)) {
        if (name.startsWith('.') || (want && !name.toLowerCase().includes(want))) continue;
        const st = statSync(join(DOWNLOADS, name));
        if (st.mtimeMs >= since) rows.push({ name, size: st.size, at: st.mtimeMs });
      }
    } catch (err) {
      return `Couldn't read Downloads: ${err instanceof Error ? err.message : String(err)}`;
    }
    rows = rows.sort((a, b) => b.at - a.at);
    const partial = rows.filter((r) => /\.(crdownload|part|download)$/i.test(r.name)).length;
    if (!rows.length) return 'No new files in Downloads in that window.';
    const list = rows.slice(0, 60).map((r) => `${r.name} · ${Math.max(1, Math.round(r.size / 1024))} KB · ${new Date(r.at).toLocaleTimeString('en-US', { timeZone: getTimezone() })}`);
    return `${rows.length} new file(s)${partial ? `, ${partial} still downloading` : ''}:\n${list.join('\n')}${rows.length > 60 ? `\n...and ${rows.length - 60} more` : ''}`;
  },
};

// For the web-task sub-agent: types the code the owner texted, without the code
// ever entering the model's prompt. Only on the site that asked for it, only
// once, and only within 10 minutes of them sending it.
export const enterOwnerCodeTool: ToolDef = {
  definition: {
    name: 'enter_owner_code',
    description: 'Type the verification code the owner texted you into the code field. Use only after you were told the owner sent the code. Pass the CSS selector of the code input (from snapshot or the page source). Then click the continue/verify button.',
    input_schema: {
      type: 'object' as const,
      properties: { selector: { type: 'string', description: 'CSS selector of the code input field.' } },
      required: ['selector'],
    },
  },
  handler: async (input) => {
    const run = activeWebTaskRun();
    if (!run || !bookingWindowOpen()) return 'Refused: no website job is running.';
    const browser = browserTools[0];
    let host: string | null = null;
    try {
      const out = String(await browser.handler({ action: 'get_current_url' }, { groupKey: 'booking' }));
      host = new URL((JSON.parse(out) as { url?: string }).url ?? '').hostname;
    } catch { /* checked below */ }
    if (run.codeHost && (!host || (host !== run.codeHost && !host.endsWith(`.${run.codeHost}`) && !run.codeHost.endsWith(`.${host}`)))) {
      return `Refused: the code was for ${run.codeHost}, and this page is ${host ?? 'unknown'}. Go back to ${run.codeHost}.`;
    }
    const code = takeCode(run.jobId);
    if (!code) return 'No code from the owner (or it expired after 10 minutes). Return needs_owner with need "code" so they can send a fresh one.';
    const r = String(await browser.handler({ action: 'fill_input', selector: String(input.selector ?? ''), value: code }, { groupKey: 'booking' }));
    return /fail|not found|error/i.test(r) ? `Couldn't type it there: ${r}. Find the right field with snapshot; the code is used up, so if this fails, return needs_owner code for a fresh one.` : 'Entered the code. Now click the verify/continue button.';
  },
};

// For the web-task sub-agent: opens the sign-in link the site emailed them, in
// the job's own tab, without the link (a login token) entering the prompt.
export const openSignInLinkTool: ToolDef = {
  definition: {
    name: 'open_sign_in_link',
    description: 'Open the sign-in link the site emailed the owner, in your tab. Use only after you were told the sign-in link arrived. Then continue from the page it opens.',
    input_schema: { type: 'object' as const, properties: {} },
  },
  handler: async () => {
    const run = activeWebTaskRun();
    if (!run || !bookingWindowOpen()) return 'Refused: no website job is running.';
    const link = takeLink(run.jobId);
    if (!link) return 'No sign-in link (or it expired after 10 minutes). Return needs_owner with need "link" so a fresh one can be sent.';
    const out = String(await browserTools[0].handler({ action: 'navigate', url: link }, { groupKey: 'booking' }));
    // Keep the token out of the transcript: drop URLs from what comes back.
    return `Opened the sign-in link.\n${out.replace(/https?:\/\/\S+/g, '[link]').slice(0, 3000)}`;
  },
};

// For the web-task sub-agent: desktop control for the few Chrome/macOS windows
// the page tools can't reach (a file dialog, a permission prompt, a save
// dialog). Only while a website job's browser run is open; the owner already
// asked for the job, so there's no extra "go"; every step is logged.
export const desktopTool: ToolDef = {
  definition: {
    name: 'desktop',
    description: 'Control the Mac screen for a Chrome or macOS window the page tools cannot reach (file dialog, permission prompt, save dialog). action: screenshot (look first), click (x,y from that screenshot), type (text), key_press (key, e.g. "return", "esc", "cmd+shift+g"). Use only for that window, then go back to the browser tools.',
    input_schema: {
      type: 'object' as const,
      properties: {
        action: { type: 'string', enum: ['screenshot', 'click', 'type', 'key_press'] },
        x: { type: 'number' }, y: { type: 'number' },
        text: { type: 'string' }, key: { type: 'string' },
      },
      required: ['action'],
    },
  },
  handler: async (input) => {
    const run = activeWebTaskRun();
    if (!run || !bookingWindowOpen()) return 'Refused: no website job is running.';
    if (input.action === 'type' && (looksLikeCardNumber(String(input.text ?? '')) || /password/i.test(String(input.text ?? '')))) {
      return 'Refused: never type card numbers or passwords.';
    }
    const { computerUseTools, approveComputerUseTask } = await import('./computer-use.js');
    approveComputerUseTask('web-task-desktop');
    return computerUseTools[0].handler(input, { groupKey: 'web-task-desktop' });
  },
};
