import Database, { type Database as DatabaseType } from 'better-sqlite3';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { toSqliteDate } from './lib/dates.js';
import { startOfTodayET, startOfWeekET } from './lib/time-et.js';
import { normalizePhone } from './lib/phone.js';
import { randomUUID } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Tests and one-off verification can point Assistant at an isolated database.
// Production keeps the existing repository-local default.
const DB_PATH = process.env.ASSISTANT_DB_PATH?.trim() || join(__dirname, '..', 'assistant.db');

const db: DatabaseType = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    role TEXT NOT NULL,        -- 'user' | 'assistant'
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS async_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id TEXT NOT NULL,
    sender TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT DEFAULT 'pending',  -- 'pending' | 'running' | 'done' | 'failed'
    result TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT
  );

  -- User-visible ledger for one-off work and long-running Codex motions.
  -- This is separate from async_tasks because it tracks cross-repo capability
  -- work, its workspace, and the artifact/status contract exposed over iMessage.
  CREATE TABLE IF NOT EXISTS work_requests (
    request_id    TEXT PRIMARY KEY,
    kind          TEXT NOT NULL, -- 'work_request' | 'motion' | 'codex'
    workspace     TEXT,
    operation     TEXT,
    repo          TEXT,
    request_text  TEXT NOT NULL,
    metadata_json TEXT,
    status        TEXT NOT NULL DEFAULT 'pending', -- pending | running | done | failed | cancelled
    result        TEXT,
    created_by_group TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    started_at    TEXT,
    completed_at  TEXT,
    updated_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS memory (
    group_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (group_id, key)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT,
    group_id TEXT NOT NULL,
    assignee TEXT NOT NULL DEFAULT 'owner',
    priority TEXT NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'open',
    due_date TEXT,
    source TEXT DEFAULT 'manual',
    created_at TEXT DEFAULT (datetime('now')),
    completed_at TEXT,
    notes TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_messages_group ON messages(group_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_async_tasks_status ON async_tasks(status);
  CREATE INDEX IF NOT EXISTS idx_work_requests_status ON work_requests(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee, status);
  CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);

  -- Family lists are deliberately separate from the canonical task system.
  -- They never enter Google Tasks sync, heartbeat surfacing, or task retirement.
  CREATE TABLE IF NOT EXISTS family_lists (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL COLLATE NOCASE UNIQUE,
    created_by_user_id TEXT,
    created_at         TEXT DEFAULT (datetime('now')),
    updated_at         TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS family_list_items (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    list_id            INTEGER NOT NULL REFERENCES family_lists(id) ON DELETE RESTRICT,
    text               TEXT NOT NULL,
    quantity           TEXT,
    notes              TEXT,
    due_date           TEXT,
    assignee           TEXT,
    status             TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
    created_by_user_id TEXT,
    updated_by_user_id TEXT,
    completed_at       TEXT,
    archived_at        TEXT,
    created_at         TEXT DEFAULT (datetime('now')),
    updated_at         TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_family_items_list
    ON family_list_items(list_id, archived_at, status);
  CREATE INDEX IF NOT EXISTS idx_family_items_due
    ON family_list_items(due_date, archived_at, status);
  CREATE INDEX IF NOT EXISTS idx_family_items_assignee
    ON family_list_items(assignee, archived_at, status);

  INSERT OR IGNORE INTO family_lists (name) VALUES
    ('Family Tasks'),
    ('Groceries'),
    ('Errands');

  -- Atomic facts: the things assistant knows about you and your world.
  -- See SECOND-BRAIN-ROADMAP.md Phase 1 for the supersession policy.
  CREATE TABLE IF NOT EXISTS facts (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subject       TEXT NOT NULL,
    predicate     TEXT NOT NULL,
    object        TEXT NOT NULL,
    fact_type     TEXT DEFAULT 'fact',
    group_id      TEXT,
    source        TEXT DEFAULT 'manual',
    source_ref    TEXT,
    confidence    REAL DEFAULT 1.0,
    sensitive     INTEGER NOT NULL DEFAULT 0,
    valid_until   TEXT,
    active        INTEGER DEFAULT 1,
    superseded_at TEXT,
    created_at    TEXT DEFAULT (datetime('now')),
    updated_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_facts_subject    ON facts(subject COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_facts_type       ON facts(fact_type);
  CREATE INDEX IF NOT EXISTS idx_facts_subj_pred  ON facts(subject COLLATE NOCASE, predicate COLLATE NOCASE, active);

  CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
    subject, predicate, object,
    content='facts', content_rowid='id'
  );
  CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
    INSERT INTO facts_fts(rowid, subject, predicate, object)
    VALUES (new.id, new.subject, new.predicate, new.object);
  END;
  CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, subject, predicate, object)
    VALUES('delete', old.id, old.subject, old.predicate, old.object);
  END;
  CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
    INSERT INTO facts_fts(facts_fts, rowid, subject, predicate, object)
    VALUES('delete', old.id, old.subject, old.predicate, old.object);
    INSERT INTO facts_fts(rowid, subject, predicate, object)
    VALUES (new.id, new.subject, new.predicate, new.object);
  END;

  -- People graph: canonical person records + email map + interaction log.
  CREATE TABLE IF NOT EXISTS people (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    company      TEXT,
    role         TEXT,
    linkedin_url TEXT,
    relationship TEXT,
    notes        TEXT,
    last_contact TEXT,
    created_at   TEXT DEFAULT (datetime('now'))
  );
  -- Normalized email→person map so the same human arriving via Spark (personal)
  -- and Calendar (work) merges into one row, not two.
  CREATE TABLE IF NOT EXISTS person_emails (
    email     TEXT PRIMARY KEY COLLATE NOCASE,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_person_emails_pid ON person_emails(person_id);
  -- Normalized phone→person map (last-10 digits, see lib/phone.ts). Lets iMessage
  -- senders (phone handles) and Apple Contacts dedup against email-keyed rows.
  CREATE TABLE IF NOT EXISTS person_phones (
    phone     TEXT PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_person_phones_pid ON person_phones(person_id);
  CREATE INDEX IF NOT EXISTS idx_people_linkedin   ON people(linkedin_url);
  CREATE INDEX IF NOT EXISTS idx_people_name       ON people(name COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS interactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id   INTEGER REFERENCES people(id) ON DELETE CASCADE,
    channel     TEXT,
    summary     TEXT,
    ref         TEXT,
    occurred_at TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_interactions_person ON interactions(person_id);
  CREATE INDEX IF NOT EXISTS idx_interactions_dedup  ON interactions(person_id, channel, ref);

  -- Relationship maintenance is intentionally isolated from interactions
  -- and people.last_contact. Those legacy surfaces include passive email
  -- reads, searches, mentions, and future calendar events, so they cannot
  -- answer either "did I reach out?" or "did we meaningfully connect?".
  CREATE TABLE IF NOT EXISTS relationship_plans (
    person_id         INTEGER PRIMARY KEY REFERENCES people(id) ON DELETE CASCADE,
    label             TEXT,
    cadence_days      INTEGER NOT NULL CHECK (cadence_days > 0 AND cadence_days <= 3650),
    preferred_channel TEXT,
    status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'paused', 'removed')),
    snoozed_until     TEXT,
    last_nudged_at    TEXT,
    source_ref        TEXT,
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS relationship_events (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    person_id             INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
    occurred_at           TEXT NOT NULL,
    channel               TEXT NOT NULL,
    direction             TEXT NOT NULL
                          CHECK (direction IN ('incoming', 'outgoing', 'two_way', 'unknown')),
    counts_as_outreach     INTEGER NOT NULL DEFAULT 0 CHECK (counts_as_outreach IN (0, 1)),
    counts_as_meaningful   INTEGER NOT NULL DEFAULT 0 CHECK (counts_as_meaningful IN (0, 1)),
    source                TEXT NOT NULL,
    source_ref            TEXT,
    confidence            REAL NOT NULL DEFAULT 1.0 CHECK (confidence >= 0 AND confidence <= 1),
    summary               TEXT,
    created_at            TEXT DEFAULT (datetime('now')),
    CHECK (counts_as_outreach = 1 OR counts_as_meaningful = 1)
  );
  CREATE INDEX IF NOT EXISTS idx_relationship_events_person_time
    ON relationship_events(person_id, occurred_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_relationship_events_source
    ON relationship_events(person_id, source, source_ref)
    WHERE source_ref IS NOT NULL;
  CREATE INDEX IF NOT EXISTS idx_relationship_plans_nudge
    ON relationship_plans(status, snoozed_until, last_nudged_at);

  -- Phase 5: passive iMessage capture. Every observed message (both directions,
  -- all chats) is logged here regardless of the @assistant trigger. The
  -- imessage-daemon reads unextracted rows and feeds the brain (facts/people/tasks).
  -- rowid_src is the chat.db ROWID; UNIQUE + INSERT OR IGNORE makes re-polling idempotent.
  CREATE TABLE IF NOT EXISTS imessage_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    rowid_src    INTEGER UNIQUE,
    chat_id      TEXT NOT NULL,
    chat_name    TEXT,
    sender       TEXT NOT NULL,           -- handle for incoming, 'me' for outgoing
    direction    TEXT NOT NULL,           -- 'in' | 'out'
    text         TEXT,
    ts           TEXT NOT NULL,           -- ISO, converted from Apple epoch
    extracted_at TEXT,                    -- NULL until the daemon processes it
    privacy_scope TEXT,                   -- non-NULL rows never enter global search/retrieval
    created_at   TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_imsg_extracted ON imessage_log(extracted_at, id);
  CREATE INDEX IF NOT EXISTS idx_imsg_chat      ON imessage_log(chat_id, ts);

  -- Durable delivery ledger for the configured Family iMessage chat. This is
  -- intentionally separate from imessage_log: that table is an observation /
  -- extraction surface, while this one is the durable, fail-closed reply
  -- boundary. The activation cursor prevents a first deploy from replaying the
  -- historical Family thread. Ambiguous post-dispatch outcomes are deliberately
  -- terminal rather than blindly replayed, so this is not an exactly-once claim.
  CREATE TABLE IF NOT EXISTS family_imessage_inbox_state (
    chat_id             TEXT PRIMARY KEY,
    activation_rowid    INTEGER NOT NULL,
    last_scanned_rowid  INTEGER NOT NULL,
    activated_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS family_imessage_inbox (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id          TEXT NOT NULL,
    source_rowid     INTEGER NOT NULL,
    source_guid      TEXT,
    sender           TEXT NOT NULL,
    raw_text         TEXT,
    message_ts       TEXT NOT NULL,
    has_attachment   INTEGER NOT NULL DEFAULT 0 CHECK (has_attachment IN (0, 1)),
    state            TEXT NOT NULL DEFAULT 'queued'
                     CHECK (state IN (
                       'queued', 'processing', 'succeeded',
                       'send_in_doubt', 'failed_before_dispatch'
                     )),
    error_code       TEXT,
    queued_at        TEXT NOT NULL DEFAULT (datetime('now')),
    processing_at    TEXT,
    completed_at     TEXT,
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(chat_id, source_rowid)
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_family_imessage_inbox_guid
    ON family_imessage_inbox(chat_id, source_guid)
    WHERE source_guid IS NOT NULL AND source_guid <> '';
  CREATE INDEX IF NOT EXISTS idx_family_imessage_inbox_queue
    ON family_imessage_inbox(chat_id, state, source_rowid);

  -- Proactive inbox-signal extraction dedup (inbox-signal-daemon).
  -- Unlike imessage_log there is no upstream poller filling this table — email
  -- lives only in Spark. The daemon enumerates a recent window from Spark and
  -- records every message_id it has SEEN here (extracted or not), so the cursor
  -- is "have we processed this message_id" rather than "id > N". message_id is
  -- Spark's per-message integer rendered as text; UNIQUE + INSERT OR IGNORE makes
  -- re-enumerating an overlapping newer_than window idempotent.
  CREATE TABLE IF NOT EXISTS email_extraction_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id    TEXT UNIQUE NOT NULL,     -- Spark message ID (the list "ID" column)
    account       TEXT,
    subject       TEXT,
    sender        TEXT,
    ts            TEXT,                      -- email date if parseable
    signal_count  INTEGER DEFAULT 0,         -- artifacts created from this email
    extracted_at  TEXT DEFAULT (datetime('now')),
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_email_ext_msgid ON email_extraction_log(message_id);
`);

// Safe migrations for scheduling columns (no-ops if already exist)
const schedulingMigrations = [
  'ALTER TABLE tasks ADD COLUMN duration_minutes INTEGER',
  'ALTER TABLE tasks ADD COLUMN focus_level TEXT DEFAULT \'normal\'',
  'ALTER TABLE tasks ADD COLUMN calendar_event_id TEXT',
  'ALTER TABLE tasks ADD COLUMN splittable INTEGER DEFAULT 1',
  // Google Tasks sync columns
  'ALTER TABLE tasks ADD COLUMN google_task_id TEXT',
  'ALTER TABLE tasks ADD COLUMN google_list_id TEXT',
  'ALTER TABLE tasks ADD COLUMN sync_to_google INTEGER DEFAULT 1',
  'ALTER TABLE tasks ADD COLUMN last_synced_at TEXT',
  'ALTER TABLE tasks ADD COLUMN updated_at TEXT',
  // Exact provenance for obligations created from mail/messages/meetings. The
  // free-form `source` column says which subsystem created a task; source_ref
  // identifies the actual upstream record (for example `email:169727`) so a
  // later reply, RSVP, or completion can reconcile the same open loop.
  'ALTER TABLE tasks ADD COLUMN source_ref TEXT',
  // Reminder hygiene columns (Phase 7). snoozed_until suppresses surfacing
  // without moving due_date; last_surfaced_at + surface_count power resurface
  // dedup so heartbeat doesn't re-ping the same task every 30 minutes.
  'ALTER TABLE tasks ADD COLUMN snoozed_until TEXT',
  'ALTER TABLE tasks ADD COLUMN last_surfaced_at TEXT',
  'ALTER TABLE tasks ADD COLUMN surface_count INTEGER DEFAULT 0',
  // retired_at (organic reminders): set when a task has been surfaced enough
  // times that the heartbeat stops re-pinging it and the morning brief instead
  // asks one pointed "kill it or commit a day" question. Cleared when the user
  // touches the task (snooze / reschedule) so it re-enters the rotation fresh.
  'ALTER TABLE tasks ADD COLUMN retired_at TEXT',
  // Shared/private conversations may be retained for local delivery auditing,
  // but this durable marker keeps them out of global message search/retrieval.
  'ALTER TABLE imessage_log ADD COLUMN privacy_scope TEXT',
  // Owner-private knowledge mined from email/messages must never leak into a
  // shared group. Older production databases already have this column from the
  // context import; keeping the migration here makes clean installs equivalent.
  'ALTER TABLE facts ADD COLUMN sensitive INTEGER NOT NULL DEFAULT 0',
  // facts.person_id (Phase 6d) — canonical link to the people row when a fact's
  // subject names a person. Filled by saveFact's auto-bind (exact name match)
  // or explicit pass-through from callers that already know the personId.
  'ALTER TABLE facts ADD COLUMN person_id INTEGER REFERENCES people(id) ON DELETE SET NULL',
  // Brain Pulse (Tier 1 Phase 1): resurface dedup + commitment completion.
  // Mirrors the tasks pattern (last_surfaced_at / surface_count) so the cron
  // doesn't re-ping the same fact every pulse. completed_at flips on a closed
  // commitment; superseded_at stays null (completion ≠ supersession).
  'ALTER TABLE facts ADD COLUMN last_surfaced_at TEXT',
  'ALTER TABLE facts ADD COLUMN surface_count INTEGER DEFAULT 0',
  'ALTER TABLE facts ADD COLUMN completed_at TEXT',
  'ALTER TABLE people ADD COLUMN last_surfaced_at TEXT',
  // Phase 2 — Hygiene Loop. Every mutation by the weekly hygiene cron writes a
  // row here with before/after JSON so `scripts/hygiene-revert.ts <run_id>`
  // can roll back a single pass without re-reasoning the diff.
  `CREATE TABLE IF NOT EXISTS hygiene_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id      TEXT NOT NULL,
    action      TEXT NOT NULL,
    fact_id     INTEGER REFERENCES facts(id),
    before_json TEXT,
    after_json  TEXT,
    rationale   TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  )`,
  // Phase 3 — Content Flywheel. Drafts have their own lifecycle
  // (pending/approved/discarded/published) and a separate source-link concept,
  // so they get their own table rather than overloading the facts row.
  `CREATE TABLE IF NOT EXISTS fact_drafts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    kind             TEXT NOT NULL,
    title            TEXT,
    body             TEXT NOT NULL,
    source_fact_ids  TEXT,
    path             TEXT,
    status           TEXT DEFAULT 'pending',
    created_at       TEXT DEFAULT (datetime('now')),
    reviewed_at      TEXT,
    last_surfaced_at TEXT
  )`,
  // Tier 2 Phase 1 — Actions layer. Real-world actions that spend money or
  // commit to a person (orders, bookings, calls) flow propose → confirm →
  // execute, each transition stamped in-row. payload_json is frozen at propose
  // time and is the audit-grade snapshot of exactly what will run. The agent
  // only ever calls propose/confirm/cancel/list; executors run INSIDE
  // confirm_action, never as agent-callable tools — that's what makes the gate
  // unskippable. See CLAUDE.md "Actions layer".
  `CREATE TABLE IF NOT EXISTS actions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    kind                 TEXT NOT NULL,        -- 'reorder' | 'booking' | 'call'
    tool_name            TEXT NOT NULL,        -- executor key in EXECUTORS dispatch
    summary              TEXT NOT NULL,        -- human-readable one-liner for the DM
    payload_json         TEXT NOT NULL,        -- full executor args; frozen at propose
    estimated_cost_cents INTEGER,              -- nullable for $0 actions
    actual_cost_cents    INTEGER,              -- written at execute
    currency             TEXT NOT NULL DEFAULT 'USD',
    reversible           INTEGER NOT NULL DEFAULT 0,
    status               TEXT NOT NULL DEFAULT 'proposed',
        -- 'proposed' | 'confirmed' | 'executing' | 'done' | 'failed' | 'cancelled'
    category             TEXT,                 -- reserved (future autonomy ladder)
    autonomy_level       TEXT NOT NULL DEFAULT 'confirm',  -- reserved; always 'confirm' in slice 1
    proposed_at          TEXT DEFAULT (datetime('now')),
    confirmed_at         TEXT,
    executed_at          TEXT,
    outcome              TEXT,
    outcome_url          TEXT,
    error                TEXT,
    created_by_group     TEXT NOT NULL,
    last_surfaced_at     TEXT
  )`,
  // Computer-use audit. The gated desktop actions (click/type/key_press/scroll)
  // are already audited in the `actions` table via propose → confirm. This table
  // is for the *free* desktop actions (screenshot/open_app/switch_app) so there's
  // a record of everything the computer_use tool did, without polluting the
  // `actions` ledger (which is the confirmed-spend/commitment record). Mirrors the
  // hygiene_log pattern. See CLAUDE.md "computer surface".
  // Owner location pings from an iPhone Shortcut (POST /location on the
  // tailnet-only voice server). Rendered into owner-only prompt context; kept 30 days.
  `CREATE TABLE IF NOT EXISTS location_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    lat         REAL,
    lon         REAL,
    address     TEXT,
    label       TEXT,                  -- e.g. "Home", from the Shortcut trigger
    event       TEXT,                  -- 'arrive' | 'leave' | 'check'
    received_at TEXT DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS computer_use_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    action           TEXT NOT NULL,        -- 'screenshot' | 'open_app' | 'switch_app'
    summary          TEXT NOT NULL,        -- human-readable one-liner
    payload_json     TEXT,                 -- the tool input that produced this
    outcome          TEXT,                 -- result text
    created_by_group TEXT NOT NULL,
    created_at       TEXT DEFAULT (datetime('now'))
  )`,

  // Per-call LLM meter. Until this existed there was NO token or cost accounting
  // anywhere: OpenAIResponse.usage was declared in lib/openai.ts and never read,
  // so the only way to discover what the bot spent was the provider invoice.
  // That is survivable at cron cadences and not survivable once an ambient loop
  // runs every few minutes -- especially since extractionComplete silently
  // reroutes to a paid model whenever the local one fails.
  //
  // Deliberately NOT reusing the `actions` ledger or spend-cap.ts: those track
  // real-world money (orders, bookings) in whole cents against a human-confirmed
  // proposal. A router call costs a small fraction of a cent, so cents would
  // round every row to 0 and the daily sum would be garbage. cost_micros is
  // micro-USD, and the distinct suffix keeps it from ever being confused with
  // actions.estimated_cost_cents when both land on the same dashboard.
  //
  // `lane` is what makes the budget safe to enforce: 'interactive' work is a
  // reply a human is waiting on and must never be refused, while 'ambient' work
  // is a loop nobody asked for and is the first thing to cut. See lib/llm-context.ts.
  `CREATE TABLE IF NOT EXISTS llm_usage (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    caller              TEXT NOT NULL,               -- 'agent:admin' | 'pulse:brain' | 'daemon:imessage' | 'router'
    lane                TEXT NOT NULL,               -- 'interactive' | 'batch' | 'ambient'
    provider            TEXT NOT NULL,               -- 'openai' | 'local'
    model               TEXT NOT NULL,
    group_id            TEXT,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    reasoning_tokens    INTEGER NOT NULL DEFAULT 0,
    cost_micros         INTEGER NOT NULL DEFAULT 0,  -- micro-USD; 0 for local
    latency_ms          INTEGER,
    ok                  INTEGER NOT NULL DEFAULT 1,
    error_kind          TEXT,                        -- '429'|'5xx'|'4xx'|'network'|'timeout'|'budget'
    attempt             INTEGER NOT NULL DEFAULT 1,
    created_at          TEXT DEFAULT (datetime('now'))
  )`,

  // Every attempt to interrupt the owner, whether or not it went out.
  //
  // Before this, ~61 independent code paths could text the owner with no shared view
  // of what else had already been said. There was no record of a message NOT
  // sent, so "the bot went quiet" and "the bot had nothing to say" were
  // indistinguishable -- which is how cold email once stopped for 15 days with
  // nothing recording that a stop had happened.
  //
  // `decision` is what ACTUALLY happened. `would_hold` is the counterfactual:
  // in observe mode the arbiter reaches a verdict but the message is sent
  // anyway, so the row says decision='sent', would_hold=1, reason='...'. The
  // ledger must never claim it held something it delivered, or the cooldown
  // queries that read it would be reasoning from fiction.
  `CREATE TABLE IF NOT EXISTS outbound_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    source       TEXT NOT NULL,          -- 'heartbeat' | 'meeting-daemon' | 'pulse:brain'
    subject      TEXT NOT NULL,          -- stable identity of the THING: 'meeting:<id>:prep'
    kind         TEXT NOT NULL,          -- time-critical|decision|reply|status|nudge
    target       TEXT,                   -- null when no recipient was configured
    decision     TEXT NOT NULL,          -- 'sent'|'held'|'deferred'|'failed'
    reason       TEXT,                   -- why the arbiter objected, if it did
    would_hold   INTEGER NOT NULL DEFAULT 0,  -- 1 = observe mode let it through anyway
    bypass       TEXT,                   -- non-null when a bypass lane was used
    mode         TEXT NOT NULL,          -- 'observe' | 'enforce' at decision time
    text_preview TEXT NOT NULL,          -- first 400 chars; full text lives in the messages table
    text_hash    TEXT NOT NULL,          -- normalized body hash, for cross-source dedup
    char_count   INTEGER NOT NULL,
    created_at   TEXT DEFAULT (datetime('now'))
  )`,
  // Shadow-only iMessage extraction. The daemon can learn what it WOULD write
  // without touching facts, tasks, people, interactions, or Google Tasks.
  // batch_key makes retry-after-crash idempotent: the same source rows produce
  // one review item even if they are seen twice before the cursor advances.
  `CREATE TABLE IF NOT EXISTS imessage_extraction_drafts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_key        TEXT NOT NULL UNIQUE,
    source_row_ids   TEXT NOT NULL,
    source_start     TEXT,
    source_end       TEXT,
    extraction_json TEXT NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending',
    created_at       TEXT DEFAULT (datetime('now')),
    reviewed_at      TEXT
  )`,
  // Historical iMessage mining has a cursor and audit trail independent of the
  // live extraction cursor. Backfilled messages are intentionally stamped as
  // extracted for the live daemon, so reusing extracted_at would either skip
  // all history or reopen live rows. One ledger row per source message makes
  // this pass resumable and its coverage auditable.
  `CREATE TABLE IF NOT EXISTS imessage_history_batches (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_key          TEXT NOT NULL UNIQUE,
    status             TEXT NOT NULL DEFAULT 'running'
                       CHECK (status IN ('running', 'completed', 'failed')),
    source_row_ids     TEXT NOT NULL,
    source_start       TEXT,
    source_end         TEXT,
    scanned_count      INTEGER NOT NULL DEFAULT 0,
    safe_count         INTEGER NOT NULL DEFAULT 0,
    private_count      INTEGER NOT NULL DEFAULT 0,
    bot_count          INTEGER NOT NULL DEFAULT 0,
    observation_count  INTEGER NOT NULL DEFAULT 0,
    fact_count         INTEGER NOT NULL DEFAULT 0,
    attempt_count      INTEGER NOT NULL DEFAULT 0,
    model              TEXT,
    error              TEXT,
    started_at         TEXT DEFAULT (datetime('now')),
    completed_at       TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS imessage_history_rows (
    imessage_id  INTEGER PRIMARY KEY REFERENCES imessage_log(id) ON DELETE CASCADE,
    batch_id     INTEGER NOT NULL REFERENCES imessage_history_batches(id) ON DELETE CASCADE,
    disposition TEXT NOT NULL
                CHECK (disposition IN ('committed', 'no_signal', 'private', 'bot_generated', 'empty', 'error')),
    processed_at TEXT DEFAULT (datetime('now'))
  )`,
  // Every canonical fact written by history keeps its exact source rows and
  // evidence quote here. fingerprint prevents a repeated semantic observation
  // from creating duplicate facts in overlapping conversations or retries.
  `CREATE TABLE IF NOT EXISTS imessage_history_fact_commits (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id           INTEGER NOT NULL REFERENCES imessage_history_batches(id) ON DELETE CASCADE,
    fact_id            INTEGER NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
    fingerprint        TEXT NOT NULL UNIQUE,
    kind               TEXT NOT NULL,
    source_message_ids TEXT NOT NULL,
    evidence_quote     TEXT NOT NULL,
    observed_at        TEXT NOT NULL,
    created_at         TEXT DEFAULT (datetime('now'))
  )`,
  // Reconciled email obligations. This is operational state, not semantic
  // memory: one row represents one question/commitment that may be evidenced
  // by several changing systems (mail, calendar, and tasks). The reconciler is
  // observe-only; these rows never mutate Spark, calendars, or tasks.
  `CREATE TABLE IF NOT EXISTS email_open_loops (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    loop_key             TEXT NOT NULL UNIQUE,
    entity_key           TEXT,
    account              TEXT,
    source_message_id    TEXT NOT NULL,
    source_thread_key    TEXT,
    subject              TEXT NOT NULL,
    contact              TEXT,
    kind                 TEXT NOT NULL DEFAULT 'email',
    requested_action     TEXT,
    status               TEXT NOT NULL DEFAULT 'open',
    resolution_kind      TEXT,
    confidence           REAL NOT NULL DEFAULT 0,
    task_id              INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
    calendar_event_id    TEXT,
    latest_inbound_at    TEXT,
    latest_outbound_at   TEXT,
    resolved_at          TEXT,
    last_checked_at      TEXT,
    metadata_json        TEXT,
    created_at           TEXT DEFAULT (datetime('now')),
    updated_at           TEXT DEFAULT (datetime('now'))
  )`,
  // Evidence is append/update-by-source. We deliberately retain only compact
  // headers/status summaries, never full private message bodies.
  `CREATE TABLE IF NOT EXISTS email_open_loop_evidence (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    open_loop_id   INTEGER NOT NULL REFERENCES email_open_loops(id) ON DELETE CASCADE,
    evidence_type  TEXT NOT NULL,
    source_ref     TEXT NOT NULL,
    occurred_at    TEXT,
    direction      TEXT,
    summary        TEXT NOT NULL,
    confidence     REAL NOT NULL DEFAULT 1,
    metadata_json  TEXT,
    created_at     TEXT DEFAULT (datetime('now')),
    updated_at     TEXT DEFAULT (datetime('now')),
    UNIQUE(open_loop_id, evidence_type, source_ref)
  )`,
  // Every status transition is durable and auditable. A current row alone
  // cannot explain why yesterday's "open" item became "scheduled" today.
  `CREATE TABLE IF NOT EXISTS email_open_loop_transitions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    open_loop_id   INTEGER NOT NULL REFERENCES email_open_loops(id) ON DELETE CASCADE,
    from_status    TEXT,
    to_status      TEXT NOT NULL,
    resolution_kind TEXT,
    evidence_ref   TEXT,
    confidence     REAL NOT NULL DEFAULT 0,
    observed_at    TEXT DEFAULT (datetime('now'))
  )`,
  // One row per incremental pass makes cadence, failures, and coverage visible
  // without turning the observer into another notification source.
  `CREATE TABLE IF NOT EXISTS email_reconciliation_runs (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    mode              TEXT NOT NULL DEFAULT 'observe',
    source            TEXT NOT NULL,
    candidate_count   INTEGER NOT NULL DEFAULT 0,
    checked_count     INTEGER NOT NULL DEFAULT 0,
    transition_count  INTEGER NOT NULL DEFAULT 0,
    error_count       INTEGER NOT NULL DEFAULT 0,
    report_json       TEXT,
    error             TEXT,
    started_at        TEXT DEFAULT (datetime('now')),
    completed_at      TEXT
  )`,
  // Errands (docs/ERRANDS.md). One row per approved errand: a goal plus the
  // envelope the owner approved (targets, what may be shared, call cap). The
  // runner in src/errands.ts works it forward; errand_events is its log.
  `CREATE TABLE IF NOT EXISTS errands (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    action_id       INTEGER,               -- the approved 'errand' action
    goal            TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',
        -- 'active' | 'waiting' (on the owner) | 'done' | 'failed' | 'cancelled'
    deadline        TEXT,                  -- YYYY-MM-DD (local), optional
    envelope_json   TEXT NOT NULL,
    target_idx      INTEGER NOT NULL DEFAULT 0,
    calls_made      INTEGER NOT NULL DEFAULT 0,
    call_state      TEXT,                  -- null | 'dialing' | 'connected'
    call_started_at TEXT,
    next_check_at   TEXT,
    outcome         TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    finished_at     TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS errand_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    errand_id   INTEGER NOT NULL,
    type        TEXT NOT NULL,             -- started | dialing | connected | call_result | callback | booked | calendar_error | note | blocked | done | failed | cancelled
    detail      TEXT,
    at          TEXT DEFAULT (datetime('now'))
  )`,
  'CREATE INDEX IF NOT EXISTS idx_errand_events ON errand_events(errand_id)',
  'ALTER TABLE actions ADD COLUMN errand_id INTEGER',
  // Wake-up calls (src/wakeup.ts). One row per call the owner set: a one-off
  // (date) or a weekly recurrence (days). cycle_date is the local morning being
  // worked right now; last_done_date stops the same morning firing twice.
  `CREATE TABLE IF NOT EXISTS wake_up_calls (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    time            TEXT NOT NULL,         -- HH:MM, local, 24h
    date            TEXT,                  -- YYYY-MM-DD (local) for a one-off
    days            TEXT,                  -- 'mon,tue,...' for a recurring one
    note            TEXT,
    status          TEXT NOT NULL DEFAULT 'active',  -- active | done | missed | cancelled
    cycle_date      TEXT,                  -- local date being worked, null when idle
    attempts_today  INTEGER NOT NULL DEFAULT 0,
    call_state      TEXT,                  -- null | 'calling' | 'connected'
    next_attempt_at TEXT,                  -- ISO UTC
    last_attempt_at TEXT,                  -- ISO UTC
    last_result     TEXT,
    last_done_date  TEXT,
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now'))
  )`,
];
for (const sql of schedulingMigrations) {
  try { db.exec(sql); } catch { /* column already exists */ }
}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_google ON tasks(google_task_id)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_snoozed ON tasks(snoozed_until)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_tasks_source_ref ON tasks(source_ref)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_person ON facts(person_id)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_commitment_open ON facts(fact_type, completed_at, active)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_facts_valid_until ON facts(valid_until)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_hygiene_run ON hygiene_log(run_id)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_drafts_status ON fact_drafts(status)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_actions_status ON actions(status)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_actions_executed ON actions(executed_at)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_computer_use_created ON computer_use_log(created_at)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_imsg_privacy ON imessage_log(privacy_scope, ts)'); } catch { /* */ }
// The budget sums filter on created_at (daily/weekly local windows) and the doctor
// slices by lane; caller is for the "who is spending" dashboard view.
try { db.exec('CREATE INDEX IF NOT EXISTS idx_llm_usage_created ON llm_usage(created_at)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_llm_usage_lane ON llm_usage(lane, created_at)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_llm_usage_caller ON llm_usage(caller, created_at)'); } catch { /* */ }
// The arbiter runs these on every interrupt, so they must all be index-covered.
try { db.exec('CREATE INDEX IF NOT EXISTS idx_outbound_subject ON outbound_log(subject, created_at)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_outbound_decision ON outbound_log(decision, created_at)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_outbound_hash ON outbound_log(text_hash, created_at)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_imessage_drafts_status ON imessage_extraction_drafts(status, created_at)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_imessage_history_batches_status ON imessage_history_batches(status, started_at)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_imessage_history_rows_batch ON imessage_history_rows(batch_id, disposition)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_imessage_history_commits_batch ON imessage_history_fact_commits(batch_id, fact_id)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_email_loops_status ON email_open_loops(status, last_checked_at)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_email_loops_source ON email_open_loops(source_message_id)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_email_loops_entity ON email_open_loops(entity_key, status)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_email_loop_evidence_time ON email_open_loop_evidence(open_loop_id, occurred_at)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_email_loop_transitions_time ON email_open_loop_transitions(observed_at)'); } catch { /* */ }
try { db.exec('CREATE INDEX IF NOT EXISTS idx_email_reconciliation_runs_time ON email_reconciliation_runs(started_at)'); } catch { /* */ }

export function saveMessage(
  groupId: string,
  sender: string,
  role: string,
  content: string,
  createdAt?: string,
) {
  if (createdAt !== undefined) {
    const timestamp = Date.parse(createdAt);
    if (!Number.isFinite(timestamp)) throw new Error('Message createdAt must be a valid timestamp.');
    // Match SQLite's UTC default format so ordering remains correct when rows
    // with original source times are interleaved with ordinary local inserts.
    const sqliteCreatedAt = new Date(timestamp).toISOString()
      .replace('T', ' ')
      .replace(/\.\d{3}Z$/, '');
    db.prepare(
      'INSERT INTO messages (group_id, sender, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(groupId, sender, role, content, sqliteCreatedAt);
    return;
  }
  db.prepare('INSERT INTO messages (group_id, sender, role, content) VALUES (?, ?, ?, ?)')
    .run(groupId, sender, role, content);
}

export function getRecentMessages(groupId: string, limit = 75): { role: string; content: string }[] {
  return db.prepare(
    'SELECT role, content FROM messages WHERE group_id = ? ORDER BY created_at DESC LIMIT ?'
  ).all(groupId, limit).reverse() as { role: string; content: string }[];
}

/** Durable, timestamped conversation context for bounded shared-intent flows.
 * Unlike the prompt-history helper, this keeps sender and time so an AMI
 * continuation expires deterministically across restarts. */
export function getRecentMessagesWithMetadata(groupId: string, limit = 75): MessageRow[] {
  return db.prepare(
    `SELECT id, group_id, sender, role, content, created_at
     FROM messages WHERE group_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).all(groupId, limit).reverse() as MessageRow[];
}

export interface MessageRow {
  id: number;
  group_id: string;
  sender: string;
  role: string;
  content: string;
  created_at: string;
}

// All messages across groups since a timestamp, oldest first.
// Used by the nightly reflection to scan everything new in one pass.
export function getMessagesSince(isoTimestamp: string): MessageRow[] {
  return db
    .prepare(
      `SELECT id, group_id, sender, role, content, created_at
       FROM messages WHERE created_at >= ?
       ORDER BY created_at ASC`
    )
    .all(isoTimestamp) as MessageRow[];
}

/** Query conversation history through an explicit group allowlist. This is the
 * only safe form for cross-group background processing such as reflection. */
export function getMessagesSinceForGroups(
  isoTimestamp: string,
  groupIds: readonly string[],
): MessageRow[] {
  const groups = [...new Set(groupIds.map((id) => id.trim()).filter(Boolean))];
  if (groups.length === 0) return [];
  const placeholders = groups.map(() => '?').join(',');
  return db
    .prepare(
      `SELECT id, group_id, sender, role, content, created_at
       FROM messages
       WHERE created_at >= ? AND group_id IN (${placeholders})
       ORDER BY created_at ASC`,
    )
    .all(isoTimestamp, ...groups) as MessageRow[];
}

// ── Phase 5: passive iMessage capture ───────────────────────────────────────

export interface IMessageLogRow {
  id: number;
  rowid_src: number;
  chat_id: string;
  chat_name: string | null;
  sender: string;
  direction: string; // 'in' | 'out'
  text: string | null;
  ts: string;
  extracted_at: string | null;
  privacy_scope: string | null;
  created_at: string;
}

// Log one observed iMessage. INSERT OR IGNORE on the UNIQUE rowid_src means
// re-polling the same chat.db ROWID never double-logs.
export function logIMessage(row: {
  rowid_src: number;
  chat_id: string;
  chat_name?: string | null;
  sender: string;
  direction: 'in' | 'out';
  text?: string | null;
  ts: string;
  /** Family rows are processed in their isolated live path and must never be
   * visible to the global extraction daemon, even between database commits. */
  alreadyExtracted?: boolean;
  /** Durable search/retrieval exclusion, independent of extraction state. */
  privacyScope?: 'family';
}): void {
  db.prepare(
    `INSERT INTO imessage_log
       (rowid_src, chat_id, chat_name, sender, direction, text, ts, extracted_at, privacy_scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END, ?)
     ON CONFLICT(rowid_src) DO UPDATE SET
       extracted_at = CASE
         WHEN excluded.extracted_at IS NOT NULL
           THEN COALESCE(imessage_log.extracted_at, excluded.extracted_at)
         ELSE imessage_log.extracted_at
       END,
       privacy_scope = COALESCE(imessage_log.privacy_scope, excluded.privacy_scope)`
  ).run(
    row.rowid_src,
    row.chat_id,
    row.chat_name ?? null,
    row.sender,
    row.direction,
    row.text ?? null,
    row.ts,
    row.alreadyExtracted ? 1 : 0,
    row.privacyScope ?? null,
  );
}

/**
 * Atomically quarantine every pending row for one chat from the global
 * iMessage extraction daemon. This closes the startup/backlog window for the
 * Family chat; live inserts use `alreadyExtracted` in `logIMessage`.
 */
export function quarantineIMessageChat(chatId: string): number {
  const normalized = chatId.trim();
  if (!normalized) return 0;
  const result = db.prepare(
    `UPDATE imessage_log
     SET extracted_at = COALESCE(extracted_at, datetime('now')),
         privacy_scope = COALESCE(privacy_scope, 'family')
     WHERE chat_id = ? AND (extracted_at IS NULL OR privacy_scope IS NULL)`,
  ).run(normalized);
  return result.changes;
}

/**
 * Return the highest chat.db ROWID already observed by the previous Assistant
 * process. On the first durable-Family deployment this is the handoff watermark:
 * the new process can resume after the last row the old process saw instead of
 * pinning its boundary after the restart and losing messages from that gap.
 * It proves observation, not handler completion, so first activation still
 * requires a quiet, settled handoff.
 *
 * Omit `chatId` to read the global observation watermark. That global value is
 * used only to detect a rebuilt Messages database whose ROWID sequence moved
 * backwards; message content is never returned here.
 */
export function getLatestObservedIMessageRowId(chatId?: string): number | null {
  const normalized = chatId?.trim();
  const row = normalized
    ? db.prepare(
        `SELECT MAX(rowid_src) AS max_rowid FROM imessage_log WHERE chat_id = ?`,
      ).get(normalized) as { max_rowid: number | null }
    : db.prepare(
        `SELECT MAX(rowid_src) AS max_rowid FROM imessage_log`,
      ).get() as { max_rowid: number | null };
  return Number.isSafeInteger(row.max_rowid) && Number(row.max_rowid) >= 0
    ? Number(row.max_rowid)
    : null;
}

/** Atomically quarantine known Family-private rows and make the exclusion
 * durable for every global message-search/retrieval caller. */
export function quarantineFamilyIMessages(ids: number[]): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE imessage_log
     SET extracted_at = COALESCE(extracted_at, datetime('now')),
         privacy_scope = COALESCE(privacy_scope, 'family')
     WHERE id IN (${placeholders})`,
  ).run(...ids);
}

// ── Durable Family iMessage delivery ──────────────────────────────────────

export type FamilyIMessageInboxState =
  | 'queued'
  | 'processing'
  | 'succeeded'
  | 'send_in_doubt'
  | 'failed_before_dispatch';

export interface FamilyIMessageInboxCursor {
  chat_id: string;
  activation_rowid: number;
  last_scanned_rowid: number;
  activated_at: string;
  updated_at: string;
}

export interface FamilyIMessageInboxRow {
  id: number;
  chat_id: string;
  source_rowid: number;
  source_guid: string | null;
  sender: string;
  raw_text: string | null;
  message_ts: string;
  has_attachment: number;
  state: FamilyIMessageInboxState;
  error_code: string | null;
  queued_at: string;
  processing_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

function requireFamilyInboxChatId(chatId: string): string {
  const normalized = chatId.trim();
  if (!normalized) throw new Error('Family inbox chat ID is required.');
  return normalized;
}

function requireSourceRowId(sourceRowId: number): number {
  if (!Number.isSafeInteger(sourceRowId) || sourceRowId < 0) {
    throw new Error('Family inbox source ROWID must be a non-negative safe integer.');
  }
  return sourceRowId;
}

/**
 * Establish the no-history-replay boundary once for an exact Family chat.
 * Repeated calls never move the original boundary or the durable scan cursor.
 */
export function activateFamilyIMessageInbox(
  chatId: string,
  currentLatestRowId: number,
): { activated: boolean; cursor: FamilyIMessageInboxCursor } {
  const normalized = requireFamilyInboxChatId(chatId);
  const baseline = requireSourceRowId(currentLatestRowId);
  const inserted = db.prepare(
    `INSERT OR IGNORE INTO family_imessage_inbox_state
       (chat_id, activation_rowid, last_scanned_rowid)
     VALUES (?, ?, ?)`,
  ).run(normalized, baseline, baseline);
  const cursor = db.prepare(
    `SELECT chat_id, activation_rowid, last_scanned_rowid, activated_at, updated_at
     FROM family_imessage_inbox_state WHERE chat_id = ?`,
  ).get(normalized) as FamilyIMessageInboxCursor | undefined;
  if (!cursor) throw new Error('Family inbox activation did not persist.');
  return { activated: inserted.changes > 0, cursor };
}

export function getFamilyIMessageInboxCursor(chatId: string): FamilyIMessageInboxCursor | null {
  const normalized = requireFamilyInboxChatId(chatId);
  return (db.prepare(
    `SELECT chat_id, activation_rowid, last_scanned_rowid, activated_at, updated_at
     FROM family_imessage_inbox_state WHERE chat_id = ?`,
  ).get(normalized) as FamilyIMessageInboxCursor | undefined) ?? null;
}

/**
 * Recover from a Messages database rebuild whose ROWID sequence restarted.
 * Existing delivery rows are retained under an opaque retired generation so
 * reused ROWIDs/GUIDs cannot collide with the new source database. The current
 * chat resumes strictly after the new database tip and therefore never replays
 * restored history as fresh directives.
 */
export function rebaseFamilyIMessageInboxAfterSourceReset(
  chatId: string,
  currentLatestRowId: number,
): { rebased: boolean; retiredRows: number } {
  const normalized = requireFamilyInboxChatId(chatId);
  const baseline = requireSourceRowId(currentLatestRowId);
  return db.transaction(() => {
    const cursor = db.prepare(
      `SELECT last_scanned_rowid FROM family_imessage_inbox_state WHERE chat_id = ?`,
    ).get(normalized) as { last_scanned_rowid: number } | undefined;
    if (!cursor) throw new Error('Family inbox must be activated before rebasing.');
    if (baseline >= cursor.last_scanned_rowid) return { rebased: false, retiredRows: 0 };

    const retiredChatId = `retired:${randomUUID()}`;
    const retired = db.prepare(
      `UPDATE family_imessage_inbox SET chat_id = ? WHERE chat_id = ?`,
    ).run(retiredChatId, normalized).changes;
    const updated = db.prepare(
      `UPDATE family_imessage_inbox_state
       SET activation_rowid = ?, last_scanned_rowid = ?, updated_at = datetime('now')
       WHERE chat_id = ? AND last_scanned_rowid > ?`,
    ).run(baseline, baseline, normalized, baseline).changes;
    if (updated !== 1) throw new Error('Family inbox source-reset rebase did not persist.');
    return { rebased: true, retiredRows: retired };
  })();
}

export type FamilyIMessageScanRecord = {
  chatId: string;
  sourceRowId: number;
  sourceGuid?: string | null;
  /** Omit sender to advance the durable scan cursor without dispatching. */
  sender?: string | null;
  rawText?: string | null;
  messageTimestamp?: string;
  hasAttachment?: boolean;
};

/**
 * Atomically enqueue one dispatchable Family row (if supplied) and advance the
 * exact chat's scan cursor. A crash can therefore leave either both effects or
 * neither; it cannot persist a cursor that skips an unrecorded request.
 */
export function recordFamilyIMessageScan(
  input: FamilyIMessageScanRecord,
): { inserted: boolean; inboxId: number | null } {
  const chatId = requireFamilyInboxChatId(input.chatId);
  const sourceRowId = requireSourceRowId(input.sourceRowId);
  const sourceGuid = input.sourceGuid?.trim() || null;
  const sender = input.sender?.trim() || null;

  return db.transaction(() => {
    const cursor = db.prepare(
      `SELECT last_scanned_rowid FROM family_imessage_inbox_state WHERE chat_id = ?`,
    ).get(chatId) as { last_scanned_rowid: number } | undefined;
    if (!cursor) throw new Error('Family inbox must be activated before scanning.');
    if (sourceRowId <= cursor.last_scanned_rowid) {
      return { inserted: false, inboxId: null };
    }

    let inserted = false;
    let inboxId: number | null = null;
    if (sender) {
      const timestamp = input.messageTimestamp?.trim();
      if (!timestamp || !Number.isFinite(Date.parse(timestamp))) {
        throw new Error('Family inbox message timestamp must be a valid ISO timestamp.');
      }
      const result = db.prepare(
        `INSERT OR IGNORE INTO family_imessage_inbox
           (chat_id, source_rowid, source_guid, sender, raw_text, message_ts, has_attachment)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        chatId,
        sourceRowId,
        sourceGuid,
        sender,
        input.rawText ?? null,
        timestamp,
        input.hasAttachment ? 1 : 0,
      );
      inserted = result.changes > 0;
      if (inserted) inboxId = Number(result.lastInsertRowid);
    }

    db.prepare(
      `UPDATE family_imessage_inbox_state
       SET last_scanned_rowid = ?, updated_at = datetime('now')
       WHERE chat_id = ? AND last_scanned_rowid < ?`,
    ).run(sourceRowId, chatId, sourceRowId);
    return { inserted, inboxId };
  })();
}

