import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createConnection } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { getMemory, deleteMemory } from './db.js';
import { takeoverBase, takeoverWebEnabled } from './lib/takeover.js';
import { resumeJobById, failJobById } from './jobs.js';
import { getBotName } from './config.js';

/**
 * The take-over page: this Mac's screen in the owner's phone browser, with
 * Done / Couldn't-do-it buttons. No app: noVNC (node_modules/@novnc/novnc) in
 * the page, and this server relays its WebSocket to macOS Screen Sharing on
 * 127.0.0.1:5900 (System Settings → General → Sharing → Screen Sharing). The
 * owner signs in to the screen with their Mac login (Apple's VNC auth needs WebCrypto,
 * so the page must be HTTPS): `tailscale serve --bg --https=8443
 * http://127.0.0.1:4013` puts it on the tailnet only (8443 isn't funneled).
 *
 * Every page and socket needs a one-time token tied to one waiting job, valid
 * 30 minutes; Done resumes that job, "Couldn't do it" stops it.
 */

const PORT = Number(process.env.TAKEOVER_PORT || 4013);
const VNC_PORT = Number(process.env.TAKEOVER_VNC_PORT || 5900);
const GROUP = 'takeover';
const NOVNC_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', '@novnc', 'novnc');

interface Session { jobId: number; label: string; host: string | null; expires: number }

