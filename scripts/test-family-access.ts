import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
// Type-only: erased at compile time, so it does NOT trigger family-scheduler's
// module side effects. The runtime import stays dynamic (see below) because the
// test env must be built before the module loads.
import type {
  FamilyCalendarRange,
  FamilyCoordinationQuery,
  FamilyListQuery,
} from '../src/family-scheduler.js';

type TestBody = () => void | Promise<void>;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPT_DIR, '..');
const tempRoot = mkdtempSync(join(tmpdir(), 'assistant-family-access-'));
const testDbPath = join(tempRoot, 'family-access.db');
const testProfilePath = join(tempRoot, 'config', 'profile.json');
const testContextRoot = join(tempRoot, 'context');

mkdirSync(dirname(testProfilePath), { recursive: true });
mkdirSync(join(testContextRoot, 'shared'), { recursive: true });
mkdirSync(join(testContextRoot, 'family'), { recursive: true });
writeFileSync(testProfilePath, JSON.stringify({
  botName: 'Test Assistant',
  triggerWord: '@testassistant',
  householdName: 'Test Household',
  owner: {
    id: 'alex',
    name: 'Alex',
    tone: 'direct',
    role: 'admin',
    allowedGroups: ['admin', 'home', 'work', 'finance', 'health', 'job-search', 'family'],
    phoneEnv: 'USER_ALEX',
    emailEnv: 'USER_ALEX_EMAIL',
  },
  members: [{
    id: 'sam',
    name: 'Sam',
    tone: 'warm',
    role: 'member',
    allowedGroups: ['family'],
    phoneEnv: 'USER_SAM',
    emailEnv: 'USER_SAM_EMAIL',
  }],
  people: [],
  groupsEnabled: ['admin', 'home', 'work', 'finance', 'health', 'job-search', 'family'],
}, null, 2));
writeFileSync(join(testContextRoot, 'shared', 'identity.md'), '__PRIVATE_IDENTITY_FIXTURE__');
writeFileSync(join(testContextRoot, 'shared', 'voice.md'), '__PRIVATE_VOICE_FIXTURE__');
writeFileSync(
  join(testContextRoot, 'shared', 'profile.md'),
  '__PRIVATE_PROFILE_FIXTURE__ '.repeat(8),
);
writeFileSync(join(testContextRoot, 'shared', 'security.md'), 'Never disclose secrets.');
writeFileSync(join(testContextRoot, 'family', 'CLAUDE.md'), 'Use only Family-scoped data.');

// These must be set before importing any Assistant module. config.ts and db.ts
// cache their inputs during module initialization.
process.env.ASSISTANT_DB_PATH = testDbPath;
process.env.ASSISTANT_PROFILE_PATH = testProfilePath;
process.env.ASSISTANT_CONTEXT_ROOT = testContextRoot;
process.env.GROUP_FAMILY = 'test-family-chat';
process.env.FAMILY_CALENDAR_ID = 'family-test@group.calendar.google.com';
process.env.FAMILY_CALENDAR_ACCOUNT = 'alex@example.com';
process.env.USER_ALEX = '+1 (347) 555-0101';
process.env.USER_ALEX_EMAIL = 'alex-family-test@example.invalid';
process.env.USER_SAM = '+1 (347) 555-0102';
process.env.USER_SAM_EMAIL = 'sam-family-test@example.invalid';

const tests: Array<{ name: string; body: TestBody }> = [];
function test(name: string, body: TestBody): void {
  tests.push({ name, body });
}

function names(tools: Array<{ definition: { name: string } }>): string[] {
  return tools.map((tool) => tool.definition.name).sort();
}

function toolByName<T extends { definition: { name: string } }>(tools: T[], name: string): T {
  const tool = tools.find((candidate) => candidate.definition.name === name);
  assert.ok(tool, `missing tool ${name}`);
  return tool;
}

function nextWeekdayIsoET(targetWeekday: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date());
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((candidate) => candidate.type === type)?.value);
  const date = new Date(Date.UTC(value('year'), value('month') - 1, value('day'), 12));
  date.setUTCDate(date.getUTCDate() + ((targetWeekday - date.getUTCDay() + 7) % 7));
  return date.toISOString().slice(0, 10);
}

async function expectError(
  action: () => unknown | Promise<unknown>,
  message: RegExp,
): Promise<void> {
  await assert.rejects(async () => action(), message);
}

