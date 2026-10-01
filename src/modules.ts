import { existsSync } from 'fs';
import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';
import { getProfileConfig } from './config.js';

// ─────────────────────────────────────────────────────────────────────────────
// Module switchboard: the list of features a user can turn on or off.
//
// Each module owns:
//   - tools:   toolRegistry keys it adds to the owner's (admin/DM) toolset
//   - groups:  group keys it registers (group-resolver.ts)
//   - start:   start functions it owns in src/index.ts
//   - daemons: scripts/*-daemon.ts processes it owns (they exit quietly when off)
//   - launchd: launchd/templates/<name>.plist.tmpl files installed for it
//   - env / deps / setupChecks: what `npm run doctor -- --setup` verifies
//
// Selection, highest precedence first:
//   1. env MODULES_OFF / MODULES_ON (comma lists of module ids; OFF wins a tie)
//   2. config/profile.json `modules: { "<id>": true|false }`
//   3. implied by the profile: a module whose group is listed in
//      profile.groupsEnabled, or whose own settings are already filled in
//      (`autoEnable`), counts as chosen
//   4. the module's defaultEnabled
// `alwaysOn` modules ignore all of the above.
//
// Keep this file light: it is imported by group-resolver, index, the daemons,
// transcribe and local-llm, so it must not import the DB or the agent.
// ─────────────────────────────────────────────────────────────────────────────

export type SetupStatus = 'ok' | 'warn' | 'fail' | 'disabled';

export interface SetupCheck {
  name: string;
  status: SetupStatus;
  detail: string;
  /** One plain-English instruction that fixes a warn/fail. */
  fix?: string;
}

export interface EnvSpec {
  key: string;
  description: string;
  /** Must be set for this module to work. */
  required?: boolean;
  /** Never print the value. */
  secret?: boolean;
  /** Value written into the generated .env.example (default: empty). */
  example?: string;
  /** This key is an inner on/off switch; the module does nothing while it is off. */
  featureSwitch?: { defaultOn: boolean };
  /** A required key counts as present when this returns true (e.g. a renamed equivalent). */
  satisfiedBy?: (env: NodeJS.ProcessEnv) => boolean;
}

export interface DepSpec {
  name: string;
  check: (env: NodeJS.ProcessEnv) => boolean;
  installHint: string;
}

export interface ModuleSpec {
  id: string;
  title: string;
  /** One plain-English sentence for a non-technical person. */
  description: string;
  defaultEnabled: boolean;
  alwaysOn?: boolean;
  groups?: string[];
  tools?: string[];
  start?: string[];
  daemons?: string[];
  launchd?: string[];
  env: EnvSpec[];
  deps: DepSpec[];
  setupChecks?: (env: NodeJS.ProcessEnv) => SetupCheck[];
  /** Counts as chosen when its settings are already present. */
  autoEnable?: (env: NodeJS.ProcessEnv) => boolean;
}

const HOME = homedir();
const has = (env: NodeJS.ProcessEnv, key: string) => Boolean(env[key]?.trim());
const bin = (env: NodeJS.ProcessEnv, key: string, fallback: string) => env[key]?.trim() || fallback;
const whisperModel = (env: NodeJS.ProcessEnv) =>
  bin(env, 'WHISPER_MODEL', join(HOME, '.cache/whisper/ggml-small.en.bin'));

