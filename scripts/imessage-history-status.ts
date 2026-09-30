import 'dotenv/config';
import db, {
  findPersonByEmail,
  findPersonByPhone,
  getIMessageHistoryCadence,
  getIMessageHistoryStatus,
} from '../src/db.js';
import { getOwner } from '../src/config.js';
import { initUsers, resolveUser } from '../src/user-resolver.js';

const before = process.env.IMESSAGE_HISTORY_BEFORE?.trim()
  || process.env.IMESSAGE_EXTRACT_NOT_BEFORE?.trim()
  || '';
if (!before || !Number.isFinite(Date.parse(before))) {
  console.error('IMESSAGE_HISTORY_BEFORE (or IMESSAGE_EXTRACT_NOT_BEFORE) must be a valid timestamp.');
  process.exit(1);
}

initUsers();

function labelChat(chatId: string, chatName: string | null): string {
  if (chatName?.trim()) return chatName.trim();
  const profileUser = resolveUser(chatId);
  if (profileUser?.id === getOwner().id) return 'Owner ↔ Assistant';
  if (profileUser) return profileUser.name;
  const person = chatId.includes('@') ? findPersonByEmail(chatId) : findPersonByPhone(chatId);
  if (person?.name) return person.name;
  if (chatId.startsWith('+')) return `phone …${chatId.replace(/\D/g, '').slice(-4)}`;
  if (chatId.includes('@')) {
    const [local, domain = 'email'] = chatId.split('@');
    return `${local.slice(0, 1)}…@${domain}`;
  }
  return `group …${chatId.slice(-6)}`;
}

const status = getIMessageHistoryStatus(before);
console.log(`Historical iMessage mining before ${before}`);
console.log(`Processed: ${status.processed.toLocaleString()} | Remaining: ${status.remaining.toLocaleString()} | Facts committed: ${status.facts.toLocaleString()}`);
console.log(`Batches: ${status.completedBatches} completed | ${status.failedBatches} failed`);
if (status.latestBatch) {
  const b = status.latestBatch;
  console.log(
    `Latest #${b.id}: ${b.status} | scanned ${b.scanned_count} | safe ${b.safe_count} | private ${b.private_count} | `
    + `bot ${b.bot_count} | accepted ${b.observation_count} | new facts ${b.fact_count}`,
  );
  if (b.error) console.log(`Error: ${b.error}`);
}

const recent = db.prepare(
  `SELECT f.id, f.subject, f.predicate, f.object, c.kind, c.observed_at
   FROM imessage_history_fact_commits c
   JOIN facts f ON f.id = c.fact_id
   ORDER BY c.id DESC LIMIT 10`,
).all() as Array<{ id: number; subject: string; predicate: string; object: string; kind: string; observed_at: string }>;
if (recent.length) {
  console.log('\nRecent committed memory:');
  for (const fact of recent) {
    console.log(`- #${fact.id} [${fact.kind}] ${fact.subject} ${fact.predicate} ${fact.object}`);
  }
}

const cadence = getIMessageHistoryCadence(10);
if (cadence.length) {
  console.log('\nTraffic cadence in processed coverage:');
  for (const row of cadence) {
    console.log(
      `- ${labelChat(row.chat_id, row.chat_name)}: ${row.messages} messages over ${row.active_months} active month(s) `
      + `(${row.messages_per_active_month}/active month; ${row.incoming} in, ${row.outgoing} out; ${row.first_ts.slice(0, 10)} → ${row.last_ts.slice(0, 10)})`,
    );
  }
  console.log('Traffic is not treated as closeness or meaningful contact. Bot-generated and private rows are excluded.');
}

