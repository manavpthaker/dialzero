// The owner's view of the job tracker (src/jobs.ts): what's going on, stop one,
// answer one that's waiting on them. Registered under `actions` (admin/DM only).

import type { ToolDef, ToolContext } from './index.js';
import { getOwner } from '../config.js';
import { describeOpenItems, stopItem, answerItem } from '../jobs.js';

const isOwner = (c?: ToolContext) => !!c?.userId && c.userId === getOwner().id;

export const jobTools: ToolDef[] = [
  {
    definition: {
      name: 'whats_going_on',
      description: `Everything you're doing or keeping an eye on for the owner, across website jobs, calls, emails and follow-ups, grouped: waiting on them, working on, keeping an eye on, finished lately. USE WHEN they asks "what are you working on", "how's X going", "anything waiting on me", "status". Reply in plain words, one short line per item, no numbers or ids, waiting-on-them first.`,
      input_schema: { type: 'object' as const, properties: {} },
    },
    handler: async () => describeOpenItems(),
  },
  {
    definition: {
      name: 'stop_job',
      description: 'Stop something you are doing for the owner, right now (a website job mid-run, a call errand, a follow-up). USE WHEN they say stop / cancel / never mind / forget it about something in progress. "which" = their words for it (e.g. "plaud"); blank if only one thing is going. Reply with the one line it returns.',
      input_schema: {
        type: 'object' as const,
        properties: { which: { type: 'string', description: 'Their words for the job, e.g. "the plaud thing".' } },
      },
    },
    handler: async (input, context) => {
      if (!isOwner(context)) return 'Only the owner can stop jobs.';
      return stopItem(String(input.which ?? ''));
    },
  },
  {
    definition: {
      name: 'answer_job',
      description: 'Pass the owner\'s answer to a job that is waiting on them (a code a site texted them, "done, I logged in", a choice). USE WHEN their message answers something listed under "Waiting on the owner". "answer" = their message as written; "which" = their words for the job, blank if only one is waiting. The job picks back up right away.',
      input_schema: {
        type: 'object' as const,
        properties: {
          answer: { type: 'string', description: "Their message, as written (e.g. '482913' or 'logged in')." },
          which: { type: 'string', description: 'Which job, in their words. Blank if only one is waiting.' },
        },
        required: ['answer'],
      },
    },
    handler: async (input, context) => {
      if (!isOwner(context)) return 'Only the owner can answer for a job.';
      return answerItem(String(input.which ?? ''), String(input.answer ?? ''));
    },
  },
];
