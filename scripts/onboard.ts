import 'dotenv/config';
import type Anthropic from '@anthropic-ai/sdk';
import { createInterface } from 'readline';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { isValidTimezone } from '../src/config.js';
import { MODULES } from '../src/modules.js';
import {
  OPENAI_MODEL,
  createOpenAIResponse,
  openAIFunctionCalls,
  openAITextFromResponse,
  toOpenAIFunctionTool,
  openAIText,
} from '../src/lib/openai.js';

/**
 * `npm run onboard` — the Mirror.
 *
 * A conversational setup wizard. Instead of hand-editing a dozen config files,
 * it interviews you (a short strategic conversation, the same "reflect you back
 * to yourself" idea behind the product), then GENERATES your assistant's
 * identity, voice, always-on profile, seed facts, per-group context, and .env
 * keys. This is also what makes the repo a clean template: there is no personal
 * data committed — your data only ever lands in gitignored files this writes.
 *
 *   npm run onboard         full run (writes real files + .env)
 *   npm run onboard:dry     generate into .onboard-dry/ and print — no real writes
 *
 * Resumable: progress is saved to .onboard-state.json so a re-run continues.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DRY = process.argv.includes('--dry');
const DRY_DIR = join(ROOT, '.onboard-dry');
const STATE_PATH = join(ROOT, '.onboard-state.json');

const MODEL = process.env.OPENAI_MODEL || OPENAI_MODEL;

// Group key → the context dir its CLAUDE.md lives in, and the example template
// to seed it from. (The Home group's context dir is historically "personal".)
const GROUP_MAP: Record<string, { contextDir: string; example: string }> = {
  admin: { contextDir: 'admin', example: 'admin.md' },
  home: { contextDir: 'personal', example: 'personal.md' },
  family: { contextDir: 'family', example: 'family.md' },
  work: { contextDir: 'work', example: 'work.md' },
  health: { contextDir: 'health', example: 'health.md' },
};

// ── tiny prompt helpers ──────────────────────────────────────────────────────
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = (q: string): Promise<string> =>
  new Promise((res) => rl.question(q, (a) => res(a.trim())));
const askDefault = async (q: string, def: string): Promise<string> =>
  (await ask(`${q} [${def}]: `)) || def;
const askYesNo = async (q: string, def = false): Promise<boolean> => {
  const a = (await ask(`${q} (${def ? 'Y/n' : 'y/N'}): `)).toLowerCase();
  if (!a) return def;
  return a.startsWith('y');
};

function banner(s: string) {
  console.log(`\n\x1b[1m${s}\x1b[0m`);
}

// ── artifact writer (dry-aware) ──────────────────────────────────────────────
function writeArtifact(relPath: string, content: string) {
  const target = DRY ? join(DRY_DIR, relPath) : join(ROOT, relPath);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { mode: 0o600 });
  // Rewriting an existing file preserves its prior mode, so enforce the
  // private operator-artifact permission after every onboarding run.
  chmodSync(target, 0o600);
  console.log(`  ${DRY ? '(dry) would write' : 'wrote'} ${relPath}${DRY ? ` → ${target}` : ''}`);
}

// Upsert KEY=value lines into .env (skipped in dry mode).
function setEnv(updates: Record<string, string>) {
  if (DRY) {
    for (const [k, v] of Object.entries(updates)) {
      console.log(`  (dry) would set ${k}=${k.includes('KEY') || k.includes('TOKEN') ? '***' : v}`);
    }
    return;
  }
  const envPath = join(ROOT, '.env');
  let lines = existsSync(envPath) ? readFileSync(envPath, 'utf-8').split('\n') : [];
  for (const [key, value] of Object.entries(updates)) {
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    const line = `${key}=${value}`;
    if (idx >= 0) lines[idx] = line;
    else lines.push(line);
  }
  writeFileSync(envPath, lines.join('\n'));
  console.log(`  updated .env (${Object.keys(updates).join(', ')})`);
}

function loadState(): any {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf-8')); } catch { /* ignore */ }
  }
  return {};
}
function saveState(state: any) {
  if (DRY) return;
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

// ── the Mirror conversation ──────────────────────────────────────────────────

const SUBMIT_TOOL: Anthropic.Tool = {
  name: 'submit_profile',
  description: 'Call this once, at the END of the interview, with everything you have gathered. Generate the markdown files (identity, voice, profile) fully written in the owner\'s chosen tone — they are used verbatim as the assistant\'s system prompt.',
  input_schema: {
    type: 'object',
    properties: {
      botName: { type: 'string', description: "What the assistant is called, e.g. 'Assistant'." },
      triggerWord: { type: 'string', description: "The @-trigger for ordinary group chats, e.g. '@assistant'. Lowercase, starts with @. The isolated Family group does not require it." },
      householdName: { type: 'string', description: "Collective noun for who it serves, e.g. 'Rivera family' or 'Alex'." },
      timezone: { type: 'string', description: "IANA timezone where the owner lives, e.g. 'America/Chicago' or 'Europe/London'." },
      owner: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          fullName: { type: 'string', description: 'Full name used on phone calls and bookings, e.g. "Alex Rivera".' },
          shortName: { type: 'string', description: 'Initials or nickname, e.g. "AR".' },
          pronouns: {
            type: 'object',
            description: 'How to refer to the owner, e.g. {subject:"she", object:"her", possessive:"her"}. Default they/them/their.',
            properties: { subject: { type: 'string' }, object: { type: 'string' }, possessive: { type: 'string' } },
          },
          tone: { type: 'string', enum: ['direct', 'warm', 'playful'] },
        },
        required: ['name', 'shortName', 'tone'],
      },
      people: {
        type: 'array',
        description: 'Inner circle (partner, kids, key contacts, etc). Seeded into the CRM.',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            relationship: { type: 'string', description: 'e.g. partner, child, friend, colleague.' },
            role: { type: 'string' },
            notes: { type: 'string' },
          },
          required: ['name'],
        },
      },
      modules: {
        type: 'object',
        description: 'Which features to turn on or off, by feature id from the list in your instructions, e.g. {"checkins": true, "phone": false}. Include every feature they chose or declined.',
        additionalProperties: { type: 'boolean' },
      },
      groupsEnabled: {
        type: 'array',
        description: 'Which groups to turn on. Subset of: admin, family, home, work, health. Always include admin. Family is the least-privilege shared household group; home is the legacy broader household group.',
        items: { type: 'string' },
      },
      identityMarkdown: { type: 'string', description: "context/shared/identity.md — the assistant's soul (~25 lines). Use the bot name + household." },
      voiceMarkdown: { type: 'string', description: 'context/shared/voice.md — how it talks to the owner, in their chosen tone (~30 lines), with a banned-LLM-tells list.' },
      profileMarkdown: { type: 'string', description: "context/shared/profile.md — the always-on owner profile narrative built from the interview (~40-60 lines)." },
      facts: {
        type: 'array',
        description: '8-15 atomic facts distilled from the interview for retrieval.',
        items: {
          type: 'object',
          properties: {
            subject: { type: 'string' },
            predicate: { type: 'string' },
            object: { type: 'string' },
            fact_type: { type: 'string', enum: ['fact', 'preference', 'decision', 'commitment', 'metric'] },
          },
          required: ['subject', 'predicate', 'object'],
        },
      },
    },
    required: ['botName', 'triggerWord', 'householdName', 'owner', 'groupsEnabled', 'identityMarkdown', 'voiceMarkdown', 'profileMarkdown', 'facts'],
  },
};

