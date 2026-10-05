// research: personalization, depth (planned parallel searches), and the Family
// data boundary. Isolated DB; the model is stubbed.
//   npm run test:research
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-research-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
const db = await import('../src/db.js');
const r = await import('../src/research.js');
const { getOwner } = await import('../src/config.js');
const owner = getOwner().name.split(' ')[0].toLowerCase();

db.saveFact({ subject: 'sam', predicate: 'is', object: "the owner's son, born 4/21/2022", fact_type: 'fact' });
db.saveFact({ subject: 'sam', predicate: 'is currently obsessed with', object: 'hockey and soccer, and fire trucks', fact_type: 'fact' });
db.saveFact({ subject: owner, predicate: 'lives in', object: 'Springfield', fact_type: 'fact' });
db.saveFact({ subject: 'activities', predicate: 'dislikes', object: 'messy indoor play spaces (sandboxes)', fact_type: 'preference' });
db.saveFact({ subject: 'sam', predicate: 'medical', object: 'SECRET-DIAGNOSIS', fact_type: 'fact', sensitive: true });
db.logLocation({ label: 'Riverside, Downtown', lat: 40.78, lon: -73.95 });
db.setMemory('family', 'sam_interests', 'Sam loves fire trucks and soccer');

const calls: Array<{ instructions: string; input: string; search: boolean }> = [];
r.setResearchDeps({
  now: () => new Date(),
  call: async (o) => {
    calls.push(o);
    // Like the real planner, the queries come from what it was given.
    if (!o.search && /plan web research/.test(o.instructions)) return { text: /Riverside/.test(o.input) ? '{"queries":["kid activities Riverside today","fire station open house October","indoor play Riverside evening"]}' : '{"queries":["family weekend activities","kids events this weekend"]}', urls: [] };
    if (!o.search && /review web research/.test(o.instructions)) return { text: '{"queries":["Lakeside Theater family show ticket price Oct 10"]}', urls: [] };
    if (o.search) return { text: `Found things for: ${o.input.split('\n')[0]}`, urls: ['https://example.com/a'] };
    return { text: 'FINAL ANSWER', urls: [] };
  },
});

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) { await fn(); passed++; console.log(`PASS  ${name}`); }

try {
  await check('owner research: planned searches run in parallel, answer is personal', async () => {
    const out = await r.research({ question: 'things to do with Sam near the river park from 5-8pm', when: 'today 5-8pm' });
    assert.equal(out, 'FINAL ANSWER');
    const searches = calls.filter((c) => c.search);
    assert.equal(searches.length, 4, 'three planned searches + one gap follow-up');
    assert.match(calls.at(-1)!.input, /Follow-up: Lakeside Theater family show ticket price/);
    const synth = calls.at(-1)!;
    assert.match(synth.input, /fire trucks/);
    assert.match(synth.input, /messy indoor play/, 'saved dislikes reach the answer');
    assert.match(synth.input, /Springfield/);
    assert.match(synth.input, /Riverside/, 'live location');
    assert.match(synth.input, /Found things for: kid activities Riverside today/);
    assert.ok(!calls.some((c) => c.input.includes('SECRET-DIAGNOSIS')), 'sensitive facts never leave');
  });

  await check('Family chat research sees Family memory only, never the owner\'s facts or location', async () => {
    calls.length = 0;
    await r.research({ question: 'what can we do this weekend' }, { family: true });
    const all = calls.map((c) => c.input).join('\n');
    assert.match(all, /Sam loves fire trucks and soccer/);
    const leak = all.match(/Springfield|Riverside|messy indoor play|the owner's son/); if (leak) console.log('LEAK CONTEXT:', all.slice(Math.max(0, all.indexOf(leak[0]) - 300), all.indexOf(leak[0]) + 100));
    assert.ok(!leak, 'no owner facts or location in a Family run');
  });

  await check('travel gets the travel guide; a broken planner still searches the question', async () => {
    calls.length = 0;
    r.setResearchDeps({ call: async (o) => { calls.push(o); if (/plan web research|review web research/.test(o.instructions)) return { text: 'no json', urls: [] }; return { text: o.search ? 'results' : 'PLAN', urls: [] }; } });
    await r.research({ question: 'help plan a long weekend in Vermont Oct 16-19 with Sam' });
    assert.match(calls[0].instructions, /drive time from home|where to stay/);
    assert.equal(calls.filter((c) => c.search).length, 1);
    assert.match(calls.find((c) => c.search)!.input, /^help plan a long weekend in Vermont/);
  });

  console.log(`\nResearch tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