function session(token: string): Session | null {
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(token)) return null;
  try {
    const s = JSON.parse(getMemory(GROUP, token) ?? 'null') as Session | null;
    if (!s || s.expires < Date.now()) return null;
    return s;
  } catch { return null; }
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function page(token: string, s: Session): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>${esc(getBotName())} · your turn</title>
<style>
  :root { color-scheme: light dark; --bg:#111; --fg:#f5f5f5; --muted:#a3a3a3; --ok:#16a34a; --no:#525252; }
  * { box-sizing: border-box; }
  html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font:15px -apple-system, system-ui, sans-serif; }
  header { padding:10px 12px; display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
  header .what { flex:1 1 100%; font-weight:600; }
  header .where { color:var(--muted); font-size:13px; flex:1 1 100%; }
  button { font:inherit; border:0; border-radius:10px; padding:10px 14px; color:#fff; background:var(--no); }
  button.ok { background:var(--ok); }
  #screen { position:absolute; top:var(--top,120px); bottom:56px; left:0; right:0; background:#000; }
  #keys { position:fixed; bottom:0; left:0; right:0; display:flex; gap:6px; padding:8px; background:#1c1c1c; }
  #keys input { flex:1; min-width:0; font:inherit; padding:8px; border-radius:8px; border:1px solid #333; background:#000; color:#fff; }
  #login { position:fixed; inset:0; display:none; align-items:center; justify-content:center; background:rgba(0,0,0,.85); }
  #login form { background:#1c1c1c; padding:16px; border-radius:14px; width:min(340px, 92vw); display:grid; gap:10px; }
  #login input { font:inherit; padding:10px; border-radius:8px; border:1px solid #333; background:#000; color:#fff; }
  #msg { color:var(--muted); font-size:13px; }
</style></head><body>
<header>
  <div class="what">${esc(s.label)}</div>
  <div class="where">${s.host ? `Chrome is on ${esc(s.host)}. ` : ''}Do the step, then tap Done.</div>
  <button class="ok" id="done">Done</button><button id="fail">Couldn't do it</button>
  <span id="msg">Connecting…</span>
</header>
<div id="screen"></div>
<div id="keys"><input id="text" placeholder="Type here, then Send" autocomplete="off" autocapitalize="off" autocorrect="off"><button id="send">Send</button><button id="enter">⏎</button><button id="back">⌫</button><button id="tab">⇥</button></div>
<div id="login"><form id="lf"><div>Sign in to the Mac's screen with your Mac login.</div>
  <input id="u" placeholder="Mac username" autocomplete="username" autocapitalize="off">
  <input id="p" type="password" placeholder="Mac password" autocomplete="current-password">
  <button class="ok" type="submit">Connect</button></form></div>
<script type="module">
import RFB from '/novnc/core/rfb.js';
const token = ${JSON.stringify(token)};
const msg = (t) => { document.getElementById('msg').textContent = t; };
document.documentElement.style.setProperty('--top', document.querySelector('header').offsetHeight + 'px');
const proto = location.protocol === 'https:' ? 'wss' : 'ws';
const rfb = new RFB(document.getElementById('screen'), proto + '://' + location.host + '/ws/' + token);
rfb.scaleViewport = true;
rfb.resizeSession = false;
rfb.addEventListener('connect', () => msg('Connected'));
rfb.addEventListener('disconnect', (e) => msg(e.detail.clean ? 'Disconnected' : 'Lost the connection. Reload to try again.'));
rfb.addEventListener('credentialsrequired', () => { document.getElementById('login').style.display = 'flex'; });
document.getElementById('lf').addEventListener('submit', (e) => {
  e.preventDefault();
  document.getElementById('login').style.display = 'none';
  rfb.sendCredentials({ username: document.getElementById('u').value, password: document.getElementById('p').value });
  document.getElementById('p').value = '';
});
const key = (sym) => rfb.sendKey(sym);
document.getElementById('send').onclick = () => {
  const box = document.getElementById('text');
  for (const ch of box.value) { const c = ch.codePointAt(0); key(c < 256 ? c : 0x01000000 + c); }
  box.value = '';
};
document.getElementById('enter').onclick = () => key(0xff0d);
document.getElementById('back').onclick = () => key(0xff08);
document.getElementById('tab').onclick = () => key(0xff09);
async function finish(what) {
  msg('Sending…');
  const r = await fetch('/t/' + token + '/' + what, { method: 'POST' });
  rfb.disconnect();
  document.body.innerHTML = '<p style="padding:24px">' + (r.ok ? (what === 'done' ? 'Thanks. Picking it back up now.' : 'Okay, that job is stopped.') : 'This link has expired.') + '</p>';
}
document.getElementById('done').onclick = () => finish('done');
document.getElementById('fail').onclick = () => finish('failed');
</script></body></html>`;
}

const TYPES: Record<string, string> = { '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm' };

async function serveNovnc(path: string, res: ServerResponse): Promise<void> {
  const rel = normalize(path.replace(/^\/novnc\//, ''));
  if (rel.startsWith('..') || !/^(core|vendor)\//.test(rel) || !/\.(js|json)$/.test(rel)) { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(join(NOVNC_ROOT, rel));
    res.writeHead(200, { 'Content-Type': TYPES[rel.slice(rel.lastIndexOf('.'))] ?? 'application/octet-stream', 'Cache-Control': 'max-age=3600' }).end(body);
  } catch { res.writeHead(404).end(); }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = (req.url ?? '/').split('?')[0].replace(/^\/takeover(?=\/)/, '');
  if (req.method === 'GET' && path.startsWith('/novnc/')) return serveNovnc(path, res);
  const m = path.match(/^\/t\/([A-Za-z0-9_-]+)(?:\/(done|failed))?$/);
  const s = m ? session(m[1]) : null;
  if (!m || !s) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('This link has expired.'); return; }
  if (req.method === 'GET' && !m[2]) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end(page(m[1], s));
    return;
  }
  if (req.method === 'POST' && m[2]) {
    deleteMemory(GROUP, m[1]);
    const ok = m[2] === 'done'
      ? resumeJobById(s.jobId, 'Done: the owner finished that step on the screen. Check the page and continue.')
      : await failJobById(s.jobId);
    res.writeHead(ok ? 200 : 410).end();
    return;
  }
  res.writeHead(405).end();
}

export function startTakeoverServer(): void {
  if (!takeoverWebEnabled()) return;
  const server = createServer((req, res) => {
    handle(req, res).catch((err) => { console.error('[takeover] request failed:', err); if (!res.headersSent) res.writeHead(500).end(); });
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const token = (req.url ?? '').split('?')[0].replace(/^\/takeover(?=\/)/, '').match(/^\/ws\/([A-Za-z0-9_-]+)$/)?.[1];
    if (!token || !session(token)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const vnc = createConnection({ host: '127.0.0.1', port: VNC_PORT });
      vnc.on('data', (d) => { if (ws.readyState === ws.OPEN) ws.send(d); });
      vnc.on('close', () => ws.close());
      vnc.on('error', (err) => { console.warn('[takeover] screen sharing:', err.message); ws.close(); });
      ws.on('message', (d) => vnc.write(d as Buffer));
      ws.on('close', () => vnc.destroy());
    });
  });
  server.on('error', (err) => console.error(`[takeover] server error: ${err.message}`));
  server.listen(PORT, '127.0.0.1', () => console.log(`[takeover] page on 127.0.0.1:${PORT} (${takeoverBase()})`));
}