// Plain-language menu of optional features, straight from src/modules.ts.
const FEATURE_MENU = MODULES
  .filter((m) => !m.alwaysOn)
  .map((m) => `- ${m.id}: ${m.title}. ${m.description}${m.defaultEnabled ? ' (on by default)' : ''}`)
  .join('\n');

const MIRROR_SYSTEM = `You are conducting the onboarding interview for a personal AI assistant that will run on the user's Mac and talk to them over iMessage. It becomes their "second brain": tasks, calendar, a people/CRM layer, durable facts, proactive reminders.

Your job: interview the user with a SHORT, sharp conversation (aim for 7-10 exchanges, ONE question at a time, no walls of text), then call submit_profile with everything — including fully-written identity.md, voice.md, and profile.md in the tone they ask for.

Cover, conversationally and in roughly this order:
1. "The list" first. This is what makes the assistant useful, so give it room: who's in their life (partner, kids, family, friends, colleagues; names + one line each), what they tend to forget or drop, and what they'd hand off to a great assistant if they had one. Encourage specifics; a couple of follow-ups here is fine.
2. What they want to call the assistant (and the @-trigger for ordinary group chats; the Family chat doesn't need one).
3. Who they are: name (and full name), pronouns, where they live (for the timezone), what they do, what they're optimizing for right now.
4. Their daily rhythm (rough — wake, work blocks, commitments).
5. How they want it to talk to them: tone (direct / warm / playful), and any "never do this" lines.
6. Which features to turn on. Describe them in plain words, a few at a time, and recommend starting small: the ones marked "on by default" are a good start, and they can add more later by saying "set me up" again. Map what they said in "the list" to features (e.g. "I forget to reply to people" → daily check-ins; "I hate calling places" → phone). The Family chat is a separate shared group text with their partner, with its own calendar and lists, and it never sees their private stuff.

Features available (id: description):
${FEATURE_MENU}

Rules:
- One question per turn. React briefly to what they said before asking the next thing. Be warm but efficient.
- Do NOT ask for phone numbers, emails, or API keys — the script handles those separately.
- When you have enough, call submit_profile. Write the markdown files richly and specifically from what they told you, in their chosen voice. The profile is third-person ("about <name>"). Avoid LLM-tell phrases.
Start now with your first question.`;

