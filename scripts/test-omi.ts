// Omi sync tests: isolated DB; Omi and the extractor are stubbed. No network.
//   npm run test:omi
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-omi-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.OMI_SYNC_LOG = join(tempRoot, 'omi-sync.log');

const db = await import('../src/db.js');
const omi = await import('../src/omi-sync.js');
const { ownerOnlyReadTools } = await import('../src/tools/index.js');
const { getOwner } = await import('../src/config.js');

const now = Date.parse('2026-10-02T20:00:00Z');
const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let cards: unknown[] = [];
let replies: string[] = [];
omi.setOmiDeps({
  call: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'get_conversations') return JSON.stringify({ conversations: cards });
    return JSON.stringify({ id: args.conversation_id, transcript: [{ is_user: true, text: "I'll send Alex the deck by Friday." }] });
  },
  extract: async () => replies.shift() ?? '{}',
  now: () => now,
  pushTask: async () => {},
});

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS  ${name}`); }

try {
  await check('reads cards whatever the field names', () => {
    const got = omi.parseCards(JSON.stringify({ conversations: [
      { id: 'a', structured: { title: 'Call with Alex' }, started_at: '2026-10-02T15:00:00Z' },
      { conversation_id: 'b', title: 'TV', discarded: true },
      { title: 'no id' },
    ] }));
    assert.deepEqual(got.map((c) => [c.id, c.title, c.discarded]), [['a', 'Call with Alex', false], ['b', 'TV', true]]);
    assert.deepEqual(omi.parseCards('not json'), []);
  });

  await check('a new conversation becomes a private promise, a task, a person, a decision', async () => {
    cards = [{ id: 'c1', title: 'Call with Alex', started_at: '2026-10-02T15:00:00Z' }, { id: 'c2', title: 'Show', discarded: true }];
    replies = [JSON.stringify({
      commitments: [{ counterpart: 'Alex', text: 'send the deck' }],
      todos: [{ title: 'Send Alex the deck', due: '2026-10-03' }],
      people: [{ name: 'Alex Rivera', note: 'talked about the deck' }],
      decisions: [{ subject: 'pilot', text: 'go with the smaller pilot' }],
    })];
    assert.equal(await omi.omiSyncTick(), 1);
    const facts = db.default.prepare("SELECT fact_type, sensitive, source_ref FROM facts WHERE source = 'omi' ORDER BY id").all() as Array<{ fact_type: string; sensitive: number; source_ref: string }>;
    assert.deepEqual(facts.map((f) => f.fact_type), ['commitment', 'decision']);
    assert.ok(facts.every((f) => f.sensitive === 1 && f.source_ref === 'omi:c1'), 'private and traceable');
    const task = db.default.prepare("SELECT title, due_date FROM tasks WHERE source = 'omi'").get() as { title: string; due_date: string };
    assert.equal(task.title, 'Send Alex the deck');
    assert.match(task.due_date, /^2026-10-03/);
    const inter = db.default.prepare("SELECT channel, summary FROM interactions WHERE ref = 'omi:c1'").get() as { channel: string; summary: string };
    assert.deepEqual(inter, { channel: 'in-person', summary: 'talked about the deck' });
    assert.ok(!calls.some((c) => c.tool === 'get_conversation_by_id' && c.args.conversation_id === 'c2'), 'discarded ones are never read');
  });

  await check('the next pass skips what it already read', async () => {
    calls.length = 0;
    assert.equal(await omi.omiSyncTick(), 0);
    assert.ok(!calls.some((c) => c.tool === 'get_conversation_by_id'));
  });

  await check('an unreadable extraction is retried next pass, not lost', async () => {
    cards = [{ id: 'c3', title: 'Lunch' }];
    replies = ['sorry, no json'];
    assert.equal(await omi.omiSyncTick(), 0);
    replies = ['{}'];
    assert.equal(await omi.omiSyncTick(), 1, 'small talk is read and kept nothing');
  });

  await check('lookup tools: read-only, and only for the owner', async () => {
    const mk = (name: string) => ({ definition: { name, description: '', input_schema: { type: 'object' as const } }, handler: async () => 'data' });
    const tools = ownerOnlyReadTools([mk('mcp_omi_get_conversations'), mk('mcp_omi_search_memories'), mk('mcp_omi_delete_memory'), mk('mcp_omi_create_action_item')]);
    assert.deepEqual(tools.map((t) => t.definition.name), ['mcp_omi_get_conversations', 'mcp_omi_search_memories']);
    assert.equal(await tools[0].handler({}, { groupKey: 'admin', userId: getOwner().id }), 'data');
    assert.equal(await tools[0].handler({}, { groupKey: 'admin', userId: 'someone-else' }), 'This is private to the owner.');
    assert.equal(await tools[0].handler({}, { groupKey: 'home' }), 'This is private to the owner.');
  });

  console.log(`\nOmi tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
