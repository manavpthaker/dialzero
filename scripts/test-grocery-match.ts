// Grocery list matcher: whole-word keywords only.
//   npm run test:grocery-match
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

// tasks-sync imports db.js, which opens a DB on load — keep it off the live one.
const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-grocery-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
const { isGroceryRelated } = await import('../src/sync/tasks-sync.js');

const cases: Array<[string, boolean]> = [
  ['Ask Alex where the team tracks work', false],
  ['Check the price on the flight', false],
  ['Fix the steam deck', false],
  ['Add breadcrumb nav to the site', false],
  ['Send the Friday recap to Jordan', false],
  ['Toil through the inbox', false],
  ['Pay Apple Academy tuition', false],
  ['buy milk', true],
  ['eggs and bread', true],
  ['Pick up apples and tomatoes', true],
  ['Grocery run', true],
];

for (const [text, want] of cases) {
  assert.equal(isGroceryRelated(text), want, `"${text}" should ${want ? '' : 'not '}match`);
  console.log(`PASS  ${want ? 'match   ' : 'no match'}  ${text}`);
}
rmSync(tempRoot, { recursive: true, force: true });
console.log(`\n${cases.length} passed`);