async function runMirror(): Promise<any> {
  const input: Array<Record<string, unknown>> = [];
  // Kick the model for its opening question.
  input.push({ role: 'user', content: [{ type: 'input_text', text: "Let's begin. Ask me your first question." }] });

  for (let turn = 0; turn < 24; turn++) {
    const resp = await createOpenAIResponse({
      model: MODEL,
      maxOutputTokens: 4096,
      instructions: MIRROR_SYSTEM,
      tools: [toOpenAIFunctionTool(SUBMIT_TOOL)],
      input,
      reasoningEffort: 'low',
    });

    input.push(...(resp.output || []));
    const toolUse = openAIFunctionCalls(resp).find((b) => b.name === 'submit_profile');
    if (toolUse) {
      try { return JSON.parse(toolUse.arguments); } catch { throw new Error('OpenAI returned invalid submit_profile arguments.'); }
    }

    const text = openAITextFromResponse(resp);

    console.log(`\n\x1b[36m${text}\x1b[0m`);
    const answer = await ask('\n› ');
    if (!answer) {
      // empty answer — nudge the model to wrap up
      input.push({ role: 'user', content: [{ type: 'input_text', text: '(no answer — if you have enough, go ahead and submit the profile)' }] });
    } else {
      input.push({ role: 'user', content: [{ type: 'input_text', text: answer }] });
    }
  }
  throw new Error('Interview did not converge — re-run npm run onboard.');
}

// ── artifact generation ──────────────────────────────────────────────────────

