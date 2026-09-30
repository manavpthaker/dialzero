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
import { bookingDeps } from '../web-booking.js';
import { prepareWebTask, startWebTask, WEB_TASK_NOT_CONNECTED, type WebTaskPayload } from '../web-task.js';

export const webTaskTools: ToolDef[] = [
  {
    definition: {
      name: 'do_online',
      description: `Get something done on a WEBSITE in the owner's Chrome, where they're signed in and their password manager fills logins: cancel a subscription, export or download their data, change an account setting, start a return. USE THIS for any website task, never computer_use (computer_use is only for things outside Chrome). Bookings use book_online; orders use propose_action.
- owner_request: the owner's exact words asking for it, copied from their message (this one or one in the last 30 minutes). With it, it runs now, no "go". Omit it when it's YOUR idea; then it's staged as #action:N for their "go".
- task: the whole job in order, in plain words, e.g. "export all recordings as audio, then cancel the subscription". Put must-do-first steps first; it stops before cancelling if an earlier step fails.
- site: the URL or the service name.
It never pays, never takes an offer to stay, and stops if a login or code is needed. The result comes back by text. If a site only lets you cancel by phone, offer call_now.
After calling this, tell the owner the returned line in one short sentence (for a proposal, DM the exact text returned).`,
      input_schema: {
        type: 'object' as const,
        properties: {
          owner_request: { type: 'string', description: "The owner's exact words asking for this. Omit if it's your idea." },
          task: { type: 'string', description: 'What to get done, in order, e.g. "export all recordings as audio, then cancel the PLAUD subscription".' },
          site: { type: 'string', description: 'URL or service name, e.g. "https://web.plaud.ai" or "PLAUD".' },
          share: { type: 'string', description: 'Details it may enter, with values (e.g. a reason for cancelling). Never card, bank, ID, or passwords. Optional.' },
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