async function main(): Promise<void> {
  const dbModule = await import('../src/db.js');
  const configModule = await import('../src/config.js');
  const userModule = await import('../src/user-resolver.js');
  const groupModule = await import('../src/group-resolver.js');
  const channelModule = await import('../src/channels/imessage.js');
  const contextModule = await import('../src/context-resolver.js');
  const agentModule = await import('../src/agent.js');
  const toolModule = await import('../src/tools/index.js');
  const calendarModule = await import('../src/tools/family-calendar.js');
  const listModule = await import('../src/tools/family-lists.js');
  const memoryModule = await import('../src/tools/family-memory.js');
  const observabilityModule = await import('../src/family-tool-observability.js');
  const manifestModule = await import('../src/family-turn-manifest.js');
  const schedulerModule = await import('../src/family-scheduler.js');
  const privateSchedulerModule = await import('../src/scheduler.js');
  const configureFamilyModule = await import('./configure-family.js');

  const familyContext = {
    groupKey: 'family',
    userId: 'alex',
    turnId: 'fixture-turn',
    currentMessage: 'Test Family request',
    chatId: process.env.GROUP_FAMILY,
    recipient: process.env.GROUP_FAMILY,
    sourceMessageKey: '0'.repeat(64),
    sourceMessageTimestamp: new Date().toISOString(),
    sourceMessageRowId: 1,
    sourceMessageGuid: 'test-family-message',
  };

  let grantSequence = 0;
  function grantedFamilyContext(
    toolName: string,
    toolInput: Record<string, unknown>,
    currentMessage: string,
    overrides: Partial<typeof familyContext> & {
      userId?: string;
      recentMessages?: Array<{ role: string; content: string; created_at: string; sender?: string; id?: number }>;
      kind?: 'new_action' | 'continuation' | 'correction' | 'destructive_request' | 'destructive_confirmation' | 'context_write';
      sourceBindings?: Array<{ source_ref: string; quote: string }>;
      nowMs?: number;
    } = {},
  ) {
    grantSequence += 1;
    const turnId = overrides.turnId || `family-test-grant-${grantSequence}`;
    const userId = overrides.userId || familyContext.userId;
    const recentRows = (overrides.recentMessages || []).map((message, index) => ({
      id: message.id ?? 800_000 + (grantSequence * 100) + index,
      group_id: 'family',
      sender: message.sender ?? (message.role === 'assistant' ? 'assistant' : userId),
      role: message.role,
      content: message.content,
      created_at: message.created_at,
    }));
    const sources = manifestModule.buildFamilyTurnSources({
      currentMessage,
      currentSenderId: userId,
      currentCreatedAt: overrides.sourceMessageTimestamp
        ?? new Date(overrides.nowMs ?? Date.now()).toISOString(),
      recentMessages: recentRows,
      nowMs: overrides.nowMs,
    });
    const kind = overrides.kind
      ?? (toolName === 'family_request_event_delete'
        ? 'destructive_request'
        : toolName === 'family_confirm_event_delete'
          ? 'destructive_confirmation'
          : 'new_action');
    const manifest = manifestModule.createFamilyTurnManifest({
      draft: {
        classification: 'action',
        actions: [{
          intent_id: `test_action_${grantSequence}`,
          tool_name: toolName,
          kind,
          arguments: toolInput,
          source_bindings: overrides.sourceBindings ?? [{ source_ref: 'current', quote: currentMessage }],
        }],
      },
      turnId,
      chatId: String(overrides.chatId ?? familyContext.chatId),
      requesterId: userId,
      sources,
      nowMs: overrides.nowMs,
    });
    const claimed = manifestModule.claimFamilyManifestAction({
      manifest,
      toolName,
      toolInput,
      currentMessage,
    });
    if ('error' in claimed) throw new Error(claimed.error);
    return {
      ...familyContext,
      ...overrides,
      userId,
      turnId,
      currentMessage,
      sourceMessageKey: overrides.sourceMessageKey
        ?? grantSequence.toString(16).padStart(64, '0'),
      sourceMessageTimestamp: overrides.sourceMessageTimestamp
        ?? new Date(overrides.nowMs ?? Date.now()).toISOString(),
      sourceMessageRowId: overrides.sourceMessageRowId ?? grantSequence,
      sourceMessageGuid: overrides.sourceMessageGuid
        ?? `test-family-message-${grantSequence}`,
      recentMessages: recentRows,
      familyTurnManifest: manifest,
      familyManifestAuthorization: claimed.authorization,
      reverifyFamilyAudience: async () => true,
    };
  }

  function grantedFamilyContextOrUntrusted(
    toolName: string,
    toolInput: Record<string, unknown>,
    currentMessage: string,
    overrides: Parameters<typeof grantedFamilyContext>[3] = {},
  ) {
    try {
      return grantedFamilyContext(toolName, toolInput, currentMessage, overrides);
    } catch {
      return { ...familyContext, ...overrides, currentMessage };
    }
  }

  test('Family chat bypasses @assistant; reactions, empty text, and emoji-only rows stay silent', () => {
    assert.equal(
      channelModule.isConfiguredFamilyChat('test-family-chat', { GROUP_FAMILY: 'test-family-chat' }),
      true,
    );
    assert.equal(
      channelModule.isConfiguredFamilyChat('some-other-chat', { GROUP_FAMILY: 'test-family-chat' }),
      false,
    );
    assert.equal(channelModule.isSubstantiveFamilyMessage('Dinner is at 6'), true);
    assert.equal(channelModule.isSubstantiveFamilyMessage('  '), false);
    assert.equal(channelModule.isSubstantiveFamilyMessage('❤️👍🏽'), false);
    assert.equal(channelModule.isSubstantiveFamilyMessage('', true), true);
    assert.equal(
      channelModule.stripOptionalFamilyMention('@testassistant add milk to Groceries', '@testassistant', 'Test Assistant'),
      'add milk to Groceries',
    );
    assert.equal(
      channelModule.stripOptionalFamilyMention('Test Assistant, schedule pickup', '@testassistant', 'Test Assistant'),
      'schedule pickup',
    );
    assert.equal(
      channelModule.stripOptionalFamilyMention('Dinner is at 6', '@testassistant', 'Test Assistant'),
      'Dinner is at 6',
    );

    const source = readFileSync(join(ROOT, 'src/channels/imessage.ts'), 'utf8');
    assert.match(source, /const reaction = \(msg\.associated_message_type \?\? 0\) !== 0/);
    assert.match(source, /dispatchable = !outgoing\s*&& !reaction/);
    assert.match(source, /if \(family\) \{\s*continue;\s*\}/);
    assert.match(source, /if\s*\(!dm\)/);
    assert.doesNotMatch(source, /if\s*\(family\)\s*\{[^}]*triggerFound/s);

    dbModule.logIMessage({
      rowid_src: 991_001,
      chat_id: 'test-family-chat',
      chat_name: 'Family',
      sender: '+13475550101',
      direction: 'in',
      text: 'Family-only context',
      ts: '2026-08-23T12:00:00.000Z',
      alreadyExtracted: true,
      privacyScope: 'family',
    });
    const extracted = dbModule.default.prepare(
      'SELECT extracted_at FROM imessage_log WHERE rowid_src = ?',
    ).get(991_001) as { extracted_at: string | null };
    assert.ok(extracted.extracted_at, 'Family row could be reprocessed by the global extraction daemon');
    assert.equal(
      dbModule.getUnextractedIMessages(100).some((row) => row.rowid_src === 991_001),
      false,
      'Family insert was observable to the global extraction daemon',
    );
    assert.match(source, /alreadyExtracted:\s*family/);
    assert.doesNotMatch(source, /markIMessageExtractedBySourceRowId/);

    dbModule.logIMessage({
      rowid_src: 991_002,
      chat_id: 'test-family-chat',
      chat_name: 'Family',
      sender: '+13475550102',
      direction: 'in',
      text: 'Discovery message logged before mapping',
      ts: '2026-08-23T12:01:00.000Z',
    });
    assert.equal(
      dbModule.getUnextractedIMessages(100).some((row) => row.rowid_src === 991_002),
      true,
    );
    assert.equal(dbModule.quarantineIMessageChat('test-family-chat'), 1);
    assert.equal(
      dbModule.getUnextractedIMessages(100).some((row) => row.rowid_src === 991_002),
      false,
      'pre-mapping Family backlog remained eligible for global extraction',
    );
    // Production initializes the authenticated profile map before iMessage
    // polling; mirror that startup ordering for Family-only handle checks.
    userModule.initUsers();
    assert.equal(channelModule.shouldQuarantineIMessageFromGlobalExtraction({
      chatId: '+13475550102',
      senderHandle: '+13475550102',
      isFromMe: false,
    }), true, 'a Family-only user DM could enter global extraction');
    assert.equal(channelModule.isFamilyScopedIMessage({
      chatId: '+13475550102',
      senderHandle: '+13475550102',
      isFromMe: false,
    }), true, 'a Family-only user DM did not receive a durable private scope');
    assert.equal(channelModule.shouldQuarantineIMessageFromGlobalExtraction({
      chatId: 'unrelated-group',
      senderHandle: '+13475550101',
      isFromMe: false,
      participantHandles: ['+13475550101', '+13475550102'],
    }), true, 'another participant\'s row in a Family-only user\'s group could enter global extraction');
    assert.equal(channelModule.shouldQuarantineIMessageFromGlobalExtraction({
      chatId: 'unrelated-group',
      senderHandle: '',
      isFromMe: true,
      participantHandles: ['+13475550102'],
    }), true, 'an outgoing row visible to a Family-only user could enter global extraction');
    assert.equal(channelModule.shouldQuarantineIMessageFromGlobalExtraction({
      chatId: 'unrelated-group',
      senderHandle: '',
      isFromMe: true,
      participantLookupFailed: true,
    }), true, 'an unprovable outgoing group row failed open');
    assert.match(source, /privacyScope:\s*familyPrivate\s*\?\s*'family'/);

    dbModule.logIMessage({
      rowid_src: 991_003,
      chat_id: 'test-family-chat',
      chat_name: 'Family',
      sender: '+13475550102',
      direction: 'in',
      text: '__IMESSAGE_SEARCH_SCOPE__ FAMILY_SECRET',
      ts: '2026-08-23T12:02:00.000Z',
      alreadyExtracted: true,
      privacyScope: 'family',
    });
    dbModule.logIMessage({
      rowid_src: 991_004,
      chat_id: 'ordinary-private-chat',
      chat_name: 'Ordinary chat',
      sender: '+13475550103',
      direction: 'in',
      text: '__IMESSAGE_SEARCH_SCOPE__ NON_FAMILY_ALLOWED',
      ts: '2026-08-23T12:03:00.000Z',
      alreadyExtracted: true,
    });
    const originalFamilyChat = process.env.GROUP_FAMILY;
    delete process.env.GROUP_FAMILY;
    const globalSearchHits = dbModule.searchIMessages({
      query: '__IMESSAGE_SEARCH_SCOPE__',
      limit: 10,
    });
    process.env.GROUP_FAMILY = originalFamilyChat;
    assert.equal(
      globalSearchHits.some((row) => row.text?.includes('FAMILY_SECRET')),
      false,
      'Family raw iMessage entered global message search/retrieval',
    );
    assert.equal(
      globalSearchHits.some((row) => row.text?.includes('NON_FAMILY_ALLOWED')),
      true,
      'non-Family control row was incorrectly hidden from global search',
    );

    const indexSource = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
    const syncSelection = "const mode = isFamily ? 'sync' : await detectMode(text);";
    assert.ok(indexSource.includes(syncSelection), 'Family messages are not deterministically forced onto the synchronous path');
    assert.ok(
      indexSource.indexOf(syncSelection) < indexSource.indexOf('const taskId = createAsyncTask('),
      'Family sync selection does not precede the generic async task write',
    );
  });

  test('Context-only Family messages cannot invoke outside-state mutation tools', () => {
    // A legacy/custom list named Task must never steal the reserved Task: cue.
    dbModule.createFamilyList('Task', 'test-fixture');
    assert.equal(agentModule.canRunFamilyTool('remember_family_context', 'Jordan likes strawberries'), true);
    assert.equal(agentModule.canRunFamilyTool('family_list_events', 'What is on the Family calendar?'), true);
    assert.equal(agentModule.canRunFamilyTool('add_family_item', 'Jordan likes strawberries'), false);
    assert.equal(agentModule.canRunFamilyTool('family_create_event', 'Maybe we should meet Friday'), false);
    assert.equal(agentModule.canRunFamilyTool('mcp_instacart_create_shopping_list', 'We often make tacos'), false);
    assert.equal(agentModule.canRunFamilyTool('mcp_spotify_play', 'The kids like Bluey songs'), false);
    const nextThursday = nextWeekdayIsoET(4);
    const nextFriday = nextWeekdayIsoET(5);
    assert.equal(agentModule.canRunFamilyTool(
      'add_family_item',
      'Please add milk to Groceries',
      { list: 'Groceries', text: 'milk' },
    ), true);
    for (const [message, input] of [
      ['Apply to Lincoln school', { list: 'Family Tasks', text: 'Apply to Lincoln school' }],
      ['Add call pediatrician', { list: 'Family Tasks', text: 'call pediatrician' }],
      ['We need to call the plumber', { list: 'Family Tasks', text: 'call the plumber' }],
      ['We have to upload the forms', { list: 'Family Tasks', text: 'upload the forms' }],
      ['Task: Review the Lincoln application', { list: 'Family Tasks', text: 'Review the Lincoln application' }],
      ['To do: Follow up with Lincoln', { list: 'Family Tasks', text: 'Follow up with Lincoln' }],
      ['Remember to print the forms', { list: 'Family Tasks', text: 'print the forms' }],
      ['Remind us to RSVP for the open house', { list: 'Family Tasks', text: 'RSVP for the open house' }],
      ["Don't let us forget to talk to admissions", { list: 'Family Tasks', text: 'talk to admissions' }],
      ['Please review the application', { list: 'Family Tasks', text: 'review the application' }],
      ['Can you follow up with Lincoln?', { list: 'Family Tasks', text: 'follow up with Lincoln' }],
      ['Add call the plumber Friday', { list: 'Family Tasks', text: 'call the plumber Friday' }],
      ['Book the dentist by Friday', { list: 'Family Tasks', text: 'Book the dentist by Friday' }],
      ['Buy milk', { list: 'Groceries', text: 'Buy milk' }],
      ['We need milk', { list: 'Groceries', text: 'milk' }],
      ['Pick up dry cleaning', { list: 'Errands', text: 'Pick up dry cleaning' }],
      ['Groceries: milk', { list: 'Groceries', text: 'milk' }],
      ['Errands: return library books', { list: 'Errands', text: 'return library books' }],
      ['Family Tasks: call pediatrician', { list: 'Family Tasks', text: 'call pediatrician' }],
      ['Can you add milk to Groceries?', { list: 'Groceries', text: 'milk' }],
      ['Add cancel Spotify subscription to Family Tasks', { list: 'Family Tasks', text: 'cancel Spotify subscription' }],
      [
        'Groceries: Milk, quantity: 2 gallons, notes: Whole milk, due: 2026-08-24, assign to: me',
        {
          list: 'Groceries',
          text: 'Milk',
          quantity: '2 gallons',
          notes: 'Whole milk',
          due_date: '2026-08-24',
          assignee: 'me',
        },
      ],
      ['Family Tasks: Call Lincoln, due: Friday', { list: 'Family Tasks', text: 'Call Lincoln', due_date: nextFriday }],
      ['Add milk to Groceries by Thursday', { list: 'Groceries', text: 'milk', due_date: nextThursday }],
      // A bare imperative names no list, so any live list is a legitimate
      // choice. These same three messages also appear above bound to the other
      // list: both bindings are accepted on purpose. Routing used to be decided
      // by a hardcoded household vocabulary, which refused every word it had
      // not been taught and even refused "Buy milk" filed under Family Tasks.
      // A misfiled item is one tap to move; a refusal loses the request.
      ['Apply to Lincoln school', { list: 'Errands', text: 'Apply to Lincoln school' }],
      ['Buy milk', { list: 'Family Tasks', text: 'Buy milk' }],
      ['Pick up dry cleaning', { list: 'Family Tasks', text: 'Pick up dry cleaning' }],
      ['Add pumpkin spice to the list', { list: 'Groceries', text: 'pumpkin spice' }],
      ['Add bananas to the list', { list: 'Groceries', text: 'bananas' }],
      // One message, several items: each row binds its own contiguous span.
      ['Add milk, eggs and bread to the list', { list: 'Groceries', text: 'milk' }],
      ['Add milk, eggs and bread to the list', { list: 'Groceries', text: 'eggs' }],
      ['Add milk, eggs and bread to the list', { list: 'Groceries', text: 'bread' }],
      ['Add pumpkin spice, pumpkin puree, and whipped cream to Groceries', { list: 'Groceries', text: 'pumpkin puree' }],
      // A run of adjacent items still binds, so an item that contains a
      // boundary word survives sitting next to other items.
      ['add mac and cheese and bananas to groceries', { list: 'Groceries', text: 'mac and cheese' }],
      // A header plus one item per line — how a shopping list actually arrives.
      ['Add to groceries:\nmilk\neggs\nbread', { list: 'Groceries', text: 'eggs' }],
      ['Groceries:\nmilk\neggs', { list: 'Groceries', text: 'milk' }],
      ['Add milk\neggs\nbread to the list', { list: 'Groceries', text: 'bread' }],
      // An item that is also a list name is an item, not a routing cue.
      ['Pick up groceries', { list: 'Errands', text: 'Pick up groceries' }],
      // Inflected verbs, possessive determiners, singular list names.
      ['Picking up milk', { list: 'Family Tasks', text: 'Picking up milk' }],
      ['Grabbed the forms', { list: 'Family Tasks', text: 'Grabbed the forms' }],
      ['Add milk to our grocery list', { list: 'Groceries', text: 'milk' }],
      ['Add stamps to the errand list', { list: 'Errands', text: 'stamps' }],
      // Politeness, incidental hedging, attribution, quoted names and urgency
      // are not reasons to refuse a plainly-worded request.
      ['add sunscreen when you get a chance', { list: 'Groceries', text: 'sunscreen' }],
      ['add batteries, might need them for the smoke alarm', { list: 'Groceries', text: 'batteries' }],
      ['add the vitamins sam texted about', { list: 'Groceries', text: 'the vitamins sam texted about' }],
      ['add "everything" bagels', { list: 'Groceries', text: '"everything" bagels' }],
      ['add the school forms, it is urgent', { list: 'Family Tasks', text: 'the school forms' }],
    ] as const) {
      assert.equal(
        agentModule.canRunFamilyTool('add_family_item', message, input),
        true,
        `natural Family input was blocked: ${message}`,
      );
    }
    for (const [message, input] of [
      ['Apply to Lincoln school', { list: 'Family Tasks', text: 'Apply to Lincoln school tomorrow' }],
      ['Groceries: milk', { list: 'Family Tasks', text: 'milk' }],
      ['Add milk to Groceries', { list: 'Errands', text: 'milk' }],
      ['Add milk to Groceries', { list: 'Groceries', text: 'milk and eggs' }],
      ['Add it as a family task', { list: 'Family Tasks', text: 'it as a family task' }],
      ['Milk', { list: 'Family Tasks', text: 'Milk' }],
      ['Lincoln school applications close soon', { list: 'Family Tasks', text: 'Lincoln school applications close soon' }],
      ['Maybe apply to Lincoln school', { list: 'Family Tasks', text: 'apply to Lincoln school' }],
      ['Apply to Lincoln school if we decide to', { list: 'Family Tasks', text: 'Apply to Lincoln school' }],
      ['Sam said “Apply to Lincoln school”', { list: 'Family Tasks', text: 'Apply to Lincoln school' }],
      ['Apply to Lincoln school in my personal tasks', { list: 'Family Tasks', text: 'Apply to Lincoln school' }],
      ['Apply to Lincoln school on the Family calendar', { list: 'Family Tasks', text: 'Apply to Lincoln school' }],
      ['Buy milk in the Instacart cart', { list: 'Family Tasks', text: 'Buy milk' }],
      ['Play the Lincoln playlist', { list: 'Family Tasks', text: 'Play the Lincoln playlist' }],
      ['Packing: socks', { list: 'Family Tasks', text: 'socks' }],
      ['Book dentist Friday at 2pm', { list: 'Family Tasks', text: 'Book dentist Friday at 2pm' }],
      ['Schedule Lincoln tour Friday at 2pm', { list: 'Family Tasks', text: 'Schedule Lincoln tour Friday at 2pm' }],
      ['Add milk to Groceries or Errands', { list: 'Family Tasks', text: 'milk to Groceries or Errands' }],
      ['Add milk to Groceries and bread to Errands', { list: 'Errands', text: 'milk to Groceries and bread' }],
      ['Call the plumber and add milk to Groceries', { list: 'Groceries', text: 'Call the plumber and add milk' }],
      ['Pick up Jordan and buy stamps in Errands', { list: 'Errands', text: 'Pick up Jordan and buy stamps' }],
      ['Call the plumber & add milk to Groceries', { list: 'Groceries', text: 'Call the plumber & add milk' }],
      ['Call the plumber. Add milk to Groceries', { list: 'Groceries', text: 'Call the plumber. Add milk' }],
      ['Groceries: Milk', { list: 'Groceries', text: 'Milk', quantity: '2 gallons' }],
      ['Groceries: Milk', { list: 'Groceries', text: 'Milk', notes: 'Whole milk' }],
      ['Groceries: Milk', { list: 'Groceries', text: 'Milk', due_date: '2026-08-24' }],
      ['Groceries: Milk', { list: 'Groceries', text: 'Milk', assignee: 'me' }],
      ['Task: Call the pediatrician', { list: 'Task', text: 'Call the pediatrician' }],
      ['Apply to Lincoln school is one idea we discussed', { list: 'Family Tasks', text: 'Apply to Lincoln school is one idea we discussed' }],
      ['Call the plumber is an option', { list: 'Family Tasks', text: 'Call the plumber is an option' }],
      // Splitting an enumeration must not become a licence to author text. Each
      // row still has to reproduce a contiguous span of the sender's own words.
      ['Add milk, eggs and bread to the list', { list: 'Groceries', text: 'vodka' }],
      ['Add milk, eggs and bread to the list', { list: 'Groceries', text: 'milk and beer' }],
      // Non-adjacent items are not a span: the sender never wrote them together.
      ['Add milk, eggs and bread to the list', { list: 'Groceries', text: 'milk and bread' }],
      // A live list is still required, and a vague span is still not an item.
      ['Add milk, eggs and bread to the list', { list: 'Pantry', text: 'milk' }],
      ['Add it and milk to Groceries', { list: 'Groceries', text: 'it' }],
    ] as const) {
      assert.equal(
        agentModule.canRunFamilyTool('add_family_item', message, input),
        false,
        `unsafe or mismatched Family input was accepted: ${message}`,
      );
    }
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'Book dentist Friday at 2pm',
      { title: 'Dentist', date: '2026-08-28', start_time: '14:00', end_time: '15:00' },
    ), true, 'calendar-shaped booking stopped routing exclusively to the Family calendar');
    assert.equal(agentModule.canRunFamilyTool(
      'add_family_item',
      'Task: Book dentist Friday at 2pm',
      { list: 'Family Tasks', text: 'Book dentist Friday at 2pm' },
    ), true, 'an explicit task cue did not override calendar-shaped wording');
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'Task: Book dentist Friday at 2pm',
      { title: 'Dentist', date: '2026-08-28', start_time: '14:00', end_time: '15:00' },
    ), false, 'an explicit task cue also authorized a calendar write');
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'Add call the plumber Friday',
      { title: 'Call the plumber', date: '2026-08-28', start_time: '09:00', end_time: '09:30' },
    ), false, 'a task with a weekday also authorized a calendar write');
    assert.equal(agentModule.canRunFamilyTool(
      'add_family_item',
      'Add chimney inspection Thursday between 12-2pm',
      { list: 'Family Tasks', text: 'chimney inspection Thursday between 12-2pm' },
    ), false, 'an event with a clock-time range also authorized a list write');
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'Set up Jordan playdate Thursday',
      { title: 'Jordan playdate', date: '2026-08-27', start_time: '09:00', end_time: '10:00' },
    ), true, 'a natural set-up request fell between the list and calendar routes');
    assert.equal(agentModule.canRunFamilyTool(
      'add_family_item',
      'Set up Jordan playdate Thursday',
      { list: 'Family Tasks', text: 'Set up Jordan playdate Thursday' },
    ), false, 'a natural playdate event also authorized a list write');
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'Schedule pickup Friday at 4',
      { title: 'Pickup', date: '2026-08-28', start_time: '16:00', end_time: '16:30' },
    ), true);
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'Add chimney inspection on Thursday between 12-2pm. Description: Chris from Right Chimney Repair.',
      { title: 'Chimney inspection', date: '2026-08-27', start_time: '12:00', end_time: '14:00' },
    ), true);
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'Add milk to Groceries on Thursday',
      { title: 'Milk', date: '2026-08-27', all_day: true },
    ), false);
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'Add Bluey to the Spotify playlist Friday',
      { title: 'Bluey', date: '2026-08-28', all_day: true },
    ), false);
    assert.equal(
      agentModule.canRunFamilyTool(
        'family_confirm_event_delete',
        'confirm delete SAFE1',
        { confirmation_code: 'SAFE1' },
      ),
      true,
    );
    assert.equal(
      agentModule.canRunFamilyTool(
        'family_confirm_event_delete',
        'confirm delete SAFE1',
        { confirmation_code: 'OTHER' },
      ),
      false,
    );
    assert.equal(agentModule.canRunFamilyTool('add_family_item', "Don't add milk yet"), false);
    assert.equal(agentModule.canRunFamilyTool(
      'add_family_item',
      'Add grocery pickup to the Family calendar Friday at 4',
      { list: 'Groceries', text: 'grocery pickup' },
    ), false);
    assert.equal(agentModule.canRunFamilyTool(
      'mcp_instacart_create_shopping_list',
      'Add Instacart delivery to the Family calendar Friday at 4',
    ), false);
    assert.equal(agentModule.canRunFamilyTool(
      'create_family_list',
      'Start a music list',
      { name: 'Music' },
    ), true);
    assert.equal(agentModule.canRunFamilyTool('mcp_spotify_play', 'Start a music list'), false);
    assert.equal(agentModule.canRunFamilyTool(
      'add_family_item',
      "Add milk to groceries was yesterday's example, not a request",
      { list: 'Groceries', text: 'milk' },
    ), false);
    assert.equal(agentModule.canRunFamilyTool('future_family_mutator', 'Please do it'), false);
    assert.equal(agentModule.canRunFamilyTool('constructor', 'Please do it'), false);
    assert.throws(
      () => grantedFamilyContext('constructor', {}, 'Please do it'),
      /not classified for Family access/i,
    );
    assert.equal(agentModule.canRunFamilyTool(
      'complete_family_item',
      'Please mark item #7 done',
      { item_id: 7 },
    ), true);
    assert.equal(agentModule.canRunFamilyTool(
      'complete_family_item',
      'Please mark groceries done',
      { item_id: 7 },
    ), false);
  });

  test('Only Alex and Sam resolve as approved Family participants', () => {
    const profile = configModule.getProfileConfig();
    assert.equal(profile.owner.id, 'alex');
    assert.ok(profile.owner.allowedGroups.includes('family'));
    const samProfile = profile.members.find((member) => member.id === 'sam');
    assert.ok(samProfile, 'Sam must be present in the private profile');
    assert.deepEqual(samProfile.allowedGroups, ['family']);
    assert.ok(profile.groupsEnabled.includes('family'));

    userModule.initUsers();
    const alex = userModule.resolveUser('+13475550101');
    const sam = userModule.resolveUser('sam-family-test@example.invalid');
    assert.equal(alex?.id, 'alex');
    assert.equal(sam?.id, 'sam');
    assert.equal(userModule.resolveUser('+13475550999'), null);
    assert.equal(
      userModule.resolveUser('+993475550101'),
      null,
      'an international number sharing the approved last ten digits authenticated',
    );
    assert.equal(userModule.normalizeAuthPhone('(347) 555-0101'), '+13475550101');
    assert.equal(userModule.isFamilyOnlyHandle('+13475550102'), true);
    assert.equal(userModule.isFamilyOnlyHandle('+13475550101'), false);

    const exact = userModule.validateGroupParticipants(
      ['+13475550101', 'sam-family-test@example.invalid'],
      ['alex', 'sam'],
    );
    assert.equal(exact.ok, true);
    assert.deepEqual(exact.actualUserIds, ['alex', 'sam']);

    const unknownAdded = userModule.validateGroupParticipants(
      ['+13475550101', '+13475550102', '+13475550999'],
      ['alex', 'sam'],
    );
    assert.equal(unknownAdded.ok, false);
    assert.equal(unknownAdded.unknownHandles.length, 1);

    const missingSam = userModule.validateGroupParticipants(
      ['+13475550101'],
      ['alex', 'sam'],
    );
    assert.equal(missingSam.ok, false);
    assert.deepEqual(missingSam.missingUserIds, ['sam']);

    assert.equal(userModule.isAllowed(sam!, 'family'), true);
    for (const privateGroup of ['admin', 'home', 'work', 'finance', 'health', 'job-search']) {
      assert.equal(userModule.isAllowed(sam!, privateGroup), false, `Sam reached ${privateGroup}`);
    }
  });

  test('Family group has a shared, smart-reply, least-privilege configuration', () => {
    groupModule.initGroups();
    const family = groupModule.getAllGroups().find((group) => group.key === 'family');
    assert.ok(family, 'GROUP_FAMILY must resolve to a Family group');
    assert.equal(family.audience, 'shared');
    assert.equal(family.replyPolicy, 'smart');
    assert.deepEqual([...(family.expectedUserIds ?? [])].sort(), ['alex', 'sam']);
    assert.deepEqual(family.tools, [
      'family-calendar',
      'family-lists',
      'family-memory',
      'family-web',
      'family-instacart',
      'family-spotify',
    ]);

    const forbiddenKeys = [
      'calendar', 'tasks', 'memory', 'people', 'messages', 'recall', 'spark', 'email',
      'finance', 'github', 'codex', 'browser', 'computer-use', 'actions',
      'household', 'career-os', 'work-request', 'instacart', 'spotify', 'web',
    ];
    for (const key of forbiddenKeys) {
      assert.equal(family.tools.includes(key), false, `Family group exposed registry key ${key}`);
    }

    const priorHealth = process.env.GROUP_HEALTH;
    process.env.GROUP_HEALTH = process.env.GROUP_FAMILY;
    groupModule.initGroups();
    assert.equal(
      groupModule.getAllGroups().some((candidate) => candidate.key === 'family' || candidate.key === 'health'),
      false,
      'a duplicate shared/private chat mapping did not fail closed',
    );
    if (priorHealth === undefined) delete process.env.GROUP_HEALTH;
    else process.env.GROUP_HEALTH = priorHealth;
    groupModule.initGroups();
  });

  test('Family callable tools are exact allowlists with no private or spending surface', async () => {
    assert.deepEqual(names(toolModule.toolRegistry['family-calendar']), [
      'family_confirm_event_delete',
      'family_create_event',
      'family_list_events',
      'family_request_event_delete',
      'family_update_event',
    ]);
    assert.deepEqual(names(toolModule.toolRegistry['family-lists']), [
      'add_family_item',
      'archive_family_item',
      'complete_family_item',
      'create_family_list',
      'edit_family_item',
      'list_family_items',
      'list_family_lists',
      'reopen_family_item',
      'restore_family_item',
    ]);
    assert.deepEqual(names(toolModule.toolRegistry['family-memory']), [
      'list_family_context',
      'list_family_coordination',
      'note_family_coordination',
      'recall_family_context',
      'remember_family_context',
      'resolve_family_coordination',
    ]);
    assert.deepEqual(names(toolModule.toolRegistry['family-web']), ['web_search']);

    const source = readFileSync(join(ROOT, 'src/tools/index.ts'), 'utf8');
    const allowlist = source.match(/const FAMILY_MCP_ALLOWLIST[\s\S]*?\n};/)?.[0] ?? '';
    assert.ok(allowlist, 'Family MCP allowlist must be explicit');
    for (const allowed of [
      'mcp_instacart_create_recipe',
      'mcp_instacart_create_shopping_list',
      'mcp_spotify_play',
      'mcp_spotify_search',
    ]) {
      assert.match(allowlist, new RegExp(`['\"]${allowed}['\"]`));
    }
    for (const forbidden of [
      'checkout', 'purchase', 'order', 'email', 'contact', 'message', 'finance',
      'github', 'codex', 'browser', 'desktop', 'task',
    ]) {
      assert.doesNotMatch(allowlist, new RegExp(forbidden, 'i'));
    }
    assert.doesNotMatch(allowlist, /get_playlists|get_current_track/i);
    assert.match(source, /serverName\.startsWith\('family-'\)/);

    const fakeCalls: string[] = [];
    const fakeTools = [
      'mcp_instacart_create_recipe',
      'mcp_instacart_create_shopping_list',
      'mcp_instacart_checkout',
    ].map((name) => ({
      definition: {
        name,
        description: name,
        input_schema: { type: 'object' as const, properties: {}, required: [] },
      },
      handler: async () => {
        fakeCalls.push(name);
        return name;
      },
    }));
    const safeAlias = toolModule.createFamilyMcpAliasTools('instacart', fakeTools);
    assert.deepEqual(names(safeAlias), [
      'mcp_instacart_create_recipe',
      'mcp_instacart_create_shopping_list',
    ]);
    await expectError(
      () => toolByName(safeAlias, 'mcp_instacart_create_recipe').handler({}, familyContext),
      /not authorized by the current source-bound request/i,
    );
    await toolByName(safeAlias, 'mcp_instacart_create_recipe').handler(
      {},
      grantedFamilyContext('mcp_instacart_create_recipe', {}, 'Create an Instacart recipe'),
    );
    assert.deepEqual(fakeCalls, ['mcp_instacart_create_recipe']);
    await expectError(
      () => toolByName(safeAlias, 'mcp_instacart_create_shopping_list').handler(
        {},
        { ...familyContext, chatId: 'forged-chat', recipient: 'forged-chat' },
      ),
      /approved user in the configured Family chat/i,
    );
    await expectError(
      () => toolByName(toolModule.toolRegistry['family-web'], 'web_search').handler(
        { query: 'private probe' },
        { ...familyContext, userId: 'unknown' },
      ),
      /approved user in the configured Family chat/i,
    );

    const rejected = toolModule.registerDiscoveredMcpTools({
      'family-web': fakeTools,
      calendar: fakeTools,
      constructor: fakeTools,
      EVIL: fakeTools,
    });
    assert.deepEqual([...rejected.rejected].sort(), ['EVIL', 'calendar', 'constructor', 'family-web']);
    assert.equal(toolModule.toolRegistry['family-web'].some((tool) => tool.definition.name === 'mcp_instacart_checkout'), false);
  });

  test('Family tool telemetry exposes decisions without message text, arguments, or identities', () => {
    const privateMessage = '__PRIVATE_FAMILY_MESSAGE_DONT_LOG__';
    const privateArguments = { title: '__PRIVATE_EVENT_TITLE_DONT_LOG__' };
    const privateError = '__PRIVATE_PROVIDER_ERROR_DONT_LOG__';
    const input = {
      decision: 'blocked',
      toolName: 'family_create_event',
      reasonCode: 'intent_not_authorized',
      userId: 'private-family-user',
      chatId: 'private-family-chat',
      turnId: 'private-family-turn',
      // Simulate an untyped caller accidentally attaching sensitive fields.
      // The record builder must use an explicit projection, never serialize
      // its input object wholesale.
      currentMessage: privateMessage,
      toolArguments: privateArguments,
      error: privateError,
    } as Parameters<typeof observabilityModule.createFamilyToolAuditRecord>[0];
    const record = observabilityModule.createFamilyToolAuditRecord(input);
    const serialized = JSON.stringify(record);

    assert.deepEqual(Object.keys(record).sort(), [
      'actor_ref', 'chat_ref', 'decision', 'event', 'reason_code', 'recorded_at', 'tool', 'turn_ref',
    ]);
    assert.equal(record.event, 'family_tool_decision');
    assert.ok(Number.isFinite(Date.parse(record.recorded_at)));
    assert.equal(record.decision, 'blocked');
    assert.equal(record.tool, 'family_create_event');
    assert.equal(record.reason_code, 'intent_not_authorized');
    assert.match(record.actor_ref ?? '', /^[a-f0-9]{16}$/);
    assert.match(record.chat_ref ?? '', /^[a-f0-9]{16}$/);
    assert.match(record.turn_ref ?? '', /^[a-f0-9]{16}$/);
    for (const privateValue of [
      privateMessage,
      privateArguments.title,
      privateError,
      'private-family-user',
      'private-family-chat',
      'private-family-turn',
    ]) {
      assert.equal(serialized.includes(privateValue), false, `Family telemetry leaked ${privateValue}`);
    }

    // Refs correlate retries only inside one process, and scope separation
    // keeps an identical raw value from producing the same actor/chat token.
    assert.equal(
      observabilityModule.createFamilyToolAuditRecord(input).turn_ref,
      record.turn_ref,
    );
    const sameRawDifferentScopes = observabilityModule.createFamilyToolAuditRecord({
      decision: 'attempted',
      toolName: 'family_create_event',
      reasonCode: 'model_requested',
      userId: 'same-value',
      chatId: 'same-value',
    });
    assert.notEqual(sameRawDifferentScopes.actor_ref, sameRawDifferentScopes.chat_ref);

    const invalidTool = observabilityModule.createFamilyToolAuditRecord({
      decision: 'blocked',
      toolName: `family_create_event ${privateMessage}`,
      reasonCode: 'tool_unavailable',
    });
    assert.equal(invalidTool.tool, 'invalid_tool_name');
    assert.equal(JSON.stringify(invalidTool).includes(privateMessage), false);

    const invalidEnums = observabilityModule.createFamilyToolAuditRecord({
      decision: privateMessage,
      toolName: 'family_create_event',
      reasonCode: privateError,
    } as unknown as Parameters<typeof observabilityModule.createFamilyToolAuditRecord>[0]);
    assert.equal(invalidEnums.decision, 'failed');
    assert.equal(invalidEnums.reason_code, 'unspecified');
    assert.equal(JSON.stringify(invalidEnums).includes(privateMessage), false);
    assert.equal(JSON.stringify(invalidEnums).includes(privateError), false);

    let emitted = '';
    const originalInfo = console.info;
    console.info = (...args: unknown[]) => { emitted += args.map(String).join(' '); };
    try {
      observabilityModule.logFamilyToolDecision(input);
    } finally {
      console.info = originalInfo;
    }
    assert.match(emitted, /^\[family-tool\] \{"event":"family_tool_decision","recorded_at":"/);
    assert.equal(emitted.includes(privateMessage), false);
    assert.equal(emitted.includes(privateArguments.title), false);
    assert.equal(emitted.includes(privateError), false);

    const agentSource = readFileSync(join(ROOT, 'src/agent.ts'), 'utf8');
    const manifestSource = readFileSync(join(ROOT, 'src/family-turn-manifest.ts'), 'utf8');
    const decisionSource = `${agentSource}\n${manifestSource}`;
    assert.match(agentSource, /import \{ logFamilyToolDecision \} from ['"]\.\/family-tool-observability\.js['"]/);
    assert.ok(
      (agentSource.match(/logFamilyToolDecision\s*\(/g) ?? []).length >= 6,
      'Family telemetry helper is not wired through the tool execution path',
    );
    for (const reasonCode of [
      'model_requested',
      'manifest_required',
      'manifest_action_mismatch',
      'audience_reverification_failed',
      'handler_completed',
      'handler_failed',
    ]) {
      assert.ok(
        decisionSource.includes(`'${reasonCode}'`),
        `Family tool telemetry is missing ${reasonCode}`,
      );
    }
  });

  test('Family prompt contains smart-silence policy and no owner task, fact, memory, profile, or voice data', () => {
    const privateTask = '__PRIVATE_OWNER_TASK_SENTINEL_8A347__';
    const privateMemory = '__PRIVATE_ADMIN_MEMORY_SENTINEL_19B6__';
    const privateFact = '__PRIVATE_GLOBAL_FACT_SENTINEL_27C1__';
    const familyMemory = '__FAMILY_MEMORY_SENTINEL_4D52__';

    dbModule.createTask({
      title: privateTask,
      group_id: 'admin',
      assignee: 'owner',
      sync_to_google: false,
    });
    dbModule.setMemory('admin', 'private_prompt_probe', privateMemory);
    dbModule.saveFact({
      subject: 'private-probe',
      predicate: 'contains',
      object: privateFact,
      group_id: 'admin',
      source: 'family-access-test',
    });
    dbModule.setMemory('family', 'school_pickup_routine', familyMemory);

    const familyGroup = {
      key: 'family',
      name: 'Family',
      tools: ['family-calendar', 'family-lists', 'family-memory', 'family-web'],
      contextPath: 'context/family',
      audience: 'shared' as const,
      replyPolicy: 'smart' as const,
      expectedUserIds: ['alex', 'sam'],
    };
    const alex = userModule.resolveUser('+13475550101');
    assert.ok(alex);
    const blocks = contextModule.loadSystemBlocks(
      familyGroup,
      alex,
      'We usually pick her up at 4.',
      '',
    );
    const prompt = `${blocks.staticPrefix}\n${blocks.dynamic}`;

    assert.match(prompt, /FAMILY_SILENT/);
    assert.match(prompt, /Reply when useful/i);
    assert.match(prompt, /Context-only messages may update Family memory only/i);
    assert.match(prompt, /Apply to Lincoln school/);
    assert.match(prompt, /require no confirmation, ID, list name, or rephrasing/i);
    assert.match(prompt, /Semantically route buying and household supplies to Groceries/i);
    assert.match(prompt, /pickups, drop-offs, and out-of-home actions to Errands/i);
    assert.match(prompt, /never use the private create_task tool/i);
    assert.match(prompt, new RegExp(familyMemory));
    assert.doesNotMatch(prompt, new RegExp(privateTask));
    assert.doesNotMatch(prompt, new RegExp(privateMemory));
    assert.doesNotMatch(prompt, new RegExp(privateFact));
    assert.doesNotMatch(prompt, /--- About Alex ---/);
    assert.doesNotMatch(prompt, /--- Voice ---/);
    assert.doesNotMatch(prompt, /Backlog:\s*\d+ open tasks/);

    const privateProfilePath = join(testContextRoot, 'shared/profile.md');
    const profileLines = readFileSync(privateProfilePath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length >= 100)
      .slice(0, 12);
    assert.ok(profileLines.length > 0, 'private profile probe needs at least one substantive line');
    for (const line of profileLines) {
      assert.equal(prompt.includes(line.slice(0, 90)), false, 'private profile material leaked');
    }

    const indexSource = readFileSync(join(ROOT, 'src/index.ts'), 'utf8');
    const agentSource = readFileSync(join(ROOT, 'src/agent.ts'), 'utf8');
    assert.match(indexSource, /isSilentFamilyResponse/);
    assert.match(indexSource, /if\s*\(!isSilentFamilyResponse\(group\.key, response\)\)/);
    assert.match(agentSource, /groupConfig\.key\s*===\s*'family'[\s\S]{0,120}FAMILY_SILENT_RESPONSE/);
  });

  test('Family conversation history never enters the global nightly reflection', () => {
    const familyHistory = '__FAMILY_REFLECTION_BLOCKED_7F91__';
    const adminHistory = '__ADMIN_REFLECTION_ALLOWED_3B20__';
    dbModule.saveMessage('family', 'alex', 'user', familyHistory);
    dbModule.saveMessage('admin', 'alex', 'user', adminHistory);
    const rows = dbModule.getMessagesSinceForGroups(
      '2000-01-01T00:00:00.000Z',
      privateSchedulerModule.PRIVATE_REFLECTION_GROUPS,
    );
    assert.equal(rows.some((row) => row.content === familyHistory), false);
    assert.equal(rows.some((row) => row.content === adminHistory), true);
    assert.equal(privateSchedulerModule.PRIVATE_REFLECTION_GROUPS.includes('family' as never), false);
    assert.equal(privateSchedulerModule.PRIVATE_REFLECTION_GROUPS.includes('home' as never), false);
  });

  test('Family memory is hard-bound to the family namespace', async () => {
    const remember = toolByName(memoryModule.familyMemoryTools, 'remember_family_context');
    const recall = toolByName(memoryModule.familyMemoryTools, 'recall_family_context');
    const list = toolByName(memoryModule.familyMemoryTools, 'list_family_context');
    const noteCoordination = toolByName(memoryModule.familyMemoryTools, 'note_family_coordination');
    const listCoordination = toolByName(memoryModule.familyMemoryTools, 'list_family_coordination');
    const resolveCoordination = toolByName(memoryModule.familyMemoryTools, 'resolve_family_coordination');

    const dinnerMemory = { key: 'Dinner Preference', value: 'Tacos on Tuesdays' };
    await expectError(
      () => remember.handler(dinnerMemory, familyContext),
      /not authorized by the current source-bound request/i,
    );
    assert.equal(dbModule.getMemory('family', 'dinner_preference'), undefined);
    await remember.handler(dinnerMemory, grantedFamilyContext(
      'remember_family_context', dinnerMemory, 'Remember that our Dinner Preference is Tacos on Tuesdays', {
        kind: 'context_write',
      },
    ));
    assert.equal(dbModule.getMemory('family', 'dinner_preference'), 'Tacos on Tuesdays');
    assert.equal(dbModule.getMemory('admin', 'dinner_preference'), undefined);
    assert.match(String(await recall.handler({ key: 'dinner_preference' }, familyContext)), /Tacos on Tuesdays/);

    for (const deniedContext of [
      { ...familyContext, userId: 'unknown' },
      { ...familyContext, chatId: 'wrong-chat', recipient: 'wrong-chat' },
      { ...familyContext, recipient: 'wrong-recipient' },
      { ...familyContext, userId: '' },
    ]) {
      await expectError(
        () => recall.handler({ key: 'dinner_preference' }, deniedContext),
        /authenticated participant in the configured Family group chat/i,
      );
    }

    dbModule.setMemory('family', 'delivery_daily_2099-01-01', 'internal reservation');
    const listed = String(await list.handler({ limit: 20 }, familyContext));
    assert.match(listed, /dinner_preference/);
    assert.doesNotMatch(listed, /delivery_daily/);
    assert.doesNotMatch(listed, /internal reservation/);

    // Reserved rows must be removed by SQL before LIMIT. Otherwise a burst of
    // delivery/security records can crowd every user-visible row out.
    dbModule.default.prepare(
      'INSERT OR REPLACE INTO memory (group_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
    ).run('family', 'crowdout_visible', 'still visible', '2099-01-01 00:00:00');
    const insertMemory = dbModule.default.prepare(
      'INSERT OR REPLACE INTO memory (group_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
    );
    for (let index = 0; index < 40; index += 1) {
      const prefix = index % 2 === 0 ? 'delivery_' : 'security_';
      insertMemory.run(
        'family',
        `${prefix}crowd_${index}`,
        `internal ${index}`,
        `2099-02-01 00:00:${String(index).padStart(2, '0')}`,
      );
    }
    const crowded = String(await list.handler({ limit: 1 }, familyContext));
    assert.match(crowded, /crowdout_visible: still visible/);
    assert.doesNotMatch(crowded, /delivery_|security_|internal \d/);

    for (const reservedKey of [
      'delivery_daily_manual',
      'security_membership_alert',
      'coordination_open_school_pickup',
    ]) {
      const reservedInput = { key: reservedKey, value: 'attempted overwrite' };
      await expectError(
        () => remember.handler(reservedInput, grantedFamilyContext(
          'remember_family_context', reservedInput, `Remember ${reservedKey}: attempted overwrite`, {
            kind: 'context_write',
          },
        )),
        /reserved prefix/i,
      );
      await expectError(
        () => recall.handler({ key: reservedKey }, familyContext),
        /reserved prefix/i,
      );
    }

    const coordinationInput = {
      topic: 'School Pickup',
      note: 'Decide who is picking up on Friday',
    };
    await noteCoordination.handler(coordinationInput, grantedFamilyContext(
      'note_family_coordination', coordinationInput,
      'Remember we need to decide who is picking up on Friday for School Pickup',
      { kind: 'context_write' },
    ));
    assert.equal(
      dbModule.getMemory('family', 'coordination_open_school_pickup'),
      'Decide who is picking up on Friday',
    );
    assert.equal(dbModule.getMemory('admin', 'coordination_open_school_pickup'), undefined);
    assert.match(String(await listCoordination.handler({}, familyContext)), /school_pickup/);
    const resolutionInput = { topic: 'School Pickup', resolution: 'Sam will pick up' };
    await resolveCoordination.handler(resolutionInput, grantedFamilyContext(
      'resolve_family_coordination', resolutionInput, 'School Pickup is resolved: Sam will pick up', {
        kind: 'context_write',
      },
    ));
    assert.equal(dbModule.getMemory('family', 'coordination_open_school_pickup'), undefined);
    assert.match(
      dbModule.getMemory('family', 'coordination_resolved_school_pickup') ?? '',
      /Sam will pick up/,
    );

    await expectError(
      () => remember.handler(
        { key: 'should_not_write', value: 'blocked' },
        { ...familyContext, groupKey: 'admin' },
      ),
      /only inside the verified Family group/i,
    );
    assert.equal(dbModule.getMemory('family', 'should_not_write'), undefined);
    assert.equal(dbModule.getMemory('admin', 'should_not_write'), undefined);
  });

  test('Legacy memory migration never promotes Family rows into global facts', () => {
    const migrationDbPath = join(tempRoot, 'family-migration.db');
    const migrationDb = new Database(migrationDbPath);
    migrationDb.exec(`
      CREATE TABLE memory (
        group_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (group_id, key)
      )
    `);
    const insert = migrationDb.prepare(
      'INSERT INTO memory (group_id, key, value, updated_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('family', 'dinner_preference', '__FAMILY_MIGRATION_BLOCKED__', '2026-01-01 00:00:00');
    insert.run('family', 'current_priorities', '__FAMILY_PRIORITY_BLOCKED__', '2026-01-01 00:00:01');
    insert.run('admin', 'coffee_preference', '__ADMIN_MIGRATION_ALLOWED__', '2026-01-01 00:00:02');
    migrationDb.close();

    const migration = spawnSync(
      join(ROOT, 'node_modules', '.bin', 'tsx'),
      [join(ROOT, 'scripts', 'migrate-memory-to-facts.ts')],
      {
        cwd: ROOT,
        env: { ...process.env, ASSISTANT_DB_PATH: migrationDbPath },
        encoding: 'utf8',
      },
    );
    assert.equal(
      migration.status,
      0,
      `migration process failed:\n${migration.stdout}\n${migration.stderr}`,
    );

    const migratedDb = new Database(migrationDbPath, { readonly: true });
    try {
      const familyFacts = migratedDb.prepare(
        "SELECT COUNT(*) AS count FROM facts WHERE group_id = 'family' OR object LIKE '__FAMILY_%'",
      ).get() as { count: number };
      const adminFacts = migratedDb.prepare(
        "SELECT COUNT(*) AS count FROM facts WHERE group_id = 'admin' AND object = '__ADMIN_MIGRATION_ALLOWED__'",
      ).get() as { count: number };
      const retainedFamilyMemory = migratedDb.prepare(
        "SELECT COUNT(*) AS count FROM memory WHERE group_id = 'family'",
      ).get() as { count: number };
      assert.equal(familyFacts.count, 0, 'Family memory escaped into facts');
      assert.equal(adminFacts.count, 1, 'control admin row did not migrate');
      assert.equal(retainedFamilyMemory.count, 2, 'Family rows were mutated instead of left isolated');
    } finally {
      migratedDb.close();
    }

    const migrationSource = readFileSync(join(ROOT, 'scripts/migrate-memory-to-facts.ts'), 'utf8');
    assert.match(migrationSource, /WHERE group_id <> \?/);
    assert.match(migrationSource, /if \(group_id === 'family'\)/);
  });

  test('Family list lifecycle is local, recoverable, and never mutates canonical tasks', async () => {
    const countTasks = () => (
      dbModule.default.prepare('SELECT COUNT(*) AS count FROM tasks').get() as { count: number }
    ).count;
    const taskCountBefore = countTasks();
    const seeded = dbModule.listFamilyLists().map((list) => list.name);
    assert.deepEqual(seeded.slice(0, 3), ['Family Tasks', 'Groceries', 'Errands']);

    const createList = toolByName(listModule.familyListTools, 'create_family_list');
    const add = toolByName(listModule.familyListTools, 'add_family_item');
    const edit = toolByName(listModule.familyListTools, 'edit_family_item');
    const complete = toolByName(listModule.familyListTools, 'complete_family_item');
    const reopen = toolByName(listModule.familyListTools, 'reopen_family_item');
    const archive = toolByName(listModule.familyListTools, 'archive_family_item');
    const restore = toolByName(listModule.familyListTools, 'restore_family_item');

    assert.match(String(await createList.handler(
      { name: 'Packing' },
      grantedFamilyContext('create_family_list', { name: 'Packing' }, 'Create a Packing list'),
    )), /Created Family list/);
    assert.match(String(await createList.handler(
      { name: 'Music' },
      grantedFamilyContext('create_family_list', { name: 'Music' }, 'Create a Music list'),
    )), /Created Family list/);
    await expectError(
      () => createList.handler(
        { name: 'To Do' },
        grantedFamilyContext('create_family_list', { name: 'To Do' }, 'Create a To Do list'),
      ),
      /reserved for natural Family Task input/i,
    );
    await expectError(
      () => createList.handler(
        { name: 'Shopping List' },
        grantedFamilyContext('create_family_list', { name: 'Shopping List' }, 'Create a Shopping List'),
      ),
      /conflicts with the existing Family list "Groceries"/i,
    );

    const naturalCases = [
      {
        message: 'Apply to Lincoln school',
        input: { list: 'Family Tasks', text: 'Apply to Lincoln school' },
        expectedList: 'Family Tasks',
      },
      {
        message: 'We need to call the plumber',
        input: { list: 'Family Tasks', text: 'call the plumber' },
        expectedList: 'Family Tasks',
      },
      {
        message: 'Task: Review the Lincoln application',
        input: { list: 'Family Tasks', text: 'Review the Lincoln application' },
        expectedList: 'Family Tasks',
      },
      {
        message: 'Remember to print the forms',
        input: { list: 'Family Tasks', text: 'print the forms' },
        expectedList: 'Family Tasks',
      },
      {
        message: "Don't let us forget to upload the documents",
        input: { list: 'Family Tasks', text: 'upload the documents' },
        expectedList: 'Family Tasks',
      },
      {
        message: 'Buy milk for school',
        input: { list: 'Groceries', text: 'Buy milk for school' },
        expectedList: 'Groceries',
      },
      {
        message: 'Groceries: Vanilla',
        input: { list: 'Groceries', text: 'Vanilla' },
        expectedList: 'Groceries',
      },
      {
        message: 'Packing: rain jackets',
        input: { list: 'Packing', text: 'rain jackets' },
        expectedList: 'Packing',
      },
      {
        message: 'Music: piano lessons',
        input: { list: 'Music', text: 'piano lessons' },
        expectedList: 'Music',
      },
      {
        message: 'Can you add yogurt to Groceries?',
        input: { list: 'Groceries', text: 'yogurt' },
        expectedList: 'Groceries',
      },
    ] as const;
    for (const fixture of naturalCases) {
      const result = String(await add.handler(
        fixture.input,
        grantedFamilyContext('add_family_item', fixture.input, fixture.message),
      ));
      const naturalId = Number(result.match(/#family-item:(\d+)/)?.[1]);
      assert.ok(
        Number.isInteger(naturalId) && naturalId > 0,
        `natural add failed for ${JSON.stringify(fixture.message)}: ${result}`,
      );
      const naturalItem = dbModule.getFamilyListItem(naturalId)!;
      assert.equal(naturalItem.list_name, fixture.expectedList);
      assert.equal(naturalItem.text, fixture.input.text);
    }

    const compoundMessage = 'Call plumber and buy batteries';
    const compoundBefore = dbModule.listFamilyListItems({ include_archived: true, limit: 500 }).length;
    for (const input of [
      { list: 'Family Tasks', text: 'Call plumber' },
      { list: 'Groceries', text: 'buy batteries' },
    ]) {
      const result = String(await add.handler(
        input,
        grantedFamilyContext('add_family_item', input, compoundMessage),
      ));
      assert.match(result, /Added to/i, `compound clause was not handled naturally: ${result}`);
    }
    assert.equal(
      dbModule.listFamilyListItems({ include_archived: true, limit: 500 }).length,
      compoundBefore + 2,
      'one compound message did not create exactly its two independently bound rows',
    );

    // The message that started all this: one enumeration, one call per item,
    // three independently bound rows instead of a single nonsense row.
    const enumeratedMessage = 'Add pumpkin spice, pumpkin puree, and whipped cream to Groceries';
    const enumeratedBefore = dbModule.listFamilyListItems({
      include_archived: true,
      limit: 500,
    }).length;
    for (const text of ['pumpkin spice', 'pumpkin puree', 'whipped cream']) {
      const result = String(await add.handler(
        { list: 'Groceries', text },
        grantedFamilyContext('add_family_item', { list: 'Groceries', text }, enumeratedMessage),
      ));
      assert.match(result, /Added to Groceries/i, `an enumerated item was refused: ${result}`);
    }
    assert.equal(
      dbModule.listFamilyListItems({ include_archived: true, limit: 500 }).length,
      enumeratedBefore + 3,
      'an enumerated grocery message did not create exactly one row per item',
    );

    const beforeLincolnRetry = dbModule.listFamilyListItems({
      include_archived: true,
      limit: 500,
    }).length;
    const wardlawRetry = String(await add.handler(
      { list: 'Family Tasks', text: 'Apply to Lincoln school' },
      grantedFamilyContext(
        'add_family_item',
        { list: 'Family Tasks', text: 'Apply to Lincoln school' },
        'Apply to Lincoln school',
      ),
    ));
    assert.match(wardlawRetry, /Already on Family Tasks:/);
    assert.equal(
      dbModule.listFamilyListItems({ include_archived: true, limit: 500 }).length,
      beforeLincolnRetry,
      'retrying a live natural input created a duplicate',
    );

    const beforeDeniedNaturalAdds = dbModule.listFamilyListItems({
      include_archived: true,
      limit: 500,
    }).length;
    for (const fixture of [
      {
        message: 'Apply to Lincoln school',
        input: { list: 'Family Tasks', text: 'Apply to Lincoln school tomorrow' },
      },
      {
        message: 'Groceries: oatmeal',
        input: { list: 'Family Tasks', text: 'oatmeal' },
      },
      {
        message: 'Add milk, eggs and bread to the list',
        input: { list: 'Groceries', text: 'milk and bread' },
      },
      {
        message: 'Add milk, eggs and bread to the list',
        input: { list: 'Groceries', text: 'vodka' },
      },
      {
        message: 'Add it as a family task',
        input: { list: 'Family Tasks', text: 'it as a family task' },
      },
      {
        message: 'Maybe apply to another school',
        input: { list: 'Family Tasks', text: 'apply to another school' },
      },
      {
        message: 'Book dentist Friday at 2pm',
        input: { list: 'Family Tasks', text: 'Book dentist Friday at 2pm' },
      },
      {
        message: 'Add milk to Groceries or Errands',
        input: { list: 'Family Tasks', text: 'milk to Groceries or Errands' },
      },
      {
        message: 'Add milk to Groceries and bread to Errands',
        input: { list: 'Errands', text: 'milk to Groceries and bread' },
      },
      {
        message: 'Call the plumber and add milk to Groceries',
        input: { list: 'Groceries', text: 'Call the plumber and add milk' },
      },
      {
        message: 'Pick up Jordan and buy stamps in Errands',
        input: { list: 'Errands', text: 'Pick up Jordan and buy stamps' },
      },
      {
        message: 'Call the plumber & add milk to Groceries',
        input: { list: 'Groceries', text: 'Call the plumber & add milk' },
      },
      {
        message: 'Call the plumber. Add milk to Groceries',
        input: { list: 'Groceries', text: 'Call the plumber. Add milk' },
      },
      {
        message: 'Groceries: Milk',
        input: { list: 'Groceries', text: 'Milk', quantity: '2 gallons' },
      },
      {
        message: 'Groceries: Milk',
        input: { list: 'Groceries', text: 'Milk', notes: 'Whole milk' },
      },
      {
        message: 'Groceries: Milk',
        input: { list: 'Groceries', text: 'Milk', due_date: '2026-08-24' },
      },
      {
        message: 'Groceries: Milk',
        input: { list: 'Groceries', text: 'Milk', assignee: 'me' },
      },
      {
        message: 'Apply to Lincoln school is one idea we discussed',
        input: { list: 'Family Tasks', text: 'Apply to Lincoln school is one idea we discussed' },
      },
      {
        message: 'Call the plumber is an option',
        input: { list: 'Family Tasks', text: 'Call the plumber is an option' },
      },
    ]) {
      await expectError(
        () => add.handler(
          fixture.input,
          grantedFamilyContextOrUntrusted('add_family_item', fixture.input, fixture.message),
        ),
        /nothing was added|not authorized/i,
      );
    }
    assert.equal(
      dbModule.listFamilyListItems({ include_archived: true, limit: 500 }).length,
      beforeDeniedNaturalAdds,
      'a mismatched or context-only natural input mutated Family lists',
    );

    const dueThursday = nextWeekdayIsoET(4);
    const naturalDueResult = String(await add.handler(
      { list: 'Groceries', text: 'oatmeal', due_date: dueThursday },
      grantedFamilyContext(
        'add_family_item',
        { list: 'Groceries', text: 'oatmeal', due_date: dueThursday },
        'Add oatmeal to Groceries by Thursday',
      ),
    ));
    const naturalDueId = Number(naturalDueResult.match(/#family-item:(\d+)/)?.[1]);
    assert.ok(Number.isInteger(naturalDueId) && naturalDueId > 0, naturalDueResult);
    assert.equal(dbModule.getFamilyListItem(naturalDueId)?.list_name, 'Groceries');
    assert.equal(dbModule.getFamilyListItem(naturalDueId)?.text, 'oatmeal');
    assert.equal(dbModule.getFamilyListItem(naturalDueId)?.due_date, dueThursday);

    const addResult = String(await add.handler({
      list: 'Groceries',
      text: 'Milk',
      quantity: '2 gallons',
      notes: 'Whole milk',
      due_date: '2026-08-24',
      assignee: 'me',
    }, grantedFamilyContext(
      'add_family_item',
      {
        list: 'Groceries',
        text: 'Milk',
        quantity: '2 gallons',
        notes: 'Whole milk',
        due_date: '2026-08-24',
        assignee: 'me',
      },
      'Groceries: Milk, quantity: 2 gallons, notes: Whole milk, due: 2026-08-24, assign to: me',
    )));
    const itemId = Number(addResult.match(/#family-item:(\d+)/)?.[1]);
    assert.ok(Number.isInteger(itemId) && itemId > 0, `could not parse Family item id from: ${addResult}`);

    let item = dbModule.getFamilyListItem(itemId)!;
    assert.equal(item.list_name, 'Groceries');
    assert.equal(item.text, 'Milk');
    assert.equal(item.quantity, '2 gallons');
    assert.equal(item.notes, 'Whole milk');
    assert.equal(item.due_date, '2026-08-24');
    assert.equal(item.assignee, 'alex');
    assert.equal(item.status, 'open');

    const editInput = {
      item_id: itemId,
      item_text: 'Milk',
      current_list: 'Groceries',
      list: 'Errands',
      text: 'Pick up milk',
      quantity: '1 case',
      notes: 'Use coupon',
      due_date: '2026-08-25',
      assignee: 'sam',
    };
    await edit.handler(
      editInput,
      grantedFamilyContext(
        'edit_family_item',
        editInput,
        'Move Milk from Groceries to Errands, rename it Pick up milk, quantity 1 case, notes Use coupon, due 2026-08-25, assign to Sam',
      ),
    );
    item = dbModule.getFamilyListItem(itemId)!;
    assert.equal(item.list_name, 'Errands');
    assert.equal(item.text, 'Pick up milk');
    assert.equal(item.quantity, '1 case');
    assert.equal(item.notes, 'Use coupon');
    assert.equal(item.due_date, '2026-08-25');
    assert.equal(item.assignee, 'sam');

    const itemIdentity = { item_id: itemId, item_text: 'Pick up milk', list: 'Errands' };
    await complete.handler(itemIdentity, grantedFamilyContext(
      'complete_family_item', itemIdentity, 'Mark Pick up milk done',
    ));
    assert.equal(dbModule.getFamilyListItem(itemId)?.status, 'completed');
    await reopen.handler(itemIdentity, grantedFamilyContext(
      'reopen_family_item', itemIdentity, 'Reopen Pick up milk',
    ));
    assert.equal(dbModule.getFamilyListItem(itemId)?.status, 'open');
    await archive.handler(itemIdentity, grantedFamilyContext(
      'archive_family_item', itemIdentity, `Archive Pick up milk (#${itemId})`,
    ));
    assert.ok(dbModule.getFamilyListItem(itemId)?.archived_at);
    assert.equal(dbModule.listFamilyListItems().some((row) => row.id === itemId), false);
    assert.equal(
      dbModule.listFamilyListItems({ include_archived: true }).some((row) => row.id === itemId),
      true,
    );
    await restore.handler(itemIdentity, grantedFamilyContext(
      'restore_family_item', itemIdentity, 'Restore Pick up milk',
    ));
    assert.equal(dbModule.getFamilyListItem(itemId)?.archived_at, null);

    await expectError(
      () => add.handler(
        { list: 'Groceries', text: 'Should be blocked' },
        { ...familyContext, groupKey: 'admin' },
      ),
      /only available inside the Family group/i,
    );
    await expectError(
      () => add.handler(
        { list: 'Groceries', text: 'No manifest write' },
        familyContext,
      ),
      /not authorized by the current source-bound request/i,
    );
    const familyItemCountBeforeForgedCalls = dbModule.listFamilyListItems({
      include_archived: true,
    }).length;
    for (const forgedContext of [
      { ...familyContext, userId: 'unknown' },
      { ...familyContext, chatId: 'wrong-chat', recipient: 'wrong-chat' },
      { ...familyContext, recipient: 'wrong-recipient' },
      { ...familyContext, chatId: undefined },
    ]) {
      await expectError(
        () => add.handler(
          { list: 'Groceries', text: 'Forged Family list write' },
          forgedContext,
        ),
        /authenticated participant in the configured Family chat/i,
      );
    }
    assert.equal(
      dbModule.listFamilyListItems({ include_archived: true }).length,
      familyItemCountBeforeForgedCalls,
      'a forged Family list context mutated the isolated list store',
    );
    assert.equal(countTasks(), taskCountBefore);
  });

  test('Family list duplicate policy distinguishes retries, history, and explicit another', async () => {
    const add = toolByName(listModule.familyListTools, 'add_family_item');
    const input = { list: 'Groceries', text: 'receipt-test milk' };
    const matchingRows = () => dbModule.listFamilyListItems({
      include_archived: true,
      limit: 500,
    }).filter((item) => item.list_name === 'Groceries' && item.text === input.text);

    const first = String(await add.handler(
      input,
      grantedFamilyContext('add_family_item', input, 'Add receipt-test milk to Groceries'),
    ));
    const firstId = Number(first.match(/#family-item:(\d+)/)?.[1]);
    assert.ok(firstId > 0);
    assert.equal(matchingRows().length, 1);

    const retry = String(await add.handler(
      input,
      grantedFamilyContext('add_family_item', input, 'Add receipt-test milk to Groceries'),
    ));
    assert.match(retry, /Already on Groceries/i);
    assert.equal(matchingRows().length, 1, 'ordinary retry created a second open row');

    // Completed and archived rows are historical occurrences. A fresh natural
    // request makes a new active occurrence instead of reviving stale details.
    assert.equal(dbModule.completeFamilyListItem(firstId, 'alex'), true);
    const afterCompleted = String(await add.handler(
      input,
      grantedFamilyContext('add_family_item', input, 'Add receipt-test milk to Groceries'),
    ));
    const secondId = Number(afterCompleted.match(/#family-item:(\d+)/)?.[1]);
    assert.ok(secondId > 0 && secondId !== firstId);
    assert.equal(dbModule.archiveFamilyListItem(secondId, 'alex'), true);
    await add.handler(
      input,
      grantedFamilyContext('add_family_item', input, 'Add receipt-test milk to Groceries'),
    );
    assert.equal(matchingRows().length, 3);

    const explicitDuplicate = String(await add.handler(
      input,
      grantedFamilyContext('add_family_item', input, 'Add another receipt-test milk to Groceries'),
    ));
    assert.match(explicitDuplicate, /Added to Groceries/i);
    assert.equal(matchingRows().length, 4, 'explicit another did not create a second active row');

    const additionalNotes = String(await add.handler(
      input,
      grantedFamilyContext(
        'add_family_item',
        input,
        'Add receipt-test milk to Groceries with additional notes later',
      ),
    ));
    assert.match(additionalNotes, /Already on Groceries/i);
    assert.equal(matchingRows().length, 4, 'unrelated additional wording bypassed duplicate protection');
  });

  test('Family list archive language binds the message, tool arguments, and live row', async () => {
    const add = toolByName(listModule.familyListTools, 'add_family_item');
    const archive = toolByName(listModule.familyListTools, 'archive_family_item');
    const restore = toolByName(listModule.familyListTools, 'restore_family_item');
    assert.deepEqual(
      archive.definition.input_schema.required,
      ['item_id', 'item_text', 'list'],
      'archive tool schema stopped requiring a complete live-row identity',
    );

    const addResult = String(await add.handler({
      list: 'Groceries',
      text: 'Peanut butter',
    }, grantedFamilyContext(
      'add_family_item',
      { list: 'Groceries', text: 'Peanut butter' },
      'Groceries: Peanut butter',
    )));
    const itemId = Number(addResult.match(/#family-item:(\d+)/)?.[1]);
    assert.ok(Number.isInteger(itemId) && itemId > 0, `could not parse archive fixture id: ${addResult}`);
    const exactInput = { item_id: itemId, item_text: 'Peanut butter', list: 'Groceries' };

    const runAuthorizedArchive = async (message: string): Promise<string> => {
      assert.equal(
        agentModule.canRunFamilyTool('archive_family_item', message, exactInput),
        true,
        `direct archive wording was blocked: ${message}`,
      );
      return String(await archive.handler(
        exactInput,
        grantedFamilyContext('archive_family_item', exactInput, message),
      ));
    };

    for (const message of [
      'Remove peanut butter from the list',
      'Archive peanut butter',
      `Archive peanut butter (#${itemId})`,
    ]) {
      assert.match(await runAuthorizedArchive(message), /Archived #family-item:/);
      assert.ok(dbModule.getFamilyListItem(itemId)?.archived_at, `${message} did not archive the row`);
      await restore.handler(
        { item_id: itemId, item_text: 'Peanut butter', list: 'Groceries' },
        grantedFamilyContext(
          'restore_family_item',
          { item_id: itemId, item_text: 'Peanut butter', list: 'Groceries' },
          'Restore peanut butter',
        ),
      );
      assert.equal(dbModule.getFamilyListItem(itemId)?.archived_at, null);
    }

    const deniedMessages = [
      `Sam said “can you archive peanut butter (#${itemId})?”`,
      `“Can you archive peanut butter (#${itemId})?”`,
      `For example, can you archive peanut butter (#${itemId})?`,
      `Hypothetical: can you archive peanut butter (#${itemId})?`,
      `What if I say can you archive peanut butter (#${itemId})?`,
      `Archive peanut butter (#${itemId}) if Sam agrees`,
      'Archive almond peanut butter',
      'Archive peanut butter cookies',
      'Archive peanut butter — just an example',
      'Archive peanut butter after Sam agrees',
      'Archive peanut butter as soon as Sam agrees',
      'Archive peanut butter later',
      'Archive peanut butter tomorrow',
      `Archive peanut butter (#${itemId}) from the Family calendar`,
      `Remove peanut butter (#${itemId}) from the Instacart cart`,
      'Remove peanut butter from my schedule',
      'Remove peanut butter from the grocery order',
      `Archive peanut butter (#${itemId}) from the Spotify playlist`,
      'Archive it',
      'Archive peanut butter or milk',
      'Archive milk or peanut butter',
      `Archive peanut butter (#${itemId} or #${itemId + 1})`,
      `Archive peanut butter (#${itemId},#${itemId + 1})`,
      `Archive peanut butter (#${itemId}/#${itemId + 1})`,
      `Archive peanut butter (#${itemId}-#${itemId + 1})`,
      `Archive peanut butter (#${itemId}.#${itemId + 1})`,
    ];
    for (const message of deniedMessages) {
      assert.equal(
        agentModule.canRunFamilyTool('archive_family_item', message, exactInput),
        false,
        `ambiguous, quoted, reported, or cross-surface wording was accepted: ${message}`,
      );
      await expectError(
        () => archive.handler(
          exactInput,
          grantedFamilyContextOrUntrusted('archive_family_item', exactInput, message),
        ),
        /nothing was archived|not authorized|question, not an authorized/i,
      );
      assert.equal(
        dbModule.getFamilyListItem(itemId)?.archived_at,
        null,
        `handler archived the row for denied wording: ${message}`,
      );
    }
    assert.equal(dbModule.getFamilyListItem(itemId)?.archived_at, null);

    assert.equal(agentModule.canRunFamilyTool(
      'archive_family_item',
      `Archive peanut butter (#${itemId})`,
      { ...exactInput, item_text: 'Almond butter' },
    ), false, 'wrong item label was accepted');
    assert.equal(agentModule.canRunFamilyTool(
      'archive_family_item',
      `Archive peanut butter (#${itemId})`,
      { ...exactInput, item_id: itemId + 1 },
    ), false, 'wrong item id was accepted');
    assert.equal(agentModule.canRunFamilyTool(
      'archive_family_item',
      `Archive peanut butter from Groceries (#${itemId})`,
      { ...exactInput, list: 'Errands' },
    ), false, 'wrong tool-argument list was accepted');
    assert.equal(agentModule.canRunFamilyTool(
      'archive_family_item',
      `Archive peanut butter from Errands (#${itemId})`,
      exactInput,
    ), false, 'wrong message list was accepted despite a correct id');
    assert.equal(agentModule.canRunFamilyTool(
      'archive_family_item',
      `Archive peanut butter (#${itemId})`,
      { item_id: itemId },
    ), false, 'id-only tool arguments were accepted');

    const wrongRowResult = String(await add.handler({
      list: 'Groceries',
      text: 'Bread',
    }, grantedFamilyContext(
      'add_family_item',
      { list: 'Groceries', text: 'Bread' },
      'Groceries: Bread',
    )));
    const wrongRowId = Number(wrongRowResult.match(/#family-item:(\d+)/)?.[1]);
    assert.ok(Number.isInteger(wrongRowId) && wrongRowId > 0);
    await expectError(
      () => archive.handler(
        { item_id: wrongRowId, item_text: 'Peanut butter', list: 'Groceries' },
        grantedFamilyContext(
          'archive_family_item',
          { item_id: wrongRowId, item_text: 'Peanut butter', list: 'Groceries' },
          'Archive peanut butter',
        ),
      ),
      /do not identify the same live Family row/i,
    );
    assert.equal(dbModule.getFamilyListItem(wrongRowId)?.archived_at, null);

    await expectError(
      () => archive.handler(
        exactInput,
        grantedFamilyContext(
          'archive_family_item', exactInput, `Archive peanut butter from Errands (#${itemId})`,
        ),
      ),
      /different or ambiguous Family list|nothing was archived/i,
    );
    assert.equal(dbModule.getFamilyListItem(itemId)?.archived_at, null);

    await expectError(
      () => archive.handler(
        exactInput,
        grantedFamilyContext(
          'archive_family_item', exactInput, `Archive peanut butter from the Instacart cart (#${itemId})`,
        ),
      ),
      /nothing was archived|another surface/i,
    );
    assert.equal(dbModule.getFamilyListItem(itemId)?.archived_at, null);

    const duplicateResult = String(await add.handler({
      list: 'Errands',
      text: 'Peanut butter',
    }, grantedFamilyContext(
      'add_family_item',
      { list: 'Errands', text: 'Peanut butter' },
      'Errands: Peanut butter',
    )));
    const duplicateId = Number(duplicateResult.match(/#family-item:(\d+)/)?.[1]);
    assert.ok(Number.isInteger(duplicateId) && duplicateId > 0);
    await expectError(
      () => archive.handler(
        exactInput,
        grantedFamilyContext('archive_family_item', exactInput, 'Archive peanut butter'),
      ),
      /ambiguous/i,
    );
    assert.equal(dbModule.getFamilyListItem(itemId)?.archived_at, null);
    assert.equal(dbModule.getFamilyListItem(duplicateId)?.archived_at, null);

    assert.match(
      await runAuthorizedArchive('Archive peanut butter from Groceries'),
      /Archived #family-item:/,
    );
    assert.ok(dbModule.getFamilyListItem(itemId)?.archived_at);
    assert.equal(dbModule.getFamilyListItem(duplicateId)?.archived_at, null);
    await restore.handler(
      { item_id: itemId, item_text: 'Peanut butter', list: 'Groceries' },
      grantedFamilyContext(
        'restore_family_item',
        { item_id: itemId, item_text: 'Peanut butter', list: 'Groceries' },
        'Restore peanut butter from Groceries',
      ),
    );

    const explicitResult = await runAuthorizedArchive(`Archive peanut butter (#${itemId})`);
    assert.match(explicitResult, /Archived #family-item:/);
    assert.ok(dbModule.getFamilyListItem(itemId)?.archived_at);
    assert.equal(dbModule.getFamilyListItem(duplicateId)?.archived_at, null);
  });

  test('Natural Family intent continues across participants without exact confirmations', async () => {
    const recent = [
      {
        role: 'user',
        content: 'Send a calendar invitation for annual dental cleanings from 2-4 PM for Sam, Riley and Alex',
        created_at: new Date().toISOString(),
      },
      {
        role: 'assistant',
        content: 'What date should I put on the Family calendar?',
        created_at: new Date().toISOString(),
      },
    ];
    const dentalInput = {
      title: 'Annual dental cleanings',
      date: '2026-09-10',
      start_time: '14:00',
      end_time: '16:00',
      description: 'For Sam, Riley and Alex',
    };
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'September 10th',
      dentalInput,
      recent,
    ), true, 'a natural date follow-up did not complete the shared calendar request');
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'September 10th',
      dentalInput,
      recent.map((message) => ({ ...message, created_at: '2020-01-01T00:00:00.000Z' })),
    ), false, 'an expired Family intent remained actionable');
    assert.equal(agentModule.canRunFamilyTool(
      'family_update_event',
      'Main Street Dental is the location',
      { event_id: 'dental-event', location: 'Main Street Dental' },
      [{
        role: 'assistant',
        content: 'Created Family event: "Annual dental cleanings" [event_id:dental-event]',
        created_at: new Date().toISOString(),
      }],
    ), true, 'a natural correction to the just-created event was blocked');

    // Plain assent to an event the assistant has fully described is a
    // confirmation. "Yes, confirmed" was refused in a real thread, and that
    // refusal taught the assistant to demand a dictated sentence instead —
    // it asked Sam for one four times in a row for a single appointment.
    const fullySpecified = [
      ...recent,
      { role: 'user', content: 'September 10th', created_at: new Date().toISOString() },
      { role: 'assistant', content: 'Ready to add annual dental cleanings on September 10, 2-4 PM.', created_at: new Date().toISOString() },
    ];
    for (const confirmation of [
      'Yes, confirmed', 'Ok', 'ok', 'yes', 'okay', 'yes please', 'go ahead',
      'yep', 'sure', 'OK.', 'Yes!', 'do it', 'confirmed', 'Yeah, go ahead',
      'that works', 'perfect',
    ]) {
      assert.equal(agentModule.canRunFamilyTool(
        'family_create_event',
        confirmation,
        dentalInput,
        fullySpecified,
      ), true, `a plain confirmation was refused: ${confirmation}`);
    }
    // Assent is only assent when it is the whole message. Anything that
    // withholds, questions, or bolts on another action is not a go-ahead.
    for (const notAConfirmation of [
      'no', 'not yet', 'maybe', 'yes if Sam is free', 'actually cancel that',
      'yes and add milk to groceries', 'Sam said ok', 'hold off',
      // Calling an idea good is not authorizing it, and this module must keep
      // agreeing with CONTEXT_ONLY_FAMILY_CLAIM about that.
      'sounds good', 'looks good', 'great', 'thanks',
    ]) {
      assert.equal(agentModule.canRunFamilyTool(
        'family_create_event',
        notAConfirmation,
        dentalInput,
        fullySpecified,
      ), false, `a non-confirmation created an event: ${notAConfirmation}`);
    }
    // A real refusal from the thread: two appointments, numeric dates, and an
    // end time nobody ever typed. "appointments" missed \bappointment\b, "9/4"
    // was not a date, and 11:00 came from "an hour" plus "Yes" — so the whole
    // request was invisible to the gate.
    const eyeMessage = 'Add two eye appointments\n\n9/4 10am for sam \n9/8 12pm for alex\n\nLocation:\n100 Main St Springfield nj 07081';
    const eyeThread = [
      { role: 'user', content: eyeMessage, created_at: new Date().toISOString() },
      { role: 'assistant', content: 'I have the dates, times, and location. Should I make each appointment one hour long?', created_at: new Date().toISOString() },
    ];
    const eyeLocation = '100 Main St Springfield nj 07081';
    for (const appointment of [
      { title: 'Eye appointment - Sam', date: '2026-09-04', start_time: '10:00', end_time: '11:00', location: eyeLocation },
      { title: 'Eye appointment - Alex', date: '2026-09-08', start_time: '12:00', end_time: '13:00', location: eyeLocation },
    ]) {
      assert.equal(agentModule.canRunFamilyTool(
        'family_create_event',
        'Yes',
        appointment,
        eyeThread,
      ), true, `a confirmed numeric-date appointment was refused: ${appointment.title}`);
    }
    // An end time still needs evidence. Without a duration anywhere in the
    // thread it is the model's invention, not a detail anyone agreed to.
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'Yes',
      { title: 'Eye appointment - Sam', date: '2026-09-04', start_time: '10:00', end_time: '11:00' },
      [
        { role: 'user', content: 'Add eye appointment 9/4 10am for sam', created_at: new Date().toISOString() },
        { role: 'assistant', content: 'Want me to add it?', created_at: new Date().toISOString() },
      ],
    ), false, 'an end time was accepted with no duration discussed');

    // Ordinary phrasings that the gate's vocabulary used to miss. Every one of
    // these was a silent refusal in a shared family thread.
    for (const [confirmation, appointment] of [
      ['9/4 at noon', { title: 'Eye appointment', date: '2026-09-04', start_time: '12:00' }],
      ['9/4 at 9:30', { title: 'Eye appointment', date: '2026-09-04', start_time: '09:30' }],
      ['fri at 10am', { title: 'Eye appointment', date: '2026-09-04', start_time: '10:00' }],
      ['9/4, 10 to 11am', { title: 'Eye appointment', date: '2026-09-04', start_time: '10:00', end_time: '11:00' }],
    ] as const) {
      assert.equal(agentModule.canRunFamilyTool(
        'family_create_event',
        confirmation,
        appointment,
        [
          { role: 'user', content: 'Add an eye appointment for Sam', created_at: new Date().toISOString() },
          { role: 'assistant', content: 'What day and time?', created_at: new Date().toISOString() },
        ],
      ), true, `ordinary date/time phrasing was refused: ${confirmation}`);
    }
    // Asking twice, or wanting two of the same kind of thing, used to lock the
    // natural path for the rest of the half hour.
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'the 4th at 10am',
      { title: 'Eye appointment', date: '2026-09-04', start_time: '10:00' },
      [
        { role: 'user', content: 'Add an eye appointment for Sam', created_at: new Date().toISOString() },
        { role: 'assistant', content: 'Sorry, I could not do that.', created_at: new Date().toISOString() },
        { role: 'user', content: 'Add an eye appointment for Sam', created_at: new Date().toISOString() },
        { role: 'assistant', content: 'What day?', created_at: new Date().toISOString() },
      ],
    ), true, 're-asking after a refusal locked the natural calendar path');
    // Answering the assistant's own follow-up question.
    assert.equal(agentModule.canRunFamilyTool(
      'family_create_event',
      'an hour',
      { title: 'Eye appointment', date: '2026-09-04', start_time: '10:00', end_time: '11:00' },
      [
        { role: 'user', content: 'Add an eye appointment for Sam on the 4th at 10am', created_at: new Date().toISOString() },
        { role: 'assistant', content: 'How long should I block?', created_at: new Date().toISOString() },
      ],
    ), true, 'answering "how long?" with a duration was refused');

    // Deletion keeps its own explicit code. Plain assent must never delete.
    for (const confirmation of ['yes', 'ok', 'Yes, confirmed', 'do it', 'go ahead']) {
      assert.equal(agentModule.canRunFamilyTool(
        'family_confirm_event_delete',
        confirmation,
        { confirmation_code: 'AB12', event_id: 'dental-event' },
        fullySpecified,
      ), false, `plain assent confirmed a deletion: ${confirmation}`);
    }

    const inserted: Array<Record<string, unknown>> = [];
    const account = 'alex@example.com';
    const familyId = 'family-natural@group.calendar.google.com';
    const fakeCalendar = {
      calendarList: {
        get: async ({ calendarId }: { calendarId: string }) => ({ data: calendarId === account
          ? { id: account, primary: true, accessRole: 'owner' }
          : { id: familyId, summary: 'Family', primary: false, accessRole: 'owner' } }),
      },
      events: {
        insert: async (args: Record<string, unknown>) => {
          inserted.push(args);
          return { data: { id: 'one-hour-event' } };
        },
      },
    };
    const naturalTools = calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => fakeCalendar as never,
      getCalendarId: () => familyId,
      getCalendarAccount: () => account,
    });
    const naturalCreateInput = {
      title: 'Jordan playdate',
      date: '2026-09-12',
      start_time: '14:00',
    };
    const naturalCreateMessage = 'Schedule Jordan playdate September 12, 2026 at 2 PM';
    await toolByName(naturalTools, 'family_create_event').handler(
      naturalCreateInput,
      grantedFamilyContext('family_create_event', naturalCreateInput, naturalCreateMessage),
    );
    assert.equal(inserted.length, 1);
    const requestBody = inserted[0].requestBody as { start: { dateTime: string }; end: { dateTime: string }; attendees?: unknown };
    assert.equal(requestBody.start.dateTime, '2026-09-12T14:00:00');
    assert.equal(requestBody.end.dateTime, '2026-09-12T15:00:00');
    assert.equal('attendees' in requestBody, false);
  });

  test('A natural message crosses the real model-manifest-handler loop once', async () => {
    const message = 'We are out of integration-test paprika';
    const toolInput = { list: 'Groceries', text: 'integration-test paprika' };
    const manifestDraft = {
      classification: 'action',
      actions: [{
        intent_id: 'integration_paprika',
        tool_name: 'add_family_item',
        kind: 'new_action',
        arguments: toolInput,
        source_bindings: [{ source_ref: 'current', quote: message }],
      }],
    };
    const responses = [
      {
        output: [{
          type: 'function_call',
          name: manifestModule.FAMILY_TURN_MANIFEST_TOOL,
          arguments: JSON.stringify(manifestDraft),
          call_id: 'manifest-call',
        }],
      },
      {
        output: [{
          type: 'function_call',
          name: 'add_family_item',
          arguments: JSON.stringify(toolInput),
          call_id: 'list-call',
        }],
      },
      {
        output: [{
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Added paprika to Groceries.' }],
        }],
      },
    ];
    let responseIndex = 0;
    const before = dbModule.listFamilyListItems({
      include_archived: true,
      limit: 500,
    }).filter((item) => item.text === toolInput.text).length;
    const response = await agentModule.runAgent(
      {
        key: 'family',
        name: 'Family',
        tools: ['family-lists'],
        contextPath: 'context/family',
        audience: 'shared',
        replyPolicy: 'smart',
        expectedUserIds: ['alex', 'sam'],
      },
      {
        id: 'alex',
        name: 'Alex',
        phone: '',
        role: 'admin',
        tone: 'direct',
        allowedGroups: ['family'],
      },
      message,
      undefined,
      undefined,
      undefined,
      'test-family-chat',
      async () => true,
      {
        key: 'f'.repeat(64),
        rowId: 998_001,
        guid: 'integration-family-message',
        timestamp: '2026-09-19T15:00:00.000Z',
      },
      {
        turnId: 'integration-family-turn',
        createResponse: async () => {
          const next = responses[responseIndex];
          responseIndex += 1;
          if (!next) throw new Error('The integration model was called too many times.');
          return next;
        },
      },
    );
    assert.equal(response, 'Added paprika to Groceries.');
    assert.equal(responseIndex, 3);
    assert.equal(
      dbModule.listFamilyListItems({ include_archived: true, limit: 500 })
        .filter((item) => item.text === toolInput.text).length,
      before + 1,
      'the real agent loop did not produce exactly one Family-local list mutation',
    );
  });

  test('Context facts cannot be relabeled as Family writes', () => {
    for (const message of [
      'Jordan likes strawberries',
      'Milk has gotten expensive',
      'We usually buy oat milk',
    ]) {
      assert.throws(
        () => grantedFamilyContext(
          'add_family_item',
          { list: 'Groceries', text: message.includes('strawberries') ? 'strawberries' : 'milk' },
          message,
        ),
        /unsafe or non-direct action language/i,
        `context-only statement authorized a list mutation: ${message}`,
      );
    }

    assert.doesNotThrow(() => grantedFamilyContext(
      'add_family_item',
      { list: 'Groceries', text: 'strawberries' },
      "We're out of strawberries",
    ));
    assert.doesNotThrow(() => grantedFamilyContext(
      'add_family_item',
      { list: 'Groceries', text: 'oat milk' },
      "We'll need oat milk",
    ));
    assert.doesNotThrow(() => grantedFamilyContext(
      'add_family_item',
      { list: 'Groceries', text: 'strawberries' },
      'Groceries: strawberries',
    ));

    assert.doesNotThrow(() => grantedFamilyContext(
      'family_create_event',
      {
        title: 'Annual dental cleanings',
        date: '2026-09-10',
        start_time: '14:00',
        end_time: '16:00',
      },
      'Annual dental cleanings September 10, 2026, 2-4 PM',
    ));
    assert.throws(
      () => grantedFamilyContext(
        'family_create_event',
        { title: "Jordan's birthday", date: '2027-05-01', all_day: true },
        "Jordan's birthday is May 1, all day",
      ),
      /unsafe or non-direct action language/i,
      'a contextual family fact authorized a calendar mutation',
    );
  });

  test('Cross-participant Diwali follow-up reaches the real gate and all-day calendar handler', async () => {
    const request = 'Add Diwali to the Family calendar on November 8';
    const followUp = 'What time should I use?';

    // This mirrors the production ordering in runAgent: the earlier turns are
    // durable before Alex's current reply is evaluated. The initiating sender
    // must survive the DB read so shared intent is attributable rather than a
    // senderless transcript assembled only for a unit test.
    dbModule.saveMessage('family', 'sam', 'user', request);
    dbModule.saveMessage('family', 'assistant', 'assistant', followUp);
    const familyHistory = dbModule.getRecentMessagesWithMetadata('family');
    const requestRow = familyHistory.find((message) => message.content === request);
    const followUpRow = familyHistory.find((message) => message.content === followUp);
    assert.equal(requestRow?.sender, 'sam');
    assert.equal(requestRow?.role, 'user');
    assert.equal(followUpRow?.sender, 'assistant');
    assert.equal(followUpRow?.role, 'assistant');
    assert.ok(
      Number(requestRow?.id) < Number(followUpRow?.id),
      'Family history did not preserve conversational order',
    );

    const input = {
      title: 'Diwali',
      date: '2026-11-08',
      all_day: true,
    };
    const sources = manifestModule.buildFamilyTurnSources({
      currentMessage: 'All day',
      currentSenderId: 'alex',
      recentMessages: familyHistory,
    });
    assert.equal(sources.find((source) => source.ref === `message:${requestRow?.id}`)?.senderId, 'sam');
    assert.equal(sources.find((source) => source.ref === 'current')?.senderId, 'alex');
    const manifest = manifestModule.createFamilyTurnManifest({
      draft: {
        classification: 'action',
        actions: [{
          intent_id: 'diwali_all_day',
          tool_name: 'family_create_event',
          kind: 'continuation',
          arguments: input,
          source_bindings: [
            { source_ref: `message:${requestRow?.id}`, quote: request },
            { source_ref: 'current', quote: 'All day' },
          ],
        }],
      },
      turnId: 'diwali-all-day-turn',
      chatId: 'test-family-chat',
      requesterId: 'alex',
      sources,
    });
    const claimed = manifestModule.claimFamilyManifestAction({
      manifest,
      toolName: 'family_create_event',
      toolInput: input,
      currentMessage: 'All day',
    });
    assert.equal('error' in claimed, false, 'the source-bound Diwali continuation was not granted');
    if ('error' in claimed) throw new Error(claimed.error);

    // The assistant may supply a prompt or repeat details, but an earlier assistant-only
    // suggestion is not household authority. The same short answer must fail
    // without an earlier request from Alex or Sam.
    const assistantOnlySources = manifestModule.buildFamilyTurnSources({
      currentMessage: 'All day',
      currentSenderId: 'alex',
      recentMessages: [{
        id: 987_654,
        group_id: 'family',
        sender: 'assistant',
        role: 'assistant',
        content: 'Should I add Diwali to the Family calendar on November 8?',
        created_at: new Date().toISOString(),
      }],
    });
    assert.throws(() => manifestModule.createFamilyTurnManifest({
      draft: {
        classification: 'action',
        actions: [{
          intent_id: 'assistant_only_diwali',
          tool_name: 'family_create_event',
          kind: 'continuation',
          arguments: input,
          source_bindings: [
            {
              source_ref: 'message:987654',
              quote: 'Should I add Diwali to the Family calendar on November 8?',
            },
            { source_ref: 'current', quote: 'All day' },
          ],
        }],
      },
      turnId: 'assistant-only-diwali-turn',
      chatId: 'test-family-chat',
      requesterId: 'alex',
      sources: assistantOnlySources,
    }), /earlier user request/i);

    const account = 'alex@example.com';
    const calendarId = 'family-diwali@group.calendar.google.com';
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const fakeCalendar = {
      calendarList: {
        get: async (args: Record<string, unknown>) => {
          calls.push({ method: 'calendarList.get', args });
          return { data: args.calendarId === account
            ? { id: account, primary: true, accessRole: 'owner' }
            : { id: calendarId, summary: 'Family', primary: false, accessRole: 'owner' } };
        },
      },
      events: {
        insert: async (args: Record<string, unknown>) => {
          calls.push({ method: 'events.insert', args });
          return { data: { id: 'diwali-all-day-event' } };
        },
      },
    };
    const tools = calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => fakeCalendar as never,
      getCalendarId: () => calendarId,
      getCalendarAccount: () => account,
    });
    const result = String(await toolByName(tools, 'family_create_event').handler(input, {
      ...familyContext,
      userId: 'alex',
      turnId: 'diwali-all-day-turn',
      currentMessage: 'All day',
      recentMessages: familyHistory,
      familyTurnManifest: manifest,
      familyManifestAuthorization: claimed.authorization,
      reverifyFamilyAudience: async () => true,
    }));

    assert.match(result, /Created Family event: "Diwali"/);
    assert.match(result, /2026-11-08 \(all day\)/);
    const insert = calls.find((call) => call.method === 'events.insert');
    assert.ok(insert, 'the authorized all-day request never reached Calendar insert');
    assert.equal(insert.args.calendarId, calendarId);
    assert.equal(insert.args.sendUpdates, 'none');
    const body = insert.args.requestBody as {
      summary: string;
      start: { date: string };
      end: { date: string };
      attendees?: unknown;
    };
    assert.equal(body.summary, 'Diwali');
    assert.deepEqual(body.start, { date: '2026-11-08' });
    assert.deepEqual(body.end, { date: '2026-11-09' });
    assert.equal('attendees' in body, false);
    assert.ok(
      calls.filter((call) => call.method === 'calendarList.get')
        .every((call) => call.args.calendarId === account || call.args.calendarId === calendarId),
      'the Diwali flow inspected an unscoped calendar',
    );
  });

  test('Family history preserves the original iMessage time across delayed processing', () => {
    const sourceTime = '2026-09-20T03:59:00.000Z';
    const content = 'Recovered Family timestamp fixture';
    dbModule.saveMessage('family', 'sam', 'user', content, sourceTime);
    const stored = dbModule.getRecentMessagesWithMetadata('family')
      .find((message) => message.content === content);
    assert.equal(stored?.created_at, '2026-09-20 03:59:00');
    const sources = manifestModule.buildFamilyTurnSources({
      currentMessage: 'Friday',
      currentSenderId: 'alex',
      recentMessages: stored ? [stored] : [],
      nowMs: Date.parse('2026-09-20T04:05:00.000Z'),
    });
    assert.equal(
      sources.find((source) => source.ref === `message:${stored?.id}`)?.createdAt,
      '2026-09-20 03:59:00',
    );
  });

  test('Family manifests scope negation to one clause and never turn a question into a write', () => {
    const clauseMessage = "Don't add milk; add eggs";
    const clauseSources = manifestModule.buildFamilyTurnSources({
      currentMessage: clauseMessage,
      currentSenderId: 'alex',
      recentMessages: [],
      nowMs: Date.parse('2026-09-19T16:00:00Z'),
    });
    const eggsInput = { list: 'Groceries', text: 'eggs' };
    const eggsManifest = manifestModule.createFamilyTurnManifest({
      draft: {
        classification: 'mixed',
        actions: [{
          intent_id: 'add_eggs_only',
          tool_name: 'add_family_item',
          kind: 'new_action',
          arguments: eggsInput,
          source_bindings: [{ source_ref: 'current', quote: 'add eggs' }],
        }],
      },
      turnId: 'clause-scoped-negation-turn',
      chatId: 'test-family-chat',
      requesterId: 'alex',
      sources: clauseSources,
      nowMs: Date.parse('2026-09-19T16:00:00Z'),
    });
    assert.equal('error' in manifestModule.claimFamilyManifestAction({
      manifest: eggsManifest,
      toolName: 'add_family_item',
      toolInput: eggsInput,
      currentMessage: clauseMessage,
    }), false, 'the independent positive clause was vetoed by the negated milk clause');

    assert.throws(() => manifestModule.createFamilyTurnManifest({
      draft: {
        classification: 'action',
        actions: [{
          intent_id: 'negated_milk',
          tool_name: 'add_family_item',
          kind: 'new_action',
          arguments: { list: 'Groceries', text: 'milk' },
          source_bindings: [{ source_ref: 'current', quote: 'add milk' }],
        }],
      },
      turnId: 'negated-clause-turn',
      chatId: 'test-family-chat',
      requesterId: 'alex',
      sources: clauseSources,
      nowMs: Date.parse('2026-09-19T16:00:00Z'),
    }), /unsafe or non-direct/i);

    const questionSources = manifestModule.buildFamilyTurnSources({
      currentMessage: 'Got milk?',
      currentSenderId: 'sam',
      recentMessages: [],
    });
    assert.throws(() => manifestModule.createFamilyTurnManifest({
      draft: {
        classification: 'action',
        actions: [{
          intent_id: 'question_is_not_completion',
          tool_name: 'complete_family_item',
          kind: 'new_action',
          arguments: { item_id: 1, item_text: 'milk', list: 'Groceries' },
          source_bindings: [{ source_ref: 'current', quote: 'Got milk?' }],
        }],
      },
      turnId: 'question-turn',
      chatId: 'test-family-chat',
      requesterId: 'sam',
      sources: questionSources,
    }), /unsafe or non-direct/i);
  });

  test('Family list manifests preserve source ownership and reject lossy or deferred writes', async () => {
    const add = toolByName(listModule.familyListTools, 'add_family_item');
    const now = new Date().toISOString();

    for (const message of [
      "Don't let us forget to not add milk",
      "Don't let us forget to maybe add milk",
      'Sam will add milk',
      "She'll add milk",
    ]) {
      assert.throws(
        () => grantedFamilyContext(
          'add_family_item',
          { list: 'Groceries', text: 'milk' },
          message,
        ),
        /unsafe or non-direct/i,
        `unsafe reminder or future commitment was granted: ${message}`,
      );
    }
    assert.doesNotThrow(() => grantedFamilyContext(
      'add_family_item',
      { list: 'Groceries', text: 'oat milk' },
      "We'll need oat milk",
    ), 'ordinary future need language was mistaken for an action commitment');

    for (const fixture of [
      ['archive_family_item', 'Archive peanut butter tomorrow'],
      ['complete_family_item', 'Complete peanut butter later'],
      ['reopen_family_item', 'Reopen peanut butter in two hours'],
      ['restore_family_item', 'Restore peanut butter after Sam agrees'],
    ] as const) {
      const input = { item_id: 999, item_text: 'Peanut butter', list: 'Groceries' };
      assert.throws(
        () => grantedFamilyContext(fixture[0], input, fixture[1]),
        /unsafe or non-direct/i,
        `deferred state change was granted: ${fixture[1]}`,
      );
    }

    assert.throws(() => grantedFamilyContext(
      'complete_family_item',
      { item_id: 999, item_text: 'Milk', list: 'Groceries' },
      'yes',
      {
        kind: 'continuation',
        recentMessages: [{
          id: 991_101,
          role: 'user',
          sender: 'sam',
          content: 'Got milk?',
          created_at: now,
        }],
        sourceBindings: [
          { source_ref: 'message:991101', quote: 'Got milk?' },
          { source_ref: 'current', quote: 'yes' },
        ],
      },
    ), /unsafe or non-direct/i, 'an earlier non-directive question authorized completion');

    for (const historical of [
      {
        id: 991_104,
        tool: 'add_family_item',
        input: { list: 'Groceries', text: 'milk' },
        message: 'I will add milk tomorrow',
      },
      {
        id: 991_105,
        tool: 'archive_family_item',
        input: { item_id: 999, item_text: 'Peanut butter', list: 'Groceries' },
        message: 'Archive peanut butter tomorrow',
      },
    ]) {
      assert.throws(
        () => grantedFamilyContext(
          historical.tool,
          historical.input,
          'yes',
          {
            kind: 'continuation',
            recentMessages: [{
              id: historical.id,
              role: 'user',
              sender: 'sam',
              content: historical.message,
              created_at: now,
            }],
            sourceBindings: [
              { source_ref: `message:${historical.id}`, quote: historical.message },
              { source_ref: 'current', quote: 'yes' },
            ],
          },
        ),
        /unsafe or non-direct/i,
        `current agreement laundered an earlier unsafe request: ${historical.message}`,
      );
    }

    const crossParticipantInput = {
      list: 'Family Tasks',
      text: 'school folders',
      due_date: nextWeekdayIsoET(5),
      assignee: 'me',
    };
    const crossParticipantResult = String(await add.handler(
      crossParticipantInput,
      grantedFamilyContext(
        'add_family_item',
        crossParticipantInput,
        'Friday',
        {
          userId: 'alex',
          kind: 'continuation',
          recentMessages: [{
            id: 991_102,
            role: 'user',
            sender: 'sam',
            content: 'Add school folders and assign them to me',
            created_at: now,
          }],
          sourceBindings: [
            { source_ref: 'message:991102', quote: 'Add school folders and assign them to me' },
            { source_ref: 'current', quote: 'Friday' },
          ],
        },
      ),
    ));
    const crossParticipantId = Number(crossParticipantResult.match(/#family-item:(\d+)/)?.[1]);
    assert.equal(
      dbModule.getFamilyListItem(crossParticipantId)?.assignee,
      'sam',
      'historical Sam "me" was reassigned to the current Alex sender',
    );

    const stitchedInput = { list: 'Groceries', text: 'milk bread' };
    await expectError(
      () => add.handler(
        stitchedInput,
        grantedFamilyContext(
          'add_family_item',
          stitchedInput,
          'bread',
          {
            kind: 'continuation',
            recentMessages: [{
              id: 991_103,
              role: 'user',
              sender: 'sam',
              content: 'Add milk',
              created_at: now,
            }],
            sourceBindings: [
              { source_ref: 'message:991103', quote: 'Add milk' },
              { source_ref: 'current', quote: 'bread' },
            ],
          },
        ),
      ),
      /nothing was added/i,
    );

    const lossyPercentageInput = { list: 'Groceries', text: 'milk', quantity: '2' };
    await expectError(
      () => add.handler(
        lossyPercentageInput,
        grantedFamilyContext(
          'add_family_item', lossyPercentageInput, 'Add 2% milk',
        ),
      ),
      /nothing was added/i,
    );

    const preservedPercentageInput = { list: 'Groceries', text: '2% milk' };
    const preservedPercentageResult = String(await add.handler(
      preservedPercentageInput,
      grantedFamilyContext(
        'add_family_item', preservedPercentageInput, 'Add 2% milk',
      ),
    ));
    assert.match(preservedPercentageResult, /Added to Groceries/i);
  });

  test('Calendar discovery binds one owned secondary Family calendar under the exact account', () => {
    const expectedAccount = 'alex@example.com';
    const entries = [
      { id: expectedAccount, summary: 'Alex Rivera', primary: true, accessRole: 'owner' },
      { id: 'family-id@group.calendar.google.com', summary: 'Family', primary: false, accessRole: 'owner' },
    ];
    assert.equal(
      configureFamilyModule.resolveFamilyCalendarAccount(entries, expectedAccount),
      expectedAccount,
    );
    assert.equal(
      configureFamilyModule.resolveFamilyCalendarId(entries, expectedAccount),
      'family-id@group.calendar.google.com',
    );
    assert.throws(
      () => configureFamilyModule.resolveFamilyCalendarId([entries[0]], expectedAccount),
      /No non-primary calendar named Family/i,
    );
    assert.throws(
      () => configureFamilyModule.resolveFamilyCalendarId(
        [entries[0], entries[1], { ...entries[1], id: 'duplicate' }],
        expectedAccount,
      ),
      /More than one non-primary calendar named Family/i,
    );
    assert.throws(
      () => configureFamilyModule.resolveFamilyCalendarId([
        { id: expectedAccount, summary: 'Family', primary: true, accessRole: 'owner' },
      ], expectedAccount),
      /No non-primary calendar named Family/i,
    );
    for (const accessRole of ['writer', 'reader']) {
      assert.throws(
        () => configureFamilyModule.resolveFamilyCalendarId([
          entries[0],
          { ...entries[1], accessRole },
        ], expectedAccount),
        /does not own it/i,
      );
    }
    for (const badEntries of [
      entries,
      [entries[1]],
      [entries[0], { ...entries[0], id: 'second-primary@example.com' }, entries[1]],
    ]) {
      const expected = badEntries === entries ? 'other@example.com' : expectedAccount;
      assert.throws(
        () => configureFamilyModule.resolveFamilyCalendarId(badEntries, expected),
        /does not exactly match FAMILY_CALENDAR_ACCOUNT/i,
      );
    }
    assert.throws(
      () => configureFamilyModule.resolveFamilyCalendarId(entries, ''),
      /FAMILY_CALENDAR_ACCOUNT must contain/i,
    );

    const source = readFileSync(join(ROOT, 'scripts/configure-family.ts'), 'utf8');
    assert.doesNotMatch(source, /\.calendars\.(?:insert|update|delete|patch)\s*\(/);
    assert.doesNotMatch(source, /\.acl\./);
  });

  test('Every Family calendar event call uses one fixed verified ID and exposes no calendar/ACL API', async () => {
    const calendarAccount = 'alex@example.com';
    const familyCalendarId = 'family-id@group.calendar.google.com';
    const calls: Array<{ method: string; args: Record<string, unknown> }> = [];
    const fakeCalendar = {
      calendarList: {
        get: async (args: Record<string, unknown>) => {
          calls.push({ method: 'calendarList.get', args });
          if (args.calendarId === calendarAccount) {
            return { data: { id: calendarAccount, primary: true, accessRole: 'owner' } };
          }
          if (args.calendarId === familyCalendarId) {
            return {
              data: {
                id: familyCalendarId,
                summary: 'Family',
                primary: false,
                accessRole: 'owner',
              },
            };
          }
          throw new Error('unexpected calendar metadata request');
        },
      },
      events: {
        list: async (args: Record<string, unknown>) => {
          calls.push({ method: 'events.list', args });
          return { data: { items: [] } };
        },
        insert: async (args: Record<string, unknown>) => {
          calls.push({ method: 'events.insert', args });
          return { data: { id: 'created-family-event' } };
        },
        patch: async (args: Record<string, unknown>) => {
          calls.push({ method: 'events.patch', args });
          return { data: { id: String(args.eventId) } };
        },
        get: async (args: Record<string, unknown>) => {
          calls.push({ method: 'events.get', args });
          return { data: { id: String(args.eventId), summary: 'Disposable Family event', status: 'confirmed' } };
        },
        delete: async (args: Record<string, unknown>) => {
          calls.push({ method: 'events.delete', args });
          return { data: {} };
        },
      },
    };
    const tools = calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => fakeCalendar as never,
      getCalendarId: () => familyCalendarId,
      getCalendarAccount: () => calendarAccount,
      now: () => Date.parse('2026-08-23T12:00:00Z'),
      createConfirmationCode: () => 'SAFE1',
    });
    await toolByName(tools, 'family_list_events').handler(
      { date: '2026-08-23', days: 2 },
      familyContext,
    );
    const createInput = {
      title: 'School pickup',
      date: '2026-08-24',
      start_time: '16:00',
      end_time: '16:30',
    };
    const createMessage = 'Schedule School pickup August 24, 2026 at 4 PM until 4:30 PM';
    await toolByName(tools, 'family_create_event').handler(
      createInput,
      grantedFamilyContext('family_create_event', createInput, createMessage),
    );
    const updateInput = {
      event_id: 'created-family-event',
      title: 'Updated school pickup',
    };
    const updateMessage = 'Change it to Updated school pickup';
    await toolByName(tools, 'family_update_event').handler(updateInput, grantedFamilyContext(
      'family_update_event',
      updateInput,
      updateMessage,
      {
      recentMessages: [{
        role: 'assistant',
        content: 'Created Family event: "School pickup" [event_id:created-family-event]',
        created_at: new Date().toISOString(),
      }],
      },
    ));

    assert.deepEqual(calls.map((call) => call.method), [
      'calendarList.get',
      'calendarList.get',
      'events.list',
      'calendarList.get',
      'calendarList.get',
      'events.insert',
      'calendarList.get',
      'calendarList.get',
      'events.get',
      'events.patch',
    ]);
    const metadataCalls = calls.filter((call) => call.method === 'calendarList.get');
    assert.deepEqual(
      metadataCalls.map((call) => call.args.calendarId),
      [calendarAccount, familyCalendarId, calendarAccount, familyCalendarId, calendarAccount, familyCalendarId],
    );
    const eventCalls = calls.filter((call) => call.method.startsWith('events.'));
    for (const call of eventCalls) {
      assert.equal(call.args.calendarId, familyCalendarId, `${call.method} escaped the Family calendar`);
      assert.notEqual(call.args.calendarId, 'primary');
      assert.notEqual(call.args.calendarId, calendarAccount);
    }
    const insertCall = calls.find((call) => call.method === 'events.insert')!;
    const patchCall = calls.find((call) => call.method === 'events.patch')!;
    assert.equal(insertCall.args.sendUpdates, 'none');
    assert.equal(patchCall.args.sendUpdates, 'none');
    assert.equal('attendees' in (insertCall.args.requestBody as Record<string, unknown>), false);
    assert.equal('attendees' in (patchCall.args.requestBody as Record<string, unknown>), false);
    assert.equal('calendars' in fakeCalendar, false);
    assert.equal('acl' in fakeCalendar, false);
    assert.throws(
      () => calendarModule.getConfiguredFamilyCalendarId({ FAMILY_CALENDAR_ID: '' }),
      /not configured/i,
    );
    assert.throws(
      () => calendarModule.getConfiguredFamilyCalendarId({ FAMILY_CALENDAR_ID: 'primary' }),
      /cannot be "primary"/i,
    );
    assert.throws(
      () => calendarModule.getConfiguredFamilyCalendarAccount({ FAMILY_CALENDAR_ACCOUNT: '' }),
      /not configured/i,
    );
    assert.throws(
      () => calendarModule.getConfiguredFamilyCalendarAccount({ FAMILY_CALENDAR_ACCOUNT: 'primary' }),
      /invalid/i,
    );

    const callsBeforeDeniedReads = calls.length;
    for (const deniedContext of [
      { ...familyContext, userId: 'unknown' },
      { ...familyContext, chatId: 'forged-chat', recipient: 'forged-chat' },
      { ...familyContext, recipient: 'forged-recipient' },
    ]) {
      await expectError(
        () => toolByName(tools, 'family_list_events').handler(
          { date: '2026-08-23', days: 1 },
          deniedContext,
        ),
        /authenticated participant in the configured Family group chat/i,
      );
    }
    assert.equal(calls.length, callsBeforeDeniedReads, 'denied calendar read reached Google metadata');

    let eventReadAttempted = false;
    const primaryBoundTools = calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => fakeCalendar as never,
      getCalendarId: () => calendarAccount,
      getCalendarAccount: () => calendarAccount,
      now: () => Date.parse('2026-08-23T12:00:00Z'),
      createConfirmationCode: () => 'SAFE2',
    });
    await expectError(
      () => toolByName(primaryBoundTools, 'family_list_events').handler(
        { date: '2026-08-23', days: 1 },
        familyContext,
      ),
      /cannot be the authenticated primary calendar/i,
    );

    const wrongAccountClient = {
      calendarList: {
        get: async () => ({
          data: {
            id: calendarAccount,
            primary: true,
            accessRole: 'owner',
          },
        }),
      },
      events: {
        list: async () => {
          eventReadAttempted = true;
          return { data: { items: [] } };
        },
      },
    };
    const wrongAccountTools = calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => wrongAccountClient as never,
      getCalendarId: () => familyCalendarId,
      getCalendarAccount: () => 'other@example.com',
      now: () => Date.parse('2026-08-23T12:00:00Z'),
      createConfirmationCode: () => 'SAFE3',
    });
    await expectError(
      () => toolByName(wrongAccountTools, 'family_list_events').handler(
        { date: '2026-08-23', days: 1 },
        familyContext,
      ),
      /primary does not match FAMILY_CALENDAR_ACCOUNT/i,
    );

    const writerFamilyClient = {
      calendarList: {
        get: async (args: Record<string, unknown>) => ({
          data: args.calendarId === calendarAccount
            ? { id: calendarAccount, primary: true, accessRole: 'owner' }
            : { id: familyCalendarId, summary: 'Family', primary: false, accessRole: 'writer' },
        }),
      },
      events: wrongAccountClient.events,
    };
    const writerFamilyTools = calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => writerFamilyClient as never,
      getCalendarId: () => familyCalendarId,
      getCalendarAccount: () => calendarAccount,
      now: () => Date.parse('2026-08-23T12:00:00Z'),
      createConfirmationCode: () => 'SAFE4',
    });
    await expectError(
      () => toolByName(writerFamilyTools, 'family_list_events').handler(
        { date: '2026-08-23', days: 1 },
        familyContext,
      ),
      /verified owned secondary Family calendar/i,
    );
    assert.equal(eventReadAttempted, false, 'unsafe account/calendar metadata reached events.list');
  });

  test('Partial Family calendar reschedules preserve the live event duration', async () => {
    const calendarAccount = 'alex@example.com';
    const familyCalendarId = 'family-duration@group.calendar.google.com';
    const patched: Array<Record<string, unknown>> = [];
    const existingEvents: Record<string, Record<string, unknown>> = {
      'timed-move': {
        id: 'timed-move',
        summary: 'Dentist',
        status: 'confirmed',
        start: { dateTime: '2026-09-21T10:00:00-04:00' },
        end: { dateTime: '2026-09-21T12:30:00-04:00' },
      },
      'all-day-move': {
        id: 'all-day-move',
        summary: 'Family trip',
        status: 'confirmed',
        start: { date: '2026-09-21' },
        end: { date: '2026-09-24' },
      },
    };
    const fakeCalendar = {
      calendarList: {
        get: async (args: Record<string, unknown>) => ({
          data: args.calendarId === calendarAccount
            ? { id: calendarAccount, primary: true, accessRole: 'owner' }
            : { id: familyCalendarId, summary: 'Family', primary: false, accessRole: 'owner' },
        }),
      },
      events: {
        get: async (args: Record<string, unknown>) => ({
          data: existingEvents[String(args.eventId)],
        }),
        patch: async (args: Record<string, unknown>) => {
          patched.push(args);
          return { data: { id: String(args.eventId) } };
        },
      },
    };
    const tools = calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => fakeCalendar as never,
      getCalendarId: () => familyCalendarId,
      getCalendarAccount: () => calendarAccount,
      now: () => Date.parse('2026-09-19T16:00:00Z'),
      createConfirmationCode: () => 'DUR1',
    });
    const update = toolByName(tools, 'family_update_event');

    const timedMove = {
      event_id: 'timed-move',
      date: '2026-09-28',
      start_time: '15:00',
    };
    await update.handler(timedMove, grantedFamilyContext(
      'family_update_event',
      timedMove,
      'Move [event_id:timed-move] to September 28, 2026 at 3 PM',
    ));
    assert.deepEqual(patched[0].requestBody, {
      start: {
        dateTime: '2026-09-28T15:00:00',
        timeZone: calendarModule.FAMILY_CALENDAR_TIME_ZONE,
      },
      end: {
        dateTime: '2026-09-28T17:30:00',
        timeZone: calendarModule.FAMILY_CALENDAR_TIME_ZONE,
      },
    }, 'a partial timed move did not preserve the existing 150-minute duration');

    const explicitEnd = {
      event_id: 'timed-move',
      date: '2026-09-28',
      start_time: '15:00',
      end_time: '16:00',
    };
    await update.handler(explicitEnd, grantedFamilyContext(
      'family_update_event',
      explicitEnd,
      'Move [event_id:timed-move] to September 28, 2026 from 3 PM to 4 PM',
    ));
    assert.equal(
      ((patched[1].requestBody as { end: { dateTime: string } }).end.dateTime),
      '2026-09-28T16:00:00',
      'an explicitly authorized end-time change was ignored',
    );

    const allDayMove = {
      event_id: 'all-day-move',
      date: '2026-09-28',
    };
    await update.handler(allDayMove, grantedFamilyContext(
      'family_update_event',
      allDayMove,
      'Move [event_id:all-day-move] to September 28, 2026',
    ));
    assert.deepEqual(patched[2].requestBody, {
      start: { date: '2026-09-28' },
      end: { date: '2026-10-01' },
    }, 'moving an all-day range did not preserve its three-day span');
  });

  test('Family calendar create receipts prevent duplicate inserts across retries and restarts', async () => {
    const calendarAccount = 'alex@example.com';
    const familyCalendarId = 'family-receipts@group.calendar.google.com';
    const events = new Map<string, Record<string, unknown>>();
    let insertAttempts = 0;
    let nextFailure: 'before-effect' | 'after-effect' | undefined;
    const fakeCalendar = {
      calendarList: {
        get: async (args: Record<string, unknown>) => ({
          data: args.calendarId === calendarAccount
            ? { id: calendarAccount, primary: true, accessRole: 'owner' }
            : { id: familyCalendarId, summary: 'Family', primary: false, accessRole: 'owner' },
        }),
      },
      events: {
        insert: async (args: Record<string, unknown>) => {
          insertAttempts += 1;
          const failure = nextFailure;
          nextFailure = undefined;
          if (failure === 'before-effect') throw new Error('transport failed before provider effect');
          const id = `receipt-event-${insertAttempts}`;
          const body = args.requestBody as Record<string, unknown>;
          const event = { id, status: 'confirmed', ...body };
          events.set(id, event);
          if (failure === 'after-effect') throw new Error('response lost after provider effect');
          return { data: event };
        },
        get: async (args: Record<string, unknown>) => {
          const event = events.get(String(args.eventId));
          if (!event) throw new Error('not found');
          return { data: event };
        },
        list: async (args: Record<string, unknown>) => {
          const constraints = Array.isArray(args.privateExtendedProperty)
            ? args.privateExtendedProperty.map(String)
            : [String(args.privateExtendedProperty ?? '')];
          const expected = constraints[0]?.split('=').slice(1).join('=');
          const items = [...events.values()].filter((event) => {
            const properties = (event.extendedProperties as {
              private?: Record<string, string>;
            } | undefined)?.private;
            return properties?.[calendarModule.FAMILY_CALENDAR_ACTION_PROPERTY] === expected;
          });
          return { data: { items } };
        },
      },
    };
    const dependencies = {
      getCalendarClient: () => fakeCalendar as never,
      getCalendarId: () => familyCalendarId,
      getCalendarAccount: () => calendarAccount,
      now: () => Date.parse('2026-09-19T16:00:00Z'),
    };
    const tools = calendarModule.createFamilyCalendarTools(dependencies);
    const create = toolByName(tools, 'family_create_event');
    const input = {
      title: 'School conference',
      date: '2026-09-25',
      start_time: '14:00',
      end_time: '15:00',
    };
    const message = 'Schedule School conference September 25, 2026 from 2 PM to 3 PM';

    const first = String(await create.handler(
      input,
      grantedFamilyContext('family_create_event', input, message),
    ));
    assert.match(first, /Created Family event/);
    assert.equal(insertAttempts, 1);

    // A fresh iMessage retry has a different source ID but the same payload.
    // It reconciles the recent provider receipt and never inserts again.
    const retried = String(await create.handler(
      input,
      grantedFamilyContext('family_create_event', input, message),
    ));
    assert.match(retried, /already created/i);
    assert.equal(insertAttempts, 1);

    // Explicit duplicate intent bypasses payload dedupe while retaining its own
    // source-bound idempotency receipt.
    const duplicateMessage = 'Schedule another School conference September 25, 2026 from 2 PM to 3 PM';
    const duplicate = String(await create.handler(
      input,
      grantedFamilyContext('family_create_event', input, duplicateMessage),
    ));
    assert.match(duplicate, /Created Family event/);
    assert.equal(insertAttempts, 2);

    // Simulate Google creating the event and the response being lost. A new
    // tool instance stands in for a service restart and reconciles the private
    // event property instead of blindly issuing another insert.
    const uncertainInput = {
      title: 'Boiler service',
      date: '2026-09-28',
      start_time: '09:00',
      end_time: '10:00',
    };
    const uncertainMessage = 'Schedule Boiler service September 28, 2026 from 9 AM to 10 AM';
    nextFailure = 'after-effect';
    await expectError(
      () => create.handler(
        uncertainInput,
        grantedFamilyContext('family_create_event', uncertainInput, uncertainMessage),
      ),
      /did not conclusively report/i,
    );
    assert.equal(insertAttempts, 3);
    const restartedCreate = toolByName(
      calendarModule.createFamilyCalendarTools(dependencies),
      'family_create_event',
    );
    const recovered = String(await restartedCreate.handler(
      uncertainInput,
      grantedFamilyContext('family_create_event', uncertainInput, uncertainMessage),
    ));
    assert.match(recovered, /already created/i);
    assert.equal(insertAttempts, 3, 'restart recovery issued a duplicate insert');

    // A timeout with no visible provider effect remains send-in-doubt. Safety
    // wins over blind retry; an explicit new/another request is required.
    const missingInput = {
      title: 'Roof estimate',
      date: '2026-09-29',
      start_time: '11:00',
      end_time: '12:00',
    };
    const missingMessage = 'Schedule Roof estimate September 29, 2026 from 11 AM to noon';
    nextFailure = 'before-effect';
    await expectError(
      () => restartedCreate.handler(
        missingInput,
        grantedFamilyContext('family_create_event', missingInput, missingMessage),
      ),
      /did not conclusively report/i,
    );
    assert.equal(insertAttempts, 4);
    await expectError(
      () => restartedCreate.handler(
        missingInput,
        grantedFamilyContext('family_create_event', missingInput, missingMessage),
      ),
      /Nothing was retried|durable receipt/i,
    );
    assert.equal(insertAttempts, 4, 'send-in-doubt action was blindly retried');

    const receiptStates = dbModule.default.prepare(
      'SELECT state, COUNT(*) AS count FROM family_calendar_action_receipts GROUP BY state',
    ).all() as Array<{ state: string; count: number }>;
    assert.deepEqual(
      Object.fromEntries(receiptStates.map((row) => [row.state, row.count])),
      { send_in_doubt: 1, succeeded: 3 },
    );
  });

  test('Family calendar evidence accepts only positive corrections and one grounded event identity', async () => {
    const calendarAccount = 'alex@example.com';
    const familyCalendarId = 'family-evidence@group.calendar.google.com';
    const inserted: Array<Record<string, unknown>> = [];
    const patched: Array<Record<string, unknown>> = [];
    const fakeCalendar = {
      calendarList: {
        get: async (args: Record<string, unknown>) => ({
          data: args.calendarId === calendarAccount
            ? { id: calendarAccount, primary: true, accessRole: 'owner' }
            : { id: familyCalendarId, summary: 'Family', primary: false, accessRole: 'owner' },
        }),
      },
      events: {
        insert: async (args: Record<string, unknown>) => {
          inserted.push(args);
          return { data: { id: `created-${inserted.length}` } };
        },
        get: async (args: Record<string, unknown>) => ({
          data: { id: String(args.eventId), summary: 'Dentist', status: 'confirmed' },
        }),
        patch: async (args: Record<string, unknown>) => {
          patched.push(args);
          return { data: { id: String(args.eventId) } };
        },
      },
    };
    const tools = calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => fakeCalendar as never,
      getCalendarId: () => familyCalendarId,
      getCalendarAccount: () => calendarAccount,
      now: () => Date.parse('2026-09-19T16:00:00Z'),
      createConfirmationCode: () => 'EVID1',
    });
    const create = toolByName(tools, 'family_create_event');
    const update = toolByName(tools, 'family_update_event');
    const historical = (id: number, content: string) => ({
      id,
      role: 'user',
      sender: 'alex',
      content,
      created_at: '2026-09-19T15:55:00.000Z',
    });
    const correctionContext = (
      input: Record<string, unknown>,
      currentMessage: string,
      prior: Array<ReturnType<typeof historical>>,
    ) => grantedFamilyContext('family_create_event', input, currentMessage, {
      kind: 'correction',
      nowMs: Date.parse('2026-09-19T16:00:00Z'),
      recentMessages: prior,
      sourceBindings: [
        ...prior.map((message) => ({ source_ref: `message:${message.id}`, quote: message.content })),
        { source_ref: 'current', quote: currentMessage },
      ],
    });

    const correctedDate = { title: 'Dentist', date: '2026-09-25', start_time: '14:00' };
    await create.handler(
      correctedDate,
      correctionContext(
        correctedDate,
        'Actually Friday, not Thursday',
        [historical(992_001, 'Schedule Dentist Thursday at 2pm')],
      ),
    );
    const rejectedDate = { ...correctedDate, date: '2026-09-24' };
    await expectError(
      () => create.handler(
        rejectedDate,
        correctionContext(
          rejectedDate,
          'Actually Friday, not Thursday',
          [historical(992_002, 'Schedule Dentist Thursday at 2pm')],
        ),
      ),
      /date is not grounded/i,
    );

    const correctedTime = { title: 'Dentist', date: '2026-09-25', start_time: '15:00' };
    await create.handler(
      correctedTime,
      correctionContext(
        correctedTime,
        'Actually 3pm, not 2pm',
        [historical(992_003, 'Schedule Dentist Friday at 2pm')],
      ),
    );
    const rejectedTime = { ...correctedTime, start_time: '14:00' };
    await expectError(
      () => create.handler(
        rejectedTime,
        correctionContext(
          rejectedTime,
          'Actually 3pm, not 2pm',
          [historical(992_004, 'Schedule Dentist Friday at 2pm')],
        ),
      ),
      /start_time is not grounded/i,
    );

    const conflictingDate = { title: 'Dentist', date: '2026-09-24', all_day: true };
    await expectError(
      () => create.handler(conflictingDate, grantedFamilyContext(
        'family_create_event',
        conflictingDate,
        'All day',
        {
          kind: 'continuation',
          nowMs: Date.parse('2026-09-19T16:00:00Z'),
          recentMessages: [
            historical(992_005, 'Schedule Dentist Thursday'),
            historical(992_006, 'Schedule Dentist Friday'),
          ],
          sourceBindings: [
            { source_ref: 'message:992005', quote: 'Schedule Dentist Thursday' },
            { source_ref: 'message:992006', quote: 'Schedule Dentist Friday' },
            { source_ref: 'current', quote: 'All day' },
          ],
        },
      )),
      /disagree on the event date/i,
    );

    const conflictingTime = { title: 'Dentist', date: '2026-09-25', start_time: '14:00' };
    await expectError(
      () => create.handler(conflictingTime, grantedFamilyContext(
        'family_create_event',
        conflictingTime,
        'Yes',
        {
          kind: 'continuation',
          nowMs: Date.parse('2026-09-19T16:00:00Z'),
          recentMessages: [
            historical(992_007, 'Schedule Dentist Friday at 2pm'),
            historical(992_008, 'Schedule Dentist Friday at 3pm'),
          ],
          sourceBindings: [
            { source_ref: 'message:992007', quote: 'Schedule Dentist Friday at 2pm' },
            { source_ref: 'message:992008', quote: 'Schedule Dentist Friday at 3pm' },
            { source_ref: 'current', quote: 'Yes' },
          ],
        },
      )),
      /disagree on the event time/i,
    );

    const stitchedTitle = { title: 'Annual dental', date: '2026-09-25', start_time: '14:00' };
    await expectError(
      () => create.handler(stitchedTitle, grantedFamilyContext(
        'family_create_event',
        stitchedTitle,
        'Dental Friday at 2pm',
        {
          kind: 'continuation',
          nowMs: Date.parse('2026-09-19T16:00:00Z'),
          recentMessages: [historical(992_009, 'Schedule annual')],
          sourceBindings: [
            { source_ref: 'message:992009', quote: 'Schedule annual' },
            { source_ref: 'current', quote: 'Dental Friday at 2pm' },
          ],
        },
      )),
      /title is not grounded/i,
    );

    const unrelatedLineage = { title: 'Dentist', date: '2026-09-25', start_time: '14:00' };
    await expectError(
      () => create.handler(unrelatedLineage, grantedFamilyContext(
        'family_create_event',
        unrelatedLineage,
        'Yes',
        {
          kind: 'continuation',
          nowMs: Date.parse('2026-09-19T16:00:00Z'),
          recentMessages: [
            historical(992_010, 'Schedule Dentist'),
            historical(992_011, 'Schedule Plumber Friday at 2pm'),
          ],
          sourceBindings: [
            { source_ref: 'message:992010', quote: 'Schedule Dentist' },
            { source_ref: 'message:992011', quote: 'Schedule Plumber Friday at 2pm' },
            { source_ref: 'current', quote: 'Yes' },
          ],
        },
      )),
      /same pending request as the title/i,
    );

    const compactOvernight = {
      title: 'Dentist',
      date: '2026-09-25',
      start_time: '11:00',
      end_time: '01:00',
      end_date: '2026-09-26',
    };
    await expectError(
      () => create.handler(compactOvernight, grantedFamilyContext(
        'family_create_event', compactOvernight, 'Schedule Dentist Friday 11-1am through Saturday',
      )),
      /compact overnight time range is ambiguous/i,
    );

    const wrongExclusiveEnd = {
      title: 'Dentist',
      date: '2026-09-25',
      end_date: '2026-09-27',
      all_day: true,
    };
    await expectError(
      () => create.handler(wrongExclusiveEnd, grantedFamilyContext(
        'family_create_event', wrongExclusiveEnd, 'Schedule Dentist Friday through Sunday all day', {
          nowMs: Date.parse('2026-09-19T16:00:00Z'),
        },
      )),
      /end_date is not grounded/i,
    );
    const correctExclusiveEnd = { ...wrongExclusiveEnd, end_date: '2026-09-28' };
    await create.handler(correctExclusiveEnd, grantedFamilyContext(
      'family_create_event', correctExclusiveEnd, 'Schedule Dentist Friday through Sunday all day', {
        nowMs: Date.parse('2026-09-19T16:00:00Z'),
      },
    ));

    const ambiguousUpdate = {
      event_id: 'dentist-a',
      location: 'Clinic',
    };
    const duplicateDentistResults = [{
      role: 'assistant',
      content: [
        '[event_id:dentist-a] Fri 2:00 PM — Dentist',
        '[event_id:dentist-b] Fri 3:00 PM — Dentist',
      ].join('\n'),
      created_at: new Date().toISOString(),
    }];
    await expectError(
      () => update.handler(ambiguousUpdate, grantedFamilyContext(
        'family_update_event', ambiguousUpdate, 'Move Dentist to Clinic', {
          recentMessages: duplicateDentistResults,
        },
      )),
      /more than one recent Family event matches/i,
    );
    assert.equal(patched.length, 0, 'an ambiguous title reached events.patch');

    await update.handler(ambiguousUpdate, grantedFamilyContext(
      'family_update_event', ambiguousUpdate, 'Move [event_id:dentist-a] to Clinic', {
        recentMessages: duplicateDentistResults,
      },
    ));
    assert.equal(patched.length, 1, 'an explicit current event ID was not authoritative');

    const audienceDeniedInput = {
      title: 'Dentist',
      date: '2026-09-25',
      start_time: '14:00',
    };
    const audienceDeniedContext = grantedFamilyContext(
      'family_create_event', audienceDeniedInput, 'Schedule Dentist Friday at 2pm', {
        nowMs: Date.parse('2026-09-19T16:00:00Z'),
      },
    );
    await expectError(
      () => create.handler(audienceDeniedInput, {
        ...audienceDeniedContext,
        reverifyFamilyAudience: async () => false,
      }),
      /participant set changed or could not be re-verified/i,
    );
    assert.equal(inserted.length, 3, 'a rejected calendar evidence case reached events.insert');
  });

  test('Family calendar word clocks require an explicit meridiem or daypart', async () => {
    const calendarAccount = 'alex@example.com';
    const familyCalendarId = 'family-word-clock@group.calendar.google.com';
    const inserted: Array<Record<string, unknown>> = [];
    const fakeCalendar = {
      calendarList: {
        get: async (args: Record<string, unknown>) => ({
          data: args.calendarId === calendarAccount
            ? { id: calendarAccount, primary: true, accessRole: 'owner' }
            : { id: familyCalendarId, summary: 'Family', primary: false, accessRole: 'owner' },
        }),
      },
      events: {
        insert: async (args: Record<string, unknown>) => {
          inserted.push(args);
          return { data: { id: `word-clock-${inserted.length}` } };
        },
      },
    };
    const create = toolByName(calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => fakeCalendar as never,
      getCalendarId: () => familyCalendarId,
      getCalendarAccount: () => calendarAccount,
      now: () => Date.parse('2026-09-19T16:00:00Z'),
    }), 'family_create_event');

    const cases = [
      {
        input: { title: 'Family dinner', date: '2026-09-22', start_time: '18:00' },
        message: 'Family dinner on September 22, 2026 at six pm',
      },
      {
        input: { title: 'Family breakfast', date: '2026-09-23', start_time: '06:00' },
        message: 'Schedule Family breakfast on September 23, 2026 at six in the morning',
      },
      {
        input: { title: 'Family movie', date: '2026-09-24', start_time: '18:00' },
        message: 'Schedule Family movie on September 24, 2026 at six in the evening',
      },
    ];
    for (const candidate of cases) {
      await create.handler(
        candidate.input,
        grantedFamilyContext('family_create_event', candidate.input, candidate.message),
      );
    }
    assert.equal(inserted.length, cases.length);

    const ambiguous = { title: 'Family walk', date: '2026-09-25', start_time: '18:00' };
    await expectError(
      () => create.handler(
        ambiguous,
        grantedFamilyContext(
          'family_create_event',
          ambiguous,
          'Schedule Family walk on September 25, 2026 at six',
        ),
      ),
      /start_time is not grounded/i,
    );
    assert.equal(inserted.length, cases.length, 'an ambiguous word clock reached events.insert');
  });

  test('Family calendar rejects recurrence, non-Eastern zones, and invalid DST wall times', async () => {
    const calendarAccount = 'alex@example.com';
    const familyCalendarId = 'family-calendar-edge-cases@group.calendar.google.com';
    const inserted: Array<Record<string, unknown>> = [];
    const fakeCalendar = {
      calendarList: {
        get: async (args: Record<string, unknown>) => ({
          data: args.calendarId === calendarAccount
            ? { id: calendarAccount, primary: true, accessRole: 'owner' }
            : { id: familyCalendarId, summary: 'Family', primary: false, accessRole: 'owner' },
        }),
      },
      events: {
        insert: async (args: Record<string, unknown>) => {
          inserted.push(args);
          return { data: { id: `edge-case-${inserted.length}` } };
        },
      },
    };
    const create = toolByName(calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => fakeCalendar as never,
      getCalendarId: () => familyCalendarId,
      getCalendarAccount: () => calendarAccount,
      now: () => Date.parse('2026-09-19T16:00:00Z'),
    }), 'family_create_event');
    const ordinaryInput = {
      title: 'Swim lesson',
      date: '2026-09-22',
      start_time: '07:00',
    };

    const recurrenceRequests = [
      'Schedule Swim lesson every other Tuesday at 7am starting September 22, 2026',
      'Schedule Swim lesson biweekly at 7am starting September 22, 2026',
      'Schedule Swim lesson fortnightly at 7am starting September 22, 2026',
      'Schedule Swim lesson daily at 7am starting September 22, 2026',
      'Schedule Swim lesson weekly at 7am starting September 22, 2026',
      'Schedule Swim lesson monthly at 7am starting September 22, 2026',
      'Schedule Swim lesson on weekdays at 7am starting September 22, 2026',
      'Schedule Swim lesson on weekends at 7am starting September 22, 2026',
      'Schedule Swim lesson as a series of events starting September 22, 2026 at 7am',
      'Schedule Swim lesson September 22, 2026 at 7am and apply it to all future events',
    ];
    for (const message of recurrenceRequests) {
      await expectError(
        () => create.handler(
          ordinaryInput,
          grantedFamilyContext('family_create_event', ordinaryInput, message),
        ),
        /Recurring Family calendar events are not supported/i,
      );
    }
    assert.equal(inserted.length, 0, 'recurrence language degraded into one calendar event');

    const nonEasternZones = [
      'PT', 'PST', 'PDT', 'Pacific Time',
      'CT', 'CST', 'CDT', 'Central Time',
      'MT', 'MST', 'MDT', 'Mountain Time',
      'UTC', 'GMT', 'Europe/London',
    ];
    const timezoneInput = {
      title: 'Timezone call',
      date: '2026-09-23',
      start_time: '10:00',
    };
    for (const zone of nonEasternZones) {
      const message = `Schedule Timezone call September 23, 2026 at 10am ${zone}`;
      await expectError(
        () => create.handler(
          timezoneInput,
          grantedFamilyContext('family_create_event', timezoneInput, message),
        ),
        /use Eastern Time.*timezone needs clarification/i,
      );
    }
    assert.equal(inserted.length, 0, 'a non-Eastern timezone was silently stored as Eastern');

    const allowedEasternCases = [
      {
        input: { title: 'Eastern call', date: '2026-10-01', start_time: '10:00' },
        message: 'Schedule Eastern call October 1, 2026 at 10am ET',
      },
      {
        input: { title: 'Winter call', date: '2026-12-01', start_time: '10:00' },
        message: 'Schedule Winter call December 1, 2026 at 10am EST',
      },
      {
        input: { title: 'Summer call', date: '2027-06-01', start_time: '10:00' },
        message: 'Schedule Summer call June 1, 2027 at 10am EDT',
      },
      {
        input: { title: 'PT appointment', date: '2026-10-02', start_time: '10:00' },
        message: 'Schedule PT appointment October 2, 2026 at 10am',
      },
    ];
    for (const candidate of allowedEasternCases) {
      await create.handler(
        candidate.input,
        grantedFamilyContext('family_create_event', candidate.input, candidate.message),
      );
    }
    assert.equal(inserted.length, allowedEasternCases.length, 'an Eastern timezone label was rejected');

    const invalidWallTimes = [
      {
        input: { title: 'DST gap', date: '2027-03-14', start_time: '02:30' },
        message: 'Schedule DST gap March 14, 2027 at 2:30am',
        error: /start_time 02:30 does not exist.*daylight-saving/i,
      },
      {
        input: {
          title: 'DST end gap',
          date: '2027-03-14',
          start_time: '01:30',
          end_time: '02:30',
        },
        message: 'Schedule DST end gap March 14, 2027 from 1:30am to 2:30am',
        error: /end_time 02:30 does not exist.*daylight-saving/i,
      },
      {
        input: { title: 'DST fold', date: '2027-11-07', start_time: '01:30' },
        message: 'Schedule DST fold November 7, 2027 at 1:30am',
        error: /start_time 01:30 occurs twice.*daylight-saving/i,
      },
      {
        input: {
          title: 'DST folded end',
          date: '2027-11-07',
          start_time: '00:30',
          end_time: '01:30',
        },
        message: 'Schedule DST folded end November 7, 2027 from 12:30am to 1:30am',
        error: /end_time 01:30 occurs twice.*daylight-saving/i,
      },
    ];
    for (const candidate of invalidWallTimes) {
      await expectError(
        () => create.handler(
          candidate.input,
          grantedFamilyContext('family_create_event', candidate.input, candidate.message),
        ),
        candidate.error,
      );
    }
    assert.equal(
      inserted.length,
      allowedEasternCases.length,
      'an invalid or repeated DST wall time reached events.insert',
    );
  });

  test('Event deletion confirmation is requester-, chat-, calendar-, and time-bound', async () => {
    const calendarAccount = 'alex@example.com';
    const familyCalendarId = 'family-delete@group.calendar.google.com';
    let configuredCalendarId = familyCalendarId;
    let nowMs = 1_000_000;
    const codes = ['DEL1', 'DEL2', 'DEL3'];
    const deletes: Array<Record<string, unknown>> = [];
    const fakeCalendar = {
      calendarList: {
        get: async (args: Record<string, unknown>) => ({
          data: args.calendarId === calendarAccount
            ? { id: calendarAccount, primary: true, accessRole: 'owner' }
            : {
                id: configuredCalendarId,
                summary: 'Family',
                primary: false,
                accessRole: 'owner',
              },
        }),
      },
      events: {
        get: async (args: Record<string, unknown>) => ({
          data: { id: String(args.eventId), summary: 'Disposable event', status: 'confirmed' },
        }),
        delete: async (args: Record<string, unknown>) => {
          deletes.push(args);
          return { data: {} };
        },
      },
    };
    const tools = calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => fakeCalendar as never,
      getCalendarId: () => configuredCalendarId,
      getCalendarAccount: () => calendarAccount,
      now: () => nowMs,
      createConfirmationCode: () => codes.shift() ?? 'DELFALLBACK',
    });
    const requestDelete = toolByName(tools, 'family_request_event_delete');
    const confirmDelete = toolByName(tools, 'family_confirm_event_delete');
    const deleteContext = (
      toolName: 'family_request_event_delete' | 'family_confirm_event_delete',
      toolInput: Record<string, unknown>,
      turnId: string,
      currentMessage: string,
      userId = 'alex',
      chatId = 'test-family-chat',
    ) => grantedFamilyContext(toolName, toolInput, currentMessage, {
      userId,
      chatId,
      recipient: chatId,
      turnId,
    });

    await requestDelete.handler(
      { event_id: 'event-one' },
      deleteContext(
        'family_request_event_delete',
        { event_id: 'event-one' },
        'request-1',
        'Delete [event_id:event-one]',
      ),
    );
    await expectError(
      () => confirmDelete.handler(
        { confirmation_code: 'DEL1' },
        deleteContext(
          'family_confirm_event_delete',
          { confirmation_code: 'DEL1' },
          'request-1',
          'confirm delete DEL1',
        ),
      ),
      /later inbound message/i,
    );
    await expectError(
      () => confirmDelete.handler(
        { confirmation_code: 'DEL1' },
        deleteContext(
          'family_confirm_event_delete',
          { confirmation_code: 'DEL1' },
          'confirm-wrong-user',
          'confirm delete DEL1',
          'sam',
        ),
      ),
      /Only the original requester/i,
    );
    await expectError(
      () => confirmDelete.handler(
        { confirmation_code: 'DEL1' },
        deleteContext(
          'family_confirm_event_delete',
          { confirmation_code: 'DEL1' },
          'confirm-without-code',
          'yes, delete it',
        ),
      ),
      /exact current-message confirmation code/i,
    );
    const originalFamilyChat = process.env.GROUP_FAMILY;
    process.env.GROUP_FAMILY = 'different-family-chat';
    try {
      await expectError(
        () => confirmDelete.handler(
          { confirmation_code: 'DEL1' },
          deleteContext(
            'family_confirm_event_delete',
            { confirmation_code: 'DEL1' },
            'confirm-wrong-chat',
            'confirm delete DEL1',
            'alex',
            'different-family-chat',
          ),
        ),
        /same Family chat/i,
      );
    } finally {
      process.env.GROUP_FAMILY = originalFamilyChat;
    }
    configuredCalendarId = 'changed-family-calendar@group.calendar.google.com';
    await expectError(
      () => confirmDelete.handler(
        { confirmation_code: 'DEL1' },
        deleteContext(
          'family_confirm_event_delete',
          { confirmation_code: 'DEL1' },
          'confirm-changed-calendar',
          'confirm delete DEL1',
        ),
      ),
      /configured Family calendar binding changed/i,
    );
    assert.equal(deletes.length, 0);

    configuredCalendarId = familyCalendarId;
    nowMs = 2_000_000;
    await requestDelete.handler(
      { event_id: 'event-two' },
      deleteContext(
        'family_request_event_delete',
        { event_id: 'event-two' },
        'request-2',
        'Delete [event_id:event-two]',
      ),
    );
    nowMs += calendarModule.FAMILY_DELETE_CONFIRMATION_TTL_MS - 1;
    await confirmDelete.handler(
      { confirmation_code: 'DEL2' },
      deleteContext(
        'family_confirm_event_delete',
        { confirmation_code: 'DEL2' },
        'confirm-2',
        'confirm delete DEL2',
      ),
    );
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].calendarId, familyCalendarId);
    assert.equal(deletes[0].eventId, 'event-two');

    nowMs = 3_000_000;
    await requestDelete.handler(
      { event_id: 'event-three' },
      deleteContext(
        'family_request_event_delete',
        { event_id: 'event-three' },
        'request-3',
        'Delete [event_id:event-three]',
      ),
    );
    nowMs += calendarModule.FAMILY_DELETE_CONFIRMATION_TTL_MS;
    await expectError(
      () => confirmDelete.handler(
        { confirmation_code: 'DEL3' },
        deleteContext(
          'family_confirm_event_delete',
          { confirmation_code: 'DEL3' },
          'confirm-3',
          'confirm delete DEL3',
        ),
      ),
      /expired/i,
    );
    assert.equal(deletes.length, 1);
  });

  test('Event deletion rechecks live attendee and event state at confirmation time', async () => {
    const calendarAccount = 'alex@example.com';
    const familyCalendarId = 'family-delete-live-check@group.calendar.google.com';
    let hasExternalAttendee = false;
    let deleteDispatches = 0;
    const fakeCalendar = {
      calendarList: {
        get: async (args: Record<string, unknown>) => ({
          data: args.calendarId === calendarAccount
            ? { id: calendarAccount, primary: true, accessRole: 'owner' }
            : { id: familyCalendarId, summary: 'Family', primary: false, accessRole: 'owner' },
        }),
      },
      events: {
        get: async (args: Record<string, unknown>) => ({
          data: {
            id: String(args.eventId),
            summary: 'Dentist',
            status: 'confirmed',
            attendees: hasExternalAttendee ? [{ email: 'guest@example.invalid' }] : [],
          },
        }),
        delete: async () => {
          deleteDispatches += 1;
          return { data: {} };
        },
      },
    };
    const tools = calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => fakeCalendar as never,
      getCalendarId: () => familyCalendarId,
      getCalendarAccount: () => calendarAccount,
      now: () => 7_000_000,
      createConfirmationCode: () => 'LIVE1',
    });
    const request = toolByName(tools, 'family_request_event_delete');
    const confirm = toolByName(tools, 'family_confirm_event_delete');
    const eventInput = { event_id: 'dentist-live' };
    await request.handler(eventInput, grantedFamilyContext(
      'family_request_event_delete', eventInput, 'Delete [event_id:dentist-live]', {
        turnId: 'live-delete-request',
      },
    ));

    hasExternalAttendee = true;
    const confirmationInput = { confirmation_code: 'LIVE1' };
    await expectError(
      () => confirm.handler(confirmationInput, grantedFamilyContext(
        'family_confirm_event_delete', confirmationInput, 'confirm delete LIVE1', {
          turnId: 'live-delete-confirm-1',
        },
      )),
      /external attendees/i,
    );
    assert.equal(deleteDispatches, 0, 'stale request-time state reached events.delete');

    hasExternalAttendee = false;
    await confirm.handler(confirmationInput, grantedFamilyContext(
      'family_confirm_event_delete', confirmationInput, 'confirm delete LIVE1', {
        turnId: 'live-delete-confirm-2',
      },
    ));
    assert.equal(deleteDispatches, 1, 'a pre-dispatch live-state refusal consumed the confirmation');
  });

  test('Event deletion is concurrency-safe, restart-safe, and send-in-doubt safe', async () => {
    const calendarAccount = 'alex@example.com';
    const familyCalendarId = 'family-delete-hardening@group.calendar.google.com';
    let accessRole = 'owner';
    let throwAfterDeleteDispatch = false;
    let deleteDispatches = 0;
    const fakeCalendar = {
      calendarList: {
        get: async (args: Record<string, unknown>) => ({
          data: args.calendarId === calendarAccount
            ? { id: calendarAccount, primary: true, accessRole: 'owner' }
            : { id: familyCalendarId, summary: 'Family', primary: false, accessRole },
        }),
      },
      events: {
        get: async (args: Record<string, unknown>) => ({
          data: { id: String(args.eventId), summary: 'Disposable event', status: 'confirmed' },
        }),
        delete: async () => {
          deleteDispatches += 1;
          if (throwAfterDeleteDispatch) throw new Error('transport status unknown');
          return { data: {} };
        },
      },
    };
    const makeTools = (code: string) => calendarModule.createFamilyCalendarTools({
      getCalendarClient: () => fakeCalendar as never,
      getCalendarId: () => familyCalendarId,
      getCalendarAccount: () => calendarAccount,
      now: () => 5_000_000,
      createConfirmationCode: () => code,
    });
    const context = (
      toolName: 'family_request_event_delete' | 'family_confirm_event_delete',
      toolInput: Record<string, unknown>,
      turnId: string,
      currentMessage: string,
    ) => grantedFamilyContext(toolName, toolInput, currentMessage, { turnId });

    const concurrentTools = makeTools('CON1');
    await toolByName(concurrentTools, 'family_request_event_delete').handler(
      { event_id: 'event-concurrent' },
      context(
        'family_request_event_delete',
        { event_id: 'event-concurrent' },
        'request-concurrent',
        'Delete [event_id:event-concurrent]',
      ),
    );
    const concurrent = await Promise.allSettled([
      toolByName(concurrentTools, 'family_confirm_event_delete').handler(
        { confirmation_code: 'CON1' },
        context(
          'family_confirm_event_delete',
          { confirmation_code: 'CON1' },
          'confirm-concurrent-a',
          'confirm delete CON1',
        ),
      ),
      toolByName(concurrentTools, 'family_confirm_event_delete').handler(
        { confirmation_code: 'CON1' },
        context(
          'family_confirm_event_delete',
          { confirmation_code: 'CON1' },
          'confirm-concurrent-b',
          'confirm delete CON1',
        ),
      ),
    ]);
    assert.equal(concurrent.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(concurrent.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(deleteDispatches, 1, 'concurrent confirmations dispatched more than one delete');

    const restartedTools = makeTools('UNUSED');
    await expectError(
      () => toolByName(restartedTools, 'family_confirm_event_delete').handler(
        { confirmation_code: 'CON1' },
        context(
          'family_confirm_event_delete',
          { confirmation_code: 'CON1' },
          'confirm-after-restart',
          'confirm delete CON1',
        ),
      ),
      /No pending Family event deletion/i,
    );
    assert.equal(deleteDispatches, 1);

    const ambiguousTools = makeTools('AMB1');
    await toolByName(ambiguousTools, 'family_request_event_delete').handler(
      { event_id: 'event-ambiguous' },
      context(
        'family_request_event_delete',
        { event_id: 'event-ambiguous' },
        'request-ambiguous',
        'Delete [event_id:event-ambiguous]',
      ),
    );
    throwAfterDeleteDispatch = true;
    await expectError(
      () => toolByName(ambiguousTools, 'family_confirm_event_delete').handler(
        { confirmation_code: 'AMB1' },
        context(
          'family_confirm_event_delete',
          { confirmation_code: 'AMB1' },
          'confirm-ambiguous',
          'confirm delete AMB1',
        ),
      ),
      /confirmation was consumed/i,
    );
    await expectError(
      () => toolByName(ambiguousTools, 'family_confirm_event_delete').handler(
        { confirmation_code: 'AMB1' },
        context(
          'family_confirm_event_delete',
          { confirmation_code: 'AMB1' },
          'retry-ambiguous',
          'confirm delete AMB1',
        ),
      ),
      /No pending Family event deletion/i,
    );
    assert.equal(deleteDispatches, 2, 'send-in-doubt confirmation was replayed');

    throwAfterDeleteDispatch = false;
    const retryableTools = makeTools('RET1');
    await toolByName(retryableTools, 'family_request_event_delete').handler(
      { event_id: 'event-retryable' },
      context(
        'family_request_event_delete',
        { event_id: 'event-retryable' },
        'request-retryable',
        'Delete [event_id:event-retryable]',
      ),
    );
    accessRole = 'writer';
    await expectError(
      () => toolByName(retryableTools, 'family_confirm_event_delete').handler(
        { confirmation_code: 'RET1' },
        context(
          'family_confirm_event_delete',
          { confirmation_code: 'RET1' },
          'confirm-before-dispatch-fails',
          'confirm delete RET1',
        ),
      ),
      /verified owned secondary Family calendar/i,
    );
    accessRole = 'owner';
    await toolByName(retryableTools, 'family_confirm_event_delete').handler(
      { confirmation_code: 'RET1' },
      context(
        'family_confirm_event_delete',
        { confirmation_code: 'RET1' },
        'confirm-after-preflight-recovers',
        'confirm delete RET1',
      ),
    );
    assert.equal(deleteDispatches, 3, 'pre-dispatch failure did not remain safely retryable');
  });

  test('Daily and Sunday schedules use Family-only data, Family target, and restart-safe dedup', async () => {
    assert.equal(schedulerModule.FAMILY_GROUP_KEY, 'family');
    assert.equal(schedulerModule.FAMILY_TIME_ZONE, 'America/New_York');
    assert.deepEqual(schedulerModule.familyScheduleExpressions({}), {
      daily: '0 7 * * *',
      weekly: '30 19 * * 0',
    });

    const queries: Array<Record<string, unknown>> = [];
    const memoryCalls: Array<{ action: string; groupId: string; key: string }> = [];
    const deliveryMemory = new Map<string, string>();
    const sends: Array<{ recipient: string; text: string }> = [];
    const memoryKey = (groupId: string, key: string) => `${groupId}:${key}`;
    const makeDeps = () => ({
      data: {
        listFamilyCalendarEvents: (query: FamilyCalendarRange) => {
          queries.push({ kind: 'calendar', ...query });
          return [{
            id: 'family-event',
            title: 'Family schedule item',
            start: String(query.startDate),
            allDay: true,
          }];
        },
        listOpenFamilyItems: (query: FamilyListQuery) => {
          queries.push({ kind: 'lists', ...query });
          return [{
            id: 1,
            listName: 'Groceries',
            text: 'Milk',
            quantity: '2',
            status: 'open',
          }];
        },
        listOpenFamilyCoordinationNotes: (query: FamilyCoordinationQuery) => {
          queries.push({ kind: 'coordination', ...query });
          return [{ id: 1, text: 'Confirm pickup', resolved: false }];
        },
      },
      memory: {
        get: (groupId: 'family', key: string) => {
          memoryCalls.push({ action: 'get', groupId, key });
          return deliveryMemory.get(memoryKey(groupId, key));
        },
        set: (groupId: 'family', key: string, value: string) => {
          memoryCalls.push({ action: 'set', groupId, key });
          deliveryMemory.set(memoryKey(groupId, key), value);
        },
        delete: (groupId: 'family', key: string) => {
          memoryCalls.push({ action: 'delete', groupId, key });
          deliveryMemory.delete(memoryKey(groupId, key));
        },
      },
      sendMessage: (recipient: string, text: string) => {
        sends.push({ recipient, text });
      },
      authorizeTarget: () => true,
      env: {
        GROUP_FAMILY: 'test-family-chat',
        GROUP_ADMIN: 'private-admin-chat',
        DM_RECIPIENT: '+13475550101',
      },
      logger: {
        log: () => undefined,
        warn: () => undefined,
        error: () => undefined,
      },
    });

    const sundayMorning = new Date('2026-08-23T11:00:00.000Z');
    const daily = await schedulerModule.runFamilyDailyUpdate(makeDeps(), sundayMorning);
    assert.equal(daily.status, 'sent');
    const dailyAfterRestart = await schedulerModule.runFamilyDailyUpdate(makeDeps(), sundayMorning);
    assert.equal(dailyAfterRestart.status, 'duplicate');

    const sundayEvening = new Date('2026-08-23T23:30:00.000Z');
    const weekly = await schedulerModule.runFamilyWeeklyUpdate(makeDeps(), sundayEvening);
    assert.equal(weekly.status, 'sent');
    const weeklyAfterRestart = await schedulerModule.runFamilyWeeklyUpdate(makeDeps(), sundayEvening);
    assert.equal(weeklyAfterRestart.status, 'duplicate');

    const uncertainMemory = new Map<string, string>();
    const uncertainSendAttempts: Array<{ recipient: string; text: string }> = [];
    const makeUncertainDeps = () => {
      const base = makeDeps();
      return {
        ...base,
        memory: {
          get: (_groupId: 'family', key: string) => uncertainMemory.get(key),
          set: (_groupId: 'family', key: string, value: string) => {
            uncertainMemory.set(key, value);
          },
          delete: (_groupId: 'family', key: string) => {
            uncertainMemory.delete(key);
          },
        },
        sendMessage: (recipient: string, text: string) => {
          // Simulate Messages accepting/recording the outbound payload and then
          // reporting an ambiguous transport failure.
          uncertainSendAttempts.push({ recipient, text });
          throw new Error('transport status unknown after dispatch');
        },
      };
    };
    const uncertainDate = new Date('2026-08-26T11:00:00.000Z');
    await expectError(
      () => schedulerModule.runFamilyDailyUpdate(makeUncertainDeps(), uncertainDate),
      /transport status unknown after dispatch/i,
    );
    const uncertainKey = schedulerModule.familyDailyDeliveryKey(uncertainDate);
    assert.match(uncertainMemory.get(uncertainKey) ?? '', /"state":"sending"/);
    const uncertainAfterRestart = await schedulerModule.runFamilyDailyUpdate(
      makeUncertainDeps(),
      uncertainDate,
    );
    assert.equal(uncertainAfterRestart.status, 'duplicate');
    assert.equal(uncertainSendAttempts.length, 1, 'send-in-doubt Family update replayed after dependency recreation');

    const queriesBeforeSuspension = queries.length;
    const sendsBeforeSuspension = sends.length;
    const suspended = await schedulerModule.runFamilyDailyUpdate({
      ...makeDeps(),
      authorizeTarget: () => false,
    }, new Date('2026-08-24T11:00:00.000Z'));
    assert.equal(suspended.status, 'disabled');
    assert.equal(queries.length, queriesBeforeSuspension, 'suspended schedule read Family data');
    assert.equal(sends.length, sendsBeforeSuspension, 'suspended schedule sent to changed membership');

    let authorizationChecks = 0;
    const sendsBeforeMembershipRace = sends.length;
    const raceClosed = await schedulerModule.runFamilyDailyUpdate({
      ...makeDeps(),
      authorizeTarget: () => {
        authorizationChecks += 1;
        return authorizationChecks === 1;
      },
    }, new Date('2026-08-25T11:00:00.000Z'));
    assert.equal(raceClosed.status, 'disabled');
    assert.equal(authorizationChecks, 2, 'membership was not rechecked immediately before send');
    assert.equal(sends.length, sendsBeforeMembershipRace, 'membership changed during build but update was sent');

    assert.equal(sends.length, 2);
    assert.ok(sends.every((send) => send.recipient === 'test-family-chat'));
    assert.ok(sends.every((send) => !send.text.includes('__PRIVATE_')));
    assert.ok(queries.length > 0);
    assert.ok(queries.every((query) => query.groupId === 'family'));
    assert.ok(memoryCalls.length > 0);
    assert.ok(memoryCalls.every((call) => call.groupId === 'family'));
    assert.equal(sends.some((send) => send.recipient === 'private-admin-chat'), false);
    assert.equal(sends.some((send) => send.recipient === '+13475550101'), false);
  });

  let failures = 0;
  for (const entry of tests) {
    try {
      // Calendar idempotency receipts are intentionally durable within one
      // scenario. Clear them between isolated acceptance scenarios so two
      // unrelated fixtures with the same event payload cannot affect each other.
      dbModule.default.prepare('DELETE FROM family_calendar_action_receipts').run();
      await entry.body();
      console.log(`PASS  ${entry.name}`);
    } catch (error) {
      failures += 1;
      console.error(`FAIL  ${entry.name}`);
      console.error(error instanceof Error ? error.stack ?? error.message : error);
    }
  }

  dbModule.default.close();
  rmSync(tempRoot, { recursive: true, force: true });

  if (failures > 0) {
    throw new Error(`${failures} Family access acceptance check${failures === 1 ? '' : 's'} failed.`);
  }
  console.log(`\nFamily access gate passed: ${tests.length} checks.`);
}

void main().catch((error) => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup for an isolated temp fixture.
  }
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
