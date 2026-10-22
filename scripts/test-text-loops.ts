// Text loops tests: isolated DB, the model stubbed. No network, nothing sent.
//   npm run test:text-loops
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-texts-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.ASSISTANT_PROFILE_PATH = join(tempRoot, 'no-profile.json');
process.env.TEXT_LOOPS_LOG = join(tempRoot, 'text-loops.log');
process.env.USER_OWNER = '+12025550100';
process.env.GROUP_HOME = 'chat000000000000000001';

const { default: db, upsertPerson, getJob } = await import('../src/db.js');
const { initUsers } = await import('../src/user-resolver.js');
const loops = await import('../src/text-loops.js');
const jobs = await import('../src/jobs.js');
initUsers();

let now = Date.parse('2026-10-21T15:00:00Z');
const replies: string[] = [];
const prompts: string[] = [];
loops.setTextLoopDeps({
  extract: async (p) => { prompts.push(p); return replies.shift() ?? '{"loops":[]}'; },
  now: () => now,
});

let src = 1;
const iso = (minAgo: number) => new Date(now - minAgo * 60_000).toISOString();
function text(chat: string, dir: 'in' | 'out', body: string, minAgo: number, opts: { chatName?: string | null; scope?: string | null } = {}) {
  db.prepare(`INSERT INTO imessage_log (rowid_src, chat_id, chat_name, sender, direction, text, ts, privacy_scope) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(src++, chat, opts.chatName ?? null, dir === 'out' ? 'me' : chat, dir, body, iso(minAgo), opts.scope ?? null);
}
const reply = (o: unknown) => replies.push(JSON.stringify(o));
const titles = () => jobs.openItems().filter((i) => i.key.startsWith('job:')).map((i) => i.title);
const jobId = (key: string) => Number(key.split(':')[1]);

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS  ${name}`); }

