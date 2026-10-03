// Module switchboard tests: selection precedence, defaults, admin tool
// filtering, group registration, doctor --setup status mapping, .env.example
// coverage and the launchd plan. Isolated DB + profile; never touches launchd
// (install-launchd runs with --dry only) and never calls OpenAI.
//   npm run test:modules
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = process.cwd();
const tempRoot = mkdtempSync(join(tmpdir(), 'dialzero-modules-'));
mkdirSync(join(tempRoot, 'config'), { recursive: true });
const profilePath = join(tempRoot, 'config', 'profile.json');
writeFileSync(profilePath, JSON.stringify({
  botName: 'Test',
  owner: { id: 'owner', name: 'Owner', tone: 'direct', role: 'admin', allowedGroups: ['admin'], phoneEnv: 'USER_OWNER' },
  members: [],
  people: [],
  groupsEnabled: ['admin'],
  modules: { email: 'on', bogus: true, dashboard: false, junk: 7 },
}));
process.env.ASSISTANT_DB_PATH = join(tempRoot, 'isolated.db');
process.env.ASSISTANT_PROFILE_PATH = profilePath;
// Empty (not unset) so nothing on this machine leaks into the defaults.
for (const k of ['MODULES_ON', 'MODULES_OFF', 'OPENAI_API_KEY', 'LOCAL_LLM_BASE_URL', 'LOCAL_LLM_MODEL', 'GROUP_ADMIN', 'GROUP_FAMILY', 'GROUP_WORK', 'GROUP_HOME', 'GROUP_HEALTH', 'FAMILY_CALENDAR_ID', 'INBOX_SIGNAL_ENABLED', 'EMAIL_RECONCILIATION_ENABLED']) process.env[k] = '';
process.env.WHISPER_BIN = join(tempRoot, 'no-whisper');
process.env.USER_OWNER = '+15555550100';

const modules = await import('../src/modules.js');
const config = await import('../src/config.js');
const groups = await import('../src/group-resolver.js');
const { toolRegistry } = await import('../src/tools/index.js');
const doctor = await import('../src/doctor.js');
const envGen = await import('./gen-env-example.js');
const launchd = await import('./install-launchd.js');

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  await fn();
  passed++;
  console.log(`PASS  ${name}`);
}

const noProfile = { profile: { groupsEnabled: [] as string[] } };
const on = (id: string, input: Parameters<typeof modules.isModuleOn>[1] = {}) => modules.isModuleOn(id, input);

