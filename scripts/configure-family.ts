import 'dotenv/config';
import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { google, type calendar_v3 } from 'googleapis';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = join(dirname(SCRIPT_PATH), '..');
const ENV_PATH = join(ROOT, '.env');

export type FamilyCalendarEntry = Pick<
  calendar_v3.Schema$CalendarListEntry,
  'id' | 'summary' | 'primary' | 'deleted' | 'accessRole'
>;

export class FamilySetupError extends Error {
  constructor(
    public readonly code:
      | 'missing_auth'
      | 'not_found'
      | 'duplicate'
      | 'invalid_id'
      | 'not_writable'
      | 'account_mismatch'
      | 'ambiguous_env'
      | 'save_failed',
    message: string,
  ) {
    super(message);
    this.name = 'FamilySetupError';
  }
}

function requireExpectedPrimaryAccount(value: unknown): string {
  const account = typeof value === 'string' ? value.trim() : '';
  if (!account) {
    throw new FamilySetupError(
      'account_mismatch',
      'FAMILY_CALENDAR_ACCOUNT must contain the exact primary calendar ID for the intended authenticated Google account.',
    );
  }
  if (account.toLowerCase() === 'primary' || /[\s\r\n\0]/.test(account)) {
    throw new FamilySetupError(
      'account_mismatch',
      'FAMILY_CALENDAR_ACCOUNT is not a safe exact primary calendar ID.',
    );
  }
  return account;
}

/** Identify and verify the exact authenticated Calendar primary account. */
export function resolveFamilyCalendarAccount(
  entries: readonly FamilyCalendarEntry[],
  expectedPrimaryAccount: string,
): string {
  const expectedAccount = requireExpectedPrimaryAccount(expectedPrimaryAccount);
  const primary = entries.filter((entry) => entry.primary === true && entry.deleted !== true);
  if (
    primary.length !== 1
    || primary[0].id?.trim() !== expectedAccount
    || primary[0].accessRole !== 'owner'
  ) {
    throw new FamilySetupError(
      'account_mismatch',
      'The authenticated Google Calendar primary does not exactly match FAMILY_CALENDAR_ACCOUNT.',
    );
  }
  return expectedAccount;
}

/** Resolve one owned secondary calendar without ever falling back to primary or
 * accepting a calendar exposed by a different authenticated account. */
export function resolveFamilyCalendarId(
  entries: readonly FamilyCalendarEntry[],
  expectedPrimaryAccount: string,
): string {
  const expectedAccount = resolveFamilyCalendarAccount(entries, expectedPrimaryAccount);
  const matches = entries.filter((entry) =>
    entry.summary === 'Family' && entry.primary !== true && entry.deleted !== true,
  );

  if (matches.length === 0) {
    throw new FamilySetupError(
      'not_found',
      'No non-primary calendar named Family was found. Create it under the current Google account, then run this again.',
    );
  }
  if (matches.length !== 1) {
    throw new FamilySetupError(
      'duplicate',
      'More than one non-primary calendar named Family was found. Rename the duplicates before continuing.',
    );
  }

  const match = matches[0];
  const id = match.id?.trim() || '';
  if (!id || id.toLowerCase() === 'primary' || id === expectedAccount || /[\r\n\0]/.test(id)) {
    throw new FamilySetupError(
      'invalid_id',
      'The Family calendar did not return a safe secondary calendar identifier.',
    );
  }
  if (match.accessRole !== 'owner') {
    throw new FamilySetupError(
      'not_writable',
      'The Family calendar exists, but the authenticated Google account does not own it.',
    );
  }
  return id;
}

function saveFamilySettings(
  settings: Readonly<Record<string, string>>,
  envPath = ENV_PATH,
): boolean {
  const original = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const hadTrailingEol = original.endsWith('\n') || original.endsWith('\r');
  const lines = original ? original.split(/\r?\n/) : [];
  if (hadTrailingEol) lines.pop();

  for (const [key, value] of Object.entries(settings)) {
    if (!value.trim() || /[\r\n\0]/.test(value)) {
      throw new FamilySetupError('invalid_id', `Refusing to save an unsafe ${key} value.`);
    }
    const targetPattern = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`);
    const indexes = lines
      .map((line, index) => targetPattern.test(line) ? index : -1)
      .filter((index) => index >= 0);
    if (indexes.length > 1) {
      throw new FamilySetupError(
        'ambiguous_env',
        `The private settings file contains more than one ${key} line. Resolve that ambiguity manually.`,
      );
    }
    const setting = `${key}=${JSON.stringify(value.trim())}`;
    if (indexes.length === 1) lines[indexes[0]] = setting;
    else lines.push(setting);
  }

  let updated = lines.join(eol);
  if (lines.length > 0 && (hadTrailingEol || original.length === 0)) updated += eol;
  if (updated === original) return false;

  const mode = existsSync(envPath) ? statSync(envPath).mode & 0o777 : 0o600;
  const tempPath = join(dirname(envPath), `.family-env-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tempPath, updated, { encoding: 'utf8', flag: 'wx', mode });
    renameSync(tempPath, envPath);
  } catch {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw new FamilySetupError('save_failed', 'The verified Family calendar binding could not be saved to the private settings file.');
  }
  return true;
}

