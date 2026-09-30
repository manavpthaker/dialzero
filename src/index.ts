import 'dotenv/config';
import { startIMessage, setMessageHandler, sendMessage } from './channels/imessage.js';
import { initUsers, resolveUser, isAllowed, getRedirectMessage } from './user-resolver.js';
import { initGroups, resolveGroup } from './group-resolver.js';
import { runAgent, FAMILY_SILENT_RESPONSE } from './agent.js';
import { detectMode } from './router.js';
import { createAsyncTask, completeAsyncTask, failAsyncTask } from './db.js';
import { registerMcpTools } from './tools/index.js';
import { startScheduler } from './scheduler.js';
import { startHeartbeat } from './heartbeat.js';
import { startJournal, handleJournalReply } from './journal.js';
import { startBrainPulse } from './brain-pulse.js';
import { startRelationshipPulse } from './relationship-pulse.js';
import { startIdeaPulse } from './idea-pulse.js';
import { startHygieneLoop } from './hygiene.js';
import { startBrowserBridge } from './browser-bridge.js';
import { startDashboard } from './dashboard.js';
import { startVoice } from './voice.js';
import { startPhone } from './phone.js';
import { startErrands } from './errands.js';
import { startWakeUpCalls } from './wakeup.js';
import { startWebTaskRunner } from './web-task.js';
import { startCheckins } from './checkins.js';
import { automationsOff, automationAllowed } from './lib/automations-off.js';
import { withLlmContext } from './lib/llm-context.js';
import { startFamilyRuntimeScheduler } from './family-runtime.js';
import { verifySharedAudience } from './family-membership.js';
import { startEmailReconciliationRuntime } from './email-reconciliation.js';
import { isOwnedOn, moduleFor, resolveModules } from './modules.js';

// Fixed receipt ack fired the instant a message lands, so the user knows it was
// received while the agent works. Deliberately NOT per-message generated — the
// LLM-written acks kept drifting out of context. One reliable signal beats a
// clever-but-wrong restatement. (Emoji is intentional here; the voice.md
// no-emoji rule governs the agent's actual replies, not this plumbing signal.)
const RECEIVED_ACK = '👀👍🏽';
function isSilentFamilyResponse(groupKey: string, response: string): boolean {
  return groupKey === 'family' && response.trim() === FAMILY_SILENT_RESPONSE;
}

/** Shared-chat membership can change while a model call is running. Re-check
 * immediately before every visible send so a newly added participant never
 * receives a response that was prepared for the approved audience. */
async function sendIfAudienceStillApproved(
  recipient: string,
  group: ReturnType<typeof resolveGroup>,
  text: string,
): Promise<boolean> {
  if (!group) return false;
  if (!(await verifySharedAudience(recipient, group))) return false;
  await sendMessage(recipient, text);
  return true;
}

