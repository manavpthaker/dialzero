import 'dotenv/config';
import { homedir } from 'os';
import Database from 'better-sqlite3';
import { backfillIMessages } from '../src/db.js';
import { decodeIMessageAttributedBody } from '../src/lib/imessage-attributed-body.js';

// Backfill older iMessage threads from chat.db into imessage_log so search_messages
// can reach history from before the bot started observing.
//
// The live poller (src/channels/imessage.ts) only logs messages from boot forward
// (its cursor seeds at MAX(ROWID)). This script reads the same columns from chat.db,
// decodes the attributedBody blob for the ~4% of messages that have no plain `text`,
// and INSERT OR IGNOREs them — idempotent against rows the poller already wrote.
//
// Backfilled rows are stamped extracted_at=now (see db.ts#backfillIMessage) so the
// imessage-daemon does NOT run LLM extraction over years of old chatter. They are for
// SEARCH only; new commitments/people/etc. still come from live messages going forward.
//
// Usage:
//   npm run backfill:imessages -- --days 365      (default 365; window in days)
//   npm run backfill:imessages -- --all           (entire history, no date floor)
//   npm run backfill:imessages -- --days 90 --dry  (count only, no writes)
//   optional: --limit N (cap rows scanned)

const CHAT_DB_PATH = `${homedir()}/Library/Messages/chat.db`;
const APPLE_EPOCH_OFFSET = 978307200; // 2001-01-01 in unix seconds

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const ALL = process.argv.includes('--all');
const DRY = process.argv.includes('--dry');
const DAYS = Number(arg('days') ?? 365);
const LIMIT = arg('limit') ? Number(arg('limit')) : undefined;
const CHUNK = 2000;

// Mirror of src/channels/imessage.ts#appleDateToISO (ns-since-2001, with a seconds
// fallback for very old rows) so backfilled timestamps match the live poller's.
function appleDateToISO(date: number): string {
  if (!date) return new Date(0).toISOString();
  const ms2001 = date > 1e12 ? date / 1e6 : date * 1000;
  return new Date(ms2001 + APPLE_EPOCH_OFFSET * 1000).toISOString();
}

interface ChatRow {
  ROWID: number;
  text: string | null;
  attributedBody: Buffer | null;
  date: number;
  is_from_me: number;
  sender_handle: string | null;
  chat_id: string | null;
  chat_name: string | null;
}

function main(): void {
  const db = new Database(CHAT_DB_PATH, { readonly: true, fileMustExist: true });

  let where = '';
  const params: number[] = [];
  if (!ALL) {
    const floorUnix = Math.floor(Date.now() / 1000) - DAYS * 86400;
    const floorNs = (floorUnix - APPLE_EPOCH_OFFSET) * 1e9;
    where = 'WHERE m.date > ?';
    params.push(floorNs);
  }

  const stmt = db.prepare(`
    SELECT
      m.ROWID, m.text, m.attributedBody, m.date, m.is_from_me,
      h.id AS sender_handle,
      c.chat_identifier AS chat_id,
      c.display_name AS chat_name
    FROM message m
    LEFT JOIN handle h ON m.handle_id = h.ROWID
    LEFT JOIN chat_message_join cmj ON m.ROWID = cmj.message_id
    LEFT JOIN chat c ON cmj.chat_id = c.ROWID
    ${where}
    ORDER BY m.ROWID ASC
    ${LIMIT ? `LIMIT ${LIMIT}` : ''}
  `);

  console.log(`[backfill] scanning chat.db (${ALL ? 'ALL history' : `last ${DAYS} days`})${DRY ? ' — DRY RUN, no writes' : ''}`);

  let scanned = 0;
  let skippedNoText = 0;
  let skippedNoChat = 0;
  let candidates = 0;
  let inserted = 0;
  let batch: Array<Parameters<typeof backfillIMessages>[0][number]> = [];

  const flush = () => {
    if (!batch.length) return;
    if (!DRY) inserted += backfillIMessages(batch);
    batch = [];
  };

  for (const msg of stmt.iterate(...params) as IterableIterator<ChatRow>) {
    scanned++;
    const chatId = msg.chat_id || msg.sender_handle || '';
    if (!chatId) { skippedNoChat++; continue; }

    const text = (msg.text && msg.text.trim())
      || decodeIMessageAttributedBody(msg.attributedBody)
      || '';
    if (!text) { skippedNoText++; continue; } // search needs text; skip attachment-only rows

    candidates++;
    batch.push({
      rowid_src: msg.ROWID,
      chat_id: chatId,
      chat_name: msg.chat_name,
      sender: msg.is_from_me ? 'me' : (msg.sender_handle || 'unknown'),
      direction: msg.is_from_me ? 'out' : 'in',
      text,
      ts: appleDateToISO(msg.date),
    });
    if (batch.length >= CHUNK) flush();
  }
  flush();
  db.close();

  console.log(`[backfill] scanned ${scanned} | text rows ${candidates} | skipped(no text) ${skippedNoText} | skipped(no chat) ${skippedNoChat}`);
  console.log(DRY
    ? `[backfill] DRY RUN — ${candidates} message(s) would be backfilled (new + already-present).`
    : `[backfill] done — ${inserted} new row(s) inserted (the rest were already in imessage_log).`);
}

main();
