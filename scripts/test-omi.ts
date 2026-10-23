// Omi sync tests: isolated DB; Omi and the extractor are stubbed. No network.
//   npm run test:omi
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-omi-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.OMI_SYNC_LOG = join(tempRoot, 'omi-sync.log');
// A household as a profile describes it: full names, and the names Omi mishears.
writeFileSync(join(tempRoot, 'profile.json'), JSON.stringify({
  owner: { id: 'owner', name: 'Robin', fullName: 'Robin Park', tone: 'direct', role: 'admin', allowedGroups: ['admin'] },
  members: [{ id: 'dana', name: 'Dana', tone: 'warm', role: 'member', allowedGroups: ['family'] }],
  people: [{ name: 'Dana', fullName: 'Dana Ellis', relationship: 'partner' }, { name: 'Kit', relationship: 'son', aliases: ['Kip', 'Kitt'] }],
  timezone: 'America/New_York',
}));
process.env.ASSISTANT_PROFILE_PATH = join(tempRoot, 'profile.json');

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
let actionItems: unknown[] = [];
const prompts: string[] = [];
const callers: string[] = [];
const stub: Parameters<typeof omi.setOmiDeps>[0] & object = {
  call: async (tool, args) => {
    calls.push({ tool, args });
    if (tool === 'get_conversations') return JSON.stringify({ conversations: cards });
    if (tool === 'get_action_items') return JSON.stringify({ action_items: actionItems });
    const t = transcripts[String(args.conversation_id)];
    if (t) return JSON.stringify(t);
    return JSON.stringify({ id: args.conversation_id, transcript: [{ is_user: true, text: "I'll send Alex the deck by Friday." }] });
  },
  extract: async (prompt) => { prompts.push(prompt); callers.push(currentLlmContext().caller); return replies.shift() ?? '{}'; },
  now: () => now,
  pushTask: async () => {},
};
omi.setOmiDeps(stub);

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

  await check('a short spoken to-do is still read', async () => {
    cards = [{ id: 'todo', structured: { title: 'Dentist' }, started_at: at(80), finished_at: at(79) }];
    transcripts.todo = { conversation: { transcript_segments: [{ text: 'Remind me to call the dentist tomorrow.', is_user: true, speaker_id: 0, start: 0, end: 3 }] } };
    prompts.length = 0;
    replies = [JSON.stringify({ todos: [{ title: 'Call the dentist', due: '2026-10-03' }] })];
    assert.equal(await omi.omiSyncTick(), 1);
    assert.equal(prompts.length, 1);
    assert.ok(db.default.prepare("SELECT 1 FROM tasks WHERE title = 'Call the dentist'").get());
  });

  await check('a short note to self is read and treated as a voice note', async () => {
    cards = [{ id: 'eye', structured: { title: 'Eye Doctor Reminder' }, started_at: at(70), finished_at: at(69) }];
    transcripts.eye = { conversation: { transcript_segments: [{ text: 'Yeah. Oh my goodness. You still need to go to the eye doctor, but not this week.', is_user: false, speaker_id: 1, start: 0, end: 4 }] } };
    prompts.length = 0;
    replies = [JSON.stringify({ todos: [{ title: 'Book the eye doctor', due: null }] })];
    assert.equal(await omi.omiSyncTick(), 1, 'not skipped for being short');
    assert.match(prompts[0], /SHORT recording, likely a note to self/);
    assert.ok(db.default.prepare("SELECT 1 FROM tasks WHERE title = 'Book the eye doctor'").get());
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

  await check('no transcript yet: retried, not marked read, then read once Omi has it', async () => {
    cards = [{ id: 'blank', structured: { title: 'First-day onboarding' }, started_at: at(200), finished_at: at(150) }];
    transcripts.blank = { conversation: { id: 'blank', transcript_segments: [] } };
    prompts.length = 0;
    assert.equal(await omi.omiSyncTick(), 0);
    assert.equal(prompts.length, 0, 'an empty transcript is never sent to the model');
    // Omi finishes processing it: the next pass reads it.
    transcripts.blank = { conversation: { transcript_segments: [{ text: 'Robin, welcome aboard. Before Friday please fill out the conflict of interest questionnaire in the portal, and upload your I-9 documents too, then accept the HR portal invite when it arrives.', is_user: false, speaker_id: 4, start: 0, end: 9 }] } };
    replies = [JSON.stringify({ todos: [{ title: 'Fill out the conflict-of-interest questionnaire', due: null }] })];
    assert.equal(await omi.omiSyncTick(), 1);
    assert.match(prompts[0], /The owner is Robin Park\./, 'the full name, from the profile');
    assert.match(prompts[0], /Omi often marks no one as the owner/);
    assert.ok(db.default.prepare("SELECT 1 FROM tasks WHERE title LIKE 'Fill out the conflict%'").get(), 'what the owner was asked to do is their to-do');
  });

  await check('gives up on a conversation that never gets a transcript', async () => {
    cards = [{ id: 'never', structured: { title: 'Ghost' }, started_at: at(200), finished_at: at(150) }];
    transcripts.never = { conversation: { transcript_segments: [] } };
    await omi.omiSyncTick();
    omi.setOmiDeps({ ...stub, now: () => now + 49 * 3_600_000 });
    await omi.omiSyncTick();
    omi.setOmiDeps({ ...stub, now: () => now + 50 * 3_600_000 });
    calls.length = 0;
    await omi.omiSyncTick();
    assert.ok(!calls.some((c) => c.tool === 'get_conversation_by_id' && c.args.conversation_id === 'never'), 'not asked for again');
    omi.setOmiDeps(stub);
  });

  await check("Omi's summary and its own to-dos go into the prompt as hints", async () => {
    cards = [{ id: 'onboard', structured: { title: 'Onboarding' }, started_at: at(300), finished_at: at(240) }];
    transcripts.onboard = { conversation: { structured: { overview: 'Robin was walked through onboarding: recap every Friday, service desk ticket.' }, transcript_segments: jordanSegs(0).conversation.transcript_segments.map((x) => ({ ...x, text: `${x.text} onboarding` })) } };
    actionItems = [{ conversation_id: 'onboard', description: 'Send Pat and Lee a recap every Friday' }, { conversation_id: 'other', description: 'Not this one' }];
    prompts.length = 0;
    replies = ['{}'];
    assert.equal(await omi.omiSyncTick(), 1);
    assert.match(prompts[0], /Omi's summary of the whole conversation: Robin was walked through onboarding/);
    assert.match(prompts[0], /To-dos Omi itself noted[\s\S]*Send Pat and Lee a recap every Friday/);
    assert.doesNotMatch(prompts[0], /Not this one/);
    actionItems = [];
  });

  await check('a long meeting is read to the end, in parts, and merged without repeats', async () => {
    const segs = Array.from({ length: 300 }, (_, i) => ({ text: `Segment ${i} of the planning meeting where we walk through phase one milestones, owners and the open risks in detail for item ${i}.`, is_user: i % 2 === 0, speaker_id: i % 2, start: i * 10, end: i * 10 + 9 }));
    segs.push({ text: "I'll put together the phase two plan and send it Thursday.", is_user: true, speaker_id: 0, start: 3100, end: 3110 });
    cards = [{ id: 'long', structured: { title: 'Q4 planning' }, started_at: at(400), finished_at: at(330) }];
    transcripts.long = { conversation: { transcript_segments: segs } };
    prompts.length = 0;
    replies = [JSON.stringify({ todos: [{ title: 'Share the risk list', due: null }] }), JSON.stringify({ todos: [{ title: 'Share the risk list', due: null }, { title: 'Put together the phase two plan', due: '2026-10-08' }] })];
    assert.equal(await omi.omiSyncTick(), 1);
    assert.equal(prompts.length, 2, 'two parts, two reads');
    assert.match(prompts[0], /part 1 of 2/);
    assert.match(prompts[1], /phase two plan and send it Thursday/, 'the end of the meeting is read');
    assert.equal((db.default.prepare("SELECT count(*) AS n FROM tasks WHERE title = 'Share the risk list'").get() as { n: number }).n, 1);
    assert.ok(db.default.prepare("SELECT 1 FROM tasks WHERE title = 'Put together the phase two plan'").get());
  });

  await check('repeated lines are sent once', async () => {
    cards = [{ id: 'echo', structured: { title: 'Phone call' }, started_at: at(500), finished_at: at(480) }];
    const line = 'We should book the venue for the cohort launch and confirm the caterer by next week.';
    transcripts.echo = { conversation: { transcript_segments: [0, 1, 2, 3].map((i) => ({ text: line, is_user: true, speaker_id: 0, start: i, end: i + 1 })).concat([{ text: 'Sounds good, I will call them after lunch today then.', is_user: false, speaker_id: 1, start: 9, end: 10 }]) } };
    prompts.length = 0;
    replies = ['{}'];
    await omi.omiSyncTick();
    assert.equal((prompts[0].match(/book the venue/g) ?? []).length, 1);
  });

  await check('the same words at a different time are not a duplicate; a fuller copy is read', () => {
    const fp = Array.from({ length: 20 }, (_, i) => `h${i}`);
    const story = { id: 'tonight', at: now, fp, start: now - 3_600_000, end: now - 3_000_000, words: 800 };
    const lastNight = { id: 'last-night', at: now, fp, start: now - 27 * 3_600_000, end: now - 26.5 * 3_600_000, words: 800 };
    assert.equal(omi.sameRecording(story, lastNight), false, 'same bedtime story, different night');
    const meeting = { id: 'full', at: now, fp, start: now - 3_600_000, end: now - 300_000, words: 6000 };
    const fragment = { id: 'frag', at: now, fp: fp.slice(0, 10), start: now - 3_600_000, end: now - 3_300_000, words: 400 };
    assert.equal(omi.sameRecording(meeting, fragment), false, 'the whole meeting is read even though a fragment was');
    assert.equal(omi.sameRecording({ ...story, id: 'desk' }, { ...story, id: 'phone' }), true, 'phone + desktop copies are still one');
  });

  await check('a conversation that grew after it was read gets its new part read', async () => {
    const segsA = Array.from({ length: 30 }, (_, i) => ({ text: `Early talk line ${i} about the roadmap and budget numbers for next quarter planning session.`, is_user: true, speaker_id: 0, start: i * 10, end: i * 10 + 9 }));
    cards = [{ id: 'grows', structured: { title: 'Evening' }, started_at: at(600), finished_at: at(540) }];
    transcripts.grows = { conversation: { transcript_segments: segsA } };
    prompts.length = 0;
    replies = ['{}'];
    assert.equal(await omi.omiSyncTick(), 1);
    const segsB = segsA.concat(Array.from({ length: 10 }, (_, i) => ({ text: `Later line ${i}: remind me to renew the car registration before the end of the month.`, is_user: true, speaker_id: 0, start: 2000 + i * 10, end: 2000 + i * 10 + 9 })));
    cards = [{ id: 'grows', structured: { title: 'Evening' }, started_at: at(600), finished_at: at(480) }];
    transcripts.grows = { conversation: { transcript_segments: segsB } };
    prompts.length = 0;
    replies = [JSON.stringify({ todos: [{ title: 'Renew the car registration', due: null }] })];
    assert.equal(await omi.omiSyncTick(), 1);
    assert.match(prompts[0], /only what was recorded after that/);
    assert.doesNotMatch(prompts[0], /Early talk line 5 /, 'the part already read is not sent again');
    assert.ok(db.default.prepare("SELECT 1 FROM tasks WHERE title = 'Renew the car registration'").get());
  });

  await check('a work meeting is never saved as media', () => {
    const r = omi.writeBack({ watched: [{ source: 'Company all-staff', topic: 'all staff meeting', takeaways: ['new policy'] }], talk: { real: true, setting: 'work', with: ['Pat'] } }, { id: 'allstaff', title: 'All staff', when: '', discarded: false });
    assert.equal(r.facts, 0);
  });

  await check('the owner is never filed as their own contact', () => {
    const r = omi.writeBack({ people: [{ name: 'Robin', note: 'x' }, { name: 'Pat Quinn', note: 'manager' }] }, { id: 'mtg', title: 'Meeting', when: '', discarded: false });
    assert.equal(r.people, 1);
  });

  await check("today is the owner's day in their timezone, not UTC", () => {
    assert.equal(omi.localYmd(Date.parse('2026-10-22T02:30:00Z')), '2026-10-21');
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

  await check('two recent Jordans: the one the owner talks to most, never a different Jordan with their own number', () => {
    const at = (d: number) => new Date(now - d * 86_400_000).toISOString();
    const lee = db.upsertPerson({ name: 'Jordan Lee' });
    for (const d of [1, 2, 3, 5]) db.addInteraction({ person_id: lee, channel: 'email', summary: 'work', occurred_at: at(d) });
    const park = db.upsertPerson({ name: 'Jordan Park' });
    db.addInteraction({ person_id: park, channel: 'in-person', summary: 'met once', occurred_at: at(2) });
    const other = db.upsertPerson({ name: 'Jordan', phones: ['+12025550142'] });
    assert.equal(omi.personIdFor('Jordan'), lee);
    db.addInteraction({ person_id: park, channel: 'in-person', summary: 'again', occurred_at: at(1) });
    const guess = omi.personIdFor('Jordan');
    assert.ok(![lee, park, other].includes(guess), 'close call: a new placeholder, not the Jordan with their own number');
  });

  await check('merging duplicates moves conversations, facts, emails and phones to one record', () => {
    const keep = db.upsertPerson({ name: 'Casey Morgan', emails: ['casey@example.org'] });
    const dup1 = db.upsertPerson({ name: 'Casey Dup' });
    const dup2 = db.upsertPerson({ name: 'Casey Dup Two', phones: ['+12025550100'] });
    db.addInteraction({ person_id: dup1, channel: 'in-person', summary: 'one-on-one', ref: 'omi:x', occurred_at: new Date(now).toISOString() });
    db.addInteraction({ person_id: dup2, channel: 'imessage', summary: 'text', occurred_at: new Date(now).toISOString() });
    const r = db.mergePeople(keep, [dup1, dup2]);
    assert.deepEqual([r.merged, r.interactions], [2, 2]);
    assert.equal(db.findPersonByPhone('+12025550100')?.id, keep);
    assert.equal(db.getPersonById(dup1), undefined);
    const other = db.upsertPerson({ name: 'Casey Elsewhere', phones: ['+12025550177'] });
    db.addInteraction({ person_id: other, channel: 'in-person', summary: 'work check-in', ref: 'omi:work', occurred_at: new Date(now).toISOString() });
    db.addInteraction({ person_id: other, channel: 'imessage', summary: 'their own text', ref: 'imessage:1', occurred_at: new Date(now).toISOString() });
    assert.equal(db.movePersonRecords(other, keep, ['omi:work']), 1);
  });

  await check('household members land on one record each, whatever Omi hears', () => {
    const dana = db.upsertPerson({ name: 'Dana Ellis' });
    db.upsertPerson({ name: 'Dana Keller' }); // someone else with the same first name
    assert.equal(omi.personIdFor('Dana'), dana);
    const kit = omi.personIdFor('Kit');
    assert.equal(omi.personIdFor('Kip'), kit);
    assert.equal(omi.personIdFor('Kitt'), kit);
    assert.match(omi.householdContext(), /Kit \(also heard as Kip, Kitt\), son/);
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
