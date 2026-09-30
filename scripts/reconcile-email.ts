import 'dotenv/config';
import {
  formatEmailReconciliationResults,
  reconcileEmailItems,
  reconcileTrackedEmailLoops,
} from '../src/email-reconciliation.js';
import { isValidEmailMessageId } from '../src/email/source.js';

const args = process.argv.slice(2);
const dry = args.includes('--dry');
const messageIds: string[] = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] !== '--message') continue;
  const value = args[i + 1]?.trim();
  if (!value || !isValidEmailMessageId(value)) {
    console.error('Usage: npm run reconcile:email -- [--dry] [--message <email message ID>]...');
    process.exit(1);
  }
  messageIds.push(value);
  i++;
}

const results = messageIds.length
  ? await reconcileEmailItems({
    items: Array.from(new Set(messageIds)).map((messageId) => ({ messageId })),
    source: dry ? 'operator-dry-run' : 'operator',
    persist: !dry,
  })
  : await reconcileTrackedEmailLoops({
    source: dry ? 'operator-tracked-dry-run' : 'operator-tracked',
    persist: !dry,
  });

console.log(formatEmailReconciliationResults(results));
