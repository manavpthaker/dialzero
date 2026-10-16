// Speaking coach tests: isolated DB; Omi and the model are stubbed. No network.
//   npm run test:speech-coach
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-speech-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.OPENAI_API_KEY = '';

const coach = await import('../src/speech-coach.js');
const { getOwner } = await import('../src/config.js');

const now = Date.parse('2026-10-18T10:50:00Z');
const staged: Array<{ subject: string; text: string; title?: string }> = [];
const asked: string[] = [];
const COACHING = JSON.stringify({
  headline: 'Warm open, but you pitched for six minutes before asking what they needed.',
  went_well: ['You named Casey early, which built trust.'],
  moments: [{ quote: '"I I put forty five minutes for the call"', better: 'Before I dive in, what would make this half hour worth it for you?', why: 'ask first' }],
  habit: 'Ask one question before every pitch.',
});
const transcripts: Record<string, unknown> = {};
coach.setCoachDeps({
  call: async (tool, args) => {
    if (tool === 'search_conversations' || tool === 'get_conversations') {
      return JSON.stringify({ conversations: [{ id: 'jordan', structured: { title: 'Product demo' }, started_at: '2026-10-15T15:55:00Z', finished_at: '2026-10-15T16:31:00Z' }] });
    }
    return JSON.stringify(transcripts[String(args.conversation_id)] ?? {});
  },
  complete: async (_system, prompt) => { asked.push(prompt); return COACHING; },
  stage: ((_source: string, subject: string, text: string) => { staged.push({ subject, text, title: text.split('\n')[0] }); }) as never,
  now: () => now,
});

// The owner talks in long stretches with fillers; they ask short questions.
function call(minutes: number, ownerLine: string) {
  const segs: Array<Record<string, unknown>> = [];
  let t = 0;
  let i = 0;
  while (t < minutes * 60) {
    segs.push({ text: `${ownerLine} part ${i}.`, is_user: true, speaker_id: 0, start: t, end: t + 50 });
    t += 52;
    segs.push({ text: `What does that mean for our coaches, number ${i}?`, is_user: false, speaker_id: 1, start: t, end: t + 6 });
    t += 8;
    i++;
  }
  return segs;
}
const seg = (s: Record<string, unknown>) => ({ text: String(s.text), isUser: s.is_user === true, speaker: Number(s.speaker_id), start: Number(s.start), end: Number(s.end) });

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS  ${name}`); }

try {
  await check('counts talk share, stretches, questions, fillers, repeats', () => {
    const m = coach.speakingMetrics(call(5, 'So um I I think the the platform basically, like, you know saves time').map(seg));
    assert.ok(m.talkShare > 0.6, `talk share ${m.talkShare}`);
    assert.equal(m.longestTurnSecs, 50);
    assert.equal(m.questions, 0);
    assert.ok(m.theirQuestions >= 4);
    assert.equal(m.topFillers.length, 3);
    assert.ok(m.fillers >= 5 * 4 && m.repeats >= 10 && m.hedges >= 5, JSON.stringify(m));
    assert.equal(coach.isRealTalk(m), true);
    assert.equal(coach.isRealTalk(coach.speakingMetrics([seg({ text: 'Yeah.', is_user: true, speaker_id: 0, start: 0, end: 1 })])), false);
  });

  await check('a long work call gets a debrief staged for the next check-in', async () => {
    const segs = call(20, 'So um the idea is we help coaches prepare');
    const m = await coach.recordConversation({ id: 'jordan', title: 'Product demo', start: '2026-10-15T15:55:00Z' }, segs.map(seg), { real: true, setting: 'work', with: ['Jordan'] });
    assert.ok(m && m.minutes >= 19);
    assert.equal(staged.length, 1);
    assert.equal(staged[0].subject, 'speech-coach:call:jordan');
    assert.match(staged[0].title ?? '', /Product demo/);
    assert.match(staged[0].text, /you talked \d+% of the time/);
    assert.match(staged[0].text, /Try instead:\n- You said "I I put forty five minutes for the call" → "Before I dive in/);
    assert.match(staged[0].text, /Practice next time: Ask one question before every pitch\./);
    assert.match(asked[0], /^You: So um/m, 'the model sees the compact transcript');
  });

  await check('short calls, family time and media get numbers only, or nothing', async () => {
    asked.length = 0; staged.length = 0;
    await coach.recordConversation({ id: 'short', title: 'Quick check-in', start: '2026-10-16T14:00:00Z' }, call(5, 'Quick update on the pilot, we have three coaches signed up and two more coming next week').map(seg), { real: true, setting: 'work' });
    await coach.recordConversation({ id: 'kai', title: 'Homework with Kai', start: '2026-10-16T11:30:00Z' }, call(16, 'Great job, now color the seven red').map(seg), { real: true, setting: 'family', with: ['Kai'] });
    assert.equal(await coach.recordConversation({ id: 'tv', title: 'A show', start: '2026-10-16T20:00:00Z' }, call(30, 'Previously on').map(seg), { real: false }), null);
    assert.equal(await coach.recordConversation({ id: 'unsure', title: 'Clips', start: '2026-10-16T21:00:00Z' }, call(30, 'Previously on').map(seg)), null, 'no talk info, no row');
    assert.equal(asked.length, 0);
    assert.equal(staged.length, 0);
    assert.equal(coach.rowsBetween('2026-10-01', '2026-11-01').map((r) => r.conversation_id).sort().join(','), 'jordan,kai,short');
  });

  await check('the Sunday summary compares settings and reuses the debrief', async () => {
    asked.length = 0;
    transcripts.kai = { conversation: { transcript_segments: call(16, 'Great job, now color the seven red') } };
    const report = await coach.weeklySpeakingReport();
    assert.ok(report);
    assert.match(report!, /^3 real conversations/);
    assert.match(report!, /Work \(2\): you talked \d+%/);
    assert.match(report!, /Family \(1\): you talked \d+%/);
    assert.match(report!, /Product demo \(Thu, \d+ min, with Jordan\)/);
    assert.match(report!, /Focus this week: Ask one question before every pitch\./);
    assert.equal(asked.length, 1, 'only the family conversation needed a new review');
  });

  await check('on demand: private to the owner, and reuses a stored review', async () => {
    const [tool] = coach.speechCoachTools;
    assert.equal(await tool.handler({ about: 'Jordan' }, { groupKey: 'admin', userId: 'someone-else' }), 'This is private to the owner.');
    asked.length = 0;
    const out = String(await tool.handler({ about: 'Jordan call' }, { groupKey: 'admin', userId: getOwner().id }));
    assert.match(out, /^Product demo/);
    assert.match(out, /Warm open/);
    assert.equal(asked.length, 0);
  });

  console.log(`\nSpeech coach tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