/**
 * Replace only FAMILY_CALENDAR_ID and preserve every other .env line. The
 * write is atomic and keeps the existing private file mode (0600 for a new
 * file). The value is quoted so it cannot introduce another setting.
 */
export function saveFamilyCalendarId(calendarId: string, envPath = ENV_PATH): boolean {
  const id = calendarId.trim();
  if (!id || id.toLowerCase() === 'primary' || /[\r\n\0]/.test(id)) {
    throw new FamilySetupError('invalid_id', 'Refusing to save an unsafe Family calendar identifier.');
  }

  return saveFamilySettings({ FAMILY_CALENDAR_ID: id }, envPath);
}

/** Save the exact secondary calendar and the authenticated account that exposed
 * it. The account pin makes an OAuth-account change visible during later setup. */
export function saveFamilyCalendarBinding(
  calendarId: string,
  account: string,
  envPath = ENV_PATH,
): boolean {
  const id = calendarId.trim();
  const normalizedAccount = account.trim();
  if (!id || id.toLowerCase() === 'primary' || /[\r\n\0]/.test(id)) {
    throw new FamilySetupError('invalid_id', 'Refusing to save an unsafe Family calendar identifier.');
  }
  if (!normalizedAccount || normalizedAccount.toLowerCase() === 'primary' || /[\s\r\n\0]/.test(normalizedAccount)) {
    throw new FamilySetupError('account_mismatch', 'Refusing to save an unsafe Family calendar account identifier.');
  }
  if (id === normalizedAccount) {
    throw new FamilySetupError('invalid_id', 'The Family calendar must not be the connected account primary calendar.');
  }
  return saveFamilySettings({
    FAMILY_CALENDAR_ID: id,
    FAMILY_CALENDAR_ACCOUNT: normalizedAccount,
  }, envPath);
}

function calendarClient(): calendar_v3.Calendar {
  const clientId = process.env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim();
  const refreshToken = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN?.trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new FamilySetupError(
      'missing_auth',
      'Google Calendar authentication is incomplete. Run the existing Google authorization setup first.',
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.calendar({ version: 'v3', auth });
}

async function listAvailableCalendars(): Promise<FamilyCalendarEntry[]> {
  const client = calendarClient();
  const calendars: FamilyCalendarEntry[] = [];
  let pageToken: string | undefined;

  do {
    const response = await client.calendarList.list({
      maxResults: 250,
      pageToken,
      showDeleted: false,
      fields: 'nextPageToken,items(id,summary,primary,deleted,accessRole)',
    });
    calendars.push(...(response.data.items ?? []));
    pageToken = response.data.nextPageToken ?? undefined;
  } while (pageToken);

  return calendars;
}

function usage(): void {
  console.log('Usage: tsx scripts/configure-family.ts [--dry | --apply]');
  console.log('Set FAMILY_CALENDAR_ACCOUNT to the exact intended authenticated primary calendar ID first.');
  console.log('Default/--dry verifies that account owns one secondary calendar named Family without changing settings.');
  console.log('--apply performs the same verification, then saves FAMILY_CALENDAR_ID and FAMILY_CALENDAR_ACCOUNT privately.');
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const allowed = new Set(['--dry', '--apply', '--help']);
  if (args.some((arg) => !allowed.has(arg)) || (args.includes('--dry') && args.includes('--apply'))) {
    usage();
    return 2;
  }
  if (args.includes('--help')) {
    usage();
    return 0;
  }

  const apply = args.includes('--apply');
  try {
    const expectedAccount = requireExpectedPrimaryAccount(process.env.FAMILY_CALENDAR_ACCOUNT);
    const entries = await listAvailableCalendars();
    const calendarAccount = resolveFamilyCalendarAccount(entries, expectedAccount);
    const calendarId = resolveFamilyCalendarId(entries, expectedAccount);

    if (!apply) {
      console.log('Family calendar verified: the exact authenticated primary account owns one secondary calendar named Family.');
      console.log('No settings changed. Run again with --apply after the calendar and sharing are ready.');
      return 0;
    }

    const changed = saveFamilyCalendarBinding(calendarId, calendarAccount);
    console.log(changed
      ? 'Family calendar verified and its binding was saved privately. Restart Assistant to activate it.'
      : 'Family calendar verified; the private binding was already current.');
    return 0;
  } catch (error) {
    if (error instanceof FamilySetupError) {
      console.error(`Family setup stopped safely: ${error.message} No settings changed.`);
    } else {
      console.error('Family setup stopped safely: Google Calendar access could not be verified. No settings changed.');
    }
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  void main().then((code) => {
    process.exitCode = code;
  });
}
