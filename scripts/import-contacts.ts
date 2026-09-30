import 'dotenv/config';
import { homedir } from 'os';
import { join } from 'path';
import { existsSync, readdirSync } from 'fs';
import Database from 'better-sqlite3';
import { upsertPerson } from '../src/db.js';

// Apple Contacts importer.
//
// Seeds the people CRM from the local Address Book so iMessage senders (phone handles)
// resolve to real, named people instead of accreting only from observed activity. Apple
// stores contacts in one SQLite DB per account source under
//   ~/Library/Application Support/AddressBook/Sources/<UUID>/AddressBook-v22.abcddb
// (plus a top-level AddressBook-v22.abcddb). We read every source read-only and upsert.
//
// upsertPerson() dedups on email → phone → linkedin, so re-running merges rather than
// duplicating, and a contact present in two sources (iCloud + Google) collapses to one
// row when they share an email or phone. Run once to bootstrap, then nightly via
// launchd/com.assistant.contacts-sync.plist.
//
// Usage: npm run import:contacts   (add --dry to preview without writing)

const DRY = process.argv.includes('--dry');
const ADDRESSBOOK_DIR = join(homedir(), 'Library', 'Application Support', 'AddressBook');

function findContactDbs(): string[] {
  const dbs: string[] = [];
  const topLevel = join(ADDRESSBOOK_DIR, 'AddressBook-v22.abcddb');
  if (existsSync(topLevel)) dbs.push(topLevel);

  const sourcesDir = join(ADDRESSBOOK_DIR, 'Sources');
  if (existsSync(sourcesDir)) {
    for (const entry of readdirSync(sourcesDir)) {
      const candidate = join(sourcesDir, entry, 'AddressBook-v22.abcddb');
      if (existsSync(candidate)) dbs.push(candidate);
    }
  }
  return dbs;
}

interface ContactRecord {
  name: string;
  company?: string;
  emails: string[];
  phones: string[];
}

// Read one Address Book source DB into normalized contact records.
function readContacts(dbPath: string): ContactRecord[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const records = db
      .prepare('SELECT Z_PK, ZFIRSTNAME, ZLASTNAME, ZORGANIZATION FROM ZABCDRECORD')
      .all() as Array<{ Z_PK: number; ZFIRSTNAME: string | null; ZLASTNAME: string | null; ZORGANIZATION: string | null }>;

    // Group phones / emails by their owning record (ZOWNER → ZABCDRECORD.Z_PK).
    const phonesByOwner = new Map<number, string[]>();
    for (const row of db.prepare('SELECT ZFULLNUMBER, ZOWNER FROM ZABCDPHONENUMBER').all() as Array<{ ZFULLNUMBER: string | null; ZOWNER: number | null }>) {
      if (!row.ZOWNER || !row.ZFULLNUMBER) continue;
      const list = phonesByOwner.get(row.ZOWNER) ?? [];
      list.push(row.ZFULLNUMBER);
      phonesByOwner.set(row.ZOWNER, list);
    }
    const emailsByOwner = new Map<number, string[]>();
    for (const row of db.prepare('SELECT ZADDRESS, ZOWNER FROM ZABCDEMAILADDRESS').all() as Array<{ ZADDRESS: string | null; ZOWNER: number | null }>) {
      if (!row.ZOWNER || !row.ZADDRESS) continue;
      const list = emailsByOwner.get(row.ZOWNER) ?? [];
      list.push(row.ZADDRESS);
      emailsByOwner.set(row.ZOWNER, list);
    }

    const out: ContactRecord[] = [];
    for (const r of records) {
      const name = [r.ZFIRSTNAME, r.ZLASTNAME].filter(Boolean).join(' ').trim();
      const company = r.ZORGANIZATION?.trim() || undefined;
      const displayName = name || company; // company-only contacts (vendors) keep their org as the name
      if (!displayName) continue; // nameless record with no org — nothing to key on
      const emails = emailsByOwner.get(r.Z_PK) ?? [];
      const phones = phonesByOwner.get(r.Z_PK) ?? [];
      if (emails.length === 0 && phones.length === 0) continue; // no identifier to dedup/link on
      out.push({
        name: displayName,
        company: name ? company : undefined, // don't duplicate org into both name and company
        emails,
        phones,
      });
    }
    return out;
  } finally {
    db.close();
  }
}

function main(): void {
  const dbs = findContactDbs();
  if (dbs.length === 0) {
    console.error(`[import-contacts] No Address Book DBs found under ${ADDRESSBOOK_DIR}`);
    process.exit(1);
  }
  console.log(`[import-contacts] Found ${dbs.length} Address Book source(s)${DRY ? ' (dry run — no writes)' : ''}`);

  let total = 0;
  let imported = 0;
  for (const dbPath of dbs) {
    let contacts: ContactRecord[];
    try {
      contacts = readContacts(dbPath);
    } catch (err) {
      console.warn(`[import-contacts] Skipped ${dbPath}: ${err instanceof Error ? err.message : err}`);
      continue;
    }
    console.log(`[import-contacts] ${contacts.length} usable contact(s) in ${dbPath.replace(homedir(), '~')}`);
    for (const c of contacts) {
      total++;
      if (DRY) continue;
      try {
        upsertPerson({ name: c.name, company: c.company, emails: c.emails, phones: c.phones });
        imported++;
      } catch (err) {
        console.warn(`[import-contacts] upsert failed for ${c.name}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  console.log(`[import-contacts] Done. ${DRY ? `${total} contact(s) would be imported` : `${imported}/${total} contact(s) upserted`}.`);
}

main();