function substitute(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

function generateGroupContext(profile: any) {
  const vars = {
    BOT_NAME: profile.botName,
    OWNER_NAME: profile.owner.name,
    OWNER_SHORT: profile.owner.shortName,
    PARTNER_NAME: (profile.people || []).find((p: any) => /partner|spouse|wife|husband/i.test(p.relationship || ''))?.name || 'your household',
    HOUSEHOLD: profile.householdName,
  };
  for (const key of profile.groupsEnabled as string[]) {
    const map = GROUP_MAP[key];
    if (!map) { console.log(`  · skipping unknown group "${key}"`); continue; }
    const examplePath = join(ROOT, 'context', '_examples', 'groups', map.example);
    if (!existsSync(examplePath)) { console.log(`  · no template for group "${key}" (${map.example}) — skipping`); continue; }
    const rendered = substitute(readFileSync(examplePath, 'utf-8'), vars);
    writeArtifact(join('context', map.contextDir, 'CLAUDE.md'), rendered);
  }
}

function buildProfileJson(profile: any) {
  const enabledGroups = profile.groupsEnabled || [];
  const partnerAllowedGroups = enabledGroups.includes('family')
    ? ['family']
    : enabledGroups.includes('home')
      ? ['home']
      : [];
  const members = (profile.people || [])
    .filter((p: any) => /partner|spouse|wife|husband/i.test(p.relationship || ''))
    .map((p: any) => ({
      id: 'partner',
      name: p.name,
      tone: 'warm',
      role: 'member',
      allowedGroups: partnerAllowedGroups,
      phoneEnv: 'USER_PARTNER',
      emailEnv: 'USER_PARTNER_EMAIL',
    }));

  return {
    botName: profile.botName,
    triggerWord: profile.triggerWord,
    householdName: profile.householdName,
    ...(isValidTimezone(profile.timezone) ? { timezone: profile.timezone } : {}),
    owner: {
      id: 'owner',
      name: profile.owner.name,
      ...(profile.owner.fullName ? { fullName: profile.owner.fullName } : {}),
      shortName: profile.owner.shortName,
      ...(profile.owner.pronouns?.subject && profile.owner.pronouns?.object && profile.owner.pronouns?.possessive
        ? { pronouns: profile.owner.pronouns }
        : {}),
      tone: profile.owner.tone,
      role: 'admin',
      allowedGroups: Array.from(new Set([...(profile.groupsEnabled || []), 'reflection', 'brain-pulse'])),
      phoneEnv: 'USER_OWNER',
      emailEnv: 'USER_OWNER_EMAIL',
    },
    members,
    people: profile.people || [],
    groupsEnabled: profile.groupsEnabled,
    modules: pickModules(profile.modules, profile.groupsEnabled || []),
  };
}

/** Keep only real feature ids; turning on the Family group implies the family feature. */
function pickModules(raw: unknown, groups: string[]): Record<string, boolean> {
  const known = new Set(MODULES.filter((m) => !m.alwaysOn).map((m) => m.id));
  const out: Record<string, boolean> = {};
  if (raw && typeof raw === 'object') {
    for (const [id, on] of Object.entries(raw as Record<string, unknown>)) {
      if (known.has(id) && typeof on === 'boolean') out[id] = on;
    }
  }
  if (groups.includes('family') && known.has('family')) out.family = true;
  return out;
}

// ── phases ───────────────────────────────────────────────────────────────────

async function phaseApiKey(state: any): Promise<string> {
  banner('Step 1 — Which AI runs your assistant');
  console.log('  Claude (Anthropic) or OpenAI. Either works for everything except phone calls,');
  console.log('  which always use OpenAI\'s voice model. This key is billed by use and is separate');
  console.log('  from any Claude or ChatGPT subscription. Set a monthly limit in the billing settings.');

  const existing = (process.env.LLM_PROVIDER || '').toLowerCase();
  let provider: 'claude' | 'openai' =
    existing === 'claude' || existing === 'anthropic' ? 'claude'
      : existing === 'openai' ? 'openai'
        : process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY ? 'claude'
          : process.env.OPENAI_API_KEY ? 'openai'
            : ((await ask('  Type claude or openai [claude]: ')).trim().toLowerCase().startsWith('o') ? 'openai' : 'claude');
  const keyVar = provider === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY';
  console.log(`  Using ${provider === 'claude' ? 'Claude' : 'OpenAI'}.`);

  let key = process.env[keyVar] || '';
  if (key) {
    console.log(`  found ${keyVar} in environment.`);
  } else {
    key = await ask(provider === 'claude'
      ? '  Paste your Claude API key from console.anthropic.com (sk-ant-…): '
      : '  Paste your OpenAI API key from platform.openai.com (sk-proj-…): ');
  }
  if (!key) throw new Error('An API key is required for the interview.');

  // Validate with a tiny call on the quick model.
  process.stdout.write('  validating… ');
  process.env[keyVar] = key;
  process.env.LLM_PROVIDER = provider;
  try {
    await openAIText({ model: process.env.OPENAI_ROUTER_MODEL || 'gpt-5.6-luna', prompt: 'Reply with exactly: pong', maxOutputTokens: 16, reasoningEffort: 'none' });
    console.log('ok.');
  } catch (err) {
    console.log('failed.');
    throw new Error(`API key validation failed: ${(err as Error).message}`);
  }
  setEnv({ LLM_PROVIDER: provider, [keyVar]: key });
  saveState(state);
  return key;
}

async function phaseContacts(profile: any) {
  banner('Step 4 — Your handles');
  console.log('  These map iMessage senders to people. Stored in .env, never committed.');
  const ownerPhone = await ask('  Your phone (e.g. +15551234567), or blank to skip: ');
  const ownerEmail = await ask('  Your iMessage email (Apple ID), or blank: ');
  const env: Record<string, string> = { TRIGGER_WORD: profile.triggerWord };
  if (ownerPhone) env.USER_OWNER = ownerPhone;
  if (ownerEmail) env.USER_OWNER_EMAIL = ownerEmail;

  const partner = (profile.people || []).find((p: any) => /partner|spouse|wife|husband/i.test(p.relationship || ''));
  if (partner) {
    const sharedGroup = (profile.groupsEnabled || []).includes('family') ? 'Family' : 'Home';
    const pPhone = await ask(`  ${partner.name}'s phone (for the ${sharedGroup} group), or blank: `);
    const pEmail = await ask(`  ${partner.name}'s email, or blank: `);
    if (pPhone) env.USER_PARTNER = pPhone;
    if (pEmail) env.USER_PARTNER_EMAIL = pEmail;
    if (pEmail && (profile.groupsEnabled || []).includes('home') && !(profile.groupsEnabled || []).includes('family')) {
      env.HOME_AUTO_ATTENDEE = pEmail;
    }
  }
  if ((profile.groupsEnabled || []).includes('family')) {
    let calendarAccount = '';
    while (!calendarAccount) {
      calendarAccount = await ask('  Exact Google account that will own the Family calendar (required): ');
      if (!calendarAccount) console.log('  Family setup needs this account pin so calendar discovery can fail closed.');
    }
    env.FAMILY_CALENDAR_ACCOUNT = calendarAccount;
    const weatherLocation = await ask('  Family weather location (city/state or ZIP), or blank: ');
    if (weatherLocation) env.FAMILY_WEATHER_LOCATION = weatherLocation;
    env.FAMILY_DAILY_CRON = '"0 7 * * *"';
    env.FAMILY_WEEKLY_CRON = '"30 19 * * 0"';
    if (existsSync(join(ROOT, 'AUTOMATIONS_OFF'))) {
      const allowlist = (process.env.AUTOMATIONS_ON || '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (!allowlist.some((entry) => entry.toLowerCase() === 'family-scheduler')) {
        allowlist.push('family-scheduler');
      }
      env.AUTOMATIONS_ON = allowlist.join(',');
    }
  }
  const ghRoot = await ask('  Path to your local repos for the Work group (e.g. ~/GitHub), or blank: ');
  if (ghRoot) env.ASSISTANT_GH_ROOT = ghRoot;
  setEnv(env);
}

async function phaseIntegrations() {
  banner('Step 5 — Integrations (all optional)');

  if (!DRY && await askYesNo('  Set up Google Calendar + Tasks now (opens a browser)?', false)) {
    console.log('  launching npm run auth:google …');
    spawnSync('npm', ['run', 'auth:google'], { cwd: ROOT, stdio: 'inherit' });
  } else {
    console.log('  skip — run `npm run auth:google` anytime.');
  }

  if (!DRY && await askYesNo('  Import Apple Contacts into the people layer now?', false)) {
    spawnSync('npm', ['run', 'import:contacts'], { cwd: ROOT, stdio: 'inherit' });
  } else {
    console.log('  skip — run `npm run import:contacts` anytime.');
  }

  console.log('\n  iMessage groups: start the bot (npm run dev) and message it; unmapped group');
  console.log('  chat IDs are logged as "[groups] Unmapped chat: … — add to .env to enable".');
  console.log('  Map them to GROUP_ADMIN / GROUP_FAMILY / GROUP_HOME / GROUP_WORK / GROUP_HEALTH in .env.');
  console.log('  Family setup is manual: create a new iMessage group with only the bot, owner, and partner.');
  console.log('  Before GROUP_FAMILY is mapped, send one temporary trigger-bearing message so the unmapped chat ID is logged.');
  console.log('  Set GROUP_FAMILY, restart, then stop using the trigger. Assistant suspends Family if membership changes.');
  console.log('  Also create a secondary Google calendar named Family, share it with the partner as an editor,');
  console.log('  and verify the partner can edit it directly before running `npm run family:configure`.');
  console.log('  That command pins both the unique calendar ID and authenticated account; it never creates calendars or changes sharing.');
  console.log('  Restart the background service: npm run restart');
  console.log('  Verify: launchctl print "gui/$(id -u)/com.assistant.agent" | grep -E \'state =|pid =|last exit code =\'');
  console.log('  Then inspect: tail -n 160 /tmp/assistant.log | grep -E \'FamilyScheduler|Family-safe MCP|automations|Suspended Family|Ready\'');
}

async function phaseSeedAndVerify() {
  banner('Step 6 — Seed + health check');
  if (DRY) { console.log('  (dry) would run: npm run seed:facts && npm run doctor'); return; }
  if (await askYesNo('  Seed the brain with your profile facts now?', true)) {
    spawnSync('npm', ['run', 'seed:facts'], { cwd: ROOT, stdio: 'inherit' });
  }
  if (await askYesNo('  Run the health check (npm run doctor)?', true)) {
    spawnSync('npm', ['run', 'doctor'], { cwd: ROOT, stdio: 'inherit' });
  }
}

// ── main ─────────────────────────────────────────────────────────────────────

async function main() {
  banner(`assistant onboarding — the Mirror${DRY ? '  (DRY RUN — nothing real is written)' : ''}`);
  console.log('A short conversation, then your assistant is configured.\n');

  const [major] = process.versions.node.split('.').map(Number);
  if (major < 20) console.log(`  ⚠ Node ${process.versions.node} detected — Node 20+ recommended.`);
  if (process.platform !== 'darwin') console.log('  ⚠ Not macOS — the iMessage channel needs a Mac. You can still configure here.');

  const state = loadState();
  await phaseApiKey(state);

  banner('Step 2 — The conversation');
  console.log('  Answer naturally. One question at a time. Ctrl-C to stop (re-run resumes).\n');
  let profile = state.profile;
  if (profile) {
    console.log('  Found a saved profile from a previous run.');
    if (await askYesNo('  Reuse it (skip the conversation)?', true)) {
      // keep it
    } else {
      profile = await runMirror();
    }
  } else {
    profile = await runMirror();
  }
  state.profile = profile;
  saveState(state);

  banner('Step 3 — Generating your assistant');
  writeArtifact('config/profile.json', JSON.stringify(buildProfileJson(profile), null, 2));
  writeArtifact('context/shared/identity.md', profile.identityMarkdown);
  writeArtifact('context/shared/voice.md', profile.voiceMarkdown);
  writeArtifact('context/shared/profile.md', profile.profileMarkdown);
  writeArtifact('context/seeds/facts.json', JSON.stringify(profile.facts || [], null, 2));
  generateGroupContext(profile);

  await phaseContacts(profile);
  await phaseIntegrations();
  await phaseSeedAndVerify();

  banner('Done.');
  console.log(`  ${profile.botName} is configured for ${profile.owner.name}.`);
  if (DRY) {
    console.log(`  Review the generated files under ${DRY_DIR}, then run \x1b[1mnpm run onboard\x1b[0m for real.`);
  } else {
    console.log('  Next: finish any skipped integrations, then \x1b[1mnpm run dev\x1b[0m to go live.');
    console.log('  Re-run \x1b[1mnpm run onboard\x1b[0m anytime to adjust.');
  }
  rl.close();
}

main().catch((err) => {
  console.error(`\n✗ ${err.message}`);
  rl.close();
  process.exit(1);
});