try {
  await check('profile.modules is normalized to booleans', () => {
    const profile = config.getProfileConfig();
    assert.deepEqual(profile.modules, { email: true, bogus: true, dashboard: false });
  });

  await check('defaults: proactive and extra-setup modules are off, basics are on', () => {
    const env = { WHISPER_BIN: join(tempRoot, 'none') } as NodeJS.ProcessEnv;
    for (const id of ['core', 'memory', 'calendar', 'email', 'actions', 'dashboard']) assert.equal(on(id, { env, ...noProfile }), true, id);
    for (const id of ['checkins', 'nudges', 'journal', 'email-watcher', 'meetings', 'phone', 'browser', 'desktop', 'voice-notes', 'siri', 'family', 'builder', 'local-model']) {
      assert.equal(on(id, { env, ...noProfile }), false, id);
    }
  });

  await check('selection precedence: env > profile > implied > default', () => {
    const profile = { modules: { checkins: true, memory: false }, groupsEnabled: ['family'] };
    assert.equal(on('checkins', { env: {}, profile }), true, 'profile turns on');
    assert.equal(on('memory', { env: {}, profile }), false, 'profile turns off a default-on module');
    assert.equal(on('memory', { env: { MODULES_ON: 'memory' }, profile }), true, 'MODULES_ON beats profile');
    assert.equal(on('checkins', { env: { MODULES_OFF: ' CheckIns ,x' }, profile }), false, 'MODULES_OFF beats profile, case-insensitive');
    assert.equal(on('checkins', { env: { MODULES_ON: 'checkins', MODULES_OFF: 'checkins' }, profile }), false, 'OFF wins a tie');
    assert.equal(on('core', { env: { MODULES_OFF: 'core' }, profile }), true, 'core is always on');
    assert.equal(on('family', { env: {}, profile }), true, 'groupsEnabled implies family');
    assert.equal(on('family', { env: {}, profile: { ...profile, modules: { family: false } } }), false, 'explicit profile beats implied');
    assert.equal(on('local-model', { env: { LOCAL_LLM_BASE_URL: 'http://x', LOCAL_LLM_MODEL: 'm' }, ...noProfile }), true, 'filled-in settings imply local-model');
    assert.equal(on('local-model', { env: { LOCAL_LLM_BASE_URL: 'http://x', LOCAL_LLM_MODEL: 'm', MODULES_OFF: 'local-model' }, ...noProfile }), false);
    assert.equal(on('nope', { env: {}, profile }), false, 'unknown ids are off');
    const state = modules.resolveModule(modules.getModule('memory')!, { env: { MODULES_ON: 'memory' }, profile });
    assert.equal(state.source, 'env-on');
    assert.deepEqual(modules.unknownModuleIds({ env: { MODULES_ON: 'email,zzz' }, profile: { modules: { bogus: true } } }), ['zzz', 'bogus']);
  });

  await check('every module tool key exists in the registry and every admin key has an owner', () => {
    // MCP connector keys (mcp-servers.json) are registered at boot, not in the static registry.
    const mcp = new Set(Object.keys((JSON.parse(readFileSync(new URL('../mcp-servers.json', import.meta.url), 'utf8')) as { mcpServers: Record<string, unknown> }).mcpServers));
    for (const m of modules.MODULES) {
      for (const key of m.tools ?? []) assert.ok(toolRegistry[key] || mcp.has(key), `${m.id} claims unknown tool key ${key}`);
    }
    process.env.MODULES_ON = modules.MODULES.map((m) => m.id).join(',');
    for (const key of groups.adminTools()) {
      assert.ok(mcp.has(key) || modules.moduleFor('tools', key), `admin key ${key} has no module`);
    }
    process.env.MODULES_ON = '';
  });

  await check('admin/DM toolset is filtered to switched-on modules', () => {
    groups.initGroups();
    const dm = groups.resolveGroup('+15555550100');
    assert.ok(dm);
    const tools = dm.tools;
    for (const key of ['calendar', 'tasks', 'memory', 'people', 'recall', 'actions', 'web', 'email', 'email-reconciliation', 'instacart']) {
      assert.ok(tools.includes(key), `expected ${key}`);
    }
    for (const key of ['computer-use', 'codex', 'github', 'browser', 'errands', 'web-booking', 'notion', 'linkedin']) {
      assert.equal(tools.includes(key), false, `unexpected ${key}`);
    }
    process.env.MODULES_ON = 'desktop,phone';
    process.env.MODULES_OFF = 'email';
    const again = groups.resolveGroup('+15555550100')!.tools;
    assert.ok(again.includes('computer-use') && again.includes('errands'));
    assert.equal(again.includes('email'), false);
    process.env.MODULES_ON = '';
    process.env.MODULES_OFF = '';
  });

  await check('groups register only when their module is on, and still fail closed on collisions', () => {
    process.env.GROUP_FAMILY = 'chat-family-1';
    process.env.GROUP_WORK = 'chat-work-1';
    process.env.GROUP_HOME = 'chat-home-1';
    groups.initGroups();
    assert.equal(groups.resolveGroup('chat-family-1'), null, 'family module is off');
    assert.equal(groups.resolveGroup('chat-work-1'), null, 'builder module is off');
    assert.equal(groups.resolveGroup('chat-home-1')?.key, 'home');
    assert.equal(groups.resolveGroup('chat-home-1')?.tools.includes('spotify'), true);

    process.env.MODULES_ON = 'builder';
    groups.initGroups();
    const work = groups.resolveGroup('chat-work-1');
    assert.equal(work?.key, 'work');
    assert.equal(work?.tools.includes('browser'), false, 'browser module off, so its tool key is dropped');

    // A switched-off group sharing an ID with a live one still disables both.
    process.env.MODULES_ON = '';
    process.env.GROUP_FAMILY = 'chat-home-1';
    groups.initGroups();
    assert.equal(groups.resolveGroup('chat-home-1'), null);
    for (const k of ['GROUP_FAMILY', 'GROUP_WORK', 'GROUP_HOME']) process.env[k] = '';
    groups.initGroups();
  });

  await check('doctor --setup: disabled vs missing-env vs missing-dep mapping (stubbed probes)', () => {
    const fake: typeof modules.MODULES = [
      { id: 'base', title: 'Base', description: 'x', defaultEnabled: true, alwaysOn: true, env: [], deps: [] },
      {
        id: 'needs-env', title: 'Needs env', description: 'x', defaultEnabled: true,
        env: [
          { key: 'FAKE_REQUIRED', required: true, description: 'Paste the fake key.' },
          { key: 'FAKE_SWITCH_ENABLED', featureSwitch: { defaultOn: false }, description: 'switch' },
        ],
        deps: [{ name: 'fake-tool', check: () => false, installHint: 'Run brew install fake-tool.' }],
        launchd: ['svc'],
      },
      {
        id: 'off-mod', title: 'Off module', description: 'x', defaultEnabled: false,
        env: [{ key: 'FAKE_OFF_REQUIRED', required: true, description: 'never checked' }],
        deps: [{ name: 'never', check: () => { throw new Error('must not run'); }, installHint: '' }],
        setupChecks: () => { throw new Error('must not run'); },
      },
    ];
    const probes = { openaiKey: () => null, launchctlList: () => '123\t0\tdev.dialzero.svc\n', fileExists: () => true };
    const r = doctor.runSetupCheck({ env: {}, profile: { groupsEnabled: [] }, modules: fake, probes });
    const by = (mod: string, name: string) => r.checks.find((c) => c.module === mod && c.name === name);

    assert.equal(r.ready, false);
    assert.equal(by('needs-env', 'settings')?.status, 'fail');
    assert.match(by('needs-env', 'settings')!.fix!, /FAKE_REQUIRED.*Paste the fake key/);
    assert.equal(by('needs-env', 'FAKE_SWITCH_ENABLED')?.status, 'warn');
    assert.equal(by('needs-env', 'fake-tool')?.status, 'fail');
    assert.equal(by('needs-env', 'fake-tool')?.fix, 'Run brew install fake-tool.');
    assert.equal(by('needs-env', 'service dev.dialzero.svc')?.status, 'ok');
    const offRows = r.checks.filter((c) => c.module === 'off-mod');
    assert.equal(offRows.length, 1);
    assert.equal(offRows[0].status, 'disabled');
    assert.equal(r.checks.some((c) => c.status === 'warn' || c.status === 'fail' ? c.module === 'off-mod' : false), false);
    for (const c of r.checks) if (c.status === 'fail' || c.status === 'warn') assert.ok(c.fix, `${c.name} has no fix`);

    const fixed = doctor.runSetupCheck({
      env: { FAKE_REQUIRED: 'x', FAKE_SWITCH_ENABLED: 'true' },
      profile: { groupsEnabled: [] },
      modules: fake.map((m) => (m.id === 'needs-env' ? { ...m, deps: [] } : m)),
      probes,
    });
    assert.equal(fixed.ready, true, JSON.stringify(fixed.checks.filter((c) => c.status === 'fail')));
    assert.equal(fixed.summary.fail, 0);
    assert.equal(fixed.checks.find((c) => c.name === 'service dev.dialzero.svc')?.status, 'ok');

    const unloaded = doctor.runSetupCheck({ env: { FAKE_REQUIRED: 'x' }, profile: { groupsEnabled: [] }, modules: fake, probes: { ...probes, launchctlList: () => '' } });
    assert.equal(unloaded.checks.find((c) => c.name === 'service dev.dialzero.svc')?.status, 'warn');

    const flipped = doctor.runSetupCheck({ env: { MODULES_ON: 'off-mod', MODULES_OFF: 'needs-env', FAKE_OFF_REQUIRED: 'y' }, profile: { groupsEnabled: [] }, modules: [fake[0], fake[1], { ...fake[2], deps: [], setupChecks: undefined }], probes });
    assert.equal(flipped.checks.find((c) => c.module === 'needs-env')?.status, 'disabled');
    assert.equal(flipped.checks.find((c) => c.module === 'off-mod' && c.name === 'settings')?.status, 'ok');
  });

  await check('doctor --health does not warn for switched-off modules', () => {
    const report = doctor.runHealthCheck();
    const status = (name: string) => report.checks.find((c) => c.name === name)?.status;
    for (const name of ['nightly reflection', 'inbox-zero pass', 'calendar prep', 'memory audit', 'daemon: inbox-signal-daemon', 'daemon: meeting-daemon', 'daemon: email-reconciliation']) {
      assert.equal(status(name), 'disabled', name);
    }
    assert.equal(report.checks.some((c) => c.name === 'daemon heartbeats'), false);
  });

  await check('.env.example is generated and covers every setting the code reads', () => {
    assert.deepEqual(envGen.undocumentedEnvKeys(), []);
    assert.equal(readFileSync(join(ROOT, '.env.example'), 'utf8'), envGen.renderEnvExample(), 'run npm run env:example');
    const keys = modules.MODULES.flatMap((m) => m.env.map((e) => e.key));
    const text = envGen.renderEnvExample();
    for (const key of keys) assert.match(text, new RegExp(`^(# )?${key}[=:]`, 'm'), key);
  });

  await check('launchd plan: only enabled modules, fully rendered (dry run)', () => {
    const vars = { NODE: '/opt/n/node', REPO: '/r/a & b', HOME: '/h', LABEL_PREFIX: 'com.test', PATH: '/usr/bin' };
    const plan = launchd.planServices(vars, { env: {}, ...noProfile }, join(tempRoot, 'agents'));
    assert.deepEqual(plan.filter((s) => s.enabled).map((s) => s.name).sort(), ['agent', 'backup', 'contacts-sync', 'imessage-daemon']);
    for (const s of plan) {
      assert.equal(s.rendered.includes('{{'), false, s.name);
      assert.ok(s.rendered.includes(`<string>com.test.${s.name}</string>`));
      assert.ok(s.module, `${s.name} template has no owning module`);
    }
    assert.ok(plan.find((s) => s.name === 'agent')!.rendered.includes('/r/a &amp; b'));
    assert.match(plan.find((s) => s.name === 'meeting-daemon')!.rendered, /SuccessfulExit<\/key>\s*<false\/>/);
    const onPlan = launchd.planServices(vars, { env: { MODULES_ON: 'meetings,email-watcher,browser' }, ...noProfile }, join(tempRoot, 'agents'));
    assert.equal(onPlan.filter((s) => s.enabled).length, 7);

    const out = execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/install-launchd.ts'), '--dry'], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, LAUNCHD_LABEL_PREFIX: 'dev.dialzero-test' },
    });
    assert.match(out, /dry run/);
    assert.match(out, /would write .*dev\.dialzero-test\.agent\.plist/);
  });

  await check('daemons exit quietly when their module is off', () => {
    const out = execFileSync(process.execPath, ['--import', 'tsx', join(ROOT, 'scripts/meeting-daemon.ts')], {
      cwd: ROOT, encoding: 'utf8', env: { ...process.env, MODULES_OFF: 'meetings' }, timeout: 60_000,
    });
    assert.match(out, /module "meetings" is off — exiting/);
  });
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}

console.log(`\n${passed} passed`);
