import { parseStrEnv } from './env.js';
import { notionUrl } from './notion-client.js';

// Standalone so both the sync engine (notion-pipelines.ts) and the senders
// (ops-digest.ts, growth.ts) can append tap-to-open Notion links without an
// import cycle. Bare URLs only — the channel `toPlainText` strips markdown links.

const APPROVE_DB = parseStrEnv('NOTION_APPROVE_DB', '');
const PIPELINES_DB = parseStrEnv('NOTION_PIPELINES_DB', '');

export function notionLinksFooter(which: Array<'approve' | 'pipelines'> = ['approve', 'pipelines']): string {
  const lines: string[] = [];
  if (which.includes('approve')) {
    const u = notionUrl(APPROVE_DB);
    if (u) lines.push(`🔵 Approve drafts: ${u}`);
  }
  if (which.includes('pipelines')) {
    const u = notionUrl(PIPELINES_DB);
    if (u) lines.push(`📊 Pipelines: ${u}`);
  }
  return lines.join('\n');
}
