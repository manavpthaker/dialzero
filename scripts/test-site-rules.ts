// Per-site permission rules: isolated DB, nothing opens a browser.
//   npm run test:site-rules
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-site-rules-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.ACTIONS_ENABLED = 'true';

const rules = await import('../src/lib/site-rules.js');
const wt = await import('../src/web-task.js');
const { toolRegistry } = await import('../src/tools/index.js');
const { getOwner } = await import('../src/config.js');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const tool = (n: string) => toolRegistry['web-booking'].find((t) => t.definition.name === n)!;
const owner = { groupKey: 'admin', userId: getOwner().id };

try {
  await check('site keys: urls, subdomains and plain names agree', () => {
    assert.equal(rules.siteKey('https://www.examplebank.com/web/auth'), 'examplebank');
    assert.equal(rules.siteKey('secure.examplebank.com'), 'examplebank');
    assert.equal(rules.siteKey('ExampleBank'), 'examplebank');
    assert.equal(rules.siteKey('shop.example.co.uk'), 'example');
  });

  await check('only the owner sets rules; list/remove work; buy is not a level here', async () => {
    const t = tool('site_permissions');
    assert.match(String(await t.handler({ op: 'set', site: 'examplebank.com', level: 'read' }, { groupKey: 'admin', userId: 'someone-else' })), /Only the owner/);
    assert.match(String(await t.handler({ op: 'set', site: 'examplebank.com', level: 'buy' }, owner)), /read or ask/);
    assert.match(String(await t.handler({ op: 'set', site: 'examplebank.com', level: 'read' }, owner)), /examplebank: look only/);
    assert.match(String(await t.handler({ op: 'set', site: 'Example Brokerage', level: 'read' }, owner)), /look only/);
    const list = String(await t.handler({ op: 'list' }, owner));
    assert.match(list, /examplebank/); assert.match(list, /examplebrokerage/);
    assert.match(String(await t.handler({ op: 'remove', site: 'Example Brokerage' }, owner)), /back to the default/);
  });

  await check('look-only site: a job that would change something is refused; reading is fine', () => {
    assert.match(rules.siteRuleRefusal('https://www.examplebank.com', 'transfer $200 to savings') ?? '', /look only/);
    assert.match(rules.siteRuleRefusal('ExampleBank', 'cancel the overdraft protection') ?? '', /look only/);
    assert.equal(rules.siteRuleRefusal('ExampleBank', 'check my balance and last 5 transactions'), null);
    assert.equal(rules.siteRuleRefusal('Streamly', 'cancel my plan'), null, 'no rule = default');
  });

  await check('do_online refuses a change on a look-only site before anything opens', async () => {
    const out = String(await tool('do_online').handler({ task: 'transfer $200 to savings', site: 'https://examplebank.com', owner_request: 'move $200 to savings' }, owner));
    assert.match(out, /Not started: .*look only/);
  });

  await check('job prompt carries the look-only line only on read sites', () => {
    assert.match(wt.webTaskPrompt({ task: 'check my balance', site: 'https://examplebank.com', owner_request: 'check my bank' }), /LOOK ONLY/);
    assert.doesNotMatch(wt.webTaskPrompt({ task: 'cancel my plan', site: 'https://streamly.example.com' }), /SITE RULE/);
  });

  console.log(`\nSite rule tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
