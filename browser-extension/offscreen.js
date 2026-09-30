// Offscreen document — holds the persistent WebSocket to assistant.
// Relays commands to the service worker for execution, then sends results back.

const DEFAULT_WS_URL = 'ws://localhost:9222';
const RECONNECT_INTERVAL = 3000;

let ws = null;
let bridgeToken = '';
let bridgeUrl = DEFAULT_WS_URL;

async function loadConfig() {
  try {
    const stored = await chrome.storage.local.get(['bridgeUrl', 'bridgeToken']);
    if (typeof stored.bridgeUrl === 'string' && stored.bridgeUrl) bridgeUrl = stored.bridgeUrl;
    if (typeof stored.bridgeToken === 'string') bridgeToken = stored.bridgeToken;
  } catch (err) {
    console.log('[assistant-offscreen] config load error (using defaults):', err);
  }
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;

  try {
    ws = new WebSocket(bridgeUrl);
  } catch (err) {
    console.log('[assistant-offscreen] WebSocket constructor error:', err);
    setTimeout(connect, RECONNECT_INTERVAL);
    return;
  }

  ws.onopen = () => {
    console.log('[assistant-offscreen] Connected to assistant');
    // Send auth handshake if a token is configured. The server tolerates this
    // frame even when token auth is disabled (it's a no-op).
    if (bridgeToken) {
      try { ws.send(JSON.stringify({ type: 'auth', token: bridgeToken })); } catch { /* ignore */ }
    }
    chrome.runtime.sendMessage({ type: 'bridge_status', message: 'Chrome extension connected' });
  };

  ws.onmessage = async (event) => {
    let request;
    try {
      request = JSON.parse(event.data);
    } catch {
      console.error('[assistant-offscreen] Bad JSON:', event.data);
      return;
    }

    // Server-originated messages (e.g. auth_ok) don't carry an action.
    if (request && request.type && !request.action) {
      console.log(`[assistant-offscreen] server: ${request.type}`);
      return;
    }

    const { id, action, params } = request;
    console.log(`[assistant-offscreen] ← ${action}`, params);

    // Forward to service worker for execution (it has chrome.tabs/scripting access)
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'bridge_command',
        id,
        action,
        params: params || {},
      });

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id: response.id, result: response.result }));
        console.log(`[assistant-offscreen] → ${action} response sent`);
      }
    } catch (err) {
      console.error(`[assistant-offscreen] SW relay error for ${action}:`, err);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ id, result: { error: err.message || String(err) } }));
      }
    }
  };

  ws.onclose = () => {
    console.log('[assistant-offscreen] Disconnected, reconnecting in 3s...');
    ws = null;
    setTimeout(connect, RECONNECT_INTERVAL);
  };

  ws.onerror = () => {
    // onclose fires after this
  };
}

loadConfig().then(() => {
  connect();
  console.log('[assistant-offscreen] Offscreen document loaded');
});