try {
  upsertPerson({ name: 'Alex Rivera', phones: ['+12025550101'] });

  await check('noise is ignored: reactions, codes, short codes', () => {
    assert.ok(loops.isNoise({ chat_id: '+12025550101', text: 'Loved “see you at 7”' }));
    assert.ok(loops.isNoise({ chat_id: '+12025550101', text: 'Your verification code is 482913' }));
    assert.ok(loops.isNoise({ chat_id: '32665(smsft)', text: 'Your order shipped' }));
    assert.ok(!loops.isNoise({ chat_id: '+12025550101', text: 'Are you in for dinner Saturday at 7?' }));
  });

  await check("the assistant's own chats are never the owner's threads", () => {
    assert.ok(loops.isAssistantChat('+12025550100'), 'the owner texting the assistant');
    assert.ok(loops.isAssistantChat('chat000000000000000001'), 'a configured group');
    assert.ok(!loops.isAssistantChat('+12025550101'));
  });

  await check('a question the owner owes an answer to becomes a "Reply to" item waiting on them, with the contact name', async () => {
    text('+12025550101', 'in', 'Are you in for dinner Saturday at 7?', 120);
    reply({ loops: [{ kind: 'owe_reply', who: 'Alex', summary: "Alex asked if you're in for Saturday dinner at 7", due: '2026-10-24', evidence: 'in for dinner Saturday', confidence: 0.9 }] });
    const r = await loops.textLoopsPass();
    assert.equal(r.added, 1);
    assert.match(prompts[0], /thread with Alex Rivera/);
    assert.match(prompts[0], /Alex Rivera: Are you in for dinner/);
    const item = jobs.openItems().find((i) => i.title.startsWith('Reply to Alex'));
    assert.ok(item, JSON.stringify(titles()));
    assert.equal(item!.status, 'waiting_on_you');
  });

  await check('the same loop is not opened twice', async () => {
    text('+12025550101', 'in', 'Also bring the salad if you come', 100);
    reply({ loops: [{ kind: 'owe_reply', who: 'Alex', summary: "Alex asked if you're in for Saturday dinner at 7", confidence: 0.9 }] });
    const r = await loops.textLoopsPass();
    assert.equal(r.added, 0);
    assert.equal(titles().filter((t) => t.startsWith('Reply to Alex')).length, 1);
  });

  await check("the owner's reply in the thread closes what they owed there", async () => {
    text('+12025550101', 'out', "Yes we're in! I'll bring the salad", 30);
    reply({ loops: [{ kind: 'i_promised', who: 'Alex', summary: "you said you'd bring the salad Saturday", confidence: 0.85 }] });
    const r = await loops.textLoopsPass();
    assert.equal(r.closed, 1);
    assert.ok(!titles().some((t) => t.startsWith('Reply to Alex')), 'replied: closed');
    assert.ok(titles().some((t) => t.startsWith('You told Alex')), 'the promise is the new open item');
  });

  await check('the model can close an item the thread settled', async () => {
    const promised = jobs.openItems().find((i) => i.title.startsWith('You told Alex'))!;
    text('+12025550101', 'in', 'Got the salad, thanks!', 10);
    reply({ loops: [], resolved: [jobId(promised.key)] });
    await loops.textLoopsPass();
    assert.equal(getJob(jobId(promised.key))!.status, 'done');
  });

  await check('unsure finds add nothing; short codes, family, group and owner chats are never read', async () => {
    text('+12025550102', 'in', 'lol', 5);
    text('32665', 'in', 'Your table is ready', 5);
    text('chat000000000000000002', 'in', 'Who is bringing dessert Sunday?', 5, { chatName: 'Family', scope: 'family' });
    text('chat000000000000000001', 'in', 'Can you pick up the dry cleaning?', 5);
    text('+12025550100', 'in', 'Remind me to call the plumber', 5);
    reply({ loops: [{ kind: 'owe_reply', who: 'Sam', summary: 'maybe something', confidence: 0.3 }] });
    prompts.length = 0;
    const r = await loops.textLoopsPass();
    assert.equal(r.added, 0);
    assert.equal(r.chats, 1, 'only the one real thread was read');
    assert.ok(!prompts.some((p) => /table is ready|dessert|dry cleaning|plumber/.test(p)));
  });

  await check('a dry run reports and writes nothing', async () => {
    text('+12025550103', 'in', 'Can you send me the photos from the party?', 20);
    reply({ loops: [{ kind: 'owe_reply', who: 'Sam', summary: 'Sam asked for the party photos', confidence: 0.9 }] });
    const before = titles().length;
    const r = await loops.textLoopsPass({ dryRun: true });
    assert.equal(r.proposed.length, 1);
    assert.equal(titles().length, before);
  });

  await check('answer_job and stop_job close a text item', async () => {
    reply({ loops: [{ kind: 'owe_reply', who: 'Sam', summary: 'Sam asked for the party photos', confidence: 0.9 }] });
    await loops.textLoopsPass();
    const sam = jobs.openItems().find((i) => i.title.startsWith('Reply to Sam'))!;
    assert.ok(jobs.resumeJobById(jobId(sam.key), 'sent them'));
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(getJob(jobId(sam.key))!.status, 'done');
    text('+12025550104', 'in', 'Are you coming to the game Sunday?', 15);
    reply({ loops: [{ kind: 'owe_reply', who: 'Jordan', summary: 'Jordan asked about the game Sunday', confidence: 0.9 }] });
    await loops.textLoopsPass();
    assert.match(await jobs.stopItem('Jordan'), /Dismissed/);
    assert.ok(!titles().some((t) => t.startsWith('Reply to Jordan')));
  });

  await check('items untouched for a week go quiet', async () => {
    text('+12025550105', 'in', 'Did you get a chance to look at the lease?', 10);
    reply({ loops: [{ kind: 'owe_reply', who: 'Casey', summary: 'Casey asked about the lease', confidence: 0.9 }] });
    await loops.textLoopsPass();
    now += 8 * 86_400_000;
    text('+12025550106', 'in', 'hey', 1);
    await loops.textLoopsPass();
    assert.ok(!titles().some((t) => t.startsWith('Reply to Casey')));
  });

  console.log(`\nText loop tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
process.exit(0);
