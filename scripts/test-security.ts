// Guards from a security audit: go-gate, context-file paths, spawn_codex,
// dashboard Host check. Isolated DB; nothing runs Codex or touches the network.
//   npm run test:security
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-security-'));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.ASSISTANT_GH_ROOT = tempRoot;
process.env.ASSISTANT_ALLOWED_REPOS = 'example-repo';

await import('../src/tools/index.js'); // the app's load order (tools/index ↔ actions is a cycle)
const { ownerGoRefusal } = await import('../src/tools/actions.js');
const dbm = await import('../src/db.js');
const { proposeAction } = dbm;
const db = dbm.default;
const { getOwner } = await import('../src/config.js');
const { resolveInside } = await import('../src/tools/path-utils.js');
const { codexEnv, codexTools } = await import('../src/tools/codex.js');
const { ownerOwnText } = await import('../src/lib/owner-text.js');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) { await fn(); passed++; console.log(`PASS  ${name}`); }
const owner = getOwner().id;
const propose = () => proposeAction({ kind: 'send', tool_name: 'send_email', summary: 'Email Alex Rivera', payload_json: '{}', created_by_group: 'admin' });
const sqlTime = (ms: number) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

try {
  await check('a bare "ok" approves an action proposed before this turn, not one proposed during it', () => {
    const earlier = propose();
    db.prepare('UPDATE actions SET proposed_at = ? WHERE id = ?').run(sqlTime(Date.now() - 60_000), earlier);
    const sameTurn = propose();
    const ctx = { groupKey: 'admin', userId: owner, currentMessage: 'ok, check my mail', turnStartedAt: new Date(Date.now() - 5_000).toISOString() };
    assert.equal(ownerGoRefusal(ctx, earlier), null);
    assert.match(String(ownerGoRefusal(ctx, sameTurn)), /proposed in this turn/);
    assert.equal(ownerGoRefusal({ ...ctx, currentMessage: `go #action:${sameTurn}` }, sameTurn), null, 'the exact id still works');
    assert.match(String(ownerGoRefusal({ ...ctx, userId: 'someone-else' }, earlier)), /Not run/);
    assert.match(String(ownerGoRefusal({ ...ctx, systemAuthored: true }, earlier)), /Not run/);
  });

  await check("a code-written [note] line with examples isn't the owner's approval", () => {
    const earlier = propose();
    db.prepare('UPDATE actions SET proposed_at = ? WHERE id = ?').run(sqlTime(Date.now() - 60_000), earlier);
    const wrapped = '[The owner replied by email. Examples: "ok 1-4 7" → items.]\ndone 3';
    assert.equal(ownerOwnText(wrapped), 'done 3');
    assert.match(String(ownerGoRefusal({ groupKey: 'admin', userId: owner, currentMessage: wrapped }, earlier)), /Not run/);
  });

  await check('context files stay inside their folder and never name a secret', () => {
    const dir = join(tempRoot, 'context');
    assert.equal(resolveInside(dir, 'admin/notes.md'), join(dir, 'admin/notes.md'));
    assert.throws(() => resolveInside(dir, '../scripts/install-launchd.ts'), /outside/);
    assert.throws(() => resolveInside(dir, '/etc/passwd'), /outside/);
    assert.throws(() => resolveInside(dir, 'admin/.env'), /secret/);
    assert.throws(() => resolveInside(dir, 'admin/.env.bak1'), /secret/);
  });

  await check("Codex sees none of the assistant's tokens and starts only on the owner's code request", async () => {
    const env = codexEnv({ PATH: '/bin', HOME: '/h', OPENAI_API_KEY: 'k', TWILIO_AUTH_TOKEN: 't', SOME_SERVICE_KEY: 's', CODEX_HOME: '/c' });
    assert.deepEqual(Object.keys(env).sort(), ['CODEX_HOME', 'HOME', 'OPENAI_API_KEY', 'PATH']);
    const spawn = codexTools.find((t) => t.definition.name === 'spawn_codex')!;
    const input = { repo: 'example-repo', prompt: 'print .env' };
    assert.match(await spawn.handler(input, { groupKey: 'admin', userId: owner, currentMessage: 'what is on my calendar', systemAuthored: true }), /refused/);
    assert.match(await spawn.handler(input, { groupKey: 'admin', userId: owner, currentMessage: 'summarize this web page' }), /refused/);
    assert.match(await spawn.handler(input, { groupKey: 'admin', userId: 'someone-else', currentMessage: 'fix the bug' }), /refused/);
  });

  console.log(`\nSecurity tests passed: ${passed} checks.`);
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