async function main() {
  console.log('[assistant] Starting...');

  // Initialize users and groups from .env
  initUsers();
  initGroups();

  // Start MCP servers (Instacart, Spotify, etc.)
  await registerMcpTools();

  const moduleStates = resolveModules();
  console.log(
    `[assistant] modules on: ${moduleStates.filter((m) => m.on).map((m) => m.id).join(', ')}`
    + ` | off: ${moduleStates.filter((m) => !m.on).map((m) => m.id).join(', ') || 'none'}`,
  );

  // Services that answer the owner directly. Each runs only if its module
  // (src/modules.ts) is on; none is held back by AUTOMATIONS_OFF.
  const services: Array<[string, () => void]> = [
    ['browser-bridge', startBrowserBridge],        // WebSocket server for the Chrome extension
    ['dashboard', startDashboard],                 // local brain dashboard at http://127.0.0.1:4000
    ['voice', startVoice],                         // iOS Shortcut endpoint (loopback; exposed via tailscale serve)
    ['phone', startPhone],
    // Errands run outside the AUTOMATIONS_OFF gate: each one is work the owner
    // explicitly approved with "go", not ambient chatter. Own kill switch: ERRANDS_ENABLED.
    ['errands', startErrands],
    // Wake-up calls: the owner set each one themselves, so also outside the gate.
    // Own kill switch: WAKEUP_CALLS_ENABLED.
    ['wakeup', startWakeUpCalls],
    // Website jobs the owner started keep going across restarts until done.
    ['web-task', startWebTaskRunner],
  ];
  for (const [key, start] of services) {
    if (!isOwnedOn('start', key)) continue;
    try { start(); }
    catch (err) { console.error(`[assistant] ${key} failed to start:`, err); }
  }

  // Set up message handler
  setMessageHandler(async ({ remoteJid, senderJid, text, image, document, sourceMessage }) => {
    // 1. Resolve the destination before the sender so a changed shared-chat
    // participant set is caught even when the incoming sender is unknown.
    const group = resolveGroup(remoteJid);
    if (!group) {
      if (remoteJid === process.env.GROUP_FAMILY?.trim()) {
        console.log('[assistant] Configured Family chat did not resolve');
      } else {
        console.log(`[assistant] Unknown group: ${remoteJid}`);
      }
      return;
    }

    // Observation-only groups are deliberately stopped before membership
    // checks, sender resolution, acknowledgements, model calls, and sends.
    // Their rows are still captured by channels/imessage.ts for the separately
    // gated memory extractor, but the bot never participates in the thread.
    if (group.replyPolicy === 'observe') {
      console.log(`[assistant] Observation-only chat: ${group.name}; no reply`);
      return;
    }

    // 2. A shared audience is live only while its local iMessage membership
    // exactly matches the approved profile users. Failure is silent in-group.
    if (!(await verifySharedAudience(remoteJid, group))) return;

    // 3. Resolve the authenticated sender.
    const user = resolveUser(senderJid);
    if (!user) {
      if (group.key === 'family') {
        console.log('[assistant] Unknown sender in configured Family chat');
      } else {
        console.log(`[assistant] Unknown sender: ${senderJid}`);
      }
      return;
    }

    // 4. Check permissions.
    if (!isAllowed(user, group.key)) {
      const msg = getRedirectMessage(user, group.key);
      await sendMessage(remoteJid, msg);
      return;
    }

    if (group.key === 'family') {
      console.log('[assistant] Authenticated Family message received');
    } else {
      console.log(`[assistant] ${user.name} → ${group.name}: ${text.slice(0, 80)}...`);
    }

    // Everything below is work a human is actively waiting on, so it runs in the
    // `interactive` lane — metered like everything else, but never refusable by
    // the token budget. A reply is the product; failing it because a background
    // loop spent the day's budget would surface a raw provider error in chat.
    const llmCtx = { caller: `agent:${group.key}`, lane: 'interactive' as const, groupKey: group.key };

    // 4.5 Journal ritual: if a morning/evening journal session is active for this
    // thread, this reply is a journal answer — record it and advance, bypassing
    // the agent and the receipt ack entirely (deterministic one-question pacing).
    if (await handleJournalReply(remoteJid, text)) return;

    // 5. Classify sync vs async. Family uses smart replies, including a truly
    // silent context-learning path, so it gets no unconditional ack/progress.
    const isFamily = group.key === 'family';
    // Keep Family work inside its own conversation/memory stores. The generic
    // async queue is monitored from the owner's private operational channel, so a
    // Family prompt must never be copied there as a "stuck task" alert.
    // NOTE: this line is pinned verbatim by the Family access gate
    // (scripts/test-family-access.ts) because forcing Family onto the sync path
    // before any async task write is a security invariant. Do not reshape it;
    // the router's own LLM attribution lives inside router.ts instead.
    const mode = isFamily ? 'sync' : await detectMode(text);
    if (!isFamily) await sendMessage(remoteJid, RECEIVED_ACK);

    // Progress callback — sends tool-by-tool updates to the chat
    const onProgress = isFamily ? undefined : async (msg: string) => {
      await sendMessage(remoteJid, msg);
    };

    if (mode === 'async') {
      const taskId = createAsyncTask(group.key, user.id, text);

      // Run in background. The context is established around the call that
      // starts the promise chain, so it propagates through the whole detached
      // run — including model calls made inside tool handlers.
      withLlmContext(llmCtx, () => runAgent(
        group,
        user,
        text,
        image,
        onProgress,
        document,
        remoteJid,
        isFamily ? () => verifySharedAudience(remoteJid, group) : undefined,
        sourceMessage,
      ))
        .then(async (response) => {
          completeAsyncTask(taskId, response);
          if (!isSilentFamilyResponse(group.key, response)) {
            await sendIfAudienceStillApproved(remoteJid, group, response);
          }
        })
        .catch(async (err) => {
          const errMsg = isFamily
            ? 'I could not process that Family request.'
            : `Task failed: ${err instanceof Error ? err.message : String(err)}`;
          failAsyncTask(taskId, errMsg);
          await sendIfAudienceStillApproved(remoteJid, group, errMsg);
        });
    } else {
      // Sync: respond directly
      try {
        const response = await withLlmContext(llmCtx, () => runAgent(
          group,
          user,
          text,
          image,
          onProgress,
          document,
          remoteJid,
          isFamily ? () => verifySharedAudience(remoteJid, group) : undefined,
          sourceMessage,
        ));
        if (!isSilentFamilyResponse(group.key, response)) {
          await sendIfAudienceStillApproved(remoteJid, group, response);
        }
      } catch (err) {
        const errMsg = isFamily
          ? 'I could not process that Family request.'
          : `Error: ${err instanceof Error ? err.message : String(err)}`;
        await sendIfAudienceStillApproved(remoteJid, group, errMsg);
      }
    }
  });

  // Start iMessage
  await startIMessage();

  // Verify a configured shared chat at startup, not only after somebody sends
  // a message. Scheduled updates use the same verifier again before each send.
  const familyChatId = process.env.GROUP_FAMILY?.trim();
  if (familyChatId) {
    const familyGroup = resolveGroup(familyChatId);
    if (!familyGroup || familyGroup.key !== 'family') {
      console.error('[assistant] Family chat mapping did not resolve; Family remains suspended');
    } else {
      const familyAudienceApproved = await verifySharedAudience(familyChatId, familyGroup);
      if (familyAudienceApproved) {
        console.log('[assistant] Family participant set verified');
      }
    }
  }

  // Gated automations. Each needs its module switched on (src/modules.ts).
  // On top of that, the AUTOMATIONS_OFF sentinel (`npm run pause`) silences the
  // whole ambient layer; AUTOMATIONS_ON is a comma-separated allowlist of keys
  // that run anyway (see lib/automations-off.ts). Each key's own env guard still
  // applies on top -- this list can permit a key, never force one on.
  const gated: Array<[string, () => void]> = [
    ['scheduler', startScheduler],
    ['checkins', startCheckins],                   // the two daily check-ins (src/checkins.ts)
    ['heartbeat', startHeartbeat],                 // proactive 30-min check-ins
    ['journal', startJournal],                     // also gated by JOURNAL_ENABLED
    ['brain-pulse', startBrainPulse],
    ['relationship-pulse', startRelationshipPulse],
    ['idea-pulse', startIdeaPulse],
    ['hygiene', startHygieneLoop],
    ['family-scheduler', () => { startFamilyRuntimeScheduler(); }],
    ['email-reconciliation', startEmailReconciliationRuntime],
  ];

  const started: string[] = [];
  const heldBack: string[] = [];
  const moduleOff: string[] = [];
  for (const [key, start] of gated) {
    if (!isOwnedOn('start', key)) { moduleOff.push(`${key} (${moduleFor('start', key)})`); continue; }
    if (!automationAllowed(key)) { heldBack.push(key); continue; }
    try { start(); started.push(key); }
    catch (err) { console.error(`[assistant] ${key} failed to start:`, err); }
  }
  console.log(
    `[assistant] automations ${automationsOff() ? 'GATED (AUTOMATIONS_OFF present)' : 'all enabled'}`
    + ` | started: ${started.join(', ') || 'none'}`
    + (heldBack.length ? ` | held back: ${heldBack.join(', ')}` : '')
    + (moduleOff.length ? ` | module off: ${moduleOff.join(', ')}` : '')
    + ' | replies always work.',
  );

  console.log('[assistant] Ready. Listening for iMessages.');
}

main().catch((err) => {
  console.error('[assistant] Fatal:', err);
  process.exit(1);
});
