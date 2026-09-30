import 'dotenv/config';
import { createHash } from 'node:crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import {
  isEmailExtracted,
  markEmailExtracted,
  saveFact,
  createTask,
  getTaskById,
  linkEmailOpenLoopCalendarByMessageId,
  linkEmailOpenLoopTaskByMessageId,
} from '../src/db.js';
import { pushTaskToGoogle } from '../src/sync/tasks-sync.js';
import { createCalendarEventRaw } from '../src/tools/calendar.js';
import { EMAIL_NOT_CONNECTED, formatEmailMessage, getEmailSource, type EmailMessage } from '../src/email/source.js';
import { sendMessage, getDefaultRecipient } from '../src/channels/imessage.js';
import { sendInterrupt, stageAmbient } from '../src/cos-outbound.js';
import { parseStrEnv, parseNumEnv, parseBoolEnv } from '../src/lib/env.js';
import { OPENAI_MODEL, OPENAI_ROUTER_MODEL, llmConfigured } from '../src/lib/openai.js';
import { extractFirstJson, extractionComplete, makeLogger, haikuPrefilter, runDaemon } from '../src/lib/daemon.js';
import { automationsOff, automationAllowed } from '../src/lib/automations-off.js';
import { isOwnedOn, moduleFor } from '../src/modules.js';

// Tier 2 — proactive inbox-signal extraction daemon.
//
// Persistent loop (launchd KeepAlive). NOT a cron — it polls the email source
// (Gmail by default, Spark optional; see src/email/source.ts) on an
// interval the way imessage-daemon polls imessage_log. The structural
// difference: email has no upstream poller filling a DB table, so this daemon
// BOTH enumerates from the mailbox AND extracts in one process, deduping against
// email_extraction_log (keyed on the provider's opaque message ID).
//
// Lifecycle (tick() every INBOX_SIGNAL_INTERVAL_MS):
//   1. enumerateNewEmails() — list a recent inbox window, drop message_ids
//      already in email_extraction_log.
//   2. Low-cost OpenAI pre-filter — cheap classify of which rows carry a delivery / bill /
//      payment-failure / registration / document signal. Drops everything else
//      (especially meeting transcripts — owned by meeting-daemon).
//   3. Primary OpenAI extraction — one structured-JSON call over the full thread bodies
//      of the survivors: { deliveries, bills, payment_failures, registrations,
//      documents }.
//   4. Auto-create artifacts (reversible only — never spends money / replies):
//        delivery     → createCalendarEventRaw (delivery window)
//        bill         → createTask(admin) + Google push    → heartbeat surfaces
//        payment_fail → high-priority createTask + urgent line in the digest DM
//        registration → createCalendarEventRaw + saveFact
//        document     → saveFact(fact_type:'reference')  → search_facts finds it
//   5. One digest DM of everything created (the "+ notify" half of the trust
//      model); payment failures first.
//   6. markEmailExtracted(ALL enumerated message_ids) — extracted or dropped —
//      so the cursor always advances and nothing is reprocessed.
//
// Surfacing is otherwise free: tasks ride heartbeat.ts, facts ride brain-pulse.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const LOG_PATH = join(REPO_ROOT, 'logs', 'inbox-signal-daemon.log');

const INTERVAL_MS = parseNumEnv('INBOX_SIGNAL_INTERVAL_MS', 15 * 60 * 1000);
const BATCH = parseNumEnv('INBOX_SIGNAL_BATCH', 50);
const WINDOW = parseStrEnv('INBOX_SIGNAL_WINDOW', '2d'); // Gmail-style newer_than window
const ENABLED = parseBoolEnv('INBOX_SIGNAL_ENABLED', false);
const PREFILTER_MODEL = parseStrEnv('OPENAI_ROUTER_MODEL', OPENAI_ROUTER_MODEL);
const EXTRACT_MODEL = parseStrEnv('OPENAI_MODEL', OPENAI_MODEL);

const TEST_MODE = process.argv.includes('--test');
const log = makeLogger(LOG_PATH, TEST_MODE);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// ── Step 1: enumerate new emails ─────────────────────────────────────────────
interface EmailRow {
  message_id: string; // opaque provider message ID
  preview: string;    // From / Subject / snippet, truncated
}

