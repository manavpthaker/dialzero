import { createServer, type IncomingMessage, type ServerResponse } from 'http';
import { timingSafeEqual, createHash } from 'crypto';
import { runAgent } from './agent.js';
import { resolveUser, isAllowed } from './user-resolver.js';
import { resolveGroup } from './group-resolver.js';
import { sendMessage, getDefaultRecipient } from './channels/imessage.js';
import { withLlmContext } from './lib/llm-context.js';
import { toPlainText } from './lib/plaintext.js';
import { logLocation } from './db.js';

// "Ask the assistant" voice entry point for the iOS Shortcut: Dictate Text → POST here →
// Speak Text. Runs as the owner in their DM thread, so voice and iMessage share
// one conversation history and toolset. Bound to loopback; reach it from the
// phone through `tailscale serve`, never by binding a public interface.

const PORT = Number(process.env.VOICE_PORT || 4010);
// Loopback always; add the mini's Tailscale IP to reach it without `tailscale serve`.
const HOSTS = (process.env.VOICE_HOSTS || '127.0.0.1').split(',').map((h) => h.trim()).filter(Boolean);
const TOKEN = process.env.VOICE_TOKEN?.trim() || '';
// Shortcuts gives up on slow requests, so answer by this deadline and finish
// the rest over iMessage.
const SYNC_TIMEOUT_MS = Number(process.env.VOICE_SYNC_TIMEOUT_MS || 25_000);
const MAX_BODY_BYTES = 16_000;

export const SPOKEN_PREFIX =
  '[Spoken via Siri. Reply in 1-3 short sentences that sound natural read aloud: no lists, markdown, links, or emoji.] ';

function tokenMatches(header: string | undefined): boolean {
  const given = header?.replace(/^Bearer\s+/i, '').trim() || '';
  if (!given) return false;
  // Hash both sides so lengths match for timingSafeEqual.
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(TOKEN).digest();
  return timingSafeEqual(a, b);
}

/** The owner's DM identity, shared by the Siri endpoint and phone calls (src/phone.ts). */
export function ownerSession() {
  const ownerHandle = getDefaultRecipient();
  const user = ownerHandle ? resolveUser(ownerHandle) : null;
  const group = ownerHandle ? resolveGroup(ownerHandle) : null;
  if (!ownerHandle || !user || !group || !isAllowed(user, group.key)) return null;
  return { ownerHandle, user, group };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function reply(res: ServerResponse, status: number, text: string): void {
  // Shortcuts only parses JSON from a 2xx, so errors ride a 200 with ok:false and get spoken.
  res.setHeader('X-Voice-Status', String(status));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: status < 400, reply: text }));
}

function forSpeech(text: string): string {
  return toPlainText(text).replace(/https?:\/\/\S+/g, 'a link').trim();
}

// iPhone Shortcut location ping. Accepts JSON {lat, lon, address?, label?, event?};
// Shortcuts' "Get Current Location" may also arrive as one text blob in "location".
async function handleLocation(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
  } catch {
    return reply(res, 400, 'Bad location payload.');
  }
  const num = (v: unknown) => {
    const n = Number(String(v ?? '').trim());
    return String(v ?? '').trim() && Number.isFinite(n) ? n : null;
  };
  const clip = (v: unknown, max: number) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max) || null;
  const lat = num(p.lat ?? p.latitude);
  const lon = num(p.lon ?? p.longitude);
  const address = clip(p.address ?? p.location, 300);
  const label = clip(p.label, 60);
  const event = clip(p.event, 20)?.toLowerCase() ?? null;
  if (lat === null && lon === null && !address && !label) return reply(res, 400, 'No location in that request.');
  logLocation({ lat, lon, address, label, event });
  console.log(`[voice] location ping${label ? ` (${label}${event ? `, ${event}` : ''})` : ''}`);
  return reply(res, 200, 'Got it.');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.on('finish', () => console.log(`[voice] ${req.method} ${req.url} → ${res.getHeader('X-Voice-Status')}`));
  res.on('close', () => { if (!res.writableFinished) console.warn(`[voice] ${req.method} ${req.url} closed before reply`); });
  const path = req.url?.split('?')[0];
  if (req.method !== 'POST' || (path !== '/voice' && path !== '/location')) return reply(res, 404, 'Not found.');
  if (!tokenMatches(req.headers.authorization)) {
    const given = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim() || '';
    console.warn(`[voice] bad token: header ${req.headers.authorization ? 'present' : 'missing'}, len=${given.length}, ends …${given.slice(-4)}`);
    return reply(res, 401, 'Not authorized.');
  }

  if (path === '/location') return handleLocation(req, res);

  let text = '';
  try {
    const raw = await readBody(req);
    const parsed = raw.trim().startsWith('{') ? JSON.parse(raw) : { text: raw };
    text = String(parsed.text ?? '').trim();
  } catch {
    return reply(res, 400, 'I could not read that request.');
  }
  if (!text) return reply(res, 400, "I didn't catch anything.");

  const owner = ownerSession();
  if (!owner) {
    console.error('[voice] Owner handle does not resolve to an allowed user/group');
    return reply(res, 500, 'Voice is not configured on the Mac mini.');
  }
  const { ownerHandle, user, group } = owner;

  console.log(`[voice] ${user.name}: ${text.slice(0, 80)}`);
  const llmCtx = { caller: `voice:${group.key}`, lane: 'interactive' as const, groupKey: group.key };
  const run = withLlmContext(llmCtx, () => runAgent(group, user, SPOKEN_PREFIX + text, undefined, undefined, undefined, ownerHandle));

  let timer: NodeJS.Timeout | undefined;
  const timedOut = Symbol('timeout');
  const first = await Promise.race([
    run.then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e })),
    new Promise<typeof timedOut>((r) => { timer = setTimeout(() => r(timedOut), SYNC_TIMEOUT_MS); }),
  ]);
  clearTimeout(timer);

  if (first === timedOut) {
    reply(res, 200, "I'm on it. I'll text you when it's done.");
    run
      .then((response) => sendMessage(ownerHandle, response))
      .catch((err) => sendMessage(ownerHandle, `Voice request failed: ${err instanceof Error ? err.message : String(err)}`))
      .catch((err) => console.error('[voice] follow-up send failed:', err));
    return;
  }
  if (!first.ok) {
    console.error('[voice] agent error:', first.e);
    return reply(res, 500, 'Something went wrong. Try again in a minute.');
  }
  return reply(res, 200, forSpeech(first.r) || 'Done.');
}

export function startVoice(): void {
  if (!TOKEN) {
    console.log('[voice] VOICE_TOKEN not set; voice endpoint disabled');
    return;
  }
  for (const host of HOSTS) {
    const server = createServer((req, res) => {
      handle(req, res).catch((err) => {
        console.error('[voice] handler error:', err);
        if (!res.headersSent) reply(res, 500, 'Something went wrong.');
      });
    });
    server.requestTimeout = 0; // the agent can run past Node's default; the race above bounds the reply
    server.on('error', (err) => console.error(`[voice] server error on ${host}:`, err));
    // Malformed requests (e.g. an https:// URL aimed at this plain-http port) never reach
    // handle(); log them so a Shortcut that "does nothing" is diagnosable.
    server.on('clientError', (err: NodeJS.ErrnoException, socket) => {
      console.warn(`[voice] bad request on ${host} (${err.code || err.message})`);
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    });
    server.listen(PORT, host, () => console.log(`[voice] listening on http://${host}:${PORT}/voice`));
  }
}
