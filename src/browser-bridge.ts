import { WebSocketServer, type WebSocket } from 'ws';

const PORT = parseInt(process.env.BROWSER_BRIDGE_PORT || '9222', 10);
// `new WebSocketServer({ port })` with no host lets Node bind :: — every
// interface, including the tailnet — while the startup log claimed "localhost".
// Combined with BROWSER_BRIDGE_TOKEN being optional (and unset), anything that
// could reach the port could drive Chrome, and `extensionSocket` is
// last-writer-wins so a second connection simply takes over. Chrome runs on the
// same machine as the bot, so loopback is the correct default.
// BROWSER_BRIDGE_HOST is the escape hatch for a split setup; pair any
// non-loopback value with BROWSER_BRIDGE_TOKEN and BROWSER_EXTENSION_ID.
const HOST = process.env.BROWSER_BRIDGE_HOST || '127.0.0.1';
const DEFAULT_TIMEOUT = 15000;

// Optional token-based auth. If BROWSER_BRIDGE_TOKEN is unset we run open
// (preserving the previous behavior on hosts that haven't been configured).
// When set, the extension MUST send {type:'auth', token} as its first frame.
const BRIDGE_TOKEN = process.env.BROWSER_BRIDGE_TOKEN || '';
const AUTH_TIMEOUT_MS = 5000;
const ALLOWED_EXTENSION_ID = process.env.BROWSER_EXTENSION_ID || '';

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  quiet?: boolean;
}

let wss: WebSocketServer | null = null;
let extensionSocket: WebSocket | null = null;
const pending = new Map<string, PendingRequest>();
let requestCounter = 0;

export function startBrowserBridge(): void {
  if (wss) return;

  wss = new WebSocketServer({ port: PORT, host: HOST });
  console.log(`[browser-bridge] WebSocket server listening on ws://${HOST}:${PORT}${BRIDGE_TOKEN ? ' (auth required)' : ' (no token — set BROWSER_BRIDGE_TOKEN to require auth)'}`);

  wss.on('connection', (socket, req) => {
    // Origin allowlist when a specific extension id is configured.
    if (ALLOWED_EXTENSION_ID) {
      const origin = req.headers.origin || '';
      const expected = `chrome-extension://${ALLOWED_EXTENSION_ID}`;
      if (origin && origin !== expected) {
        console.warn(`[browser-bridge] rejecting connection from unexpected origin: ${origin}`);
        socket.close(4403, 'forbidden origin');
        return;
      }
    }

    // Authentication handshake (only when a token is configured).
    let authed = !BRIDGE_TOKEN;
    let authTimer: ReturnType<typeof setTimeout> | null = null;
    if (!authed) {
      authTimer = setTimeout(() => {
        console.warn('[browser-bridge] closing connection — no auth within timeout');
        socket.close(4401, 'auth timeout');
      }, AUTH_TIMEOUT_MS);
    }

    console.log(`[browser-bridge] connection opened${authed ? '' : ' — awaiting auth'}`);

    socket.on('message', (data) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        console.error('[browser-bridge] Bad JSON from extension');
        return;
      }

      if (!authed) {
        if (msg.type === 'auth' && typeof msg.token === 'string' && msg.token === BRIDGE_TOKEN) {
          authed = true;
          if (authTimer) clearTimeout(authTimer);
          extensionSocket = socket;
          console.log('[browser-bridge] auth ok — extension connected');
          try { socket.send(JSON.stringify({ type: 'auth_ok' })); } catch { /* ignore */ }
          return;
        }
        console.warn('[browser-bridge] auth failed — closing');
        socket.close(4401, 'auth failed');
        return;
      }

      const typed = msg as { id: string; result: unknown };
      const req2 = pending.get(typed.id);
      if (!req2) {
        console.log(`[browser-bridge] stale response id=${typed.id}`);
        return;
      }

      clearTimeout(req2.timer);
      pending.delete(typed.id);

      const result = typed.result as Record<string, unknown> | undefined;
      if (result && typeof result === 'object' && 'error' in result) {
        if (!req2.quiet) console.log(`[browser-bridge] ← error: ${(result as { error: string }).error}`);
        req2.reject(new Error(result.error as string));
      } else {
        if (!req2.quiet) console.log(`[browser-bridge] ← ok ${JSON.stringify(result).slice(0, 200)}`);
        req2.resolve(result);
      }
    });

    if (authed) extensionSocket = socket;

    socket.on('close', () => {
      if (authTimer) clearTimeout(authTimer);
      console.log('[browser-bridge] Chrome extension disconnected');
      if (extensionSocket === socket) extensionSocket = null;
      // Reject all pending requests
      for (const [id, req] of pending) {
        clearTimeout(req.timer);
        req.reject(new Error('Chrome extension disconnected'));
        pending.delete(id);
      }
    });

    socket.on('error', (err) => {
      console.error('[browser-bridge] Socket error:', err.message);
    });
  });
}

export function browserBridgeStarted(): boolean {
  return wss !== null;
}

export function isBrowserConnected(): boolean {
  return extensionSocket !== null && extensionSocket.readyState === 1; // WebSocket.OPEN
}

export function sendCommand(
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs: number = DEFAULT_TIMEOUT,
  quiet = false,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!isBrowserConnected()) {
      console.log(`[browser-bridge] REJECT ${action} — not connected (socket=${extensionSocket ? 'present' : 'null'}, ready=${extensionSocket?.readyState})`);
      reject(new Error('Chrome extension not connected — open Chrome on the Mac mini'));
      return;
    }

    const id = `req_${++requestCounter}_${Date.now()}`;

    const timer = setTimeout(() => {
      pending.delete(id);
      console.log(`[browser-bridge] TIMEOUT ${action} (id=${id}) after ${timeoutMs}ms`);
      reject(new Error(`Browser command timed out after ${timeoutMs}ms: ${action}`));
    }, timeoutMs);

    pending.set(id, { resolve, reject, timer, quiet });

    if (!quiet) console.log(`[browser-bridge] → ${action}`, JSON.stringify(params).slice(0, 200));
    extensionSocket!.send(JSON.stringify({ id, action, params }));
  });
}

export function stopBrowserBridge(): void {
  if (wss) {
    wss.close();
    wss = null;
  }
  extensionSocket = null;
  for (const [id, req] of pending) {
    clearTimeout(req.timer);
    req.reject(new Error('Bridge shutting down'));
    pending.delete(id);
  }
}