/** Oldest-first work that is safe to start. Processing/send-in-doubt rows are
 * deliberately absent: an uncertain action is never replayed automatically. */
export function getQueuedFamilyIMessages(chatId: string): FamilyIMessageInboxRow[] {
  const normalized = requireFamilyInboxChatId(chatId);
  return db.prepare(
    `SELECT * FROM family_imessage_inbox
     WHERE chat_id = ? AND state = 'queued'
     ORDER BY source_rowid ASC, id ASC`,
  ).all(normalized) as FamilyIMessageInboxRow[];
}

/** Claim immediately before entering the user handler. The compare-and-set is
 * the last duplicate-delivery guard if the same row was enqueued twice in RAM. */
export function claimFamilyIMessage(inboxId: number): boolean {
  const result = db.prepare(
    `UPDATE family_imessage_inbox
     SET state = 'processing', processing_at = datetime('now'),
         error_code = NULL, updated_at = datetime('now')
     WHERE id = ? AND state = 'queued'`,
  ).run(inboxId);
  return result.changes > 0;
}

export function markFamilyIMessageSucceeded(inboxId: number): boolean {
  const result = db.prepare(
    `UPDATE family_imessage_inbox
     SET state = 'succeeded', completed_at = datetime('now'),
         error_code = NULL, updated_at = datetime('now')
     WHERE id = ? AND state = 'processing'`,
  ).run(inboxId);
  return result.changes > 0;
}

