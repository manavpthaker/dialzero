import 'dotenv/config';
import { google } from 'googleapis';
import { createServer } from 'http';
import { URL } from 'url';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');

function writeRefreshToken(token: string): boolean {
  if (!existsSync(ENV_PATH)) return false;
  const contents = readFileSync(ENV_PATH, 'utf-8');
  const line = `GOOGLE_CALENDAR_REFRESH_TOKEN=${token}`;
  let updated: string;
  if (/^GOOGLE_CALENDAR_REFRESH_TOKEN=.*$/m.test(contents)) {
    updated = contents.replace(/^GOOGLE_CALENDAR_REFRESH_TOKEN=.*$/m, line);
  } else {
    updated = contents.trimEnd() + `\n${line}\n`;
  }
  writeFileSync(ENV_PATH, updated);
  return true;
}

const CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
// GOOGLE_AUTH_REDIRECT lets you finish the sign-in from another device, e.g. a
// phone on your Tailscale network (https://<mac>.<tailnet>.ts.net:3333/callback,
// served to this port).
const REDIRECT_URI = process.env.GOOGLE_AUTH_REDIRECT || 'http://localhost:3333/callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CALENDAR_CLIENT_ID or GOOGLE_CALENDAR_CLIENT_SECRET in .env');
  process.exit(1);
}

const oauth2 = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: 'offline',
  prompt: 'consent',
  scope: [
    'https://www.googleapis.com/auth/calendar',
    'https://www.googleapis.com/auth/tasks',
    // Email tools + daemons (src/email/gmail.ts): read, archive, save drafts.
    'https://www.googleapis.com/auth/gmail.modify',
    // send_email action (src/tools/outbound-send.ts), behind the actions gate.
    'https://www.googleapis.com/auth/gmail.send',
  ],
});

console.log('\nThis grants Calendar, Tasks and Gmail (read, archive, drafts, send).');
console.log('If you authorized before email moved to Gmail, run this once more so the new Gmail permission is granted.');
console.log(`\n1. Make sure ${REDIRECT_URI} is an authorized redirect URI in your Google Cloud Console.`);
console.log('   → https://console.cloud.google.com/apis/credentials\n');
console.log('2. Open this URL in your browser:\n');
console.log(authUrl);
console.log('\n3. Waiting for callback...\n');

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://localhost:3333`);
  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400);
    res.end('No code parameter');
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    if (!tokens.refresh_token) {
      console.error('\n✗ No refresh_token returned. Google only returns one on first consent.');
      console.error('  Revoke access at https://myaccount.google.com/permissions and run this again.\n');
      res.writeHead(500);
      res.end('No refresh token returned — check terminal.');
      setTimeout(() => process.exit(1), 1000);
      return;
    }

    const wrote = writeRefreshToken(tokens.refresh_token);
    console.log('\n✓ Got refresh token!');
    if (wrote) {
      console.log('✓ Written to .env automatically.');
      console.log('\nNow restart assistant:');
      console.log('  npm run restart\n');
    } else {
      console.log('\n⚠ Could not find .env — add this manually:');
      console.log(`GOOGLE_CALENDAR_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    }

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<h1>Done! Token saved to .env. You can close this tab.</h1>');
  } catch (err) {
    console.error('Token exchange failed:', err);
    res.writeHead(500);
    res.end('Token exchange failed — check terminal.');
  }

  setTimeout(() => process.exit(0), 1000);
});

server.listen(3333, () => {
  console.log('Listening on http://localhost:3333/callback');
});
