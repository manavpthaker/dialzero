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
const { currentLlmContext } = await import('../src/lib/llm-context.js');
const coach = await import('../src/speech-coach.js');
const { ownerOnlyReadTools } = await import('../src/tools/index.js');
const { getOwner } = await import('../src/config.js');

const now = Date.parse('2026-10-02T20:00:00Z');
const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
let cards: unknown[] = [];
let replies: string[] = [];
const transcripts: Record<string, unknown> = {};
const prompts: string[] = [];
const callers: string[] = [];
omi.setOmiDeps({
  call: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'get_conversations') return JSON.stringify({ conversations: cards });
    const t = transcripts[String(args.conversation_id)];
    if (t) return JSON.stringify(t);
    return JSON.stringify({ id: args.conversation_id, transcript: [{ is_user: true, text: "I'll send Alex the deck by Friday." }] });
  },
  extract: async (prompt) => { prompts.push(prompt); callers.push(currentLlmContext().caller); return replies.shift() ?? '{}'; },
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

  // A real two-way call: the owner and Jordan, with a few fillers and questions.
  const jordanSegs = (speakerOfHim: number, extraVoices = false) => {
    const segs: Array<Record<string, unknown>> = [];
    let t = 0;
    for (let i = 0; i < 12; i++) {
      segs.push({ text: `So um the the idea is we help coaches you know prepare before session ${['one','two','three','four','five','six','seven','eight','nine','ten','eleven','twelve'][i]}, and it saves them ${i + 2} hours on client ${['Ana','Ben','Cal','Dee','Eve','Fay','Gus','Hal','Ivy','Jo','Kim','Lu'][i]} every single week?`, is_user: true, speaker_id: speakerOfHim, start: t, end: t + 12 });
      t += 13;
      segs.push({ text: 'That makes sense to me, tell me more about how the coaches would use it with clients in our program.', is_user: extraVoices && i % 3 === 0, speaker_id: extraVoices && i % 3 === 0 ? 7 : 1, start: t, end: t + 8 });
      t += 9;
    }
    return { conversation: { transcript_segments: segs } };
  };
  const at = (min: number) => new Date(now - min * 60_000).toISOString();

  await check('waits until Omi is done with a conversation', async () => {
    cards = [{ id: 'live', structured: { title: 'Still going' }, started_at: at(30), finished_at: at(10) }];
    calls.length = 0;
    assert.equal(await omi.omiSyncTick(), 0);
    assert.ok(!calls.some((c) => c.tool === 'get_conversation_by_id'), 'not read before it settles');
  });

  await check('tiny fragments are dropped without a model call', async () => {
    cards = [{ id: 'frag', structured: { title: 'Yeah.' }, started_at: at(120), finished_at: at(119) }];
    transcripts.frag = { conversation: { transcript_segments: [{ text: 'Yeah.', is_user: true, speaker_id: 0, start: 0, end: 1 }] } };
    prompts.length = 0;
    assert.equal(await omi.omiSyncTick(), 0);
    assert.equal(prompts.length, 0);
    calls.length = 0;
    await omi.omiSyncTick();
    assert.ok(!calls.some((c) => c.tool === 'get_conversation_by_id'), 'and not read again');
  });

  await check('the same call recorded twice is read once, from the cleaner copy, with cost attributed', async () => {
    db.default.prepare("INSERT INTO tasks (title, group_id, assignee, status, source) VALUES ('Send Jordan the one-pager', 'admin', 'owner', 'open', 'agent')").run();
    cards = [
      { id: 'phone-copy', structured: { title: 'Product demo' }, started_at: at(100), finished_at: at(60) },
      { id: 'desk-copy', structured: { title: 'Product demo and feedback' }, started_at: at(95), finished_at: at(60) },
    ];
    transcripts['phone-copy'] = jordanSegs(9, true);
    transcripts['desk-copy'] = jordanSegs(0);
    prompts.length = 0; callers.length = 0;
    replies = [JSON.stringify({ talk: { real: true, setting: 'work', with: ['Jordan'] } })];
    assert.equal(await omi.omiSyncTick(), 1);
    assert.equal(prompts.length, 1, 'one extraction for two copies');
    assert.match(prompts[0], /Product demo and feedback/, 'the copy that tags one voice as the owner');
    assert.match(prompts[0], /^You: So um/m, 'compact transcript, not raw JSON');
    assert.match(prompts[0], /Already on the owner.s task list[\s\S]*Send Jordan the one-pager/);
    assert.deepEqual(callers, ['omi-sync']);
    const row = db.default.prepare("SELECT setting, with_names, metrics_json FROM speech_reviews WHERE conversation_id = 'desk-copy'").get() as { setting: string; with_names: string; metrics_json: string };
    assert.equal(row.setting, 'work');
    assert.equal(row.with_names, 'Jordan');
    const m = JSON.parse(row.metrics_json) as { talkShare: number; questions: number; fillers: number; repeats: number };
    assert.ok(m.talkShare > 0.5 && m.questions === 12 && m.fillers === 24 && m.repeats === 12, JSON.stringify(m));
  });

  await check('a copy that shows up a tick later is still skipped', async () => {
    cards = [{ id: 'late-copy', structured: { title: 'Demo (again)' }, started_at: at(100), finished_at: at(59) }];
    transcripts['late-copy'] = jordanSegs(2);
    prompts.length = 0;
    assert.equal(await omi.omiSyncTick(), 0);
    assert.equal(prompts.length, 0);
  });

  await check('a first name lands on the contact the owner already has', () => {
    const jordan = db.upsertPerson({ name: 'Jordan Rivera' });
    db.addInteraction({ person_id: jordan, channel: 'email', summary: 'demo follow-up', occurred_at: new Date(now - 86_400_000).toISOString() });
    db.upsertPerson({ name: 'Jordan Hughes' }); // no recent contact
    assert.equal(omi.personIdFor('Jordan'), jordan);
    assert.equal(omi.personIdFor('jordan rivera'), jordan);
    const casey = omi.personIdFor('Casey');
    assert.equal(omi.personIdFor('Casey'), casey, 'a bare name is reused, not added again');
    const sam = db.upsertPerson({ name: 'Sam Lee' });
    const sam2 = db.upsertPerson({ name: 'Sam Kay' });
    db.addInteraction({ person_id: sam, channel: 'email', summary: 'x', occurred_at: new Date(now - 86_400_000).toISOString() });
    db.addInteraction({ person_id: sam2, channel: 'email', summary: 'y', occurred_at: new Date(now - 86_400_000).toISOString() });
    assert.ok(![sam, sam2].includes(omi.personIdFor('Sam')), 'two recent Sams: not guessed');
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