export function markFamilyIMessageSendInDoubt(
  inboxId: number,
  errorCode = 'handler_interrupted',
): boolean {
  const result = db.prepare(
    `UPDATE family_imessage_inbox
     SET state = 'send_in_doubt', completed_at = datetime('now'),
         error_code = ?, updated_at = datetime('now')
     WHERE id = ? AND state = 'processing'`,
  ).run(errorCode, inboxId);
  return result.changes > 0;
}

export function markFamilyIMessageFailedBeforeDispatch(
  inboxId: number,
  errorCode = 'pre_dispatch_failure',
): boolean {
  const result = db.prepare(
    `UPDATE family_imessage_inbox
     SET state = 'failed_before_dispatch', completed_at = datetime('now'),
         error_code = ?, updated_at = datetime('now')
     WHERE id = ? AND state = 'queued'`,
  ).run(errorCode, inboxId);
  return result.changes > 0;
}

/**
 * A prior process died after the durable claim. Whether its tool call reached
 * the provider is unknowable, so startup converts every such row to an
 * operator-visible terminal state instead of replaying it.
 */
export function recoverInterruptedFamilyIMessages(chatId: string): number {
  const normalized = requireFamilyInboxChatId(chatId);
  const result = db.prepare(
    `UPDATE family_imessage_inbox
     SET state = 'send_in_doubt', completed_at = datetime('now'),
         error_code = 'process_interrupted', updated_at = datetime('now')
     WHERE chat_id = ? AND state = 'processing'`,
  ).run(normalized);
  return result.changes;
}

/** Test/doctor readback; never used to assemble a Family prompt. */
export function getFamilyIMessageInboxRows(chatId: string): FamilyIMessageInboxRow[] {
  const normalized = requireFamilyInboxChatId(chatId);
  return db.prepare(
    `SELECT * FROM family_imessage_inbox WHERE chat_id = ?
     ORDER BY source_rowid ASC, id ASC`,
  ).all(normalized) as FamilyIMessageInboxRow[];
}

// Backfill one historical iMessage from chat.db. Same idempotent INSERT OR IGNORE
// as logIMessage, but stamps extracted_at = now so the imessage-daemon does NOT run
// LLM extraction over years of old history — backfilled rows are for search only.
// Returns true if a new row was inserted (false if the ROWID was already present).
export function backfillIMessage(row: {
  rowid_src: number;
  chat_id: string;
  chat_name?: string | null;
  sender: string;
  direction: 'in' | 'out';
  text?: string | null;
  ts: string;
}): boolean {
  const privacyScope = process.env.GROUP_FAMILY?.trim() === row.chat_id ? 'family' : null;
  const res = db.prepare(
    `INSERT OR IGNORE INTO imessage_log
       (rowid_src, chat_id, chat_name, sender, direction, text, ts, extracted_at, privacy_scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)`
  ).run(
    row.rowid_src,
    row.chat_id,
    row.chat_name ?? null,
    row.sender,
    row.direction,
    row.text ?? null,
    row.ts,
    privacyScope,
  );
  if (privacyScope) {
    db.prepare(
      `UPDATE imessage_log
       SET extracted_at = COALESCE(extracted_at, datetime('now')),
           privacy_scope = COALESCE(privacy_scope, ?)
       WHERE rowid_src = ?`,
    ).run(privacyScope, row.rowid_src);
  }
  return res.changes > 0;
}

// Bulk backfill wrapped in a single transaction (152k individual inserts in WAL mode
// would otherwise fsync per row). Returns how many rows were newly inserted.
export function backfillIMessages(rows: Array<Parameters<typeof backfillIMessage>[0]>): number {
  const txn = db.transaction((batch: Array<Parameters<typeof backfillIMessage>[0]>) => {
    let inserted = 0;
    for (const r of batch) if (backfillIMessage(r)) inserted++;
    return inserted;
  });
  return txn(rows);
}

// Oldest-first batch of messages the daemon hasn't processed yet.
export function getUnextractedIMessages(limit = 100): IMessageLogRow[] {
  return db
    .prepare(
      `SELECT id, rowid_src, chat_id, chat_name, sender, direction, text, ts, extracted_at, privacy_scope, created_at
       FROM imessage_log WHERE extracted_at IS NULL
       ORDER BY id ASC LIMIT ?`
    )
    .all(limit) as IMessageLogRow[];
}

/**
 * Read only unprocessed rows at or after a deliberate activation boundary.
 * Older NULL rows remain untouched for a separate reviewed backfill; unlike
 * marking them extracted, this is reversible and preserves the backlog.
 */
export function getUnextractedIMessagesSince(notBefore: string, limit = 100): IMessageLogRow[] {
  return db.prepare(
    `SELECT id, rowid_src, chat_id, chat_name, sender, direction, text, ts, extracted_at, privacy_scope, created_at
     FROM imessage_log
     WHERE extracted_at IS NULL AND datetime(ts) >= datetime(?)
     ORDER BY id ASC LIMIT ?`,
  ).all(notBefore, limit) as IMessageLogRow[];
}

export interface IMessageExtractionDraft {
  id: number;
  batch_key: string;
  source_row_ids: string;
  source_start: string | null;
  source_end: string | null;
  extraction_json: string;
  status: 'pending' | 'accepted' | 'discarded';
  created_at: string;
  reviewed_at: string | null;
}

export function createIMessageExtractionDraft(args: {
  batchKey: string;
  sourceRowIds: number[];
  sourceStart?: string;
  sourceEnd?: string;
  extraction: unknown;
}): number | null {
  const result = db.prepare(
    `INSERT OR IGNORE INTO imessage_extraction_drafts
       (batch_key, source_row_ids, source_start, source_end, extraction_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    args.batchKey,
    JSON.stringify(args.sourceRowIds),
    args.sourceStart ?? null,
    args.sourceEnd ?? null,
    JSON.stringify(args.extraction),
  );
  return result.changes ? Number(result.lastInsertRowid) : null;
}

export function listIMessageExtractionDrafts(opts: {
  status?: IMessageExtractionDraft['status'];
  limit?: number;
} = {}): IMessageExtractionDraft[] {
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  return opts.status
    ? db.prepare(
        'SELECT * FROM imessage_extraction_drafts WHERE status = ? ORDER BY id DESC LIMIT ?',
      ).all(opts.status, limit) as IMessageExtractionDraft[]
    : db.prepare(
        'SELECT * FROM imessage_extraction_drafts ORDER BY id DESC LIMIT ?',
      ).all(limit) as IMessageExtractionDraft[];
}

export type IMessageHistoryDisposition =
  | 'committed'
  | 'no_signal'
  | 'private'
  | 'bot_generated'
  | 'empty'
  | 'error';

export interface IMessageHistoryBatchRow {
  id: number;
  batch_key: string;
  status: 'running' | 'completed' | 'failed';
  source_row_ids: string;
  source_start: string | null;
  source_end: string | null;
  scanned_count: number;
  safe_count: number;
  private_count: number;
  bot_count: number;
  observation_count: number;
  fact_count: number;
  attempt_count: number;
  model: string | null;
  error: string | null;
  started_at: string;
  completed_at: string | null;
}

export interface IMessageHistoryFactInput {
  fingerprint: string;
  kind: 'fact' | 'figure' | 'link' | 'preference' | 'decision';
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
  sourceMessageIds: number[];
  sourceRef: string;
  evidenceQuote: string;
  observedAt: string;
}

/** Newest-first history cursor, independent of imessage_log.extracted_at. */
export function getNextIMessageHistoryRows(before: string, limit = 75): IMessageLogRow[] {
  const bounded = Math.max(1, Math.min(Math.floor(limit), 200));
  return db.prepare(
    `SELECT l.id, l.rowid_src, l.chat_id, l.chat_name, l.sender, l.direction,
            l.text, l.ts, l.extracted_at, l.privacy_scope, l.created_at
     FROM imessage_log l
     LEFT JOIN imessage_history_rows h ON h.imessage_id = l.id
     WHERE h.imessage_id IS NULL
       AND l.privacy_scope IS NULL
       AND datetime(l.ts) < datetime(?)
     ORDER BY l.id DESC
     LIMIT ?`,
  ).all(before, bounded) as IMessageLogRow[];
}

export function beginIMessageHistoryBatch(args: {
  batchKey: string;
  rows: IMessageLogRow[];
  model: string;
}): IMessageHistoryBatchRow {
  const ids = args.rows.map((row) => row.id);
  const times = args.rows.map((row) => row.ts).sort();
  const txn = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO imessage_history_batches
         (batch_key, source_row_ids, source_start, source_end, scanned_count, model)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      args.batchKey,
      JSON.stringify(ids),
      times[0] ?? null,
      times[times.length - 1] ?? null,
      ids.length,
      args.model,
    );
    db.prepare(
      `UPDATE imessage_history_batches
       SET status = 'running', attempt_count = attempt_count + 1,
           error = NULL, started_at = datetime('now'), completed_at = NULL
       WHERE batch_key = ? AND status != 'completed'`,
    ).run(args.batchKey);
    return db.prepare(
      'SELECT * FROM imessage_history_batches WHERE batch_key = ?',
    ).get(args.batchKey) as IMessageHistoryBatchRow;
  });
  return txn();
}

export function failIMessageHistoryBatch(batchId: number, error: string): void {
  db.prepare(
    `UPDATE imessage_history_batches
     SET status = 'failed', error = ?, completed_at = datetime('now')
     WHERE id = ?`,
  ).run(error.slice(0, 1000), batchId);
}

/**
 * Atomically append evidence-backed historical references and advance the
 * separate history cursor. These are always owner-private reference facts;
 * they cannot supersede current preferences, decisions, or metrics.
 */
export function commitIMessageHistoryBatch(args: {
  batchId: number;
  dispositions: Array<{ imessageId: number; disposition: IMessageHistoryDisposition }>;
  facts: IMessageHistoryFactInput[];
  safeCount: number;
  privateCount: number;
  botCount: number;
  observationCount: number;
}): { factsInserted: number } {
  const txn = db.transaction(() => {
    let factsInserted = 0;
    for (const fact of args.facts) {
      const prior = db.prepare(
        'SELECT fact_id FROM imessage_history_fact_commits WHERE fingerprint = ?',
      ).get(fact.fingerprint) as { fact_id: number } | undefined;
      if (prior) continue;

      const factId = saveFact({
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        fact_type: 'reference',
        group_id: 'admin',
        source: 'imessage-history',
        source_ref: fact.sourceRef,
        confidence: fact.confidence,
        sensitive: true,
        mode: 'append',
      });
      db.prepare(
        `INSERT INTO imessage_history_fact_commits
           (batch_id, fact_id, fingerprint, kind, source_message_ids, evidence_quote, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        args.batchId,
        factId,
        fact.fingerprint,
        fact.kind,
        JSON.stringify(fact.sourceMessageIds),
        fact.evidenceQuote,
        fact.observedAt,
      );
      factsInserted++;
    }

    const rowInsert = db.prepare(
      `INSERT OR IGNORE INTO imessage_history_rows (imessage_id, batch_id, disposition)
       VALUES (?, ?, ?)`,
    );
    for (const row of args.dispositions) {
      rowInsert.run(row.imessageId, args.batchId, row.disposition);
    }

    db.prepare(
      `UPDATE imessage_history_batches
       SET status = 'completed', safe_count = ?, private_count = ?, bot_count = ?,
           observation_count = ?, fact_count = ?, error = NULL,
           completed_at = datetime('now')
       WHERE id = ?`,
    ).run(
      args.safeCount,
      args.privateCount,
      args.botCount,
      args.observationCount,
      factsInserted,
      args.batchId,
    );
    return { factsInserted };
  });
  return txn();
}

export function getIMessageHistoryStatus(before: string): {
  remaining: number;
  processed: number;
  facts: number;
  completedBatches: number;
  failedBatches: number;
  latestBatch: IMessageHistoryBatchRow | null;
} {
  const remaining = (db.prepare(
    `SELECT COUNT(*) AS n FROM imessage_log l
     LEFT JOIN imessage_history_rows h ON h.imessage_id = l.id
     WHERE h.imessage_id IS NULL AND l.privacy_scope IS NULL
       AND datetime(l.ts) < datetime(?)`,
  ).get(before) as { n: number }).n;
  const processed = (db.prepare(
    `SELECT COUNT(*) AS n FROM imessage_history_rows h
     JOIN imessage_log l ON l.id = h.imessage_id
     WHERE datetime(l.ts) < datetime(?)`,
  ).get(before) as { n: number }).n;
  const facts = (db.prepare('SELECT COUNT(*) AS n FROM imessage_history_fact_commits').get() as { n: number }).n;
  const counts = db.prepare(
    `SELECT SUM(status = 'completed') AS completed, SUM(status = 'failed') AS failed
     FROM imessage_history_batches`,
  ).get() as { completed: number | null; failed: number | null };
  const latestBatch = db.prepare(
    'SELECT * FROM imessage_history_batches ORDER BY id DESC LIMIT 1',
  ).get() as IMessageHistoryBatchRow | undefined;
  return {
    remaining,
    processed,
    facts,
    completedBatches: counts.completed ?? 0,
    failedBatches: counts.failed ?? 0,
    latestBatch: latestBatch ?? null,
  };
}

export interface IMessageHistoryCadenceRow {
  chat_id: string;
  chat_name: string | null;
  messages: number;
  incoming: number;
  outgoing: number;
  active_days: number;
  active_months: number;
  first_ts: string;
  last_ts: string;
  messages_per_active_month: number;
}

/** Traffic cadence only: never interpreted as closeness or meaningful contact. */
export function getIMessageHistoryCadence(limit = 20): IMessageHistoryCadenceRow[] {
  const bounded = Math.max(1, Math.min(Math.floor(limit), 200));
  return db.prepare(
    `SELECT l.chat_id, MAX(l.chat_name) AS chat_name,
            COUNT(*) AS messages,
            SUM(l.direction = 'in') AS incoming,
            SUM(l.direction = 'out') AS outgoing,
            COUNT(DISTINCT substr(l.ts, 1, 10)) AS active_days,
            COUNT(DISTINCT substr(l.ts, 1, 7)) AS active_months,
            MIN(l.ts) AS first_ts, MAX(l.ts) AS last_ts,
            ROUND(COUNT(*) * 1.0 / COUNT(DISTINCT substr(l.ts, 1, 7)), 2) AS messages_per_active_month
     FROM imessage_history_rows h
     JOIN imessage_log l ON l.id = h.imessage_id
     WHERE h.disposition IN ('committed', 'no_signal', 'empty')
     GROUP BY l.chat_id
     ORDER BY messages DESC
     LIMIT ?`,
  ).all(bounded) as IMessageHistoryCadenceRow[];
}

// Mark a batch processed. Call for BOTH extracted and filtered-out rows so the
// cursor always advances and nothing is reprocessed on the next tick.
export function markIMessagesExtracted(ids: number[]): void {
  if (!ids.length) return;
  const placeholders = ids.map(() => '?').join(',');
  db.prepare(
    `UPDATE imessage_log SET extracted_at = datetime('now') WHERE id IN (${placeholders})`
  ).run(...ids);
}