function previewOf(m: EmailMessage): string {
  return [m.from && `From: ${m.from}`, m.subject && `Subject: ${m.subject}`, m.snippet]
    .filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 400);
}

async function enumerateNewEmails(): Promise<EmailRow[]> {
  const source = await getEmailSource();
  if (!source) {
    log(`enumerate: ${EMAIL_NOT_CONNECTED}`);
    return [];
  }
  let all: EmailRow[];
  try {
    all = (await source.listRecent({ newerThan: WINDOW, limit: BATCH }))
      .map((m) => ({ message_id: m.id, preview: previewOf(m) }));
  } catch (err) {
    log(`enumerate: ${err instanceof Error ? err.message.split('\n')[0] : err}`);
    return [];
  }
  const fresh = all.filter((r) => !isEmailExtracted(r.message_id));
  log(`enumerate: ${all.length} in window, ${fresh.length} new`);
  return fresh;
}

// ── Step 2: OpenAI pre-filter ────────────────────────────────────────────────
async function prefilterEmails(rows: EmailRow[]): Promise<EmailRow[]> {
  return haikuPrefilter({
    items: rows,
    render: (r, i) => `[${i}] ${r.preview}`,
    model: PREFILTER_MODEL,
    log,
    caller: 'prefilter:inbox-signal-daemon',
    criteria: `You are a fast email classifier. Below are numbered emails (From + Subject).

Return a JSON array of the indices of emails that look like ANY of:
- a delivery or shipment confirmation / "out for delivery" / "arriving" notice
- a bill, invoice, or upcoming-payment notice with money due
- a FAILED or declined payment / card-expired / subscription-paused alert
- a confirmation that the owner registered for / booked an event, appointment, or class he should attend
- an important document or file shared with the owner (attachment, Google Drive / Dropbox share link, signed contract)

Ignore: newsletters, marketing, social notifications, meeting-transcript emails, and anything where someone ELSE registered for the owner's event (inbound signups are not actionable for him).`,
  });
}

// ── Step 3: OpenAI extraction ────────────────────────────────────────────────
interface ExtractJson {
  deliveries?: Array<{ message_id: string; carrier?: string; item?: string; date: string; window_start?: string | null; window_end?: string | null; tracking?: string | null }>;
  bills?: Array<{ message_id: string; payee: string; amount?: string | null; due_date: string }>;
  payment_failures?: Array<{ message_id: string; service: string; amount?: string | null; reason?: string | null; action_url?: string | null }>;
  registrations?: Array<{ message_id: string; event_name: string; date: string; start_time?: string | null; end_time?: string | null; location?: string | null; organizer?: string | null }>;
  documents?: Array<{ message_id: string; title: string; kind?: string | null; link?: string | null; attachment_name?: string | null; sender?: string | null }>;
}

async function readEmailBodies(rows: EmailRow[]): Promise<string> {
  const blocks: string[] = [];
  const source = await getEmailSource();
  for (const r of rows) {
    let body: string;
    try {
      if (!source) throw new Error(EMAIL_NOT_CONNECTED);
      const thread = await source.readThread(r.message_id);
      body = thread.messages.map((m) => formatEmailMessage(m, { body: true, maxBody: 2500 })).join('\n\n');
    } catch (err) {
      body = `(could not read thread: ${err instanceof Error ? err.message : err})`;
    }
    blocks.push(`=== message_id: ${r.message_id} ===\n${body.slice(0, 2500)}`);
  }
  return blocks.join('\n\n');
}