function ollamaReachable(env: NodeJS.ProcessEnv): boolean {
  const base = (env.LOCAL_LLM_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!base) return false;
  try {
    execFileSync('/usr/bin/curl', ['-sf', '--max-time', '3', `${base}/api/version`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Shared env blocks -----------------------------------------------------------

/** A model key for whichever provider was chosen (Claude or OpenAI). */
const modelKeySet = (env: NodeJS.ProcessEnv): boolean => {
  const choice = (env.LLM_PROVIDER || '').trim().toLowerCase();
  if (choice === 'claude' || choice === 'anthropic') return Boolean(env.ANTHROPIC_API_KEY?.trim());
  if (choice === 'openai') return Boolean(env.OPENAI_API_KEY?.trim());
  return Boolean(env.OPENAI_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim());
};

const OPENAI_ENV: EnvSpec[] = [
  { key: 'LLM_PROVIDER', example: 'claude', description: 'Which AI runs the assistant: claude or openai. Blank = whichever key is set (OpenAI if both).' },
  { key: 'ANTHROPIC_API_KEY', required: true, satisfiedBy: modelKeySet, secret: true, description: 'Your Claude API key (console.anthropic.com > API keys), if you chose Claude. A Claude subscription does not cover this; it is billed separately.' },
  { key: 'CLAUDE_MODEL', example: 'claude-opus-5', description: 'Main Claude model. claude-sonnet-5 costs less.' },
  { key: 'CLAUDE_FAST_MODEL', example: 'claude-haiku-4-5', description: 'Quick Claude model for sorting, lookups and web search.' },
  { key: 'ANTHROPIC_TIMEOUT_MS', example: '120000', description: 'How long one Claude call may take, in milliseconds.' },
  { key: 'ANTHROPIC_MAX_RETRIES', example: '3', description: 'Retries per Claude call on rate limits and network errors.' },
  { key: 'OPENAI_API_KEY', required: true, satisfiedBy: modelKeySet, secret: true, description: 'Your OpenAI API key (platform.openai.com > API keys), if you chose OpenAI. Also needed for phone calls either way.' },
  { key: 'OPENAI_MODEL', example: 'gpt-5.6-terra', description: 'Main model that writes replies.' },
  { key: 'OPENAI_ROUTER_MODEL', example: 'gpt-5.6-luna', description: 'Small, cheap model for quick sorting decisions.' },
  { key: 'OPENAI_RETRIEVAL_MODEL', description: 'Model that decides what to look up in memory. Defaults to OPENAI_ROUTER_MODEL.' },
  { key: 'OPENAI_SEARCH_MODEL', description: 'Model used for web search. Defaults to OPENAI_ROUTER_MODEL.' },
  { key: 'OPENAI_BASE_URL', description: 'Only for an OpenAI-compatible proxy. Leave blank.' },
  { key: 'OPENAI_TIMEOUT_MS', example: '120000', description: 'How long one model call may take, in milliseconds.' },
  { key: 'OPENAI_MAX_ATTEMPTS', example: '4', description: 'Retries per model call on rate limits and network errors.' },
];

const BUDGET_ENV: EnvSpec[] = [
  { key: 'LLM_DAILY_CAP_USD', example: '8', description: 'Daily model spend cap in dollars. Replies are never refused; background work pauses.' },
  { key: 'LLM_WEEKLY_CAP_USD', example: '40', description: 'Weekly model spend cap in dollars.' },
  { key: 'LLM_AMBIENT_DAILY_CAP_USD', example: '4', description: 'Daily cap for background work only.' },
  { key: 'LLM_FALLBACK_DAILY_CAP_USD', example: '1', description: 'Tighter background cap while the local model is down.' },
  { key: 'LLM_BUDGET_ENFORCED', example: 'true', description: 'false = log budget breaches but keep going.' },
  {
    key: 'LLM_PRICES_JSON',
    description: 'Per-model prices, USD per 1M tokens. Keep the outer single quotes. Unknown models are priced high on purpose, so check these against the provider pricing page.',
    example: `'{"gpt-5.6-terra":{"input":2.0,"cachedInput":0.2,"output":12.0},"gpt-5.6-luna":{"input":0.2,"cachedInput":0.02,"output":1.2},"gpt-5.6-sol":{"input":5.0,"cachedInput":0.5,"output":30.0}}'`,
  },
];

// Probes shared by the core module's setup checks ------------------------------

export const CHAT_DB_PATH = join(HOME, 'Library', 'Messages', 'chat.db');

function probeChatDb(): SetupCheck {
  const fix = 'Open System Settings > Privacy & Security > Full Disk Access and turn on Terminal (and node, for the background service).';
  if (!existsSync(CHAT_DB_PATH)) {
    return { name: 'messages database', status: 'fail', detail: `${CHAT_DB_PATH} not found (or hidden without Full Disk Access)`, fix: `Sign in to Messages on this Mac, then: ${fix}` };
  }
  try {
    execFileSync('/usr/bin/sqlite3', ['-readonly', CHAT_DB_PATH, 'SELECT 1 FROM message LIMIT 1;'], { stdio: 'pipe', timeout: 5000 });
    return { name: 'messages database', status: 'ok', detail: 'chat.db is readable (Full Disk Access granted)' };
  } catch {
    return { name: 'messages database', status: 'fail', detail: 'chat.db exists but cannot be read — Full Disk Access is missing', fix };
  }
}

function probeMessagesAutomation(): SetupCheck {
  try {
    execFileSync('/usr/bin/osascript', ['-e', 'tell application "Messages" to get name'], { stdio: 'pipe', timeout: 8000 });
    return { name: 'messages automation', status: 'ok', detail: 'allowed to control Messages' };
  } catch (err) {
    const timedOut = (err as { code?: string; signal?: string }).signal === 'SIGTERM';
    return {
      name: 'messages automation',
      status: 'fail',
      detail: timedOut ? 'timed out waiting for permission to control Messages' : 'not allowed to control Messages',
      fix: 'Open System Settings > Privacy & Security > Automation and allow Terminal (and node) to control Messages.',
    };
  }
}

function ownerHandleSet(env: NodeJS.ProcessEnv): boolean {
  const owner = getProfileConfig().owner;
  return has(env, owner.phoneEnv || 'USER_OWNER') || has(env, owner.emailEnv || 'USER_OWNER_EMAIL');
}

function ownerHandleCheck(env: NodeJS.ProcessEnv): SetupCheck {
  const owner = getProfileConfig().owner;
  const phoneKey = owner.phoneEnv || 'USER_OWNER';
  const emailKey = owner.emailEnv || 'USER_OWNER_EMAIL';
  if (has(env, phoneKey) || has(env, emailKey)) {
    return { name: 'owner handle', status: 'ok', detail: `${has(env, phoneKey) ? phoneKey : emailKey} is set` };
  }
  return {
    name: 'owner handle',
    status: 'fail',
    detail: `neither ${phoneKey} nor ${emailKey} is set, so nobody is allowed to text the assistant`,
    fix: `Put your iMessage phone number in .env as ${phoneKey}=+15551234567 (or run npm run onboard).`,
  };
}

function adminChatCheck(env: NodeJS.ProcessEnv): SetupCheck {
  const owner = getProfileConfig().owner;
  const group = env.GROUP_ADMIN?.trim();
  const dm = env.DM_RECIPIENT?.trim() || env[owner.phoneEnv || 'USER_OWNER']?.trim();
  if (!group && !dm) {
    return { name: 'admin chat', status: 'fail', detail: 'nowhere to send your private messages', fix: 'Set USER_OWNER (your phone number) in .env; the assistant will text you directly.' };
  }
  if (!group) return { name: 'admin chat', status: 'ok', detail: 'private messages go to your own number' };
  try {
    const out = execFileSync('/usr/bin/sqlite3', ['-readonly', CHAT_DB_PATH,
      `SELECT COUNT(*) FROM chat WHERE chat_identifier = '${group.replace(/'/g, "''")}' OR guid = '${group.replace(/'/g, "''")}';`,
    ], { stdio: 'pipe', timeout: 5000 }).toString().trim();
    return out !== '0'
      ? { name: 'admin chat', status: 'ok', detail: 'GROUP_ADMIN matches a chat in Messages' }
      : { name: 'admin chat', status: 'warn', detail: 'GROUP_ADMIN does not match any chat in Messages', fix: 'Start the assistant, send a message in the chat you want, and copy the chat ID it logs into GROUP_ADMIN.' };
  } catch {
    return { name: 'admin chat', status: 'warn', detail: 'could not look up GROUP_ADMIN (Messages database unreadable)', fix: 'Fix the "messages database" check first.' };
  }
}

// The module list ---------------------------------------------------------------

export const MODULES: ModuleSpec[] = [
  {
    id: 'core',
    title: 'Core chat',
    description: 'Text the assistant over iMessage and it texts you back, can search the web, and keeps a household notes file.',
    defaultEnabled: true,
    alwaysOn: true,
    groups: ['admin', 'home', 'health'],
    tools: ['web', 'household'],
    launchd: ['agent', 'backup'],
    env: [
      ...OPENAI_ENV,
      { key: 'USER_OWNER', required: true, satisfiedBy: ownerHandleSet, description: 'Your own iMessage phone number, with country code (+15551234567). Only listed people can talk to the assistant.' },
      { key: 'USER_OWNER_EMAIL', description: 'Your iMessage email address, if you text from one.' },
      { key: 'ASSISTANT_TIMEZONE', example: 'America/Chicago', description: 'Your timezone, if different from this Mac\'s. Usually set by the setup interview.' },
      { key: 'DIALZERO_DENYLIST', description: 'Maintainers only: path to a private list of words that must never be committed (npm run check:portable).' },
      { key: 'TRIGGER_WORD', example: '@assistant', description: 'Word that wakes the assistant in group chats. DMs never need it.' },
      { key: 'GROUP_ADMIN', description: 'Optional chat ID for a private group with the assistant. Blank = it texts your number directly.' },
      { key: 'GROUP_HOME', description: 'Optional chat ID for a household group chat.' },
      { key: 'GROUP_HEALTH', description: 'Optional chat ID for a health-tracking chat.' },
      { key: 'DM_RECIPIENT', description: 'Where scheduled messages go when no group is set. Defaults to USER_OWNER.' },
      { key: 'ASSISTANT_DEFAULT_RECIPIENT', description: 'Legacy alias for DM_RECIPIENT.' },
      { key: 'ASSISTANT_DB_PATH', description: 'Where the SQLite database lives. Default: assistant.db in this folder.' },
      { key: 'ASSISTANT_PROFILE_PATH', description: 'Where the profile lives. Default: config/profile.json.' },
      { key: 'ASSISTANT_CONTEXT_ROOT', description: 'Where the context/ prompt files live. Default: context/ in this folder.' },
      { key: 'ASSISTANT_ROUTER_TIMEOUT_MS', description: 'Time limit for the quick "reply now or work in background" decision.' },
      { key: 'ASSISTANT_SMART_RETRIEVAL', example: 'true', description: 'false = simpler keyword memory lookups.' },
      { key: 'ASSISTANT_RETRIEVAL_TIMEOUT_MS', example: '2000', description: 'Time limit for deciding what to look up in memory.' },
      { key: 'IMESSAGE_APPLESCRIPT_TIMEOUT_MS', description: 'Time limit for sending one iMessage.' },
      { key: 'IMESSAGE_RECOVERY_WINDOW_MIN', description: 'After a restart, how far back to catch up on missed messages.' },
      { key: 'SIPS_BIN', description: 'Path to macOS sips (converts iPhone photos). Default /usr/bin/sips.' },
      { key: 'INSTACART_API_KEY', secret: true, description: 'Optional Instacart connector key used by mcp-servers.json.' },
      { key: 'AUTOMATIONS_ON', description: 'While paused (npm run pause), comma list of background parts that still run, e.g. family-scheduler.' },
      { key: 'MODULES_ON', description: 'Comma list of module ids to force on (overrides config/profile.json).' },
      { key: 'MODULES_OFF', description: 'Comma list of module ids to force off (overrides config/profile.json).' },
      { key: 'LAUNCHD_LABEL_PREFIX', example: 'dev.dialzero', description: 'Prefix for the background service names.' },
      ...BUDGET_ENV,
    ],
    deps: [],
    setupChecks: (env) => [probeChatDb(), probeMessagesAutomation(), ownerHandleCheck(env), adminChatCheck(env)],
  },
  {
    id: 'memory',
    title: 'Memory',
    description: 'Remembers facts, people and past conversations, and quietly picks up promises and deadlines from your texts.',
    defaultEnabled: true,
    tools: ['memory', 'people', 'relationships', 'messages', 'recall'],
    daemons: ['imessage-daemon'],
    launchd: ['imessage-daemon', 'contacts-sync'],
    env: [
      { key: 'IMESSAGE_DAEMON_INTERVAL_MS', example: '600000', description: 'How often texts are read for facts, in milliseconds.' },
      { key: 'IMESSAGE_EXTRACT_BATCH', example: '100', description: 'Messages read per pass.' },
      { key: 'IMESSAGE_EXTRACT_MODE', example: 'write', description: 'write = save what it learns; shadow = drafts for review only (needs the local model).' },
      { key: 'IMESSAGE_EXTRACT_NOT_BEFORE', description: 'Ignore messages before this ISO date. Required in shadow mode.' },
      { key: 'IMESSAGE_HISTORY_ENABLED', example: 'false', description: 'Also mine old message history (needs the local model).' },
      { key: 'IMESSAGE_HISTORY_BEFORE', description: 'ISO date; history mining reads messages before it.' },
      { key: 'IMESSAGE_HISTORY_BATCH', example: '75', description: 'Old messages read per pass.' },
      { key: 'IMESSAGE_HISTORY_INTERVAL_MS', example: '600000', description: 'How often history mining runs.' },
      { key: 'IMESSAGE_HISTORY_MAX_OBSERVATIONS', example: '12', description: 'Most facts saved per history pass.' },
    ],
    deps: [],
    setupChecks: (env) => {
      const mode = (env.IMESSAGE_EXTRACT_MODE || 'write').trim().toLowerCase();
      if (mode === 'shadow' && !has(env, 'IMESSAGE_EXTRACT_NOT_BEFORE')) {
        return [{ name: 'message reading mode', status: 'fail', detail: 'shadow mode needs a start date', fix: 'Set IMESSAGE_EXTRACT_NOT_BEFORE to today, e.g. 2026-01-01T00:00:00.000Z, or set IMESSAGE_EXTRACT_MODE=write.' }];
      }
      return [{ name: 'message reading mode', status: 'ok', detail: mode }];
    },
  },
  {
    id: 'calendar',
    title: 'Calendar and tasks',
    description: 'Reads and adds Google Calendar events and keeps a to-do list that shows up in Google Tasks on your phone.',
    defaultEnabled: true,
    tools: ['calendar', 'tasks'],
    env: [
      { key: 'GOOGLE_CALENDAR_CLIENT_ID', required: true, description: 'Google OAuth client ID (Google Cloud console > Credentials, type Desktop app).' },
      { key: 'GOOGLE_CALENDAR_CLIENT_SECRET', required: true, secret: true, description: 'Google OAuth client secret.' },
      { key: 'GOOGLE_CALENDAR_REFRESH_TOKEN', required: true, secret: true, description: 'Written by npm run auth:google.' },
      { key: 'HOME_AUTO_ATTENDEE', description: 'Email invited to events created from the household chat. Blank = nobody.' },
    ],
    deps: [],
    setupChecks: (env) => [has(env, 'GOOGLE_CALENDAR_REFRESH_TOKEN')
      ? { name: 'google sign-in', status: 'ok', detail: 'refresh token present' }
      : { name: 'google sign-in', status: 'fail', detail: 'not signed in to Google yet', fix: 'Run npm run auth:google and follow the browser prompt.' }],
  },
  {
    id: 'email',
    title: 'Email',
    description: 'Reads, searches, archives and drafts your email (Gmail, or the Spark app) and tracks which emails still need a reply.',
    defaultEnabled: true,
    tools: ['email', 'spark', 'email-reconciliation'],
    start: ['email-reconciliation'],
    env: [
      { key: 'EMAIL_SOURCE', example: 'gmail', description: 'gmail (default when Google is connected), spark, or none.' },
      { key: 'SPARK_BIN', example: '/usr/local/bin/spark', description: 'Path to the Spark command-line tool (only if EMAIL_SOURCE=spark).' },
      { key: 'EMAIL_RECONCILIATION_ENABLED', example: 'true', featureSwitch: { defaultOn: true }, description: 'true (default) = every 15 minutes, check tracked emails for replies and RSVPs (read-only).' },
      { key: 'EMAIL_RECONCILIATION_INTERVAL_MS', example: '900000', description: 'How often tracked emails are rechecked.' },
      { key: 'EMAIL_RECONCILIATION_BATCH', example: '25', description: 'Tracked emails checked per pass.' },
    ],
    deps: [{ name: 'email connection', check: (env) => (env.EMAIL_SOURCE === 'spark' ? existsSync(bin(env, 'SPARK_BIN', '/usr/local/bin/spark')) : env.EMAIL_SOURCE !== 'none' && has(env, 'GOOGLE_CALENDAR_REFRESH_TOKEN')), installHint: 'Connect Google (npm run auth:google) for Gmail, or set EMAIL_SOURCE=spark and turn on the Spark app\'s command-line tool.' }],
  },
  {
    id: 'email-watcher',
    title: 'Email watcher',
    description: 'Watches new email for deliveries, bills and failed payments and adds them to your calendar and to-dos.',
    defaultEnabled: false,
    daemons: ['inbox-signal-daemon'],
    launchd: ['inbox-signal-daemon'],
    env: [
      { key: 'INBOX_SIGNAL_ENABLED', example: 'true', featureSwitch: { defaultOn: false }, description: 'Must be true for the watcher to act.' },
      { key: 'INBOX_SIGNAL_INTERVAL_MS', example: '900000', description: 'How often new email is checked.' },
      { key: 'INBOX_SIGNAL_BATCH', example: '50', description: 'Emails read per pass.' },
      { key: 'INBOX_SIGNAL_WINDOW', example: '2d', description: 'How far back each pass looks.' },
    ],
    deps: [{ name: 'email connection', check: (env) => (env.EMAIL_SOURCE === 'spark' ? existsSync(bin(env, 'SPARK_BIN', '/usr/local/bin/spark')) : env.EMAIL_SOURCE !== 'none' && has(env, 'GOOGLE_CALENDAR_REFRESH_TOKEN')), installHint: 'Connect Google (npm run auth:google) for Gmail, or set EMAIL_SOURCE=spark and turn on the Spark app\'s command-line tool.' }],
  },
  {
    id: 'checkins',
    title: 'Daily check-ins',
    description: 'Sends one short morning and one evening message with what needs you, plus urgent heads-ups like "time to leave".',
    defaultEnabled: false,
    start: ['scheduler', 'checkins', 'heartbeat'],
    env: [
      { key: 'COS_CHECKIN_MORNING_CRON', example: '30 8 * * *', description: 'When the morning check-in goes out (cron, your local time).' },
      { key: 'COS_CHECKIN_EVENING_CRON', example: '0 18 * * *', description: 'When the evening check-in goes out.' },
      { key: 'COS_ARBITER_MODE', example: 'enforce', description: 'enforce = hold back non-urgent texts; observe = log but send everything.' },
      { key: 'COS_DAILY_INTERRUPT_BUDGET', example: '3', description: 'Most unprompted texts per day.' },
      { key: 'COS_INTERRUPT_BUDGET_OVERDRAFT', example: '2', description: 'Extra texts allowed for truly time-critical things.' },
      { key: 'HEARTBEAT_BACKOFF_HOURS', example: '24,48,96,168', description: 'Growing gaps between reminders about the same task.' },
      { key: 'HEARTBEAT_RETIRE_AFTER', example: '4', description: 'Reminders before a task becomes a "keep or drop it?" question.' },
      { key: 'HEARTBEAT_RESURFACE_HOURS', description: 'Old setting, no longer used.' },
    ],
    deps: [],
  },
  {
    id: 'nudges',
    title: 'Proactive nudges',
    description: 'Occasionally reminds you of promises you made, people you have not talked to lately, and ideas it could help with, and tidies its own memory weekly.',
    defaultEnabled: false,
    start: ['brain-pulse', 'relationship-pulse', 'idea-pulse', 'hygiene'],
    env: [
      { key: 'PULSE_RESURFACE_HOURS', example: '18', description: 'Minimum hours before the same reminder repeats.' },
      { key: 'IDEA_PULSE_ENABLED', example: 'false', featureSwitch: { defaultOn: false }, description: 'true = afternoon "here is how I could help" ideas.' },
      { key: 'RELATIONSHIP_PULSE_ENABLED', example: 'false', featureSwitch: { defaultOn: false }, description: 'true = weekly "you have not talked to these people lately".' },
      { key: 'RELATIONSHIP_PULSE_CRON', example: '15 11 * * 5', description: 'When the people reminder goes out.' },
      { key: 'RELATIONSHIP_PULSE_MAX', example: '5', description: 'Most people per reminder.' },
      { key: 'HYGIENE_ENABLED', example: 'false', featureSwitch: { defaultOn: false }, description: 'true = Monday memory cleanup (merges duplicates, drops expired facts).' },
      { key: 'HYGIENE_CONFIDENCE_THRESHOLD', example: '0.4', description: 'Cleanup: facts below this confidence are candidates to drop.' },
      { key: 'HYGIENE_DEMOTE_MIN_AGE_DAYS', example: '30', description: 'Cleanup: minimum age before a fact is demoted.' },
      { key: 'HYGIENE_STALE_COMMITMENT_DAYS', example: '90', description: 'Cleanup: promises older than this are closed.' },
      { key: 'HYGIENE_MIN_SURFACE_BEFORE_EXPIRE', example: '3', description: 'Cleanup: times a fact is shown before it may expire.' },
      { key: 'MEMORY_AUDIT_ENABLED', example: 'false', description: 'true = during cleanup, also merge facts that mean the same thing.' },
      { key: 'MEMORY_AUDIT_MIN_ROWS_PER_SUBJECT', example: '3', description: 'Audit only subjects with at least this many facts.' },
      { key: 'MEMORY_AUDIT_MAX_SUBJECTS_PER_RUN', example: '10', description: 'Most subjects audited per week.' },
      { key: 'MEMORY_AUDIT_MODEL', description: 'Model for the audit. Defaults to OPENAI_MODEL.' },
    ],
    deps: [],
  },
  {
    id: 'journal',
    title: 'Journal',
    description: 'Asks you a few reflection questions each morning and evening and saves your answers to Notion.',
    defaultEnabled: false,
    start: ['journal'],
    env: [
      { key: 'JOURNAL_ENABLED', example: 'true', featureSwitch: { defaultOn: false }, description: 'Must be true for journal prompts to go out.' },
      { key: 'JOURNAL_MORNING_CRON', example: '45 7 * * *', description: 'When the morning questions start.' },
      { key: 'JOURNAL_EVENING_CRON', example: '30 20 * * *', description: 'When the evening questions start.' },
      { key: 'JOURNAL_SESSION_EXPIRY_H', example: '4', description: 'Hours before an unanswered session is dropped.' },
      { key: 'NOTION_TOKEN', required: true, secret: true, description: 'Notion integration secret (notion.so/profile/integrations).' },
      { key: 'NOTION_JOURNAL_DB', required: true, description: 'ID of the Notion database that holds one page per day.' },
    ],
    deps: [],
  },
  {
    id: 'meetings',
    title: 'Meeting prep',
    description: 'Before meetings with outside people it sends you a short brief, and afterwards asks how it went.',
    defaultEnabled: false,
    daemons: ['meeting-daemon'],
    launchd: ['meeting-daemon'],
    env: [
      { key: 'INTERNAL_DOMAINS', example: 'gmail.com', description: 'Comma list of email domains that count as "your own people"; others get a brief.' },
    ],
    deps: [],
  },
  {
    id: 'actions',
    title: 'Actions with approval',
    description: 'Lets the assistant text or email people for you, but only after you reply "go" to approve each one.',
    defaultEnabled: true,
    tools: ['actions', 'followup-tools'],
    start: ['followups'],
    env: [
      { key: 'ACTIONS_ENABLED', example: 'true', featureSwitch: { defaultOn: true }, description: 'false = the assistant cannot propose or carry out any action.' },
      { key: 'ACTIONS_DAILY_CAP_USD', example: '100', description: 'Most real money actions may spend per day.' },
      { key: 'ACTIONS_WEEKLY_CAP_USD', example: '400', description: 'Most real money actions may spend per week.' },
    ],
    deps: [],
  },
  {
    id: 'phone',
    title: 'Phone calls',
    description: 'Gives the assistant a phone number so you can call it, it can call businesses for you, and it can wake you up with a call.',
    defaultEnabled: false,
    tools: ['errands'],
    start: ['phone', 'errands', 'wakeup'],
    env: [
      { key: 'PHONE_PUBLIC_URL', required: true, description: 'Public https address that reaches this Mac (e.g. from tailscale funnel).' },
      { key: 'TWILIO_ACCOUNT_SID', required: true, description: 'Twilio account ID.' },
      { key: 'TWILIO_AUTH_TOKEN', required: true, secret: true, description: 'Twilio auth token.' },
      { key: 'TWILIO_NUMBER', required: true, description: 'The Twilio phone number the assistant uses.' },
      { key: 'OPENAI_API_KEY', required: true, secret: true, description: 'OpenAI API key. Phone calls use OpenAI\'s voice model even if Claude runs the assistant.' },
      { key: 'OPENAI_PROJECT_ID', required: true, description: 'OpenAI project that receives the calls.' },
      { key: 'OPENAI_WEBHOOK_SECRET', required: true, secret: true, description: 'Secret of the OpenAI webhook pointed at <PHONE_PUBLIC_URL>/openai/webhook.' },
      { key: 'OPENAI_REALTIME_MODEL', example: 'gpt-realtime', description: 'Voice model for calls.' },
      { key: 'PHONE_TRANSCRIBE_MODEL', description: 'Model that transcribes calls.' },
      { key: 'PHONE_VOICE', example: 'marin', description: 'Voice the assistant speaks with.' },
      { key: 'PHONE_HOST', description: 'Address the call server listens on. Default 127.0.0.1.' },
      { key: 'PHONE_PORT', example: '4011', description: 'Port the call server listens on.' },
      { key: 'PHONE_REQUIRE_VERIFIED_CALLER', example: 'true', description: 'Only accept your calls when the carrier verifies caller ID.' },
      { key: 'PHONE_OWNER_NUMBERS', description: 'Extra numbers of yours, comma separated.' },
      { key: 'PHONE_CALLBACK_NUMBER', description: 'Number left in voicemails. Blank = none.' },
      { key: 'PHONE_MAX_CALL_MIN', example: '15', description: 'Longest call, in minutes.' },
      { key: 'PHONE_TOOL_TIMEOUT_MS', description: 'How long a call waits for an answer before saying it will text you.' },
      { key: 'PHONE_RING_ON_CRITICAL', example: 'false', description: 'true = ring your phone for time-critical alerts (never at night).' },
      { key: 'PHONE_RING_DAILY_CAP', example: '3', description: 'Most alert calls per day.' },
      { key: 'ERRANDS_ENABLED', example: 'true', featureSwitch: { defaultOn: true }, description: 'false = no calls to businesses for you.' },
      { key: 'ERRAND_CALL_START', example: '9', description: 'Earliest hour to call businesses.' },
      { key: 'ERRAND_CALL_END', example: '18', description: 'Latest hour to call businesses.' },
      { key: 'ERRAND_RETRY_GAP_MIN', example: '120', description: 'Minutes between retries of the same number.' },
      { key: 'ERRAND_DAILY_CALL_CAP', example: '10', description: 'Most errand calls per day.' },
      { key: 'WAKEUP_CALLS_ENABLED', example: 'true', featureSwitch: { defaultOn: true }, description: 'false = no wake-up calls.' },
      { key: 'WAKEUP_MAX_ATTEMPTS', example: '7', description: 'Wake-up call tries before giving up and texting.' },
      { key: 'WAKEUP_RETRY_MIN', example: '3', description: 'Minutes between wake-up tries.' },
      { key: 'WAKEUP_GRACE_MIN', example: '60', description: 'Minutes late a wake-up call may still go out after a restart.' },
      { key: 'WAKEUP_MAX_CALL_MIN', example: '5', description: 'Longest wake-up call, in minutes.' },
    ],
    deps: [],
  },
  {
    id: 'browser',
    title: 'Web browsing, booking and website jobs',
    description: 'Lets the assistant use Chrome on this Mac to read pages, book appointments, cancel subscriptions, export your data and change account settings. It never pays without your approval.',
    defaultEnabled: false,
    tools: ['browser', 'web-booking', 'booking-browser'],
    start: ['browser-bridge', 'web-task', 'chrome-health'],
    launchd: ['chrome'],
    env: [
      { key: 'BROWSER_BRIDGE_TOKEN', secret: true, description: 'Shared secret the Chrome extension must send. Strongly recommended.' },
      { key: 'BROWSER_EXTENSION_ID', description: 'Only accept this Chrome extension ID.' },
      { key: 'BROWSER_BRIDGE_HOST', example: '127.0.0.1', description: 'Address the extension connects to.' },
      { key: 'BROWSER_BRIDGE_PORT', example: '9222', description: 'Port the extension connects to.' },
      { key: 'BOOKING_TIMEOUT_MS', description: 'Time limit for one online booking.' },
      { key: 'WEB_TASK_TIMEOUT_MS', example: '1800000', description: 'Time limit for one browser run of a website job (it keeps going run after run).' },
      { key: 'WEB_TASK_MAX_RUNS', example: '20', description: 'Browser runs a website job may take before it gives up and texts you.' },
      { key: 'DOWNLOADS_DIR', description: 'Where Chrome saves downloads, so website jobs can confirm an export landed. Default ~/Downloads.' },
      { key: 'WEB_TASK_RETRY_GAP_MS', example: '180000', description: 'Wait after a run that did not work, before trying another way.' },
      { key: 'ACTIONS_REORDER_DRY_RUN', example: 'false', description: 'true = stop before the final "place order" click (practice mode).' },
      { key: 'BROWSER_UPLOAD_ROOTS', description: 'Comma list of folders the browser may upload files from. Blank = uploads off.' },
    ],
    deps: [{ name: 'Google Chrome', check: () => existsSync('/Applications/Google Chrome.app'), installHint: 'Install Google Chrome, then load the extension in browser-extension/ (see browser-extension/SETUP.md).' }],
  },
  {
    id: 'desktop',
    title: 'Desktop control',
    description: 'Lets the assistant see this Mac\'s screen and, after you approve, click and type for you.',
    defaultEnabled: false,
    tools: ['computer-use'],
    env: [
      { key: 'CLICLICK_BIN', example: '/opt/homebrew/bin/cliclick', description: 'Path to cliclick (clicks and typing).' },
      { key: 'COMPUTER_USE_SCREENSHOT_PX', example: '1280', description: 'Screenshot size the model sees.' },
      { key: 'COMPUTER_USE_GATE_ALL', example: 'false', description: 'true = even opening apps needs your approval.' },
      { key: 'COMPUTER_USE_TASK_WINDOW_MS', description: 'How long one desktop task may run.' },
      { key: 'SCREENCAPTURE_BIN', description: 'Path to macOS screencapture.' },
      { key: 'OPEN_BIN', description: 'Path to macOS open.' },
      { key: 'SYSTEM_PROFILER_BIN', description: 'Path to macOS system_profiler.' },
    ],
    deps: [{ name: 'cliclick', check: (env) => existsSync(bin(env, 'CLICLICK_BIN', '/opt/homebrew/bin/cliclick')), installHint: 'Run brew install cliclick, then allow node in System Settings > Privacy & Security > Accessibility and Screen Recording.' }],
  },
  {
    id: 'voice-notes',
    title: 'Voice notes',
    description: 'Understands voice memos you send over iMessage by transcribing them on this Mac.',
    defaultEnabled: false,
    env: [
      { key: 'WHISPER_BIN', example: '/opt/homebrew/bin/whisper-cli', description: 'Path to whisper-cli.' },
      { key: 'FFMPEG_BIN', example: '/opt/homebrew/bin/ffmpeg', description: 'Path to ffmpeg.' },
      { key: 'WHISPER_MODEL', description: 'Path to the speech model file. Default ~/.cache/whisper/ggml-small.en.bin.' },
    ],
    deps: [
      { name: 'whisper-cli', check: (env) => existsSync(bin(env, 'WHISPER_BIN', '/opt/homebrew/bin/whisper-cli')), installHint: 'Run brew install whisper-cpp.' },
      { name: 'ffmpeg', check: (env) => existsSync(bin(env, 'FFMPEG_BIN', '/opt/homebrew/bin/ffmpeg')), installHint: 'Run brew install ffmpeg.' },
      { name: 'whisper model', check: (env) => existsSync(whisperModel(env)), installHint: 'Download ggml-small.en.bin from huggingface.co/ggerganov/whisper.cpp into ~/.cache/whisper/.' },
    ],
    autoEnable: (env) => existsSync(bin(env, 'WHISPER_BIN', '/opt/homebrew/bin/whisper-cli'))
      && existsSync(bin(env, 'FFMPEG_BIN', '/opt/homebrew/bin/ffmpeg'))
      && existsSync(whisperModel(env)),
  },
  {
    id: 'siri',
    title: 'Ask from Siri',
    description: 'Lets you ask the assistant by voice from an iPhone Shortcut and hear the answer.',
    defaultEnabled: false,
    start: ['voice'],
    env: [
      { key: 'VOICE_TOKEN', required: true, secret: true, description: 'Password the Shortcut sends. Make it long and random.' },
      { key: 'VOICE_PORT', example: '4010', description: 'Port the Shortcut endpoint listens on.' },
      { key: 'VOICE_HOSTS', description: 'Addresses to listen on, comma separated. Default 127.0.0.1.' },
      { key: 'VOICE_SYNC_TIMEOUT_MS', example: '25000', description: 'Slower answers arrive by text instead.' },
    ],
    deps: [],
  },
  {
    id: 'family',
    title: 'Family chat',
    description: 'Joins one family group chat to keep a shared calendar and lists, without ever seeing your private stuff.',
    defaultEnabled: false,
    groups: ['family'],
    tools: ['family-calendar', 'family-lists', 'family-memory', 'family-web'],
    start: ['family-scheduler'],
    env: [
      { key: 'GROUP_FAMILY', required: true, description: 'Chat ID of a new group with only you, your family and the assistant.' },
      { key: 'FAMILY_CALENDAR_ID', required: true, description: 'Written by npm run family:configure. Never "primary".' },
      { key: 'FAMILY_CALENDAR_ACCOUNT', required: true, description: 'Google account that owns the Family calendar.' },
      { key: 'USER_PARTNER', description: 'Your partner\'s iMessage phone number.' },
      { key: 'USER_PARTNER_EMAIL', description: 'Your partner\'s iMessage email.' },
      { key: 'FAMILY_WEATHER_LOCATION', description: 'Town for the daily weather line.' },
      { key: 'FAMILY_DAILY_CRON', example: '"0 7 * * *"', description: 'When the daily family update goes out.' },
      { key: 'FAMILY_WEEKLY_CRON', example: '"30 19 * * 0"', description: 'When the weekly family update goes out.' },
      { key: 'FAMILY_MESSAGE_SETTLE_MS', description: 'Wait for a burst of family texts to finish before answering.' },
      { key: 'FAMILY_INBOX_MAX_AGE_HOURS', description: 'Family texts older than this are not answered after downtime.' },
    ],
    deps: [],
  },
  {
    id: 'builder',
    title: 'Builder extras',
    description: 'For programmers: lets the assistant work in your code folders, check GitHub, search LinkedIn and read Notion.',
    defaultEnabled: false,
    groups: ['work'],
    tools: ['codex', 'github', 'linkedin', 'notion'],
    env: [
      { key: 'GROUP_WORK', description: 'Optional chat ID for a work group chat.' },
      { key: 'CODEX_BIN', example: '/opt/homebrew/bin/codex', description: 'Path to the Codex command-line tool.' },
      { key: 'CODEX_MODEL', example: 'gpt-5.6-terra', description: 'Model Codex uses.' },
      { key: 'CODEX_SANDBOX', example: 'workspace-write', description: 'What Codex may touch. Keep workspace-write.' },
      { key: 'ASSISTANT_GH_ROOT', description: 'Folder your code folders live in. Default ~/Documents/GitHub.' },
      { key: 'ASSISTANT_ALLOWED_REPOS', description: 'Comma list of code folders the assistant may use.' },
      { key: 'ASSISTANT_DRAFTS_ROOT', description: 'Where drafts are saved. Default ~/assistant-drafts.' },
      { key: 'NOTION_OTHER_BRAIN_DB', description: 'Optional Notion database where "save this to Notion" captures go.' },
      { key: 'NOTION_TOKEN', secret: true, description: 'Notion integration secret (notion.so/profile/integrations).' },
      { key: 'NOTION_APPROVE_DB', description: 'Optional Notion database for approvals.' },
      { key: 'NOTION_PIPELINES_DB', description: 'Optional Notion database for pipelines.' },
    ],
    deps: [{ name: 'codex', check: (env) => existsSync(bin(env, 'CODEX_BIN', '/opt/homebrew/bin/codex')), installHint: 'Run brew install codex (or npm i -g @openai/codex) and set CODEX_BIN to its path.' }],
  },
  {
    id: 'local-model',
    title: 'Local model',
    description: 'Runs background reading of your messages on a free model on this Mac (Ollama) instead of paying OpenAI.',
    defaultEnabled: false,
    env: [
      { key: 'LOCAL_LLM_BASE_URL', required: true, example: 'http://127.0.0.1:11434', description: 'Address of Ollama.' },
      { key: 'LOCAL_LLM_MODEL', required: true, example: 'qwen3:8b', description: 'Model name in Ollama (ollama pull <name>).' },
      { key: 'LOCAL_LLM_KEEP_ALIVE', example: '30m', description: 'How long Ollama keeps the model loaded.' },
      { key: 'LOCAL_LLM_TIMEOUT_MS', example: '120000', description: 'Time limit per local call.' },
      { key: 'LOCAL_LLM_NUM_CTX', example: '16384', description: 'How much text the model reads at once.' },
      { key: 'LOCAL_LLM_PREFILTER', example: 'false', description: 'true = also run the quick sorting step locally.' },
      { key: 'LOCAL_LLM_BREAKER_THRESHOLD', example: '3', description: 'Failures in a row before the local model is skipped for a while.' },
      { key: 'LOCAL_LLM_BREAKER_COOLDOWN_MIN', example: '15', description: 'Minutes to skip it after that.' },
      { key: 'SYSCTL_BIN', description: 'Path to sysctl, used by npm run model:fit.' },
    ],
    deps: [{ name: 'ollama', check: ollamaReachable, installHint: 'Run brew install ollama && brew services start ollama && ollama pull qwen3:8b.' }],
    autoEnable: (env) => has(env, 'LOCAL_LLM_BASE_URL') && has(env, 'LOCAL_LLM_MODEL'),
  },
  {
    id: 'dashboard',
    title: 'Dashboard',
    description: 'A private web page on this Mac showing what the assistant knows and is tracking.',
    defaultEnabled: true,
    start: ['dashboard'],
    env: [
      { key: 'ASSISTANT_DASH_PORT', example: '4000', description: 'Port for http://127.0.0.1:<port>.' },
    ],
    deps: [],
  },
];

// Selection ---------------------------------------------------------------------

export type ModuleSource = 'always' | 'env-off' | 'env-on' | 'profile' | 'profile-groups' | 'configured' | 'default';

export interface ModuleState {
  id: string;
  title: string;
  on: boolean;
  source: ModuleSource;
}

export interface SelectionInput {
  env?: NodeJS.ProcessEnv;
  profile?: { modules?: Record<string, boolean>; groupsEnabled?: string[] };
  modules?: ModuleSpec[];
}

function envList(raw: string | undefined): string[] {
  return (raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function resolveModule(spec: ModuleSpec, input: SelectionInput = {}): ModuleState {
  const env = input.env ?? process.env;
  const profile = input.profile ?? getProfileConfig();
  const base = { id: spec.id, title: spec.title };
  if (spec.alwaysOn) return { ...base, on: true, source: 'always' };
  const id = spec.id.toLowerCase();
  if (envList(env.MODULES_OFF).includes(id)) return { ...base, on: false, source: 'env-off' };
  if (envList(env.MODULES_ON).includes(id)) return { ...base, on: true, source: 'env-on' };
  const chosen = profile.modules?.[spec.id];
  if (typeof chosen === 'boolean') return { ...base, on: chosen, source: 'profile' };
  if (spec.groups?.some((g) => profile.groupsEnabled?.includes(g))) return { ...base, on: true, source: 'profile-groups' };
  if (spec.autoEnable?.(env)) return { ...base, on: true, source: 'configured' };
  return { ...base, on: spec.defaultEnabled, source: 'default' };
}

export function resolveModules(input: SelectionInput = {}): ModuleState[] {
  return (input.modules ?? MODULES).map((spec) => resolveModule(spec, input));
}

export function getModule(id: string, modules: ModuleSpec[] = MODULES): ModuleSpec | undefined {
  return modules.find((m) => m.id === id);
}

/** Is this module switched on? Unknown ids are off. */
export function isModuleOn(id: string, input: SelectionInput = {}): boolean {
  const spec = getModule(id, input.modules);
  return spec ? resolveModule(spec, input).on : false;
}

/** Module ids named in MODULES_ON/MODULES_OFF/profile.modules that do not exist. */
export function unknownModuleIds(input: SelectionInput = {}): string[] {
  const env = input.env ?? process.env;
  const profile = input.profile ?? getProfileConfig();
  const known = new Set((input.modules ?? MODULES).map((m) => m.id.toLowerCase()));
  const named = [...envList(env.MODULES_ON), ...envList(env.MODULES_OFF), ...Object.keys(profile.modules ?? {}).map((k) => k.toLowerCase())];
  return [...new Set(named.filter((id) => !known.has(id)))];
}

function ownerOf(kind: 'tools' | 'groups' | 'start' | 'daemons' | 'launchd', key: string, modules: ModuleSpec[]): ModuleSpec | undefined {
  return modules.find((m) => m[kind]?.includes(key));
}

/** Module that owns a start function / daemon / launchd template / group / tool key. */
export function moduleFor(kind: 'tools' | 'groups' | 'start' | 'daemons' | 'launchd', key: string, modules: ModuleSpec[] = MODULES): string | undefined {
  return ownerOf(kind, key, modules)?.id;
}

/**
 * Is the thing identified by (kind, key) switched on? Keys no module claims
 * (e.g. MCP servers from mcp-servers.json) are left alone and count as on.
 */
export function isOwnedOn(kind: 'tools' | 'groups' | 'start' | 'daemons' | 'launchd', key: string, input: SelectionInput = {}): boolean {
  const owner = ownerOf(kind, key, input.modules ?? MODULES);
  return owner ? resolveModule(owner, input).on : true;
}

/** Drop tool registry keys that belong to a switched-off module. */
export function enabledToolKeys(keys: readonly string[], input: SelectionInput = {}): string[] {
  return keys.filter((key) => isOwnedOn('tools', key, input));
}

/** launchd label prefix, e.g. dev.dialzero -> dev.dialzero.agent. */
export function launchdLabelPrefix(env: NodeJS.ProcessEnv = process.env): string {
  return env.LAUNCHD_LABEL_PREFIX?.trim() || 'dev.dialzero';
}

/** Evaluate an env feature switch the same way lib/env.ts parseBoolEnv does. */
export function featureSwitchOn(spec: EnvSpec, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[spec.key];
  if (raw === undefined || raw === '') return spec.featureSwitch?.defaultOn ?? true;
  return !['false', '0', 'no', 'off'].includes(raw.trim().toLowerCase());
}