// Agent-facing search over observed iMessage history. Matches a free-text query against
// the message body, the sender handle, and the chat name. Optionally narrows to one
// sender/chat handle. Newest first. Note: only covers messages logged since the bot
// started observing (no historical backfill).
export function searchIMessages(opts: { query?: string; handle?: string; chatId?: string; limit?: number }): IMessageLogRow[] {
  const clauses: string[] = ['privacy_scope IS NULL', 'text IS NOT NULL', "TRIM(text) <> ''"];
  const params: (string | number)[] = [];
  // The Family chat has its own conversation/memory namespace. Keep its raw
  // rows for local delivery auditing, but never expose them through the global
  // owner message-search/retrieval surface.
  const familyChatId = process.env.GROUP_FAMILY?.trim();
  if (familyChatId) {
    clauses.push('chat_id <> ?');
    params.push(familyChatId);
  }
  if (opts.query && opts.query.trim()) {
    const q = `%${opts.query.trim()}%`;
    clauses.push('(text LIKE ? OR sender LIKE ? OR COALESCE(chat_name, \'\') LIKE ?)');
    params.push(q, q, q);
  }
  if (opts.handle && opts.handle.trim()) {
    const h = `%${opts.handle.trim()}%`;
    clauses.push('(sender LIKE ? OR chat_id LIKE ? OR COALESCE(chat_name, \'\') LIKE ?)');
    params.push(h, h, h);
  }
  if (opts.chatId && opts.chatId.trim()) {
    clauses.push('chat_id = ?');
    params.push(opts.chatId.trim());
  }
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  params.push(limit);
  return db.prepare(
    `SELECT * FROM imessage_log WHERE ${clauses.join(' AND ')} ORDER BY ts DESC LIMIT ?`
  ).all(...params) as IMessageLogRow[];
}

// ── Inbox-signal extraction dedup (inbox-signal-daemon) ──────────────────────

// True if we've already enumerated this Spark message in a prior tick.
export function isEmailExtracted(messageId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM email_extraction_log WHERE message_id = ? LIMIT 1')
    .get(messageId);
  return row !== undefined;
}

// Record that a Spark message has been processed. Call for BOTH emails that
// yielded artifacts and ones the prefilter dropped, so the cursor always
// advances. INSERT OR IGNORE keeps re-enumeration idempotent. Returns true if
// this was the first time we've seen this message_id.
export function markEmailExtracted(row: {
  message_id: string;
  account?: string | null;
  subject?: string | null;
  sender?: string | null;
  ts?: string | null;
  signal_count?: number;
}): boolean {
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO email_extraction_log (message_id, account, subject, sender, ts, signal_count)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(
      row.message_id,
      row.account ?? null,
      row.subject ?? null,
      row.sender ?? null,
      row.ts ?? null,
      row.signal_count ?? 0,
    );
  return res.changes > 0;
}

// ── Cross-system email reconciliation ledger ────────────────────────────────

export type EmailOpenLoopStatus =
  | 'open'
  | 'drafted'
  | 'tasked'
  | 'responded'
  | 'scheduled'
  | 'resolved'
  | 'uncertain';