async function extractSignals(rows: EmailRow[]): Promise<ExtractJson | null> {
  const bodies = await readEmailBodies(rows);
  const prompt = `Extract actionable signals from these emails. Each block is tagged with its message_id — echo the SAME message_id back on every item you extract from that block. Reply with JSON only, no prose.

{
  "deliveries":       [{"message_id":"", "carrier":"e.g. Amazon/UPS/USPS", "item":"short desc of what's arriving", "date":"YYYY-MM-DD", "window_start":"HH:MM or null", "window_end":"HH:MM or null", "tracking":"or null"}],
  "bills":            [{"message_id":"", "payee":"who is owed", "amount":"e.g. $84.20 or null", "due_date":"YYYY-MM-DD"}],
  "payment_failures": [{"message_id":"", "service":"e.g. Netflix/AWS", "amount":"or null", "reason":"e.g. card declined / expired", "action_url":"or null"}],
  "registrations":    [{"message_id":"", "event_name":"", "date":"YYYY-MM-DD", "start_time":"HH:MM or null", "end_time":"HH:MM or null", "location":"or null", "organizer":"or null"}],
  "documents":        [{"message_id":"", "title":"what the doc is", "kind":"e.g. contract/invoice/spreadsheet", "link":"share URL or null", "attachment_name":"file name or null", "sender":"or null"}]
}

Rules:
- Resolve all relative dates ("tomorrow", "arriving Tuesday") against today (${today()}). Use 24h HH:MM for times.
- registrations = events the owner themselves registered for / booked and should attend. NEVER include emails where someone else signed up for the owner's own event.
- payment_failures = the payment FAILED or needs action. A normal upcoming-renewal notice is a bill, not a failure.
- documents = a real file/attachment or share link worth keeping; skip inline marketing images and tracking pixels.
- Omit any section entirely if empty. Be conservative — when a date or amount is ambiguous, omit the field (or the item) rather than guess.

${bodies}`;

  try {
    const text = await extractionComplete({ prompt, maxTokens: 2000, openaiModel: EXTRACT_MODEL, log, caller: 'inbox-signal-daemon' });
    const json = extractFirstJson(text, '{', '}');
    if (!json) {
      log('extract: could not locate JSON in response');
      return null;
    }
    return JSON.parse(json) as ExtractJson;
  } catch (err) {
    log(`extract failed: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

// ── Step 4+5: write back artifacts + build the digest ────────────────────────
interface Writeback {
  signalsByMsg: Map<string, number>; // message_id → artifacts created
  urgentLines: string[];             // payment failures — lead the DM
  normalLines: string[];             // deliveries/bills/registrations/documents
}

async function writeBackAndDigest(parsed: ExtractJson): Promise<Writeback> {
  const wb: Writeback = { signalsByMsg: new Map(), urgentLines: [], normalLines: [] };
  const bump = (mid: string) => wb.signalsByMsg.set(mid, (wb.signalsByMsg.get(mid) || 0) + 1);

  // Deliveries → calendar event (no task; the calendar + 6:30am prep cover it).
  for (const d of parsed.deliveries ?? []) {
    if (!d.date) continue;
    const label = [d.carrier, d.item].filter(Boolean).join(' — ') || 'Package';
    const title = `📦 Delivery: ${label}`;
    try {
      if (!TEST_MODE) {
        const { eventId } = await createCalendarEventRaw({
          title,
          date: d.date,
          allDay: !d.window_start,
          startTime: d.window_start || undefined,
          endTime: d.window_end || undefined,
          description: d.tracking ? `Tracking: ${d.tracking}` : undefined,
          addHomeAttendee: false,
          sourceRef: `email:${d.message_id}`,
        });
        if (eventId) linkEmailOpenLoopCalendarByMessageId(d.message_id, eventId);
      }
      const when = d.window_start ? `${d.date} ${d.window_start}–${d.window_end || ''}` : d.date;
      wb.normalLines.push(`📦 ${label} — ${when}`);
      bump(d.message_id);
    } catch (err) {
      log(`writeback delivery failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Bills → admin task (Google-synced; heartbeat surfaces it).
  for (const b of parsed.bills ?? []) {
    if (!b.payee || !b.due_date) continue;
    const title = `Pay ${b.payee}${b.amount ? ` ${b.amount}` : ''}`;
    try {
      if (!TEST_MODE) {
        const id = createTask({
          title,
          group_id: 'admin',
          assignee: 'owner',
          due_date: b.due_date,
          source: 'inbox-signal-daemon',
          source_ref: `email:${b.message_id}`,
          sync_to_google: true,
          notes: 'Captured from a bill email',
        });
        linkEmailOpenLoopTaskByMessageId(b.message_id, id);
        const t = getTaskById(id);
        if (t) pushTaskToGoogle(t).catch((err) => log(`google task push failed: ${err}`));
      }
      wb.normalLines.push(`💵 ${title} — due ${b.due_date}`);
      bump(b.message_id);
    } catch (err) {
      log(`writeback bill failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Payment failures → high-priority task (due today) + urgent DM line.
  for (const p of parsed.payment_failures ?? []) {
    if (!p.service) continue;
    const title = `Fix payment: ${p.service}${p.amount ? ` ${p.amount}` : ''}`;
    try {
      if (!TEST_MODE) {
        const id = createTask({
          title,
          group_id: 'admin',
          assignee: 'owner',
          priority: 'high',
          due_date: today(),
          source: 'inbox-signal-daemon',
          source_ref: `email:${p.message_id}`,
          notes: [p.reason, p.action_url].filter(Boolean).join(' — ') || 'Payment failed',
        });
        linkEmailOpenLoopTaskByMessageId(p.message_id, id);
        const t = getTaskById(id);
        if (t) pushTaskToGoogle(t).catch((err) => log(`google task push failed: ${err}`));
      }
      const detail = [p.reason, p.action_url].filter(Boolean).join(' — ');
      wb.urgentLines.push(`⚠️ Payment failed: ${p.service}${p.amount ? ` ${p.amount}` : ''}${detail ? ` (${detail})` : ''}`);
      bump(p.message_id);
    } catch (err) {
      log(`writeback payment_failure failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Registrations → calendar event + durable fact.
  for (const r of parsed.registrations ?? []) {
    if (!r.event_name || !r.date) continue;
    try {
      if (!TEST_MODE) {
        const { eventId } = await createCalendarEventRaw({
          title: r.event_name,
          date: r.date,
          allDay: !r.start_time,
          startTime: r.start_time || undefined,
          endTime: r.end_time || undefined,
          description: r.location ? `Location: ${r.location}` : undefined,
          addHomeAttendee: false,
          sourceRef: `email:${r.message_id}`,
        });
        if (eventId) linkEmailOpenLoopCalendarByMessageId(r.message_id, eventId);
        saveFact({
          subject: (r.organizer || r.event_name).trim(),
          predicate: 'registered for',
          object: `${r.event_name} on ${r.date}${r.location ? ` @ ${r.location}` : ''}`,
          fact_type: 'fact',
          source: 'inbox-signal-daemon',
          source_ref: `email:${r.message_id}`,
        });
      }
      wb.normalLines.push(`🗓️ ${r.event_name} — ${r.date}${r.start_time ? ` ${r.start_time}` : ''}`);
      bump(r.message_id);
    } catch (err) {
      log(`writeback registration failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Documents → reference fact (searchable via search_facts). v1 stores the
  // pointer; fetching/parsing Drive files is a follow-up (the daemon runs in the
  // bot process, not an MCP session).
  for (const doc of parsed.documents ?? []) {
    if (!doc.title) continue;
    const objectParts = [doc.title, doc.attachment_name, doc.link].filter(Boolean);
    try {
      if (!TEST_MODE) {
        saveFact({
          subject: (doc.sender || doc.title).trim(),
          predicate: 'shared document',
          object: objectParts.join(' — '),
          fact_type: 'reference',
          source: 'inbox-signal-daemon',
          source_ref: `email:${doc.message_id}`,
        });
      }
      wb.normalLines.push(`📎 ${doc.title}${doc.sender ? ` (from ${doc.sender})` : ''}`);
      bump(doc.message_id);
    } catch (err) {
      log(`writeback document failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return wb;
}

async function sendDigest(wb: Writeback): Promise<void> {
  if (!wb.urgentLines.length && !wb.normalLines.length) return;
  if (TEST_MODE) {
    log(`would INTERRUPT: ${wb.urgentLines.join(' / ') || '(none)'}`);
    log(`would STAGE ambient: ${wb.normalLines.join(' / ') || '(none)'}`);
    return;
  }
  // Re-homed under the CoS: payment failures interrupt immediately; everything
  // else (deliveries/bills/registrations/documents) batches into the next
  // morning brief — the task/event artifact already exists, so the notification
  // can wait. Falls back to a direct digest DM if routing ever throws.
  try {
    if (wb.urgentLines.length) {
      await sendInterrupt({
        source: 'inbox-signal-daemon',
        // Keyed on the flagged content itself: an overlapping enumeration
        // window re-surfacing the same payment failure is the same alert, but
        // a genuinely new one still gets through.
        subject: `inbox:urgent:${createHash('sha1').update(wb.urgentLines.join('|')).digest('hex').slice(0, 16)}`,
        kind: 'time-critical',
        text: `Heads up — inbox flagged:\n${wb.urgentLines.join('\n')}`,
      });
    }
    for (const line of wb.normalLines) stageAmbient('inbox', line, { subject: 'inbox' });
  } catch (err) {
    log(`digest routing failed, falling back to direct DM: ${err instanceof Error ? err.message : err}`);
    const recipient = getDefaultRecipient();
    if (recipient) {
      try {
        await sendMessage(recipient, `Inbox auto-actions:\n${[...wb.urgentLines, ...wb.normalLines].join('\n')}`);
      } catch { /* channel down */ }
    }
  }
}

// ── Tick ─────────────────────────────────────────────────────────────────────
async function tick(): Promise<void> {
  if (!ENABLED) {
    log('INBOX_SIGNAL_ENABLED=false — skipping');
    return;
  }
  if (!llmConfigured()) {
    log('no model API key — skipping (emails left for next run)');
    return;
  }

  const rows = await enumerateNewEmails();
  if (!rows.length) {
    if (TEST_MODE) log('tick: no new emails');
    return;
  }

  const candidates = await prefilterEmails(rows);
  log(`tick: ${candidates.length} candidate(s) after prefilter`);

  if (candidates.length) {
    const parsed = await extractSignals(candidates);
    if (parsed) {
      const counts = {
        deliveries: parsed.deliveries?.length ?? 0,
        bills: parsed.bills?.length ?? 0,
        payment_failures: parsed.payment_failures?.length ?? 0,
        registrations: parsed.registrations?.length ?? 0,
        documents: parsed.documents?.length ?? 0,
      };
      log(`tick: extracted ${JSON.stringify(counts)}`);
      const wb = await writeBackAndDigest(parsed);
      await sendDigest(wb);

      // Mark each enumerated row, carrying its per-email artifact count.
      if (!TEST_MODE) {
        for (const r of rows) {
          markEmailExtracted({ message_id: r.message_id, signal_count: wb.signalsByMsg.get(r.message_id) || 0 });
        }
      }
      log(`tick: marked ${rows.length} email(s) extracted`);
      return;
    }
  }

  // No candidates (or extraction failed) — still advance the cursor so we don't
  // re-enumerate the same emails every tick.
  if (!TEST_MODE) {
    for (const r of rows) markEmailExtracted({ message_id: r.message_id });
  }
  log(`tick: marked ${rows.length} email(s) extracted`);
}

// Feature switchboard (src/modules.ts): exit quietly when this daemon's module
// is off. launchd templates use KeepAlive SuccessfulExit=false, so a clean exit
// stays down instead of restarting. --test runs regardless.
if (!TEST_MODE && !isOwnedOn('daemons', 'inbox-signal-daemon')) {
  console.log(`[inbox-signal-daemon] module "${moduleFor('daemons', 'inbox-signal-daemon')}" is off — exiting.`);
  process.exit(0);
}

// Same allowlist as the other daemons: AUTOMATIONS_ON=...,inbox-signal-daemon
// lets it run while the sentinel keeps the rest of the ambient layer quiet.
if (automationsOff() && !automationAllowed('inbox-signal-daemon')) {
  console.log('[inbox-signal-daemon] AUTOMATIONS_OFF sentinel present and not allowlisted — exiting.');
  process.exit(0);
}

runDaemon({ name: 'inbox-signal-daemon', intervalMs: INTERVAL_MS, testMode: TEST_MODE, tick, log }).catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