export interface EmailOpenLoopRow {
  id: number;
  loop_key: string;
  entity_key: string | null;
  account: string | null;
  source_message_id: string;
  source_thread_key: string | null;
  subject: string;
  contact: string | null;
  kind: string;
  requested_action: string | null;
  status: EmailOpenLoopStatus;
  resolution_kind: string | null;
  confidence: number;
  task_id: number | null;
  calendar_event_id: string | null;
  latest_inbound_at: string | null;
  latest_outbound_at: string | null;
  resolved_at: string | null;
  last_checked_at: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailOpenLoopEvidenceRow {
  id: number;
  open_loop_id: number;
  evidence_type: string;
  source_ref: string;
  occurred_at: string | null;
  direction: string | null;
  summary: string;
  confidence: number;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailOpenLoopTransitionRow {
  id: number;
  open_loop_id: number;
  from_status: string | null;
  to_status: EmailOpenLoopStatus;
  resolution_kind: string | null;
  evidence_ref: string | null;
  confidence: number;
  observed_at: string;
  subject?: string;
  contact?: string | null;
}

export function upsertEmailOpenLoop(input: {
  loopKey: string;
  entityKey?: string | null;
  account?: string | null;
  sourceMessageId: string;
  sourceThreadKey?: string | null;
  subject: string;
  contact?: string | null;
  kind?: string;
  requestedAction?: string | null;
  taskId?: number | null;
  calendarEventId?: string | null;
  metadata?: Record<string, unknown> | null;
}): EmailOpenLoopRow {
  const metadataJson = input.metadata ? JSON.stringify(input.metadata) : null;
  db.prepare(
    `INSERT INTO email_open_loops
       (loop_key, entity_key, account, source_message_id, source_thread_key,
        subject, contact, kind, requested_action, task_id, calendar_event_id,
        metadata_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(loop_key) DO UPDATE SET
       entity_key = COALESCE(excluded.entity_key, email_open_loops.entity_key),
       account = COALESCE(excluded.account, email_open_loops.account),
       source_thread_key = COALESCE(excluded.source_thread_key, email_open_loops.source_thread_key),
       subject = CASE WHEN excluded.subject <> '' THEN excluded.subject ELSE email_open_loops.subject END,
       contact = COALESCE(excluded.contact, email_open_loops.contact),
       kind = CASE WHEN excluded.kind <> '' THEN excluded.kind ELSE email_open_loops.kind END,
       requested_action = COALESCE(excluded.requested_action, email_open_loops.requested_action),
       task_id = COALESCE(excluded.task_id, email_open_loops.task_id),
       calendar_event_id = COALESCE(excluded.calendar_event_id, email_open_loops.calendar_event_id),
       metadata_json = COALESCE(excluded.metadata_json, email_open_loops.metadata_json),
       updated_at = datetime('now')`
  ).run(
    input.loopKey,
    input.entityKey ?? null,
    input.account ?? null,
    input.sourceMessageId,
    input.sourceThreadKey ?? null,
    input.subject,
    input.contact ?? null,
    input.kind || 'email',
    input.requestedAction ?? null,
    input.taskId ?? null,
    input.calendarEventId ?? null,
    metadataJson,
  );
  return db.prepare('SELECT * FROM email_open_loops WHERE loop_key = ?').get(input.loopKey) as EmailOpenLoopRow;
}

export function getEmailOpenLoopByMessageId(messageId: string): EmailOpenLoopRow | undefined {
  return db.prepare(
    `SELECT * FROM email_open_loops
     WHERE source_message_id = ?
        OR id IN (
          SELECT open_loop_id FROM email_open_loop_evidence WHERE source_ref = ?
        )
     ORDER BY id DESC LIMIT 1`
  ).get(messageId, `email:${messageId}`) as EmailOpenLoopRow | undefined;
}

export function getEmailOpenLoopByThreadKey(threadKey: string): EmailOpenLoopRow | undefined {
  return db.prepare(
    'SELECT * FROM email_open_loops WHERE source_thread_key = ? ORDER BY id DESC LIMIT 1'
  ).get(threadKey) as EmailOpenLoopRow | undefined;
}

export function getActiveEmailOpenLoopByEntityKey(entityKey: string): EmailOpenLoopRow | undefined {
  return db.prepare(
    `SELECT * FROM email_open_loops
     WHERE entity_key = ? AND status NOT IN ('resolved')
     ORDER BY updated_at DESC, id DESC LIMIT 1`
  ).get(entityKey) as EmailOpenLoopRow | undefined;
}

export function listEmailOpenLoops(opts: {
  statuses?: EmailOpenLoopStatus[];
  limit?: number;
} = {}): EmailOpenLoopRow[] {
  const statuses = opts.statuses?.length ? Array.from(new Set(opts.statuses)) : [];
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 250);
  if (!statuses.length) {
    return db.prepare(
      'SELECT * FROM email_open_loops ORDER BY updated_at DESC, id DESC LIMIT ?'
    ).all(limit) as EmailOpenLoopRow[];
  }
  const placeholders = statuses.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM email_open_loops WHERE status IN (${placeholders})
     ORDER BY updated_at DESC, id DESC LIMIT ?`
  ).all(...statuses, limit) as EmailOpenLoopRow[];
}

export function addEmailOpenLoopEvidence(input: {
  openLoopId: number;
  evidenceType: string;
  sourceRef: string;
  occurredAt?: string | null;
  direction?: string | null;
  summary: string;
  confidence?: number;
  metadata?: Record<string, unknown> | null;
}): void {
  db.prepare(
    `INSERT INTO email_open_loop_evidence
       (open_loop_id, evidence_type, source_ref, occurred_at, direction,
        summary, confidence, metadata_json, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(open_loop_id, evidence_type, source_ref) DO UPDATE SET
       occurred_at = COALESCE(excluded.occurred_at, email_open_loop_evidence.occurred_at),
       direction = COALESCE(excluded.direction, email_open_loop_evidence.direction),
       summary = excluded.summary,
       confidence = excluded.confidence,
       metadata_json = COALESCE(excluded.metadata_json, email_open_loop_evidence.metadata_json),
       updated_at = datetime('now')`
  ).run(
    input.openLoopId,
    input.evidenceType,
    input.sourceRef,
    input.occurredAt ?? null,
    input.direction ?? null,
    input.summary,
    input.confidence ?? 1,
    input.metadata ? JSON.stringify(input.metadata) : null,
  );
}

export function getEmailOpenLoopEvidence(openLoopId: number, limit = 25): EmailOpenLoopEvidenceRow[] {
  return db.prepare(
    `SELECT * FROM email_open_loop_evidence WHERE open_loop_id = ?
     ORDER BY COALESCE(occurred_at, created_at) DESC, id DESC LIMIT ?`
  ).all(openLoopId, Math.min(Math.max(limit, 1), 100)) as EmailOpenLoopEvidenceRow[];
}

export function updateEmailOpenLoopState(input: {
  openLoopId: number;
  status: EmailOpenLoopStatus;
  resolutionKind?: string | null;
  confidence: number;
  evidenceRef?: string | null;
  latestInboundAt?: string | null;
  latestOutboundAt?: string | null;
  taskId?: number | null;
  calendarEventId?: string | null;
  checkedAt?: string;
}): { row: EmailOpenLoopRow; changed: boolean } {
  const before = db.prepare('SELECT * FROM email_open_loops WHERE id = ?').get(input.openLoopId) as EmailOpenLoopRow | undefined;
  if (!before) throw new Error(`Email open loop #${input.openLoopId} not found`);
  const checkedAt = input.checkedAt || new Date().toISOString();
  const terminal = ['responded', 'scheduled', 'resolved'].includes(input.status);
  const changed = before.status !== input.status
    || (before.resolution_kind || null) !== (input.resolutionKind ?? null);

  db.transaction(() => {
    db.prepare(
      `UPDATE email_open_loops SET
         status = ?, resolution_kind = ?, confidence = ?,
         latest_inbound_at = COALESCE(?, latest_inbound_at),
         latest_outbound_at = COALESCE(?, latest_outbound_at),
         task_id = COALESCE(?, task_id),
         calendar_event_id = COALESCE(?, calendar_event_id),
         resolved_at = CASE WHEN ? = 1 THEN COALESCE(resolved_at, ?) ELSE NULL END,
         last_checked_at = ?, updated_at = datetime('now')
       WHERE id = ?`
    ).run(
      input.status,
      input.resolutionKind ?? null,
      Math.min(Math.max(input.confidence, 0), 1),
      input.latestInboundAt ?? null,
      input.latestOutboundAt ?? null,
      input.taskId ?? null,
      input.calendarEventId ?? null,
      terminal ? 1 : 0,
      checkedAt,
      checkedAt,
      input.openLoopId,
    );
    if (changed) {
      db.prepare(
        `INSERT INTO email_open_loop_transitions
           (open_loop_id, from_status, to_status, resolution_kind, evidence_ref, confidence, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        input.openLoopId,
        before.status,
        input.status,
        input.resolutionKind ?? null,
        input.evidenceRef ?? null,
        Math.min(Math.max(input.confidence, 0), 1),
        checkedAt,
      );
    }
  })();

  const row = db.prepare('SELECT * FROM email_open_loops WHERE id = ?').get(input.openLoopId) as EmailOpenLoopRow;
  return { row, changed };
}

export function linkEmailOpenLoopTaskByMessageId(messageId: string, taskId: number): void {
  db.prepare(
    `UPDATE email_open_loops SET task_id = ?, updated_at = datetime('now')
     WHERE source_message_id = ?
        OR id IN (
          SELECT open_loop_id FROM email_open_loop_evidence WHERE source_ref = ?
        )`
  ).run(taskId, messageId, `email:${messageId}`);
}

export function linkEmailOpenLoopCalendarByMessageId(messageId: string, calendarEventId: string): void {
  db.prepare(
    `UPDATE email_open_loops SET calendar_event_id = ?, updated_at = datetime('now')
     WHERE source_message_id = ?
        OR id IN (
          SELECT open_loop_id FROM email_open_loop_evidence WHERE source_ref = ?
        )`
  ).run(calendarEventId, messageId, `email:${messageId}`);
}

export function getRecentEmailOpenLoopTransitions(sinceIso: string, limit = 50): EmailOpenLoopTransitionRow[] {
  return db.prepare(
    `SELECT t.*, l.subject, l.contact
     FROM email_open_loop_transitions t
     JOIN email_open_loops l ON l.id = t.open_loop_id
     WHERE t.observed_at >= ?
     ORDER BY t.observed_at DESC, t.id DESC LIMIT ?`
  ).all(sinceIso, Math.min(Math.max(limit, 1), 200)) as EmailOpenLoopTransitionRow[];
}

export function startEmailReconciliationRun(input: {
  source: string;
  candidateCount: number;
  mode?: 'observe';
}): number {
  const result = db.prepare(
    `INSERT INTO email_reconciliation_runs (mode, source, candidate_count)
     VALUES (?, ?, ?)`
  ).run(input.mode || 'observe', input.source, input.candidateCount);
  return result.lastInsertRowid as number;
}

export function finishEmailReconciliationRun(input: {
  runId: number;
  checkedCount: number;
  transitionCount: number;
  errorCount: number;
  report?: unknown;
  error?: string | null;
}): void {
  db.prepare(
    `UPDATE email_reconciliation_runs SET
       checked_count = ?, transition_count = ?, error_count = ?,
       report_json = ?, error = ?, completed_at = datetime('now')
     WHERE id = ?`
  ).run(
    input.checkedCount,
    input.transitionCount,
    input.errorCount,
    input.report === undefined ? null : JSON.stringify(input.report),
    input.error ?? null,
    input.runId,
  );
}

export function createAsyncTask(groupId: string, sender: string, prompt: string): number {
  const result = db.prepare(
    'INSERT INTO async_tasks (group_id, sender, prompt) VALUES (?, ?, ?)'
  ).run(groupId, sender, prompt);
  return result.lastInsertRowid as number;
}

export function completeAsyncTask(taskId: number, result: string) {
  db.prepare(
    "UPDATE async_tasks SET status = 'done', result = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(result, taskId);
}

export function failAsyncTask(taskId: number, error: string) {
  db.prepare(
    "UPDATE async_tasks SET status = 'failed', result = ?, completed_at = datetime('now') WHERE id = ?"
  ).run(error, taskId);
}

export function getPendingTasks() {
  return db.prepare("SELECT * FROM async_tasks WHERE status = 'pending'").all();
}

export type WorkRequestStatus = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface WorkRequestRow {
  request_id: string;
  kind: string;
  workspace: string | null;
  operation: string | null;
  repo: string | null;
  request_text: string;
  metadata_json: string | null;
  status: WorkRequestStatus;
  result: string | null;
  created_by_group: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
}

export function createWorkRequest(input: {
  kind: 'work_request' | 'motion' | 'codex';
  workspace?: string;
  operation?: string;
  repo?: string;
  requestText: string;
  metadata?: Record<string, unknown>;
  groupId?: string;
}): string {
  const requestId = `wr_${Date.now().toString(36)}_${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO work_requests
       (request_id, kind, workspace, operation, repo, request_text, metadata_json, created_by_group)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    requestId,
    input.kind,
    input.workspace ?? null,
    input.operation ?? null,
    input.repo ?? null,
    input.requestText,
    input.metadata ? JSON.stringify(input.metadata) : null,
    input.groupId ?? null,
  );
  return requestId;
}

export function startWorkRequest(requestId: string): void {
  db.prepare(
    `UPDATE work_requests
     SET status = 'running', started_at = COALESCE(started_at, datetime('now')), updated_at = datetime('now')
     WHERE request_id = ?`
  ).run(requestId);
}

export function completeWorkRequest(requestId: string, result: string): void {
  db.prepare(
    `UPDATE work_requests
     SET status = 'done', result = ?, completed_at = datetime('now'), updated_at = datetime('now')
     WHERE request_id = ?`
  ).run(result, requestId);
}

export function failWorkRequest(requestId: string, error: string): void {
  db.prepare(
    `UPDATE work_requests
     SET status = 'failed', result = ?, completed_at = datetime('now'), updated_at = datetime('now')
     WHERE request_id = ?`
  ).run(error, requestId);
}

export function getWorkRequest(requestId: string): WorkRequestRow | undefined {
  return db.prepare('SELECT * FROM work_requests WHERE request_id = ?').get(requestId) as WorkRequestRow | undefined;
}

export function listWorkRequests(limit = 20): WorkRequestRow[] {
  const safeLimit = Math.min(Math.max(Math.floor(limit), 1), 100);
  return db.prepare('SELECT * FROM work_requests ORDER BY created_at DESC LIMIT ?').all(safeLimit) as WorkRequestRow[];
}

export function setMemory(groupId: string, key: string, value: string) {
  db.prepare(
    'INSERT OR REPLACE INTO memory (group_id, key, value, updated_at) VALUES (?, ?, ?, datetime(\'now\'))'
  ).run(groupId, key, value);
}

export function getMemory(groupId: string, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM memory WHERE group_id = ? AND key = ?').get(groupId, key) as { value: string } | undefined;
  return row?.value;
}

export function deleteMemory(groupId: string, key: string): void {
  db.prepare('DELETE FROM memory WHERE group_id = ? AND key = ?').run(groupId, key);
}

export interface MemoryEntry { key: string; value: string; updated_at: string }

export function getRecentMemory(
  groupId: string,
  opts: {
    prefix?: string;
    suffix?: string;
    excludePrefixes?: readonly string[];
    limit?: number;
  } = {}
): MemoryEntry[] {
  const limit = opts.limit ?? 5;
  const params: (string | number)[] = [groupId];
  let where = 'group_id = ?';
  if (opts.prefix) { where += ' AND key LIKE ?'; params.push(`${opts.prefix}%`); }
  if (opts.suffix) { where += ' AND key LIKE ?'; params.push(`%${opts.suffix}`); }
  for (const prefix of opts.excludePrefixes ?? []) {
    if (!prefix) continue;
    // Filter reserved internal rows in SQL, before LIMIT, so a burst of newer
    // delivery/security records cannot crowd all user-visible memory out.
    where += ' AND substr(lower(key), 1, length(?)) <> lower(?)';
    params.push(prefix, prefix);
  }
  params.push(limit);
  return db.prepare(
    `SELECT key, value, updated_at FROM memory WHERE ${where} ORDER BY updated_at DESC LIMIT ?`
  ).all(...params) as MemoryEntry[];
}

// --- Facts (knowledge store) ---

export interface Fact {
  id: number;
  subject: string;
  predicate: string;
  object: string;
  fact_type: string;
  group_id: string | null;
  source: string;
  source_ref: string | null;
  confidence: number;
  sensitive: number;
  valid_until: string | null;
  active: number;
  superseded_at: string | null;
  created_at: string;
  updated_at: string;
  person_id: number | null;
  // Phase 1 additions:
  last_surfaced_at: string | null;
  surface_count: number | null;
  completed_at: string | null;
}

// fact_types that overwrite prior (subject, predicate) rows. Others append.
const SUPERSEDE_FACT_TYPES = new Set(['preference', 'decision', 'metric']);

// Stopwords for FTS5 query sanitization. We strip these before building MATCH
// expressions so a sentence like "What's the Q1 budget?" tokenizes to {q1, budget}.
const FTS_STOPWORDS = new Set([
  'a','an','the','and','or','but','if','then','so',
  'is','are','was','were','be','been','being','am',
  'do','does','did','doing','done',
  'have','has','had','having',
  'i','me','my','mine','myself',
  'you','your','yours','yourself','youre','youve',
  'he','him','his','she','her','hers','it','its',
  'we','us','our','ours','they','them','their','theirs',
  'this','that','these','those',
  'what','whats','which','who','whom','where','when','why','how',
  'of','for','to','at','by','in','on','with','about','from','into','onto','as','out','up','down',
  'can','could','will','would','should','may','might','must','shall',
  'not','no','yes','very','just','now','then','here','there','also','too',
  'tell','show','give','get','got','let','lets','please',
  's','t','d','ll','ve','re','m',
]);

function ftsTokenize(text: string): string {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  const kept = tokens.filter((t) => t.length >= 2 && !FTS_STOPWORDS.has(t));
  if (kept.length === 0) return '';
  return kept.map((t) => `"${t}"`).join(' OR ');
}

export function saveFact(f: {
  subject: string;
  predicate: string;
  object: string;
  fact_type?: string;
  group_id?: string;
  source?: string;
  source_ref?: string;
  confidence?: number;
  /** Owner-private facts are excluded from every shared/non-private group. */
  sensitive?: boolean;
  valid_until?: string;
  mode?: 'append' | 'supersede';
  /** Canonical person link. If omitted, saveFact attempts an exact-name auto-bind
   *  to a row in `people` (case-insensitive). Set explicitly when the caller
   *  already knows the person id (calendar/spark/linkedin hooks). */
  person_id?: number | null;
}): number {
  const subject = f.subject.trim().toLowerCase();
  const predicate = f.predicate.trim().toLowerCase();
  if (!subject || !predicate) {
    throw new Error('saveFact: subject and predicate are required');
  }
  const fact_type = f.fact_type || 'fact';
  const mode = f.mode || (SUPERSEDE_FACT_TYPES.has(fact_type) ? 'supersede' : 'append');

  // Auto-bind: if the caller didn't pass a person_id, try to resolve the subject
  // to a person row via strict exact-name match (case-insensitive). Strict match
  // avoids false binds — "John" wouldn't bind to "John Smith".
  let personId: number | null = f.person_id ?? null;
  if (personId === null) {
    try {
      const hit = db
        .prepare('SELECT id FROM people WHERE name = ? COLLATE NOCASE LIMIT 1')
        .get(subject) as { id: number } | undefined;
      if (hit) personId = hit.id;
    } catch { /* ignore — auto-bind is opportunistic */ }
  }

  if (mode === 'supersede') {
    db.prepare(
      `UPDATE facts SET active = 0, superseded_at = datetime('now')
       WHERE subject = ? COLLATE NOCASE AND predicate = ? COLLATE NOCASE AND active = 1`
    ).run(subject, predicate);
  }

  const result = db.prepare(
    `INSERT INTO facts (subject, predicate, object, fact_type, group_id, source, source_ref, confidence, sensitive, valid_until, person_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    subject,
    predicate,
    f.object,
    fact_type,
    f.group_id || null,
    f.source || 'manual',
    f.source_ref || null,
    f.confidence ?? 1.0,
    f.sensitive ? 1 : 0,
    toSqliteDate(f.valid_until),
    personId,
  );
  return result.lastInsertRowid as number;
}

export function searchFacts(query: string, limit = 8): Fact[] {
  const ftsQuery = ftsTokenize(query);
  if (!ftsQuery) return [];
  try {
    return db.prepare(
      `SELECT f.* FROM facts_fts
       JOIN facts f ON f.id = facts_fts.rowid
       WHERE facts_fts MATCH ?
         AND f.active = 1
         AND (f.valid_until IS NULL OR datetime(f.valid_until) > datetime('now'))
       ORDER BY rank LIMIT ?`
    ).all(ftsQuery, limit) as Fact[];
  } catch {
    // FTS5 syntax errors shouldn't blow up the prompt-building path.
    return [];
  }
}

// Loose keyword tokens (non-stopword, len>=2) for a LIKE fallback. Unlike
// ftsTokenize this returns the raw tokens, not an FTS MATCH expression.
function looseTokens(text: string): string[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  return tokens.filter((t) => t.length >= 2 && !FTS_STOPWORDS.has(t));
}

// FTS-first fact search with a LIKE fallback. searchFacts (FTS5) is precise but
// brittle: a stopword-only query, a near-miss phrasing, or a substring that
// isn't a whole token returns nothing. When FTS comes up empty we scan
// subject/predicate/object with LIKE '%token%' (OR across tokens) so the agent
// stops claiming "I don't have that" when the data is right there. Same
// active/unexpired filter as searchFacts.
export function searchFactsBroad(query: string, limit = 8): Fact[] {
  const ftsHits = searchFacts(query, limit);
  if (ftsHits.length > 0) return ftsHits;

  const tokens = looseTokens(query);
  if (tokens.length === 0) return [];
  const clauses = tokens
    .map(() => '(subject LIKE ? OR predicate LIKE ? OR object LIKE ?)')
    .join(' OR ');
  const params: (string | number)[] = [];
  for (const t of tokens) {
    const like = `%${t}%`;
    params.push(like, like, like);
  }
  params.push(limit);
  try {
    return db.prepare(
      `SELECT * FROM facts
       WHERE (${clauses})
         AND active = 1
         AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
       ORDER BY updated_at DESC LIMIT ?`
    ).all(...params) as Fact[];
  } catch {
    return [];
  }
}

// Plain ordered list of facts — the "show me everything" safety net. Used by the
// recall tool and dashboard when no targeted query applies.
export function getAllFacts(opts: { limit?: number; includeInactive?: boolean } = {}): Fact[] {
  const limit = opts.limit ?? 200;
  if (opts.includeInactive) {
    return db.prepare('SELECT * FROM facts ORDER BY updated_at DESC LIMIT ?').all(limit) as Fact[];
  }
  return db.prepare(
    `SELECT * FROM facts
     WHERE active = 1
       AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
     ORDER BY updated_at DESC LIMIT ?`
  ).all(limit) as Fact[];
}

export function factsAbout(subject: string, limit = 12): Fact[] {
  const s = subject.trim();
  if (!s) return [];

  // First try the subject string. Then, if the subject names a known person,
  // also union facts linked by person_id — catches cases where the same person
  // is referenced under different subject strings ("aniket", "aniket-patel").
  const byString = db.prepare(
    `SELECT * FROM facts
     WHERE subject = ? COLLATE NOCASE
       AND active = 1
       AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
     ORDER BY updated_at DESC LIMIT ?`
  ).all(s, limit) as Fact[];

  const person = db
    .prepare('SELECT id FROM people WHERE name = ? COLLATE NOCASE LIMIT 1')
    .get(s) as { id: number } | undefined;
  if (!person) return byString;

  const byPerson = db.prepare(
    `SELECT * FROM facts
     WHERE person_id = ?
       AND active = 1
       AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
     ORDER BY updated_at DESC LIMIT ?`
  ).all(person.id, limit) as Fact[];

  // Merge + dedupe by id, preserving string-match order first (most likely
  // semantically aligned with what the agent searched for).
  const seen = new Set<number>();
  const merged: Fact[] = [];
  for (const list of [byString, byPerson]) {
    for (const fact of list) {
      if (seen.has(fact.id)) continue;
      seen.add(fact.id);
      merged.push(fact);
      if (merged.length >= limit) return merged;
    }
  }
  return merged;
}

/** Direct lookup by person id. Used by the People Context block in
 *  loadSystemPrompt — once a person is matched, prefer their `person_id`-
 *  linked facts over a fuzzy subject-string lookup. */
export function factsByPersonId(personId: number, limit = 6): Fact[] {
  return db.prepare(
    `SELECT * FROM facts
     WHERE person_id = ?
       AND active = 1
       AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
     ORDER BY updated_at DESC LIMIT ?`
  ).all(personId, limit) as Fact[];
}

export function getBrainStats(): {
  facts_active: number;
  people: number;
  open_tasks: number;
  messages_24h: number;
  last_reflection: string | null;
} {
  const facts = db.prepare('SELECT COUNT(*) AS c FROM facts WHERE active = 1').get() as { c: number };
  const people = db.prepare('SELECT COUNT(*) AS c FROM people').get() as { c: number };
  const open = db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE status IN ('open','in_progress')").get() as { c: number };
  const msgs = db.prepare("SELECT COUNT(*) AS c FROM messages WHERE created_at >= datetime('now', '-1 day')").get() as { c: number };
  const lastReflection = (db.prepare("SELECT value FROM memory WHERE group_id = 'reflection' AND key = 'last_reflection_at'").get() as { value: string } | undefined)?.value || null;
  return {
    facts_active: facts.c,
    people: people.c,
    open_tasks: open.c,
    messages_24h: msgs.c,
    last_reflection: lastReflection,
  };
}

export function getFactsByType(types: string[], limit = 20): Fact[] {
  if (types.length === 0) return [];
  const placeholders = types.map(() => '?').join(',');
  return db.prepare(
    `SELECT * FROM facts
     WHERE fact_type IN (${placeholders})
       AND active = 1
       AND (valid_until IS NULL OR datetime(valid_until) > datetime('now'))
     ORDER BY confidence DESC, updated_at DESC LIMIT ?`
  ).all(...types, limit) as Fact[];
}

// --- Brain Pulse helpers (Tier 1 Phase 1) ---
//
// All three "find" queries filter rows surfaced within PULSE_RESURFACE_HOURS so
// the same nudge doesn't fire every 11/16 pulse. Mirrors getOverdueTasks's
// dedup-aware shape. mark* helpers flip last_surfaced_at after a pulse cites
// (or even considers) the row — conservative, same posture as
// heartbeatTaskCheck → markTaskSurfaced.

const PULSE_RESURFACE_HOURS = Number(process.env.PULSE_RESURFACE_HOURS) || 18;

export function getStaleCommitments(limit = 5): Fact[] {
  return db.prepare(
    `SELECT * FROM facts
     WHERE fact_type = 'commitment' AND active = 1 AND completed_at IS NULL
       AND datetime(created_at) < datetime('now', '-7 days')
       AND (last_surfaced_at IS NULL
            OR datetime(last_surfaced_at) < datetime('now', '-' || ? || ' hours'))
     ORDER BY datetime(created_at) ASC LIMIT ?`
  ).all(PULSE_RESURFACE_HOURS, limit) as Fact[];
}

export function getExpiringFacts(daysAhead = 7, limit = 5): Fact[] {
  // Exclude 'metric' (fix #4): metrics carry valid_until = next Sunday by design
  // and auto-supersede weekly. Surfacing them every Mon-Sun would be recurring
  // noise, not action.
  return db.prepare(
    `SELECT * FROM facts
     WHERE valid_until IS NOT NULL AND active = 1
       AND fact_type != 'metric'
       AND datetime(valid_until) BETWEEN datetime('now') AND datetime('now', '+' || ? || ' days')
       AND (last_surfaced_at IS NULL
            OR datetime(last_surfaced_at) < datetime('now', '-' || ? || ' hours'))
     ORDER BY datetime(valid_until) ASC LIMIT ?`
  ).all(daysAhead, PULSE_RESURFACE_HOURS, limit) as Fact[];
}

export function getDormantLeads(daysSince = 60, limit = 5): Person[] {
  return db.prepare(
    `SELECT * FROM people
     WHERE relationship = 'lead'
       AND (last_contact IS NULL OR datetime(last_contact) < datetime('now', '-' || ? || ' days'))
       AND (last_surfaced_at IS NULL
            OR datetime(last_surfaced_at) < datetime('now', '-' || ? || ' hours'))
     ORDER BY datetime(COALESCE(last_contact, created_at)) ASC LIMIT ?`
  ).all(daysSince, PULSE_RESURFACE_HOURS, limit) as Person[];
}

// People we've actually interacted with before but have gone quiet on. Unlike
// getDormantLeads this is relationship-agnostic and requires a real prior contact
// (last_contact IS NOT NULL), so it surfaces "we used to talk, now cold" rather than
// the thousands of never-contacted imported Apple Contacts. Powers who_to_reach_out_to.
export function getStaleContacts(daysSince = 30, limit = 15): Person[] {
  return db.prepare(
    `SELECT * FROM people
     WHERE last_contact IS NOT NULL
       AND datetime(last_contact) < datetime('now', '-' || ? || ' days')
     ORDER BY datetime(last_contact) ASC LIMIT ?`
  ).all(daysSince, limit) as Person[];
}

export function markFactSurfaced(id: number): void {
  db.prepare(
    "UPDATE facts SET last_surfaced_at = datetime('now'), surface_count = COALESCE(surface_count, 0) + 1 WHERE id = ?"
  ).run(id);
}

export function markPersonSurfaced(id: number): void {
  db.prepare(
    "UPDATE people SET last_surfaced_at = datetime('now') WHERE id = ?"
  ).run(id);
}

export function completeFact(id: number, note?: string): void {
  // Do NOT touch superseded_at — completion is a different semantic from
  // supersession. Dashboards distinguish "done" (completed_at + active=0,
  // superseded_at IS NULL) from "replaced by newer fact" (superseded_at set).
  if (note) {
    db.prepare(
      `UPDATE facts SET completed_at = datetime('now'), active = 0,
                        source_ref = COALESCE(source_ref || '; ', '') || 'completed via pulse: ' || ?
       WHERE id = ? AND fact_type = 'commitment'`
    ).run(note, id);
  } else {
    db.prepare(
      "UPDATE facts SET completed_at = datetime('now'), active = 0 WHERE id = ? AND fact_type = 'commitment'"
    ).run(id);
  }
}

export function extendFactValidity(id: number, days: number): void {
  // If valid_until is null, anchor to 'now'; otherwise extend from existing value.
  db.prepare(
    `UPDATE facts SET valid_until = datetime(COALESCE(valid_until, 'now'), '+' || ? || ' days') WHERE id = ?`
  ).run(days, id);
}

// --- Hygiene helpers (Tier 1 Phase 2) ---
//
// The weekly hygiene cron writes every mutation to `hygiene_log` with full
// before/after JSON. Revert is a single UPDATE per row from the snapshot.
//
// `findDuplicateFacts` keys on (subject, predicate, OBJECT) and restricts to
// `fact_type='fact'` ONLY. Append-only log types (commitment/feedback) can
// legitimately share (subject, predicate) with different objects — dedup-ing
// those would destroy real distinct entries.

export interface DuplicateFactGroup {
  subject: string;
  predicate: string;
  object: string;
  ids: number[];
}

export interface ContradictionGroup {
  subject: string;
  predicate: string;
  ids: number[];
}

export function findDuplicateFacts(): DuplicateFactGroup[] {
  const rows = db.prepare(
    `SELECT subject, predicate, object, GROUP_CONCAT(id) AS ids, COUNT(*) AS c
     FROM facts
     WHERE active = 1 AND fact_type = 'fact'
     GROUP BY LOWER(subject), LOWER(predicate), LOWER(object)
     HAVING c > 1`
  ).all() as Array<{ subject: string; predicate: string; object: string; ids: string; c: number }>;
  return rows.map((r) => ({
    subject: r.subject,
    predicate: r.predicate,
    object: r.object,
    ids: r.ids.split(',').map((s) => Number(s)),
  }));
}

export function findContradictions(): ContradictionGroup[] {
  // Defensive guard: supersede-types should never have >1 active row on
  // (subject, predicate). If this turns up rows, something bypassed saveFact's
  // supersession path. Flag only; never auto-resolve.
  const rows = db.prepare(
    `SELECT subject, predicate, GROUP_CONCAT(id) AS ids, COUNT(*) AS c
     FROM facts
     WHERE active = 1 AND fact_type IN ('preference','decision','metric')
     GROUP BY LOWER(subject), LOWER(predicate)
     HAVING c > 1`
  ).all() as Array<{ subject: string; predicate: string; ids: string; c: number }>;
  return rows.map((r) => ({
    subject: r.subject,
    predicate: r.predicate,
    ids: r.ids.split(',').map((s) => Number(s)),
  }));
}

export function findLowConfidenceFacts(threshold: number, minAgeDays: number): Fact[] {
  return db.prepare(
    `SELECT * FROM facts
     WHERE active = 1 AND confidence < ?
       AND datetime(updated_at) < datetime('now', '-' || ? || ' days')`
  ).all(threshold, minAgeDays) as Fact[];
}

export function findExpiredCommitments(staleDays: number, minSurfaceCount: number): Fact[] {
  // Safe-to-retire: commitments older than `staleDays` that brain-pulse has
  // already surfaced `minSurfaceCount` times without resolution. "Old" alone
  // isn't enough — a never-pinged commitment might still be live.
  return db.prepare(
    `SELECT * FROM facts
     WHERE fact_type = 'commitment' AND active = 1 AND completed_at IS NULL
       AND datetime(created_at) < datetime('now', '-' || ? || ' days')
       AND COALESCE(surface_count, 0) >= ?`
  ).all(staleDays, minSurfaceCount) as Fact[];
}

export function findStaleNeverSurfacedCommitments(staleDays: number): Fact[] {
  // Same age window, but brain-pulse has never pinged. Flag for human review;
  // never auto-mutate.
  return db.prepare(
    `SELECT * FROM facts
     WHERE fact_type = 'commitment' AND active = 1 AND completed_at IS NULL
       AND datetime(created_at) < datetime('now', '-' || ? || ' days')
       AND COALESCE(surface_count, 0) = 0`
  ).all(staleDays) as Fact[];
}

export interface HygieneLogRow {
  id: number;
  run_id: string;
  action: string;
  fact_id: number | null;
  before_json: string | null;
  after_json: string | null;
  rationale: string | null;
  created_at: string;
}

export function logHygieneAction(args: {
  runId: string;
  action: string;
  factId: number | null;
  before: unknown;
  after: unknown;
  rationale: string;
}): void {
  db.prepare(
    `INSERT INTO hygiene_log (run_id, action, fact_id, before_json, after_json, rationale)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    args.runId,
    args.action,
    args.factId,
    args.before === undefined ? null : JSON.stringify(args.before),
    args.after === undefined ? null : JSON.stringify(args.after),
    args.rationale,
  );
}

export function getRecentHygieneActions(limit = 20): HygieneLogRow[] {
  return db.prepare(
    `SELECT * FROM hygiene_log ORDER BY id DESC LIMIT ?`
  ).all(limit) as HygieneLogRow[];
}

export function getHygieneRun(runId: string): HygieneLogRow[] {
  return db.prepare(
    `SELECT * FROM hygiene_log WHERE run_id = ? ORDER BY id DESC`
  ).all(runId) as HygieneLogRow[];
}

// ── Computer-use audit ───────────────────────────────────────────────────────

export interface ComputerUseLogRow {
  id: number;
  action: string;
  summary: string;
  payload_json: string | null;
  outcome: string | null;
  created_by_group: string;
  created_at: string;
}

// Record a free (non-gated) computer_use action — screenshot / open_app /
// switch_app. Gated actions (click/type/key_press/scroll) are audited in the
// `actions` table instead, via propose → confirm.
export function logComputerUseAction(args: {
  action: string;
  summary: string;
  payload?: unknown;
  outcome?: string;
  group: string;
}): void {
  db.prepare(
    `INSERT INTO computer_use_log (action, summary, payload_json, outcome, created_by_group)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    args.action,
    args.summary,
    args.payload === undefined ? null : JSON.stringify(args.payload),
    args.outcome ?? null,
    args.group,
  );
}

export function getRecentComputerUseActions(limit = 20): ComputerUseLogRow[] {
  return db.prepare(
    `SELECT * FROM computer_use_log ORDER BY id DESC LIMIT ?`
  ).all(limit) as ComputerUseLogRow[];
}

export interface LocationRow {
  id: number; lat: number | null; lon: number | null; address: string | null;
  label: string | null; event: string | null; received_at: string;
}

export function logLocation(loc: { lat?: number | null; lon?: number | null; address?: string | null; label?: string | null; event?: string | null }): void {
  db.prepare('INSERT INTO location_log (lat, lon, address, label, event) VALUES (?, ?, ?, ?, ?)')
    .run(loc.lat ?? null, loc.lon ?? null, loc.address ?? null, loc.label ?? null, loc.event ?? null);
  db.prepare("DELETE FROM location_log WHERE received_at < datetime('now', '-30 days')").run();
}

export function getLatestLocation(): LocationRow | undefined {
  return db.prepare('SELECT * FROM location_log ORDER BY id DESC LIMIT 1').get() as LocationRow | undefined;
}

export function setFactInactive(id: number, completed = false): void {
  // Used by hygiene to demote / dedupe / expire. Optionally flips completed_at
  // alongside active=0 (for the expire-commitment path). superseded_at stays
  // null — these aren't supersessions, they're hygiene-driven retirements.
  if (completed) {
    db.prepare(
      "UPDATE facts SET active = 0, completed_at = datetime('now') WHERE id = ?"
    ).run(id);
  } else {
    db.prepare("UPDATE facts SET active = 0 WHERE id = ?").run(id);
  }
}

export function restoreFactFromSnapshot(id: number, snapshot: Partial<Fact>): void {
  // Used by revertHygieneRun. Restores the columns hygiene might have touched:
  // active, completed_at, superseded_at (defensive — should already be null),
  // confidence. Subject/predicate/object are never mutated by hygiene so we
  // don't restore them — keeps the revert narrow and safe.
  db.prepare(
    `UPDATE facts
       SET active = COALESCE(?, active),
           completed_at = ?,
           superseded_at = ?,
           confidence = COALESCE(?, confidence)
       WHERE id = ?`
  ).run(
    snapshot.active ?? null,
    (snapshot.completed_at ?? null) as string | null,
    (snapshot.superseded_at ?? null) as string | null,
    snapshot.confidence ?? null,
    id,
  );
}

// --- Content drafts (Tier 1 Phase 3) ---

export interface FactDraft {
  id: number;
  kind: string;
  title: string | null;
  body: string;
  source_fact_ids: string | null;
  path: string | null;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  last_surfaced_at: string | null;
}

export function createDraft(args: {
  kind: 'linkedin' | 'newsletter';
  title?: string;
  body: string;
  source_fact_ids?: number[];
  path?: string;
}): number {
  const result = db.prepare(
    `INSERT INTO fact_drafts (kind, title, body, source_fact_ids, path)
     VALUES (?, ?, ?, ?, ?)`
  ).run(
    args.kind,
    args.title ?? null,
    args.body,
    args.source_fact_ids ? JSON.stringify(args.source_fact_ids) : null,
    args.path ?? null,
  );
  return result.lastInsertRowid as number;
}

export function getDraftById(id: number): FactDraft | undefined {
  return db.prepare('SELECT * FROM fact_drafts WHERE id = ?').get(id) as FactDraft | undefined;
}

export function listDrafts(opts: { status?: string; limit?: number } = {}): FactDraft[] {
  const limit = opts.limit ?? 20;
  if (opts.status) {
    return db.prepare(
      'SELECT * FROM fact_drafts WHERE status = ? ORDER BY created_at DESC LIMIT ?'
    ).all(opts.status, limit) as FactDraft[];
  }
  return db.prepare(
    'SELECT * FROM fact_drafts ORDER BY created_at DESC LIMIT ?'
  ).all(limit) as FactDraft[];
}

export function updateDraftStatus(id: number, status: 'pending' | 'approved' | 'discarded' | 'published'): void {
  db.prepare(
    "UPDATE fact_drafts SET status = ?, reviewed_at = datetime('now') WHERE id = ?"
  ).run(status, id);
}

export function getUnreviewedDraftsCount(): number {
  const row = db.prepare("SELECT COUNT(*) AS c FROM fact_drafts WHERE status = 'pending'").get() as { c: number };
  return row.c;
}

export function getRecentFactsBySource(source: string, sinceIso: string, limit = 20): Fact[] {
  return db.prepare(
    `SELECT * FROM facts
     WHERE source = ? AND active = 1
       AND datetime(created_at) >= datetime(?)
     ORDER BY datetime(created_at) DESC LIMIT ?`
  ).all(source, sinceIso, limit) as Fact[];
}

export function getTopRecentPeople(sinceIso: string, limit = 5): Array<{ person_id: number; name: string; count: number }> {
  return db.prepare(
    `SELECT i.person_id AS person_id, p.name AS name, COUNT(*) AS count
     FROM interactions i
     JOIN people p ON p.id = i.person_id
     WHERE datetime(COALESCE(i.occurred_at, i.created_at)) >= datetime(?)
     GROUP BY i.person_id
     ORDER BY count DESC
     LIMIT ?`
  ).all(sinceIso, limit) as Array<{ person_id: number; name: string; count: number }>;
}

export function revertHygieneRun(runId: string): { reverted: number; skipped: number } {
  const rows = getHygieneRun(runId);
  if (rows.length === 0) return { reverted: 0, skipped: 0 };

  // Sanity guard: refuse runs older than 14 days. Hygiene log keeps rows but
  // the live state may have moved on; mass-reverting a stale run could undo
  // newer legitimate changes.
  const oldest = rows[rows.length - 1];
  const ageMs = Date.now() - new Date(oldest.created_at + 'Z').getTime();
  if (ageMs > 14 * 86400 * 1000) {
    throw new Error(`Hygiene run ${runId} is older than 14 days; refusing to revert. Manual recovery required.`);
  }

  let reverted = 0;
  let skipped = 0;
  const tx = db.transaction((logRows: HygieneLogRow[]) => {
    for (const row of logRows) {
      if (row.fact_id === null || !row.before_json) {
        skipped++;
        continue;
      }
      try {
        const snapshot = JSON.parse(row.before_json) as Partial<Fact>;
        restoreFactFromSnapshot(row.fact_id, snapshot);
        reverted++;
      } catch {
        skipped++;
      }
    }
  });
  tx(rows);
  return { reverted, skipped };
}

// --- People graph ---

export interface Person {
  id: number;
  name: string;
  company: string | null;
  role: string | null;
  linkedin_url: string | null;
  relationship: string | null;
  notes: string | null;
  last_contact: string | null;
  created_at: string;
}

export interface Interaction {
  id: number;
  person_id: number;
  channel: string | null;
  summary: string | null;
  ref: string | null;
  occurred_at: string | null;
  created_at: string;
}

// Upsert with multi-key dedup: try (any of) emails → linkedin_url → otherwise insert.
// Only patches fields that are explicitly provided; never overwrites with null.
export function upsertPerson(input: {
  emails?: string[];
  phones?: string[];
  name?: string;
  company?: string;
  role?: string;
  linkedin_url?: string;
  relationship?: string;
  notes?: string;
}): number {
  const emails = (input.emails ?? [])
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  const phones = Array.from(new Set(
    (input.phones ?? []).map((p) => normalizePhone(p)).filter((p) => p.length > 0)
  ));

  let personId: number | undefined;

  if (emails.length > 0) {
    const placeholders = emails.map(() => '?').join(',');
    const found = db
      .prepare(`SELECT person_id FROM person_emails WHERE email IN (${placeholders}) LIMIT 1`)
      .get(...emails) as { person_id: number } | undefined;
    if (found) personId = found.person_id;
  }

  if (!personId && phones.length > 0) {
    const placeholders = phones.map(() => '?').join(',');
    const found = db
      .prepare(`SELECT person_id FROM person_phones WHERE phone IN (${placeholders}) LIMIT 1`)
      .get(...phones) as { person_id: number } | undefined;
    if (found) personId = found.person_id;
  }

  if (!personId && input.linkedin_url) {
    const found = db
      .prepare('SELECT id FROM people WHERE linkedin_url = ? LIMIT 1')
      .get(input.linkedin_url) as { id: number } | undefined;
    if (found) personId = found.id;
  }

  if (!personId) {
    const fallbackName = input.name?.trim() || emails[0] || 'Unknown';
    const result = db
      .prepare(
        `INSERT INTO people (name, company, role, linkedin_url, relationship, notes)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        fallbackName,
        input.company ?? null,
        input.role ?? null,
        input.linkedin_url ?? null,
        input.relationship ?? null,
        input.notes ?? null,
      );
    personId = result.lastInsertRowid as number;
  } else {
    const sets: string[] = [];
    const params: (string | null)[] = [];
    if (input.name) { sets.push('name = ?'); params.push(input.name); }
    if (input.company) { sets.push('company = ?'); params.push(input.company); }
    if (input.role) { sets.push('role = ?'); params.push(input.role); }
    if (input.linkedin_url) { sets.push('linkedin_url = ?'); params.push(input.linkedin_url); }
    if (input.relationship) { sets.push('relationship = ?'); params.push(input.relationship); }
    if (input.notes) { sets.push('notes = ?'); params.push(input.notes); }
    if (sets.length > 0) {
      params.push(String(personId));
      db.prepare(`UPDATE people SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    }
  }

  for (const email of emails) {
    db.prepare('INSERT OR IGNORE INTO person_emails (email, person_id) VALUES (?, ?)').run(email, personId);
  }

  for (const phone of phones) {
    db.prepare('INSERT OR IGNORE INTO person_phones (phone, person_id) VALUES (?, ?)').run(phone, personId);
  }

  return personId;
}

export function findPersonByPhone(phone: string): Person | undefined {
  const p = normalizePhone(phone);
  if (!p) return undefined;
  return db
    .prepare(
      `SELECT p.* FROM people p
       JOIN person_phones pp ON pp.person_id = p.id
       WHERE pp.phone = ? LIMIT 1`
    )
    .get(p) as Person | undefined;
}

export function findPersonByEmail(email: string): Person | undefined {
  const e = email.trim().toLowerCase();
  if (!e) return undefined;
  return db
    .prepare(
      `SELECT p.* FROM people p
       JOIN person_emails pe ON pe.person_id = p.id
       WHERE pe.email = ? COLLATE NOCASE LIMIT 1`
    )
    .get(e) as Person | undefined;
}

/** Every phone (normalized last-10-digit form) and email on file for a person. */
export function getPersonHandles(personId: number): { phones: string[]; emails: string[] } {
  const phones = (db.prepare('SELECT phone FROM person_phones WHERE person_id = ?').all(personId) as { phone: string }[]).map((r) => r.phone);
  const emails = (db.prepare('SELECT email FROM person_emails WHERE person_id = ?').all(personId) as { email: string }[]).map((r) => r.email);
  return { phones, emails };
}

export function getPersonById(id: number): Person | undefined {
  return db.prepare('SELECT * FROM people WHERE id = ?').get(id) as Person | undefined;
}

export function peopleSearch(query: string, limit = 5): Person[] {
  const q = `%${query.trim().toLowerCase()}%`;
  if (q === '%%') return [];
  return db
    .prepare(
      `SELECT DISTINCT p.* FROM people p
       LEFT JOIN person_emails pe ON pe.person_id = p.id
       WHERE LOWER(p.name) LIKE ? OR LOWER(COALESCE(p.company,'')) LIKE ? OR LOWER(COALESCE(pe.email,'')) LIKE ?
       ORDER BY COALESCE(p.last_contact, p.created_at) DESC LIMIT ?`
    )
    .all(q, q, q, limit) as Person[];
}

export function addInteraction(input: {
  person_id: number;
  channel?: string;
  summary?: string;
  ref?: string;
  occurred_at?: string;
}): number {
  // Dedup on (person, channel, ref) so re-reading the same email/event doesn't spam.
  if (input.ref && input.channel) {
    const existing = db
      .prepare('SELECT id FROM interactions WHERE person_id = ? AND channel = ? AND ref = ? LIMIT 1')
      .get(input.person_id, input.channel, input.ref) as { id: number } | undefined;
    if (existing) return existing.id;
  }
  const occurredAt = toSqliteDate(input.occurred_at);
  const result = db
    .prepare(
      `INSERT INTO interactions (person_id, channel, summary, ref, occurred_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      input.person_id,
      input.channel ?? null,
      input.summary ?? null,
      input.ref ?? null,
      occurredAt,
    );
  if (occurredAt) {
    db.prepare(
      `UPDATE people SET last_contact = ?
       WHERE id = ? AND (last_contact IS NULL OR datetime(last_contact) < datetime(?))`
    ).run(occurredAt, input.person_id, occurredAt);
  }
  return result.lastInsertRowid as number;
}

export function getRecentInteractions(personId: number, limit = 5): Interaction[] {
  return db
    .prepare(
      `SELECT * FROM interactions WHERE person_id = ?
       ORDER BY COALESCE(occurred_at, created_at) DESC LIMIT ?`
    )
    .all(personId, limit) as Interaction[];
}

// --- Relationship maintenance ledger ---

export type RelationshipPlanStatus = 'active' | 'paused' | 'removed';
export type RelationshipDirection = 'incoming' | 'outgoing' | 'two_way' | 'unknown';
export type RelationshipState =
  | 'upcoming'
  | 'due'
  | 'waiting_for_reply'
  | 'baseline_unknown'
  | 'snoozed'
  | 'paused'
  | 'removed';

export interface RelationshipPlan {
  person_id: number;
  label: string | null;
  cadence_days: number;
  preferred_channel: string | null;
  status: RelationshipPlanStatus;
  snoozed_until: string | null;
  last_nudged_at: string | null;
  source_ref: string | null;
  created_at: string;
  updated_at: string;
}

export interface RelationshipEvent {
  id: number;
  person_id: number;
  occurred_at: string;
  channel: string;
  direction: RelationshipDirection;
  counts_as_outreach: number;
  counts_as_meaningful: number;
  source: string;
  source_ref: string | null;
  confidence: number;
  summary: string | null;
  created_at: string;
}

export interface RelationshipStatus extends RelationshipPlan {
  name: string;
  last_outreach_at: string | null;
  last_meaningful_at: string | null;
  next_due_at: string | null;
  days_overdue: number | null;
  state: RelationshipState;
}

export function getRelationshipPlan(personId: number): RelationshipPlan | undefined {
  return db.prepare(
    'SELECT * FROM relationship_plans WHERE person_id = ?'
  ).get(personId) as RelationshipPlan | undefined;
}

export function upsertRelationshipPlan(input: {
  person_id: number;
  cadence_days?: number;
  label?: string | null;
  preferred_channel?: string | null;
  status?: RelationshipPlanStatus;
  snoozed_until?: string | null;
  source_ref?: string | null;
}): RelationshipPlan {
  if (!getPersonById(input.person_id)) {
    throw new Error(`No person on file with id ${input.person_id}.`);
  }

  const existing = getRelationshipPlan(input.person_id);
  const cadenceDays = input.cadence_days ?? existing?.cadence_days;
  if (!Number.isInteger(cadenceDays) || cadenceDays! < 1 || cadenceDays! > 3650) {
    throw new Error('cadence_days must be a whole number between 1 and 3650.');
  }

  const status = input.status ?? existing?.status ?? 'active';
  if (!['active', 'paused', 'removed'].includes(status)) {
    throw new Error(`Unsupported relationship plan status: ${status}`);
  }

  const label = input.label === undefined
    ? existing?.label ?? null
    : input.label?.trim() || null;
  const preferredChannel = input.preferred_channel === undefined
    ? existing?.preferred_channel ?? null
    : input.preferred_channel?.trim() || null;
  const snoozedUntil = input.snoozed_until === undefined
    ? existing?.snoozed_until ?? null
    : toSqliteDate(input.snoozed_until);
  if (input.snoozed_until && !snoozedUntil) {
    throw new Error('snoozed_until must be a valid date/time.');
  }
  const sourceRef = input.source_ref === undefined
    ? existing?.source_ref ?? null
    : input.source_ref?.trim() || null;

  db.prepare(
    `INSERT INTO relationship_plans
       (person_id, label, cadence_days, preferred_channel, status, snoozed_until, source_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(person_id) DO UPDATE SET
       label = excluded.label,
       cadence_days = excluded.cadence_days,
       preferred_channel = excluded.preferred_channel,
       status = excluded.status,
       snoozed_until = excluded.snoozed_until,
       source_ref = excluded.source_ref,
       updated_at = datetime('now')`
  ).run(
    input.person_id,
    label,
    cadenceDays,
    preferredChannel,
    status,
    snoozedUntil,
    sourceRef,
  );

  return getRelationshipPlan(input.person_id)!;
}

export function upsertRelationshipPlans(
  inputs: Array<Parameters<typeof upsertRelationshipPlan>[0]>,
): RelationshipPlan[] {
  return db.transaction((plans: typeof inputs) => plans.map(upsertRelationshipPlan))(inputs);
}

type RelationshipEventInput = {
  person_id: number;
  occurred_at?: string | Date;
  channel: string;
  direction: RelationshipDirection;
  counts_as_outreach: boolean;
  counts_as_meaningful: boolean;
  source: string;
  source_ref?: string | null;
  confidence?: number;
  summary?: string | null;
};

function writeRelationshipEvent(input: RelationshipEventInput): number {
  if (!getPersonById(input.person_id)) {
    throw new Error(`No person on file with id ${input.person_id}.`);
  }
  if (!input.counts_as_outreach && !input.counts_as_meaningful) {
    throw new Error('A relationship event must count as outreach, meaningful contact, or both.');
  }
  if (!['incoming', 'outgoing', 'two_way', 'unknown'].includes(input.direction)) {
    throw new Error(`Unsupported relationship event direction: ${input.direction}`);
  }

  const occurredAt = toSqliteDate(input.occurred_at ?? new Date());
  if (!occurredAt) throw new Error('occurred_at must be a valid date/time.');
  const occurredMs = Date.parse(`${occurredAt.replace(' ', 'T')}Z`);
  if (occurredMs > Date.now() + 5 * 60 * 1000) {
    throw new Error('occurred_at cannot be materially in the future.');
  }

  const channel = input.channel.trim();
  const source = input.source.trim();
  if (!channel) throw new Error('channel is required.');
  if (!source) throw new Error('source is required.');
  const sourceRef = input.source_ref?.trim() || null;
  const confidence = input.confidence ?? 1;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error('confidence must be between 0 and 1.');
  }
  const summary = input.summary?.trim() || null;

  const existing = sourceRef
    ? db.prepare(
      `SELECT * FROM relationship_events
       WHERE person_id = ? AND source = ? AND source_ref = ? LIMIT 1`
    ).get(input.person_id, source, sourceRef) as RelationshipEvent | undefined
    : undefined;

  if (existing) {
    const latestOccurredAt = occurredMs > Date.parse(`${existing.occurred_at.replace(' ', 'T')}Z`)
      ? occurredAt
      : existing.occurred_at;
    const direction: RelationshipDirection = existing.direction === input.direction
      ? existing.direction
      : existing.direction === 'unknown'
        ? input.direction
        : input.direction === 'unknown'
          ? existing.direction
          : 'two_way';
    db.prepare(
      `UPDATE relationship_events SET
         occurred_at = ?, channel = ?, direction = ?,
         counts_as_outreach = ?, counts_as_meaningful = ?,
         confidence = ?, summary = COALESCE(?, summary)
       WHERE id = ?`
    ).run(
      latestOccurredAt,
      channel,
      direction,
      existing.counts_as_outreach || input.counts_as_outreach ? 1 : 0,
      existing.counts_as_meaningful || input.counts_as_meaningful ? 1 : 0,
      Math.max(existing.confidence, confidence),
      summary,
      existing.id,
    );
    return existing.id;
  }

  const result = db.prepare(
    `INSERT INTO relationship_events
       (person_id, occurred_at, channel, direction, counts_as_outreach,
        counts_as_meaningful, source, source_ref, confidence, summary)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.person_id,
    occurredAt,
    channel,
    input.direction,
    input.counts_as_outreach ? 1 : 0,
    input.counts_as_meaningful ? 1 : 0,
    source,
    sourceRef,
    confidence,
    summary,
  );
  return result.lastInsertRowid as number;
}

export function recordRelationshipEvent(input: RelationshipEventInput): number {
  return db.transaction(writeRelationshipEvent)(input);
}

/** One confirmed shared call/visit becomes one event per explicitly named
 * participant. The shared source_ref keeps the batch auditable and replay-safe. */
export function recordSharedRelationshipEvent(
  personIds: number[],
  input: Omit<RelationshipEventInput, 'person_id'>,
): number[] {
  const ids = Array.from(new Set(personIds));
  if (ids.length === 0) throw new Error('At least one person_id is required.');
  return db.transaction((targets: number[]) =>
    targets.map((personId) => writeRelationshipEvent({ ...input, person_id: personId }))
  )(ids);
}

export function getRelationshipEvents(personId: number, limit = 20): RelationshipEvent[] {
  return db.prepare(
    `SELECT * FROM relationship_events WHERE person_id = ?
     ORDER BY datetime(occurred_at) DESC, id DESC LIMIT ?`
  ).all(personId, Math.min(Math.max(limit, 1), 200)) as RelationshipEvent[];
}

function sqliteDateMs(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

export function listRelationshipStatuses(opts: {
  person_id?: number;
  include_inactive?: boolean;
  as_of?: string | Date;
  followup_wait_days?: number;
} = {}): RelationshipStatus[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (opts.person_id !== undefined) {
    clauses.push('rp.person_id = ?');
    params.push(opts.person_id);
  }
  if (!opts.include_inactive) clauses.push("rp.status = 'active'");
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(
    `SELECT rp.*, p.name,
       MAX(CASE WHEN re.counts_as_outreach = 1 THEN re.occurred_at END) AS last_outreach_at,
       MAX(CASE WHEN re.counts_as_meaningful = 1 THEN re.occurred_at END) AS last_meaningful_at
     FROM relationship_plans rp
     JOIN people p ON p.id = rp.person_id
     LEFT JOIN relationship_events re ON re.person_id = rp.person_id
     ${where}
     GROUP BY rp.person_id
     ORDER BY rp.cadence_days ASC, p.name COLLATE NOCASE ASC`
  ).all(...params) as Array<RelationshipPlan & {
    name: string;
    last_outreach_at: string | null;
    last_meaningful_at: string | null;
  }>;

  const asOfSql = toSqliteDate(opts.as_of ?? new Date())!;
  const asOfMs = sqliteDateMs(asOfSql)!;
  const followupWaitDays = Math.min(Math.max(opts.followup_wait_days ?? 7, 0), 365);
  const followupWaitMs = followupWaitDays * 24 * 60 * 60 * 1000;

  return rows.map((row): RelationshipStatus => {
    const lastOutreachMs = sqliteDateMs(row.last_outreach_at);
    const lastMeaningfulMs = sqliteDateMs(row.last_meaningful_at);
    const snoozedUntilMs = sqliteDateMs(row.snoozed_until);
    const freshUnansweredOutreach = lastOutreachMs !== null
      && (lastMeaningfulMs === null || lastOutreachMs > lastMeaningfulMs)
      && asOfMs - lastOutreachMs < followupWaitMs;

    let state: RelationshipState;
    let nextDueAt: string | null = null;
    let daysOverdue: number | null = null;

    if (row.status === 'removed') {
      state = 'removed';
    } else if (row.status === 'paused') {
      state = 'paused';
    } else if (snoozedUntilMs !== null && snoozedUntilMs > asOfMs) {
      state = 'snoozed';
    } else if (lastMeaningfulMs === null) {
      state = freshUnansweredOutreach ? 'waiting_for_reply' : 'baseline_unknown';
    } else {
      const dueMs = lastMeaningfulMs + row.cadence_days * 24 * 60 * 60 * 1000;
      nextDueAt = toSqliteDate(new Date(dueMs));
      if (dueMs > asOfMs) {
        state = 'upcoming';
      } else if (freshUnansweredOutreach) {
        state = 'waiting_for_reply';
      } else {
        state = 'due';
        daysOverdue = Math.max(0, Math.floor((asOfMs - dueMs) / (24 * 60 * 60 * 1000)));
      }
    }

    return {
      ...row,
      next_due_at: nextDueAt,
      days_overdue: daysOverdue,
      state,
    };
  });
}

export function getDueRelationshipStatuses(opts: {
  limit?: number;
  as_of?: string | Date;
  followup_wait_days?: number;
  nudge_cooldown_days?: number;
} = {}): RelationshipStatus[] {
  const asOfSql = toSqliteDate(opts.as_of ?? new Date())!;
  const asOfMs = sqliteDateMs(asOfSql)!;
  const cooldownMs = Math.min(Math.max(opts.nudge_cooldown_days ?? 6, 0), 365)
    * 24 * 60 * 60 * 1000;
  const eligible = listRelationshipStatuses({
    as_of: asOfSql,
    followup_wait_days: opts.followup_wait_days,
  }).filter((status) => {
    if (status.state !== 'due' && status.state !== 'baseline_unknown') return false;
    const lastNudgedMs = sqliteDateMs(status.last_nudged_at);
    return lastNudgedMs === null || asOfMs - lastNudgedMs >= cooldownMs;
  });

  eligible.sort((a, b) => {
    // A known, genuinely due cadence outranks an unknown baseline. This keeps
    // weekly anchors from being crowded out while unknown baselines rotate.
    if (a.state !== b.state) return a.state === 'due' ? -1 : 1;

    // Compare known overdue rows relative to their own cadence, not raw days.
    const aRatio = (a.days_overdue ?? 0) / a.cadence_days;
    const bRatio = (b.days_overdue ?? 0) / b.cadence_days;
    if (aRatio !== bRatio) return bRatio - aRatio;

    // Then rotate oldest/never-nudged plans forward.
    const aNudged = sqliteDateMs(a.last_nudged_at) ?? Number.NEGATIVE_INFINITY;
    const bNudged = sqliteDateMs(b.last_nudged_at) ?? Number.NEGATIVE_INFINITY;
    if (aNudged !== bNudged) return aNudged - bNudged;
    if (a.cadence_days !== b.cadence_days) return a.cadence_days - b.cadence_days;
    return a.name.localeCompare(b.name);
  });

  return eligible.slice(0, Math.min(Math.max(opts.limit ?? 3, 1), 20));
}

export function markRelationshipPlansNudged(personIds: number[], at?: string | Date): void {
  const ids = Array.from(new Set(personIds));
  if (ids.length === 0) return;
  const when = toSqliteDate(at ?? new Date());
  if (!when) throw new Error('Nudge timestamp must be a valid date/time.');
  const update = db.prepare(
    `UPDATE relationship_plans
     SET last_nudged_at = ?, updated_at = datetime('now')
     WHERE person_id = ? AND status = 'active'`
  );
  db.transaction((targets: number[]) => {
    for (const id of targets) update.run(when, id);
  })(ids);
}

// --- Task management ---

export interface Task {
  id: number;
  title: string;
  description: string | null;
  group_id: string;
  assignee: string;
  priority: string;
  status: string;
  due_date: string | null;
  source: string;
  source_ref: string | null;
  created_at: string;
  completed_at: string | null;
  notes: string | null;
  duration_minutes: number | null;
  focus_level: string | null;
  calendar_event_id: string | null;
  splittable: number | null;
  google_task_id: string | null;
  google_list_id: string | null;
  sync_to_google: number | null;
  last_synced_at: string | null;
  updated_at: string | null;
  snoozed_until: string | null;
  last_surfaced_at: string | null;
  surface_count: number | null;
  retired_at: string | null;
}

export function createTask(task: {
  title: string;
  description?: string;
  group_id: string;
  assignee?: string;
  priority?: string;
  due_date?: string;
  source?: string;
  source_ref?: string;
  notes?: string;
  duration_minutes?: number;
  focus_level?: string;
  splittable?: boolean;
  sync_to_google?: boolean;
  google_task_id?: string;
  google_list_id?: string;
}): number {
  const assignee = task.assignee || 'owner';
  const sync = task.sync_to_google !== undefined
    ? (task.sync_to_google ? 1 : 0)
    : (assignee === 'assistant' ? 0 : 1);
  const result = db.prepare(
    `INSERT INTO tasks (title, description, group_id, assignee, priority, due_date, source, source_ref, notes, duration_minutes, focus_level, splittable, sync_to_google, google_task_id, google_list_id, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    task.title,
    task.description || null,
    task.group_id,
    assignee,
    task.priority || 'medium',
    task.due_date || null,
    task.source || 'manual',
    task.source_ref || null,
    task.notes || null,
    task.duration_minutes || null,
    task.focus_level || null,
    task.splittable === false ? 0 : 1,
    sync,
    task.google_task_id || null,
    task.google_list_id || null,
  );
  return result.lastInsertRowid as number;
}

export function updateTaskStatus(taskId: number, status: string, notes?: string) {
  if (status === 'done' || status === 'cancelled') {
    db.prepare(
      "UPDATE tasks SET status = ?, notes = COALESCE(?, notes), completed_at = datetime('now'), updated_at = datetime('now') WHERE id = ?"
    ).run(status, notes || null, taskId);
  } else {
    db.prepare(
      "UPDATE tasks SET status = ?, notes = COALESCE(?, notes), updated_at = datetime('now') WHERE id = ?"
    ).run(status, notes || null, taskId);
  }
}

export function getTaskById(taskId: number): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId) as Task | undefined;
}

export function updateTaskFields(taskId: number, fields: Partial<Pick<Task, 'title' | 'description' | 'due_date' | 'notes' | 'priority'>>) {
  const sets: string[] = [];
  const params: (string | null)[] = [];
  for (const [k, v] of Object.entries(fields)) {
    sets.push(`${k} = ?`);
    params.push((v as string | null) ?? null);
  }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now')");
  // Rescheduling (a new due_date) is a re-engagement: reset the decay ladder +
  // retirement so the moved deadline starts a fresh surfacing cycle.
  if ('due_date' in fields) {
    sets.push('surface_count = 0', 'last_surfaced_at = NULL', 'retired_at = NULL');
  }
  params.push(String(taskId));
  db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function setTaskGoogleMapping(taskId: number, googleTaskId: string, googleListId: string) {
  db.prepare(
    "UPDATE tasks SET google_task_id = ?, google_list_id = ?, last_synced_at = datetime('now') WHERE id = ?"
  ).run(googleTaskId, googleListId, taskId);
}

export function stampTaskSynced(taskId: number) {
  db.prepare("UPDATE tasks SET last_synced_at = datetime('now') WHERE id = ?").run(taskId);
}

export function clearTaskGoogleMapping(taskId: number) {
  db.prepare('UPDATE tasks SET google_task_id = NULL, google_list_id = NULL WHERE id = ?').run(taskId);
}

export function getTaskByGoogleId(googleTaskId: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE google_task_id = ?').get(googleTaskId) as Task | undefined;
}

export function getTaskBySourceRef(sourceRef: string): Task | undefined {
  return db.prepare('SELECT * FROM tasks WHERE source_ref = ? ORDER BY id DESC LIMIT 1').get(sourceRef) as Task | undefined;
}

export function getTasksNeedingPush(): Task[] {
  return db.prepare(
    `SELECT * FROM tasks
     WHERE sync_to_google = 1
       AND (google_task_id IS NULL OR last_synced_at IS NULL OR updated_at > last_synced_at)`
  ).all() as Task[];
}

export function getTasksWithGoogleMapping(): Task[] {
  return db.prepare('SELECT * FROM tasks WHERE google_task_id IS NOT NULL').all() as Task[];
}

export function getOpenTasks(groupId?: string, assignee?: string): Task[] {
  let query = "SELECT * FROM tasks WHERE status IN ('open', 'in_progress')";
  const params: string[] = [];
  if (groupId) { query += ' AND group_id = ?'; params.push(groupId); }
  if (assignee) { query += ' AND assignee = ?'; params.push(assignee); }
  query += ' ORDER BY CASE priority WHEN \'urgent\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 ELSE 3 END, due_date ASC';
  return db.prepare(query).all(...params) as Task[];
}

// Resurface window for heartbeat task pings. Configurable via env so the user
// can dial reminder frequency without code edits.
const HEARTBEAT_RESURFACE_HOURS = Number(process.env.HEARTBEAT_RESURFACE_HOURS) || 6;

// Escalating backoff (organic reminders). Instead of a flat re-ping every N
// hours, the gap before a task is surfaced again grows with how many times it's
// already been surfaced: the first surface (surface_count 0) is immediate, then
// LADDER[surface_count-1] hours, capped at the last rung. So a task you keep
// ignoring goes quiet on its own instead of pinging every 6h. Tunable via
// HEARTBEAT_BACKOFF_HOURS (comma-separated hours), default ~1d, 2d, 4d, weekly.
const BACKOFF_LADDER_HOURS: number[] = (() => {
  const raw = process.env.HEARTBEAT_BACKOFF_HOURS;
  if (raw) {
    const parsed = raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 0);
    if (parsed.length > 0) return parsed;
  }
  return [24, 48, 96, 168];
})();

// After this many surfaces a still-open task stops being re-pinged by the
// heartbeat and is routed to the morning "needs a decision" pass instead (one
// pointed question, then retired until touched). Tunable via HEARTBEAT_RETIRE_AFTER.
const RETIRE_AT_SURFACE_COUNT = Number(process.env.HEARTBEAT_RETIRE_AFTER) || 4;

// SQL CASE → hours to wait before the next surface, given surface_count. Built
// once from the ladder; the values are sanitized integers so they're safe to
// inline. surface_count 0 → 0h (immediate first ping).
const DECAY_HOURS_CASE: string = (() => {
  const rungs = BACKOFF_LADDER_HOURS;
  const lines = ['CASE', 'WHEN COALESCE(surface_count,0) <= 0 THEN 0'];
  for (let i = 0; i < rungs.length - 1; i++) {
    lines.push(`WHEN COALESCE(surface_count,0) = ${i + 1} THEN ${rungs[i]}`);
  }
  lines.push(`ELSE ${rungs[rungs.length - 1]}`);
  lines.push('END');
  return lines.join(' ');
})();

// Shared eligibility predicate: open, not snoozed, not retired, and the decayed
// resurface gap has elapsed. (Caller adds the overdue/due-soon time window.)
const DECAY_ELIGIBLE = `
       AND (snoozed_until IS NULL OR snoozed_until <= datetime('now'))
       AND retired_at IS NULL
       AND NOT EXISTS (
         SELECT 1 FROM email_open_loops eol
         WHERE eol.task_id = tasks.id
           AND eol.status IN ('responded', 'scheduled', 'resolved')
       )
       AND (last_surfaced_at IS NULL
            OR datetime(last_surfaced_at, '+' || (${DECAY_HOURS_CASE}) || ' hours') <= datetime('now'))`;

// Default-filtered versions used by the heartbeat + morning brief — exclude
// snoozed/retired tasks and tasks within their (decaying) resurface gap, and
// drop tasks that have crossed the retire threshold (those go to the morning
// decision pass via getTasksNeedingDecision). Cancelled tasks excluded by status.
export function getOverdueTasks(): Task[] {
  return db.prepare(
    `SELECT * FROM tasks
     WHERE status IN ('open', 'in_progress')
       AND due_date IS NOT NULL AND due_date < datetime('now')
       AND COALESCE(surface_count,0) < ${RETIRE_AT_SURFACE_COUNT}
       ${DECAY_ELIGIBLE}
     ORDER BY due_date ASC`
  ).all() as Task[];
}

export function getTasksDueSoon(hours: number): Task[] {
  return db.prepare(
    `SELECT * FROM tasks
     WHERE status IN ('open', 'in_progress')
       AND due_date IS NOT NULL
       AND due_date BETWEEN datetime('now') AND datetime('now', '+' || ? || ' hours')
       AND COALESCE(surface_count,0) < ${RETIRE_AT_SURFACE_COUNT}
       ${DECAY_ELIGIBLE}
     ORDER BY due_date ASC`
  ).all(hours) as Task[];
}

// Tasks that have been surfaced enough times to cross the retire threshold and
// are due for their next (decayed) surface — but instead of re-pinging, the
// morning brief asks one pointed question and retires them. Same snooze/retire/
// decay gating as the surfacing queries.
export function getTasksNeedingDecision(): Task[] {
  return db.prepare(
    `SELECT * FROM tasks
     WHERE status IN ('open', 'in_progress')
       AND due_date IS NOT NULL AND due_date < datetime('now')
       AND COALESCE(surface_count,0) >= ${RETIRE_AT_SURFACE_COUNT}
       ${DECAY_ELIGIBLE}
     ORDER BY due_date ASC`
  ).all() as Task[];
}

// Unfiltered variants for the dashboard, daily brief, etc. — these should
// always show the truth, not the dedup-aware view used by the heartbeat.
export function getOverdueTasksAll(): Task[] {
  return db.prepare(
    "SELECT * FROM tasks WHERE status IN ('open', 'in_progress') AND due_date IS NOT NULL AND due_date < datetime('now') ORDER BY due_date ASC"
  ).all() as Task[];
}

export function getTasksDueSoonAll(hours: number): Task[] {
  return db.prepare(
    `SELECT * FROM tasks WHERE status IN ('open', 'in_progress') AND due_date IS NOT NULL AND due_date BETWEEN datetime('now') AND datetime('now', '+' || ? || ' hours') ORDER BY due_date ASC`
  ).all(hours) as Task[];
}

export function snoozeTask(taskId: number, untilIso: string): void {
  // Snoozing is a re-engagement — reset the decay ladder + retirement so the
  // task gets a fresh cycle when the snooze expires (not an instant re-ping at
  // its old, decayed-out cadence).
  db.prepare(
    "UPDATE tasks SET snoozed_until = ?, surface_count = 0, last_surfaced_at = NULL, retired_at = NULL, updated_at = datetime('now') WHERE id = ?"
  ).run(untilIso, taskId);
}

export function markTaskSurfaced(taskId: number): void {
  db.prepare(
    "UPDATE tasks SET last_surfaced_at = datetime('now'), surface_count = COALESCE(surface_count, 0) + 1 WHERE id = ?"
  ).run(taskId);
}

// Pull a task out of the reminder rotation after the morning decision question.
// Stays out until the user touches it (resetTaskSurfacing clears retired_at).
export function markTaskRetired(taskId: number): void {
  db.prepare("UPDATE tasks SET retired_at = datetime('now') WHERE id = ?").run(taskId);
}

// "Touch" reset: the user re-engaged with the task (snoozed or rescheduled), so
// the decay ladder and any retirement start fresh — next time it's eligible it
// surfaces immediately, then decays again.
export function resetTaskSurfacing(taskId: number): void {
  db.prepare(
    "UPDATE tasks SET surface_count = 0, last_surfaced_at = NULL, retired_at = NULL WHERE id = ?"
  ).run(taskId);
}

export function getTaskStats(): { total: number; open: number; done: number; overdue: number } {
  const total = (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c;
  const open = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status IN ('open', 'in_progress')").get() as { c: number }).c;
  const done = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status = 'done' AND completed_at > datetime('now', '-7 days')").get() as { c: number }).c;
  const overdue = (db.prepare("SELECT COUNT(*) as c FROM tasks WHERE status IN ('open', 'in_progress') AND due_date IS NOT NULL AND due_date < datetime('now')").get() as { c: number }).c;
  return { total, open, done, overdue };
}

export function updateTaskSchedule(taskId: number, calendarEventId: string) {
  db.prepare('UPDATE tasks SET calendar_event_id = ? WHERE id = ?').run(calendarEventId, taskId);
}

export function clearTaskSchedule(taskId: number) {
  db.prepare('UPDATE tasks SET calendar_event_id = NULL WHERE id = ?').run(taskId);
}

export function getSchedulableTasks(assignee?: string): Task[] {
  let query = `SELECT * FROM tasks
    WHERE status IN ('open', 'in_progress')
      AND calendar_event_id IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM email_open_loops eol
        WHERE eol.task_id = tasks.id
          AND eol.status IN ('responded', 'scheduled', 'resolved')
      )`;
  const params: string[] = [];
  if (assignee) { query += ' AND assignee = ?'; params.push(assignee); }
  query += " ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, due_date ASC";
  return db.prepare(query).all(...params) as Task[];
}

// --- Family-local lists ---
//
// This is a separate persistence surface, not a filtered view over `tasks`.
// Nothing here has Google Task mapping fields or calls the task sync layer.

export type FamilyListItemStatus = 'open' | 'completed';

export interface FamilyList {
  id: number;
  name: string;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface FamilyListSummary extends FamilyList {
  open_count: number;
  completed_count: number;
  archived_count: number;
}

export interface FamilyListItem {
  id: number;
  list_id: number;
  list_name: string;
  text: string;
  quantity: string | null;
  notes: string | null;
  due_date: string | null;
  assignee: string | null;
  status: FamilyListItemStatus;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  completed_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const FAMILY_LIST_ITEM_SELECT = `
  SELECT i.*, l.name AS list_name
  FROM family_list_items i
  JOIN family_lists l ON l.id = i.list_id`;

function requireNonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

export function listFamilyLists(): FamilyListSummary[] {
  return db.prepare(
    `SELECT l.*,
            SUM(CASE WHEN i.archived_at IS NULL AND i.status = 'open' THEN 1 ELSE 0 END) AS open_count,
            SUM(CASE WHEN i.archived_at IS NULL AND i.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
            SUM(CASE WHEN i.archived_at IS NOT NULL THEN 1 ELSE 0 END) AS archived_count
     FROM family_lists l
     LEFT JOIN family_list_items i ON i.list_id = l.id
     GROUP BY l.id
     ORDER BY CASE l.name
       WHEN 'Family Tasks' THEN 0
       WHEN 'Groceries' THEN 1
       WHEN 'Errands' THEN 2
       ELSE 3
     END, l.name COLLATE NOCASE ASC`
  ).all() as FamilyListSummary[];
}

export function getFamilyList(listId: number): FamilyList | undefined {
  return db.prepare('SELECT * FROM family_lists WHERE id = ?').get(listId) as FamilyList | undefined;
}

export function getFamilyListByName(name: string): FamilyList | undefined {
  const normalized = name.trim();
  if (!normalized) return undefined;
  return db.prepare(
    'SELECT * FROM family_lists WHERE name = ? COLLATE NOCASE'
  ).get(normalized) as FamilyList | undefined;
}

/** Create a named Family list, returning the existing id on a case-insensitive match. */
export function createFamilyList(name: string, createdByUserId?: string): number {
  const normalized = requireNonEmpty(name, 'list name');
  const result = db.prepare(
    `INSERT OR IGNORE INTO family_lists (name, created_by_user_id)
     VALUES (?, ?)`
  ).run(normalized, createdByUserId?.trim() || null);
  if (result.changes > 0) return result.lastInsertRowid as number;
  const existing = getFamilyListByName(normalized);
  if (!existing) throw new Error(`Could not create Family list "${normalized}"`);
  return existing.id;
}

export function getFamilyListItem(itemId: number): FamilyListItem | undefined {
  return db.prepare(
    `${FAMILY_LIST_ITEM_SELECT} WHERE i.id = ?`
  ).get(itemId) as FamilyListItem | undefined;
}

export function listFamilyListItems(filters: {
  list_id?: number;
  status?: FamilyListItemStatus;
  assignee?: string | null;
  include_archived?: boolean;
  due_after?: string;
  due_before?: string;
  limit?: number;
} = {}): FamilyListItem[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (!filters.include_archived) clauses.push('i.archived_at IS NULL');
  if (filters.list_id !== undefined) {
    clauses.push('i.list_id = ?');
    params.push(filters.list_id);
  }
  if (filters.status !== undefined) {
    clauses.push('i.status = ?');
    params.push(filters.status);
  }
  if (filters.assignee === null) {
    clauses.push('i.assignee IS NULL');
  } else if (filters.assignee !== undefined) {
    clauses.push('i.assignee = ?');
    params.push(filters.assignee);
  }
  if (filters.due_after) {
    clauses.push('i.due_date IS NOT NULL AND datetime(i.due_date) >= datetime(?)');
    params.push(filters.due_after);
  }
  if (filters.due_before) {
    clauses.push('i.due_date IS NOT NULL AND datetime(i.due_date) <= datetime(?)');
    params.push(filters.due_before);
  }

  const requestedLimit = filters.limit ?? 200;
  const limit = Number.isInteger(requestedLimit)
    ? Math.max(1, Math.min(requestedLimit, 500))
    : 200;
  params.push(limit);

  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return db.prepare(
    `${FAMILY_LIST_ITEM_SELECT}${where}
     ORDER BY i.archived_at IS NOT NULL ASC,
              i.status = 'completed' ASC,
              i.due_date IS NULL ASC,
              datetime(i.due_date) ASC,
              i.created_at ASC,
              i.id ASC
     LIMIT ?`
  ).all(...params) as FamilyListItem[];
}

export function addFamilyListItem(input: {
  list_id: number;
  text: string;
  quantity?: string | null;
  notes?: string | null;
  due_date?: string | null;
  assignee?: string | null;
  created_by_user_id?: string;
}): number {
  const text = requireNonEmpty(input.text, 'item text');
  const result = db.prepare(
    `INSERT INTO family_list_items
       (list_id, text, quantity, notes, due_date, assignee, created_by_user_id, updated_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.list_id,
    text,
    input.quantity ?? null,
    input.notes ?? null,
    input.due_date ?? null,
    input.assignee ?? null,
    input.created_by_user_id?.trim() || null,
    input.created_by_user_id?.trim() || null,
  );
  return result.lastInsertRowid as number;
}

export function updateFamilyListItem(
  itemId: number,
  fields: {
    list_id?: number;
    text?: string;
    quantity?: string | null;
    notes?: string | null;
    due_date?: string | null;
    assignee?: string | null;
    updated_by_user_id?: string;
  },
): boolean {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];

  if (fields.list_id !== undefined) { sets.push('list_id = ?'); params.push(fields.list_id); }
  if (fields.text !== undefined) { sets.push('text = ?'); params.push(requireNonEmpty(fields.text, 'item text')); }
  if (fields.quantity !== undefined) { sets.push('quantity = ?'); params.push(fields.quantity); }
  if (fields.notes !== undefined) { sets.push('notes = ?'); params.push(fields.notes); }
  if (fields.due_date !== undefined) { sets.push('due_date = ?'); params.push(fields.due_date); }
  if (fields.assignee !== undefined) { sets.push('assignee = ?'); params.push(fields.assignee); }
  if (fields.updated_by_user_id !== undefined) {
    sets.push('updated_by_user_id = ?');
    params.push(fields.updated_by_user_id.trim() || null);
  }
  if (sets.length === 0) return false;

  sets.push("updated_at = datetime('now')");
  params.push(itemId);
  const result = db.prepare(
    `UPDATE family_list_items SET ${sets.join(', ')}
     WHERE id = ? AND archived_at IS NULL`
  ).run(...params);
  return result.changes > 0;
}

export function completeFamilyListItem(itemId: number, updatedByUserId?: string): boolean {
  const result = db.prepare(
    `UPDATE family_list_items
     SET status = 'completed', completed_at = COALESCE(completed_at, datetime('now')),
         updated_by_user_id = COALESCE(?, updated_by_user_id), updated_at = datetime('now')
     WHERE id = ? AND archived_at IS NULL`
  ).run(updatedByUserId?.trim() || null, itemId);
  return result.changes > 0;
}

export function reopenFamilyListItem(itemId: number, updatedByUserId?: string): boolean {
  const result = db.prepare(
    `UPDATE family_list_items
     SET status = 'open', completed_at = NULL,
         updated_by_user_id = COALESCE(?, updated_by_user_id), updated_at = datetime('now')
     WHERE id = ? AND archived_at IS NULL`
  ).run(updatedByUserId?.trim() || null, itemId);
  return result.changes > 0;
}

export function archiveFamilyListItem(itemId: number, updatedByUserId?: string): boolean {
  const result = db.prepare(
    `UPDATE family_list_items
     SET archived_at = datetime('now'),
         updated_by_user_id = COALESCE(?, updated_by_user_id), updated_at = datetime('now')
     WHERE id = ? AND archived_at IS NULL`
  ).run(updatedByUserId?.trim() || null, itemId);
  return result.changes > 0;
}

export function restoreFamilyListItem(itemId: number, updatedByUserId?: string): boolean {
  const result = db.prepare(
    `UPDATE family_list_items
     SET archived_at = NULL,
         updated_by_user_id = COALESCE(?, updated_by_user_id), updated_at = datetime('now')
     WHERE id = ? AND archived_at IS NOT NULL`
  ).run(updatedByUserId?.trim() || null, itemId);
  return result.changes > 0;
}

// --- Actions layer (Tier 2 Phase 1) ---
//
// propose → confirm → execute, with every transition stamped in-row. The
// payload_json snapshot frozen at propose time is the audit record. Spend SUMs
// are bounded by ET calendar day/week (see lib/time-et.ts); only status='done'
// rows with an actual_cost_cents count toward the cap.

export interface Action {
  id: number;
  kind: string;
  tool_name: string;
  summary: string;
  payload_json: string;
  estimated_cost_cents: number | null;
  actual_cost_cents: number | null;
  currency: string;
  reversible: number;
  status: string; // 'proposed' | 'confirmed' | 'executing' | 'done' | 'failed' | 'cancelled'
  category: string | null;
  autonomy_level: string;
  proposed_at: string;
  confirmed_at: string | null;
  executed_at: string | null;
  outcome: string | null;
  outcome_url: string | null;
  error: string | null;
  created_by_group: string;
  last_surfaced_at: string | null;
  errand_id?: number | null;
}

export function proposeAction(a: {
  kind: string;
  tool_name: string;
  summary: string;
  payload_json: string;
  estimated_cost_cents?: number | null;
  reversible?: boolean;
  category?: string | null;
  created_by_group: string;
  errand_id?: number | null;
}): number {
  const result = db.prepare(
    `INSERT INTO actions (kind, tool_name, summary, payload_json, estimated_cost_cents, reversible, category, created_by_group, errand_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    a.kind,
    a.tool_name,
    a.summary,
    a.payload_json,
    a.estimated_cost_cents ?? null,
    a.reversible ? 1 : 0,
    a.category ?? null,
    a.created_by_group,
    a.errand_id ?? null,
  );
  return result.lastInsertRowid as number;
}

export function getAction(id: number): Action | undefined {
  return db.prepare('SELECT * FROM actions WHERE id = ?').get(id) as Action | undefined;
}

export function listPendingActions(limit = 20): Action[] {
  return db.prepare(
    "SELECT * FROM actions WHERE status = 'proposed' ORDER BY proposed_at DESC LIMIT ?"
  ).all(limit) as Action[];
}

export function listRecentActions(limit = 20): Action[] {
  return db.prepare(
    `SELECT * FROM actions WHERE status IN ('done','failed','cancelled')
     ORDER BY COALESCE(executed_at, confirmed_at, proposed_at) DESC LIMIT ?`
  ).all(limit) as Action[];
}

// Edit-in-place while still 'proposed' (the `edit #action:N` path). Refreshes the
// frozen payload + derived summary/estimate; never advances status.
export function updateActionProposal(id: number, fields: {
  summary?: string;
  payload_json?: string;
  estimated_cost_cents?: number | null;
}): void {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (fields.summary !== undefined) { sets.push('summary = ?'); params.push(fields.summary); }
  if (fields.payload_json !== undefined) { sets.push('payload_json = ?'); params.push(fields.payload_json); }
  if (fields.estimated_cost_cents !== undefined) { sets.push('estimated_cost_cents = ?'); params.push(fields.estimated_cost_cents); }
  if (sets.length === 0) return;
  params.push(id);
  db.prepare(`UPDATE actions SET ${sets.join(', ')} WHERE id = ? AND status = 'proposed'`).run(...params);
}

export function confirmAction(id: number): void {
  db.prepare(
    "UPDATE actions SET status = 'confirmed', confirmed_at = datetime('now') WHERE id = ? AND status = 'proposed'"
  ).run(id);
}

export function markActionExecuting(id: number): void {
  db.prepare("UPDATE actions SET status = 'executing' WHERE id = ?").run(id);
}

export function markActionDone(id: number, r: { outcome: string; outcome_url?: string | null; actual_cost_cents: number }): void {
  db.prepare(
    "UPDATE actions SET status = 'done', outcome = ?, outcome_url = ?, actual_cost_cents = ?, executed_at = datetime('now') WHERE id = ?"
  ).run(r.outcome, r.outcome_url ?? null, r.actual_cost_cents, id);
}

export function markActionFailed(id: number, error: string): void {
  db.prepare(
    "UPDATE actions SET status = 'failed', error = ?, executed_at = datetime('now') WHERE id = ?"
  ).run(error, id);
}

// Returns true only if the row was in 'proposed'; lets the tool report a clean
// "already executed / already cancelled" instead of silently no-op'ing.
export function cancelAction(id: number): boolean {
  const result = db.prepare(
    "UPDATE actions SET status = 'cancelled' WHERE id = ? AND status = 'proposed'"
  ).run(id);
  return result.changes > 0;
}

export function getDailyActionSpendCents(): number {
  const since = toSqliteDate(startOfTodayET());
  const row = db.prepare(
    "SELECT COALESCE(SUM(actual_cost_cents), 0) AS c FROM actions WHERE status = 'done' AND executed_at >= ?"
  ).get(since) as { c: number };
  return row.c;
}

export function getWeeklyActionSpendCents(): number {
  const since = toSqliteDate(startOfWeekET());
  const row = db.prepare(
    "SELECT COALESCE(SUM(actual_cost_cents), 0) AS c FROM actions WHERE status = 'done' AND executed_at >= ?"
  ).get(since) as { c: number };
  return row.c;
}

// ── LLM meter ────────────────────────────────────────────────────────────────
// Model-call accounting, distinct from the real-money `actions` ledger above.
// Both use startOfTodayET/startOfWeekET so the two budgets roll over together.

export interface LlmUsageRow {
  caller: string;
  lane: string;
  provider: string;
  model: string;
  group_id?: string | null;
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cost_micros?: number;
  latency_ms?: number | null;
  ok?: boolean;
  error_kind?: string | null;
  attempt?: number;
}

// Prepared inline like every other write in this file. better-sqlite3 is
// synchronous, so this is microseconds of statement compilation against an HTTP
// call measured in seconds -- cheap enough to sit on every model call. Callers
// must never let a metering failure break the call it is metering;
// lib/llm-usage.ts owns that try/catch.
export function recordLlmUsageRow(row: LlmUsageRow): void {
  db.prepare(
    `INSERT INTO llm_usage
       (caller, lane, provider, model, group_id, input_tokens, cached_input_tokens,
        output_tokens, reasoning_tokens, cost_micros, latency_ms, ok, error_kind, attempt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.caller, row.lane, row.provider, row.model, row.group_id ?? null,
    row.input_tokens ?? 0, row.cached_input_tokens ?? 0,
    row.output_tokens ?? 0, row.reasoning_tokens ?? 0,
    row.cost_micros ?? 0, row.latency_ms ?? null,
    row.ok === false ? 0 : 1, row.error_kind ?? null, row.attempt ?? 1,
  );
}

/** Micro-USD spent since an local day/week boundary. `lane` narrows to one lane. */
export function getLlmSpendMicros(since: Date, lane?: string): number {
  const sinceStr = toSqliteDate(since);
  const row = lane
    ? db.prepare('SELECT COALESCE(SUM(cost_micros), 0) AS c FROM llm_usage WHERE created_at >= ? AND lane = ?').get(sinceStr, lane) as { c: number }
    : db.prepare('SELECT COALESCE(SUM(cost_micros), 0) AS c FROM llm_usage WHERE created_at >= ?').get(sinceStr) as { c: number };
  return row.c;
}

export function getDailyLlmSpendMicros(lane?: string): number {
  return getLlmSpendMicros(startOfTodayET(), lane);
}

export function getWeeklyLlmSpendMicros(lane?: string): number {
  return getLlmSpendMicros(startOfWeekET(), lane);
}

/** Per-caller rollup for the dashboard and the doctor's "who is spending" view. */
export function getLlmSpendByCaller(since: Date, limit = 20): Array<{
  caller: string; lane: string; calls: number; cost_micros: number;
  input_tokens: number; output_tokens: number; errors: number;
}> {
  return db.prepare(
    `SELECT caller, lane, COUNT(*) AS calls,
            COALESCE(SUM(cost_micros),0)   AS cost_micros,
            COALESCE(SUM(input_tokens),0)  AS input_tokens,
            COALESCE(SUM(output_tokens),0) AS output_tokens,
            COALESCE(SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END),0) AS errors
     FROM llm_usage WHERE created_at >= ?
     GROUP BY caller, lane ORDER BY cost_micros DESC LIMIT ?`,
  ).all(toSqliteDate(since), limit) as Array<{
    caller: string; lane: string; calls: number; cost_micros: number;
    input_tokens: number; output_tokens: number; errors: number;
  }>;
}

// ── Outbound arbitration ─────────────────────────────────────────────────────

export interface OutboundLogRow {
  id: number;
  source: string;
  subject: string;
  kind: string;
  target: string | null;
  decision: string;
  reason: string | null;
  would_hold: number;
  bypass: string | null;
  mode: string;
  text_preview: string;
  text_hash: string;
  char_count: number;
  created_at: string;
}

export function logOutbound(row: Omit<OutboundLogRow, 'id' | 'created_at'>): number {
  const res = db.prepare(
    `INSERT INTO outbound_log
       (source, subject, kind, target, decision, reason, would_hold, bypass, mode,
        text_preview, text_hash, char_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.source, row.subject, row.kind, row.target ?? null, row.decision,
    row.reason ?? null, row.would_hold ? 1 : 0, row.bypass ?? null, row.mode,
    row.text_preview, row.text_hash, row.char_count,
  );
  return Number(res.lastInsertRowid);
}

/**
 * When this subject last actually reached the owner.
 *
 * Deliberately `decision = 'sent'`: a held message did not consume any
 * attention, so it must not start a cooldown. In observe mode everything is
 * 'sent', which is correct — they really did receive it.
 */
export function lastSentForSubject(subject: string, sinceIso: string): string | null {
  const row = db.prepare(
    `SELECT created_at FROM outbound_log
      WHERE subject = ? AND decision = 'sent' AND created_at >= ?
      ORDER BY id DESC LIMIT 1`,
  ).get(subject, sinceIso) as { created_at: string } | undefined;
  return row?.created_at ?? null;
}

/** Interrupts delivered since `sinceIso`. `reply` is excluded by the caller's rules. */
export function countSentSince(sinceIso: string, excludeKinds: string[] = []): number {
  const placeholders = excludeKinds.map(() => '?').join(',');
  const sql = `SELECT COUNT(*) AS c FROM outbound_log
                WHERE decision = 'sent' AND created_at >= ?`
    + (excludeKinds.length ? ` AND kind NOT IN (${placeholders})` : '');
  const row = db.prepare(sql).get(sinceIso, ...excludeKinds) as { c: number };
  return row.c;
}

/** A different source that already said substantially this, recently. */
export function findDuplicateSince(textHash: string, sinceIso: string, excludeSource: string): string | null {
  const row = db.prepare(
    `SELECT source FROM outbound_log
      WHERE text_hash = ? AND decision = 'sent' AND created_at >= ? AND source <> ?
      LIMIT 1`,
  ).get(textHash, sinceIso, excludeSource) as { source: string } | undefined;
  return row?.source ?? null;
}

/**
 * Everything said about this subject since `sinceIso`, newest first.
 *
 * Reads ALL decisions, not just sends: an item folded into the morning brief was
 * logged as one row, and the point of this query is that the 10:00 heartbeat
 * must not re-raise it. Cooldown alone cannot catch that — it is a different
 * source with a different clock.
 */
export function subjectHistorySince(subject: string, sinceIso: string): Array<{ kind: string; decision: string }> {
  return db.prepare(
    `SELECT kind, decision FROM outbound_log
      WHERE subject = ? AND created_at >= ? ORDER BY id DESC`,
  ).all(subject, sinceIso) as Array<{ kind: string; decision: string }>;
}

/** Operator view: what the arbiter held, or would have held in observe mode. */
export function recentHeldOutbound(limit = 40): OutboundLogRow[] {
  return db.prepare(
    `SELECT * FROM outbound_log
      WHERE decision <> 'sent' OR would_hold = 1
      ORDER BY id DESC LIMIT ?`,
  ).all(limit) as OutboundLogRow[];
}

/** Operator view: who is loudest. */
export function outboundTallySince(sinceIso: string): Array<{
  source: string; decision: string; would_hold: number; n: number;
}> {
  return db.prepare(
    `SELECT source, decision, would_hold, COUNT(*) AS n FROM outbound_log
      WHERE created_at >= ? GROUP BY source, decision, would_hold ORDER BY n DESC`,
  ).all(sinceIso) as Array<{ source: string; decision: string; would_hold: number; n: number }>;
}

/** Models seen since `since` — the doctor warns when one is missing a price. */
export function getLlmModelsSince(since: Date): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT model FROM llm_usage WHERE created_at >= ? AND provider = 'openai'",
  ).all(toSqliteDate(since)) as Array<{ model: string }>;
  return rows.map((r) => r.model);
}

export default db;

// ── Errands (docs/ERRANDS.md) ────────────────────────────────────────────────

export interface ErrandRow {
  id: number;
  action_id: number | null;
  goal: string;
  status: string;
  deadline: string | null;
  envelope_json: string;
  target_idx: number;
  calls_made: number;
  call_state: string | null;
  call_started_at: string | null;
  next_check_at: string | null;
  outcome: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export interface ErrandEventRow { id: number; errand_id: number; type: string; detail: string | null; at: string }

export function createErrand(e: { action_id: number | null; goal: string; deadline: string | null; envelope_json: string }): number {
  const r = db.prepare(
    `INSERT INTO errands (action_id, goal, deadline, envelope_json, next_check_at) VALUES (?, ?, ?, ?, datetime('now'))`
  ).run(e.action_id, e.goal, e.deadline, e.envelope_json);
  return r.lastInsertRowid as number;
}

export function getErrand(id: number): ErrandRow | undefined {
  return db.prepare('SELECT * FROM errands WHERE id = ?').get(id) as ErrandRow | undefined;
}

/** Only the listed columns can change; updated_at is always stamped. */
export function updateErrand(id: number, patch: Partial<Pick<ErrandRow,
  'status' | 'envelope_json' | 'target_idx' | 'calls_made' | 'call_state' | 'call_started_at' | 'next_check_at' | 'outcome' | 'finished_at'>>): void {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE errands SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => patch[k] ?? null), id);
}

/** Active errands whose next check is due and that aren't mid-call. */
export function getDueErrands(): ErrandRow[] {
  return db.prepare(
    `SELECT * FROM errands WHERE status = 'active'
       AND (call_state IS NULL)
       AND (next_check_at IS NULL OR next_check_at <= datetime('now'))
     ORDER BY id`
  ).all() as ErrandRow[];
}

/** Errands with a call that may have gone quiet (for the watchdog). */
export function getErrandsInCall(): ErrandRow[] {
  return db.prepare(`SELECT * FROM errands WHERE status = 'active' AND call_state IS NOT NULL`).all() as ErrandRow[];
}

/**
 * Errands a business might be calling back about: open ones, plus done/failed
 * ones that finished in the last `days` days. Open errands first, newest first.
 */
export function getErrandsForCallback(days = 3): ErrandRow[] {
  return db.prepare(
    `SELECT * FROM errands
      WHERE status IN ('active','waiting')
         OR (status IN ('done','failed') AND finished_at >= datetime('now', ?))
      ORDER BY CASE WHEN status IN ('active','waiting') THEN 0 ELSE 1 END, id DESC`
  ).all(`-${Math.max(1, Math.round(days))} days`) as ErrandRow[];
}

export function listErrands(opts: { open?: boolean; limit?: number } = {}): ErrandRow[] {
  const where = opts.open ? `WHERE status IN ('active','waiting')` : '';
  return db.prepare(`SELECT * FROM errands ${where} ORDER BY id DESC LIMIT ?`).all(opts.limit ?? 20) as ErrandRow[];
}

export function addErrandEvent(errandId: number, type: string, detail?: string | null): void {
  db.prepare('INSERT INTO errand_events (errand_id, type, detail) VALUES (?, ?, ?)').run(errandId, type, detail ?? null);
}

export function getErrandEvents(errandId: number, limit = 50): ErrandEventRow[] {
  return db.prepare('SELECT * FROM errand_events WHERE errand_id = ? ORDER BY id DESC LIMIT ?').all(errandId, limit) as ErrandEventRow[];
}

/** Errand calls placed today (local), across all errands, for the daily cap. */
export function countErrandCallsToday(): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM errand_events WHERE type = 'dialing' AND at >= ?`
  ).get(toSqliteDate(startOfTodayET())) as { n: number };
  return row.n;
}

// ── Wake-up calls (src/wakeup.ts) ────────────────────────────────────────────

export interface WakeUpCallRow {
  id: number;
  time: string;
  date: string | null;
  days: string | null;
  note: string | null;
  status: string;
  cycle_date: string | null;
  attempts_today: number;
  call_state: string | null;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  last_result: string | null;
  last_done_date: string | null;
  created_at: string;
  updated_at: string;
}

export function createWakeUpCall(w: { time: string; date: string | null; days: string | null; note: string | null; last_done_date?: string | null }): number {
  const r = db.prepare(
    'INSERT INTO wake_up_calls (time, date, days, note, last_done_date) VALUES (?, ?, ?, ?, ?)'
  ).run(w.time, w.date, w.days, w.note, w.last_done_date ?? null);
  return r.lastInsertRowid as number;
}

export function getWakeUpCall(id: number): WakeUpCallRow | undefined {
  return db.prepare('SELECT * FROM wake_up_calls WHERE id = ?').get(id) as WakeUpCallRow | undefined;
}

export function listWakeUpCalls(opts: { active?: boolean } = {}): WakeUpCallRow[] {
  const where = opts.active ? `WHERE status = 'active'` : '';
  return db.prepare(`SELECT * FROM wake_up_calls ${where} ORDER BY id`).all() as WakeUpCallRow[];
}

/** Only the listed columns can change; updated_at is always stamped. */
export function updateWakeUpCall(id: number, patch: Partial<Pick<WakeUpCallRow,
  'status' | 'cycle_date' | 'attempts_today' | 'call_state' | 'next_attempt_at' | 'last_attempt_at' | 'last_result' | 'last_done_date'>>): void {
  const keys = Object.keys(patch) as Array<keyof typeof patch>;
  if (!keys.length) return;
  const sets = keys.map((k) => `${k} = ?`).join(', ');
  db.prepare(`UPDATE wake_up_calls SET ${sets}, updated_at = datetime('now') WHERE id = ?`)
    .run(...keys.map((k) => patch[k] ?? null), id);
}

// ── Restart recovery (src/channels/imessage.ts#recoverInterruptedDMs) ────────

function toSqliteUtc(iso: string): string {
  return new Date(iso).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, '');
}

/** Has the bot answered anything outside Family since this instant? */
export function hasAssistantReplySince(iso: string): boolean {
  return !!db.prepare(
    `SELECT 1 FROM messages WHERE role = 'assistant' AND group_id != 'family' AND created_at >= ? LIMIT 1`
  ).get(toSqliteUtc(iso));
}

/**
 * Drop user rows saved by a run that a restart killed before it replied, so the
 * recovered run doesn't put the same message in history twice.
 */
export function dropUnansweredUserRowsSince(iso: string): number {
  const since = toSqliteUtc(new Date(Date.parse(iso) - 5000).toISOString());
  return db.prepare(
    `DELETE FROM messages WHERE role = 'user' AND group_id != 'family' AND created_at >= ?`
  ).run(since).changes;
}

// ── Forgetting (owner-requested deletion) ─────────────────────────────────────
// A real DELETE, not active=0: when the owner says "forget that", the row and its
// full-text index entry (facts_ad trigger) are gone from the database.

/** Facts that would be deleted for this subject: exact subject match, case-insensitive. */
export function factsForSubject(subject: string): Fact[] {
  return db.prepare('SELECT * FROM facts WHERE subject = ? COLLATE NOCASE ORDER BY id').all(subject.trim().toLowerCase()) as Fact[];
}

export function deleteFacts(ids: number[]): number {
  const del = db.prepare('DELETE FROM facts WHERE id = ?');
  let n = 0;
  db.transaction(() => { for (const id of ids) n += del.run(id).changes; })();
  return n;
}
