// Assistant Browser Bridge — Chrome Extension (Manifest V3)
//
// Architecture: Service Worker ↔ Offscreen Document ↔ WebSocket ↔ assistant
//
// MV3 service workers get killed after 30s of inactivity, so we can't hold
// a WebSocket in the SW. Instead, the offscreen document keeps the persistent
// WS connection and relays commands to the SW via chrome.runtime messaging.

const OFFSCREEN_DOC = 'offscreen.html';

// ── Offscreen document lifecycle ──────────────────────────────────────

async function ensureOffscreen() {
  const existing = await chrome.offscreen.hasDocument();
  if (existing) return;

  await chrome.offscreen.createDocument({
    url: OFFSCREEN_DOC,
    reasons: ['WORKERS'],   // closest valid reason for a persistent connection
    justification: 'Maintain WebSocket connection to assistant server',
  });
  console.log('[assistant-bg] Offscreen document created');
}

// Keep the offscreen doc alive with a periodic alarm
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 }); // every ~24s

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'keepalive') {
    await ensureOffscreen();
  }
});

// ── Message relay: offscreen doc sends commands here, we execute & reply ──

// Pop-ups and new tabs a page opens (window.open, target=_blank), keyed by the
// tab that opened them, so a job can follow a "Manage billing" pop-up to
// Stripe instead of staring at the page it left.
const openedBy = new Map(); // sourceTabId -> [{ tabId, url, at }]
chrome.webNavigation.onCreatedNavigationTarget.addListener((d) => {
  const list = openedBy.get(d.sourceTabId) || [];
  list.push({ tabId: d.tabId, url: d.url, at: Date.now() });
  openedBy.set(d.sourceTabId, list.slice(-5));
});

/** A tab the given tab opened since it was last asked, if any (reported once). */
async function takeOpenedTab(tabId) {
  const list = openedBy.get(tabId);
  if (!list || !list.length) return null;
  openedBy.delete(tabId);
  const last = list[list.length - 1];
  try {
    const t = await chrome.tabs.get(last.tabId);
    return { tabId: t.id, url: t.url || last.url, title: t.title || '' };
  } catch {
    return null; // already closed
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'bridge_command') {
    handleAction(msg.action, msg.params || {})
      .then(async (result) => {
        // Tell the caller about a pop-up/new tab this tab just opened.
        const src = msg.params && msg.params.tabId;
        if (src && result && typeof result === 'object' && !Array.isArray(result)) {
          const opened = await takeOpenedTab(src);
          if (opened) result.openedTab = opened;
        }
        return result;
      })
      .then(result => sendResponse({ id: msg.id, result }))
      .catch(err => sendResponse({ id: msg.id, result: { error: err.message || String(err) } }));
    return true; // keep channel open for async response
  }

  if (msg.type === 'bridge_status') {
    console.log('[assistant-bg]', msg.message);
    return false;
  }
});

// ── Action handlers (same as before, run in SW context) ───────────────

async function handleAction(action, params) {
  switch (action) {
    case 'navigate':          return await doNavigate(params);
    case 'click':             return await doClick(params);
    case 'extract_text':      return await doExtractText(params);
    case 'get_page_source':   return await doGetPageSource(params);
    case 'fill_input':        return await doFillInput(params);
    case 'type_editor':       return await doTypeEditor(params);
    case 'submit_form':       return await doSubmitForm(params);
    case 'wait_for_selector': return await doWaitForSelector(params);
    case 'get_current_url':   return await doGetCurrentUrl(params);
    case 'list_tabs':         return await doListTabs(params);
    case 'switch_tab':        return await doSwitchTab(params);
    case 'close_tab':         return await doCloseTab(params);
    case 'upload_file':       return await doUploadFile(params);
    case 'snapshot':          return await doSnapshot(params);
    case 'scroll':            return await doScroll(params);
    case 'screenshot':        return await doScreenshot(params);
    case 'click_at':          return await doClickAt(params);
    case 'real_click':        return await doRealClick(params);
    case 'real_type':         return await doRealType(params);
    case 'real_key':          return await doRealKey(params);
    case 'reload_extension':  setTimeout(() => chrome.runtime.reload(), 300); return { reloading: true };
    case 'version':           return { version: chrome.runtime.getManifest().version };
    default:
      return { error: `Unknown action: ${action}` };
  }
}

async function getTab(tabId) {
  if (tabId) return await chrome.tabs.get(tabId);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) return tab;
  const all = await chrome.tabs.query({});
  if (all.length > 0) return all[0];
  throw new Error('No tabs available');
}

function waitForTabLoad(tabId, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── upload_file ──
// Inject an image (or any file) into a hidden <input type=file> — the way
// LinkedIn's post composer takes media. The DOM forbids setting input.value,
// but assigning input.files from a DataTransfer IS allowed in Chrome, so we
// decode the base64 the bridge sent into a File and hand it over, then fire the
// input/change events the composer listens for. Caller is responsible for first
// clicking the photo button so the file input exists, then passing its selector.
async function doUploadFile({ selector, base64, filename, mimeType, tabId }) {
  if (!selector || !base64) return { error: 'selector and base64 are required' };
  const tab = await getTab(tabId);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, b64, fname, mime) => {
      const input = document.querySelector(sel);
      if (!input) return { found: false };
      if (input.tagName !== 'INPUT' || input.type !== 'file') {
        return { found: true, isFileInput: false, tag: input.tagName, type: input.type };
      }
      let bytes;
      try {
        const bin = atob(b64);
        bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      } catch (e) {
        return { found: true, isFileInput: true, decoded: false, error: String(e) };
      }
      const file = new File([bytes], fname || 'image.png', { type: mime || 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, isFileInput: true, decoded: true, name: file.name, size: file.size, type: file.type, count: input.files.length };
    },
    args: [selector, base64, filename || 'image.png', mimeType || 'image/png'],
  });

  if (!result.found) return { error: `File input not found: ${selector}` };
  if (!result.isFileInput) return { error: `Element ${selector} (${result.tag}/${result.type}) is not an <input type=file>` };
  if (!result.decoded) return { error: `base64 decode failed: ${result.error}` };
  if (!result.count) return { error: 'file did not attach (input.files empty after set)' };
  await sleep(1800); // let LinkedIn render the upload/preview before the caller posts
  return { uploaded: true, name: result.name, size: result.size, type: result.type };
}

// ── navigate ──

async function doNavigate({ url, tabId, newTab }) {
  if (!url) return { error: 'url is required' };
  let tab;
  if (newTab) {
    tab = await chrome.tabs.create({ url, active: false });
  } else {
    tab = await getTab(tabId);
    await chrome.tabs.update(tab.id, { url });
  }
  const loadPromise = waitForTabLoad(tab.id, 20000);
  await loadPromise;
  await sleep(2000);
  tab = await chrome.tabs.get(tab.id);

  const [{ result: pageData }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      // Remove noise elements
      const remove = document.querySelectorAll('script, style, nav, footer, header, [role="navigation"], [role="banner"], noscript');
      remove.forEach(el => el.remove());
      const text = document.body ? document.body.innerText.substring(0, 12000) : '';

      // Extract links with their text — crucial for product searches, articles, etc.
      const links = [];
      const seen = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        const linkText = (a.innerText || a.textContent || '').trim().substring(0, 120);
        if (href && linkText.length > 2 && !seen.has(href) && href.startsWith('http') && !href.includes('javascript:')) {
          seen.add(href);
          links.push({ text: linkText, url: href });
        }
        if (links.length >= 30) break;
      }

      return { text, links };
    },
  });

  return {
    tabId: tab.id,
    title: tab.title || '',
    url: tab.url || '',
    text: pageData.text || '',
    links: pageData.links || [],
  };
}

// ── click ──

async function doClick({ selector, text, index, guard, tabId }) {
  if (!selector && !text && index == null) return { error: 'selector, text, or index is required' };
  const tab = await getTab(tabId);
  if (index != null && snapshotMaps.has(tab.id)) {
    const r = await clickSnapshotIndex(tab, index, guard);
    if (r) return finishClick(tab, r, `#${index}`);
  }

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, txt, idx, grd) => {
      const visible = (e) => {
        const r = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none';
      };
      const clickableSel = 'a, button, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="row"], [role="option"], [role="checkbox"], input, select, [onclick], [tabindex], li, tr, label, summary';
      let el = null;
      if (idx != null) el = document.querySelector(`[data-bb-idx="${idx}"]`);
      if (!el && sel) el = document.querySelector(sel);
      if (!el && txt) {
        const want = txt.trim().toLowerCase();
        // 1) a real control whose text matches
        for (const c of document.querySelectorAll('a, button, [role="button"], input[type="submit"], [onclick]')) {
          if (visible(c) && (c.textContent || c.value || '').trim().toLowerCase().includes(want)) { el = c; break; }
        }
        // 2) otherwise the smallest visible element holding that text (a list row,
        //    a div with a click handler), then its nearest clickable ancestor
        if (!el) {
          let best = null;
          for (const c of document.querySelectorAll('body *')) {
            if (c.children.length > 8) continue;
            const t = (c.innerText || '').trim().toLowerCase();
            if (!t.includes(want) || !visible(c)) continue;
            if (!best || t.length < (best.innerText || '').trim().length) best = c;
          }
          if (best) el = best.closest(clickableSel) || best;
        }
      }
      if (!el) return { found: false };
      // The caller's "never click this" rule (e.g. pay buttons), checked on the
      // element actually found, so clicking by index can't slip past it.
      const label = `${el.innerText || el.textContent || el.value || ''} ${el.getAttribute('aria-label') || ''}`;
      if (grd && new RegExp(grd, 'i').test(label)) return { found: true, refused: true, text: label.trim().slice(0, 80) };
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      // Full pointer sequence: many app frameworks ignore a bare .click().
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      return { found: true, tag: el.tagName, text: (el.innerText || el.textContent || '').trim().substring(0, 100) };
    },
    args: [selector || null, text || null, index == null ? null : Number(index), guard || null],
  });

  if (result.refused) return { error: `Refused: "${result.text}" pays or adds a card. STOP and return status "blocked" saying the site wants a card or payment.` };
  if (!result.found) return { error: `Element not found: ${index != null ? `#${index}` : selector || text}. Try snapshot to see what's clickable.` };
  await sleep(1500);
  const updatedTab = await chrome.tabs.get(tab.id);
  return { clicked: true, element: result.tag, elementText: result.text, currentUrl: updatedTab.url, currentTitle: updatedTab.title };
}

// ── snapshot: numbered list of what's visible and clickable ──

// Per tab: snapshot index → { frameId, local } so clicks reach elements inside
// embedded frames (billing portals, consent dialogs) and shadow DOM too.
const snapshotMaps = new Map();

async function doSnapshot({ tabId, limit }) {
  const tab = await getTab(tabId);
  const max = Math.min(Number(limit) || 150, 400);
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: (max) => {
      // Walk the page including open shadow roots (many modals live in one).
      const all = [];
      const walk = (root) => {
        for (const e of root.querySelectorAll('*')) {
          all.push(e);
          if (e.shadowRoot) walk(e.shadowRoot);
        }
      };
      walk(document);
      all.forEach((e) => e.removeAttribute && e.removeAttribute('data-bb-idx'));
      const clickable = (e) => e.matches('a, button, input, select, textarea, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="row"], [role="option"], [role="checkbox"], [role="radio"], [role="switch"], [onclick], [tabindex], li, tr, summary, label')
        || ((e.tagName === 'DIV' || e.tagName === 'SPAN') && getComputedStyle(e).cursor === 'pointer');
      const out = [];
      let n = 0;
      for (const e of all) {
        if (!(e instanceof HTMLElement) || !clickable(e)) continue;
        const r = e.getBoundingClientRect();
        if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.top > innerHeight * 3) continue;
        const cs = getComputedStyle(e);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        const label = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        if (!label && !['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(e.tagName)) continue;
        e.setAttribute('data-bb-idx', String(n));
        const kind = (e.getAttribute('role') || e.tagName.toLowerCase()) + (e.type ? `:${e.type}` : '');
        out.push({ local: n, line: `${kind} "${label}"${r.top > innerHeight ? ' (below)' : ''}` });
        n++;
        if (n >= max) break;
      }
      const se = document.scrollingElement;
      return { url: location.href, title: document.title, top: window === window.top, items: out,
        scroll: se ? `${Math.round(se.scrollTop)}/${Math.round(se.scrollHeight - se.clientHeight)}` : '' };
    },
    args: [max],
  });
  const map = [];
  const lines = [];
  let main = null;
  for (const fr of results) {
    const r = fr.result;
    if (!r) continue;
    if (r.top) main = r;
    if (!r.items.length) continue;
    if (!r.top) lines.push(`-- inside embedded frame: ${r.url.slice(0, 80)}`);
    for (const it of r.items) {
      if (map.length >= max) break;
      lines.push(`[${map.length}] ${it.line}`);
      map.push({ frameId: fr.frameId, local: it.local });
    }
  }
  snapshotMaps.set(tab.id, map);
  return { url: main?.url ?? tab.url, title: main?.title ?? tab.title, count: map.length, scroll: main?.scroll ?? '', items: lines.join('\n') };
}

async function clickSnapshotIndex(tab, index, guard) {
  const entry = (snapshotMaps.get(tab.id) || [])[Number(index)];
  if (!entry) return null;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [entry.frameId] },
    func: (local, grd) => {
      const click = (el, grd) => {
        if (!el) return { found: false };
        const label = `${el.innerText || el.textContent || el.value || ''} ${(el.getAttribute && el.getAttribute('aria-label')) || ''}`;
        if (grd && new RegExp(grd, 'i').test(label)) return { found: true, refused: true, text: label.trim().slice(0, 80) };
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.click();
        return { found: true, tag: el.tagName, text: (el.innerText || el.textContent || '').trim().substring(0, 100) };
      };
      const find = (root) => {
        const hit = root.querySelector(`[data-bb-idx="${local}"]`);
        if (hit) return hit;
        for (const e of root.querySelectorAll('*')) if (e.shadowRoot) { const h = find(e.shadowRoot); if (h) return h; }
        return null;
      };
      return click(find(document), grd);
    },
    args: [entry.local, guard || null],
  });
  return result;
}

// ── screenshot: what the page looks like (for screens the DOM won't explain) ──

async function doScreenshot({ tabId }) {
  const tab = await getTab(tabId);
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  await sleep(400);
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 60 });
  const [{ result: view }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => ({ w: innerWidth, h: innerHeight }) });
  // Scale to page (CSS) pixels so x,y read off the image are what click_at and
  // real_click expect, even on a 2x display.
  let base64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '');
  try {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    if (bmp.width !== view.w) {
      const canvas = new OffscreenCanvas(view.w, view.h);
      canvas.getContext('2d').drawImage(bmp, 0, 0, view.w, view.h);
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.6 });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      base64 = btoa(bin);
    }
  } catch { /* keep the original image */ }
  return { base64, width: view.w, height: view.h };
}

// ── real input: trusted mouse/keyboard events via Chrome's DevTools protocol ──
// For pages that ignore scripted clicks. Attaching shows Chrome's "being
// controlled" bar on that tab; we detach after a minute idle.

const attached = new Map(); // tabId -> detach timer

async function cdp(tabId, method, params = {}) {
  if (!attached.has(tabId)) {
    await chrome.debugger.attach({ tabId }, '1.3');
  } else {
    clearTimeout(attached.get(tabId));
  }
  attached.set(tabId, setTimeout(() => { chrome.debugger.detach({ tabId }).catch(() => {}); attached.delete(tabId); }, 60_000));
  return chrome.debugger.sendCommand({ tabId }, method, params);
}
chrome.debugger.onDetach.addListener((src) => { if (src.tabId) attached.delete(src.tabId); });

/** What's at x,y (top-level page coordinates), looking into same-tab frames: its label, for the guard. */
async function labelAt(tab, x, y) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (px, py) => {
      let el = document.elementFromPoint(px, py);
      while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(px, py); if (!inner || inner === el) break; el = inner; }
      if (!el) return { label: '' };
      if (el.tagName === 'IFRAME') { const r = el.getBoundingClientRect(); return { iframe: el.src, x: px - r.left, y: py - r.top }; }
      return { label: `${el.innerText || el.value || ''} ${el.getAttribute('aria-label') || ''}`.trim().slice(0, 120) };
    },
    args: [x, y],
  });
  if (result && result.iframe) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const fr = frames.find((f) => f.frameId !== 0 && f.url.startsWith(result.iframe.split('#')[0]));
    if (!fr) return '';
    const [{ result: inner }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [fr.frameId] },
      func: (px, py) => { const el = document.elementFromPoint(px, py); return el ? `${el.innerText || el.value || ''} ${el.getAttribute('aria-label') || ''}`.trim().slice(0, 120) : ''; },
      args: [result.x, result.y],
    });
    return inner || '';
  }
  return (result && result.label) || '';
}

/** Center of a snapshot-indexed element in top-level page coordinates. */
async function pointOfIndex(tab, index) {
  const entry = (snapshotMaps.get(tab.id) || [])[Number(index)];
  if (!entry) return null;
  const [{ result: inFrame }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id, frameIds: [entry.frameId] },
    func: (local) => {
      const find = (root) => {
        const hit = root.querySelector(`[data-bb-idx="${local}"]`);
        if (hit) return hit;
        for (const e of root.querySelectorAll('*')) if (e.shadowRoot) { const h = find(e.shadowRoot); if (h) return h; }
        return null;
      };
      const el = find(document);
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, url: location.href };
    },
    args: [entry.local],
  });
  if (!inFrame) return null;
  if (entry.frameId === 0) return { x: inFrame.x, y: inFrame.y };
  // Inside a frame: add the frame's offset in the top page.
  const [{ result: off }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (url) => {
      for (const f of document.querySelectorAll('iframe')) {
        if (f.src && url.startsWith(f.src.split('#')[0])) { const r = f.getBoundingClientRect(); return { x: r.left, y: r.top }; }
      }
      return null;
    },
    args: [inFrame.url],
  });
  return off ? { x: off.x + inFrame.x, y: off.y + inFrame.y } : null;
}

async function doRealClick({ index, x, y, guard, tabId }) {
  const tab = await getTab(tabId);
  let pt = null;
  if (index != null) pt = await pointOfIndex(tab, index);
  else if (x != null && y != null) pt = { x: Number(x), y: Number(y) };
  if (!pt) return { error: 'real_click needs an index from the last snapshot, or x,y from a screenshot.' };
  await sleep(300); // let scrollIntoView settle
  const label = await labelAt(tab, pt.x, pt.y);
  if (guard && new RegExp(guard, 'i').test(label)) {
    return { error: `Refused: "${label.slice(0, 80)}" pays or adds a card. STOP and return status "blocked" saying the site wants a card or payment.` };
  }
  const base = { x: Math.round(pt.x), y: Math.round(pt.y), button: 'left', clickCount: 1 };
  await cdp(tab.id, 'Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' });
  await cdp(tab.id, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' });
  await cdp(tab.id, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' });
  await sleep(1500);
  const t = await chrome.tabs.get(tab.id);
  return { clicked: true, real: true, at: base, elementText: label.slice(0, 100), currentUrl: t.url, currentTitle: t.title };
}

async function doRealType({ value, fieldGuard, tabId }) {
  const tab = await getTab(tabId);
  if (value == null || value === '') return { error: 'value is required' };
  // What has focus (looking into same-tab frames), checked against the caller's rule.
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id, allFrames: true },
    func: () => {
      if (!document.hasFocus()) return null;
      let el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (!el || el === document.body || el.tagName === 'IFRAME') return null;
      return `${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''} ${el.type || ''}`;
    },
  });
  const field = results.map((r) => r.result).find(Boolean) || '';
  if (fieldGuard && new RegExp(fieldGuard, 'i').test(field)) {
    return { error: 'Refused: the focused field is a card/payment field. STOP and return status "blocked" saying the site wants a card.' };
  }
  await cdp(tab.id, 'Input.insertText', { text: String(value) });
  return { typed: String(value).length, field: field.trim().slice(0, 80) };
}

async function doRealKey({ key, tabId }) {
  const tab = await getTab(tabId);
  const KEYS = { enter: ['Enter', 13], tab: ['Tab', 9], escape: ['Escape', 27], esc: ['Escape', 27], backspace: ['Backspace', 8], space: [' ', 32], arrowdown: ['ArrowDown', 40], arrowup: ['ArrowUp', 38] };
  const k = KEYS[String(key || '').toLowerCase()];
  if (!k) return { error: `key must be one of: ${Object.keys(KEYS).join(', ')}` };
  const [name, code] = k;
  await cdp(tab.id, 'Input.dispatchKeyEvent', { type: 'keyDown', key: name, windowsVirtualKeyCode: code, text: name === 'Enter' ? '\r' : name === ' ' ? ' ' : undefined });
  await cdp(tab.id, 'Input.dispatchKeyEvent', { type: 'keyUp', key: name, windowsVirtualKeyCode: code });
  await sleep(800);
  return { pressed: name };
}

// ── click_at: click whatever is at a point on the page (from a screenshot) ──

async function doClickAt({ x, y, guard, tabId }) {
  const tab = await getTab(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (px, py, grd) => {
      const click = (el, grd) => {
        if (!el) return { found: false };
        const label = `${el.innerText || el.textContent || el.value || ''} ${(el.getAttribute && el.getAttribute('aria-label')) || ''}`;
        if (grd && new RegExp(grd, 'i').test(label)) return { found: true, refused: true, text: label.trim().slice(0, 80) };
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.click();
        return { found: true, tag: el.tagName, text: (el.innerText || el.textContent || '').trim().substring(0, 100) };
      };
      let el = document.elementFromPoint(px, py);
      while (el && el.shadowRoot) { const inner = el.shadowRoot.elementFromPoint(px, py); if (!inner || inner === el) break; el = inner; }
      if (el && el.tagName === 'IFRAME') {
        const r = el.getBoundingClientRect();
        return { iframe: true, src: el.src, x: px - r.left, y: py - r.top };
      }
      return click(el, grd);
    },
    args: [Number(x), Number(y), guard || null],
  });
  if (result && result.iframe) {
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
    const fr = frames.find((f) => f.frameId !== 0 && result.src && f.url.startsWith(result.src.split('#')[0]));
    if (!fr) return { error: 'That spot is inside an embedded frame I could not reach. Try snapshot.' };
    const [{ result: inner }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [fr.frameId] },
      func: (px, py, grd) => {
        const click = (el, grd) => {
        if (!el) return { found: false };
        const label = `${el.innerText || el.textContent || el.value || ''} ${(el.getAttribute && el.getAttribute('aria-label')) || ''}`;
        if (grd && new RegExp(grd, 'i').test(label)) return { found: true, refused: true, text: label.trim().slice(0, 80) };
        if (el.scrollIntoView) el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const opts = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        el.dispatchEvent(new PointerEvent('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new PointerEvent('pointerup', opts));
        el.dispatchEvent(new MouseEvent('mouseup', opts));
        el.click();
        return { found: true, tag: el.tagName, text: (el.innerText || el.textContent || '').trim().substring(0, 100) };
      };
        return click(document.elementFromPoint(px, py), grd);
      },
      args: [result.x, result.y, guard || null],
    });
    return finishClick(tab, inner, `${x},${y}`);
  }
  return finishClick(tab, result, `${x},${y}`);
}

async function finishClick(tab, result, what) {
  if (!result || !result.found) return { error: `Nothing clickable at ${what}. Take a screenshot or snapshot again.` };
  if (result.refused) return { error: `Refused: "${result.text}" pays or adds a card. STOP and return status "blocked" saying the site wants a card or payment.` };
  await sleep(1500);
  const t = await chrome.tabs.get(tab.id);
  return { clicked: true, element: result.tag, elementText: result.text, currentUrl: t.url, currentTitle: t.title };
}

// ── scroll: the page, or the biggest scrollable list on it ──

async function doScroll({ direction, amount, selector, tabId }) {
  const tab = await getTab(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (dir, amt, sel) => {
      let box = sel ? document.querySelector(sel) : null;
      if (!box) {
        // Long lists in web apps usually scroll inside a container, not the page.
        let best = null;
        for (const e of document.querySelectorAll('body *')) {
          if (e.scrollHeight - e.clientHeight > 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) {
            if (!best || e.clientHeight * e.clientWidth > best.clientHeight * best.clientWidth) best = e;
          }
        }
        const page = document.scrollingElement;
        box = best && (!page || best.scrollHeight - best.clientHeight > page.scrollHeight - page.clientHeight) ? best : page;
      }
      const step = (amt || 1) * box.clientHeight * 0.9;
      const before = box.scrollTop;
      if (dir === 'top') box.scrollTop = 0;
      else if (dir === 'bottom') box.scrollTop = box.scrollHeight;
      else box.scrollTop += dir === 'up' ? -step : step;
      return { scrolled: Math.round(box.scrollTop - before), position: Math.round(box.scrollTop), max: Math.round(box.scrollHeight - box.clientHeight), atEnd: box.scrollTop + box.clientHeight >= box.scrollHeight - 2 };
    },
    args: [direction || 'down', Number(amount) || 1, selector || null],
  });
  await sleep(800);
  return result;
}

// ── extract_text ──

async function doExtractText({ selector, tabId }) {
  if (!selector) return { error: 'selector is required' };
  const tab = await getTab(tabId);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      const elements = document.querySelectorAll(sel);
      if (elements.length === 0) return { found: false, texts: [] };
      const texts = [];
      for (const el of Array.from(elements).slice(0, 10)) {
        const t = el.innerText || el.textContent || '';
        if (t.trim()) texts.push(t.trim());
      }
      return { found: true, count: elements.length, texts };
    },
    args: [selector],
  });

  if (!result.found) return { error: `No elements found: ${selector}` };
  const combined = result.texts.join('\n\n---\n\n');
  return { count: result.count, text: combined.substring(0, 12000), truncated: combined.length > 12000 };
}

// ── get_page_source ──

async function doGetPageSource({ tabId }) {
  const tab = await getTab(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      const html = document.documentElement.outerHTML;
      return { length: html.length, html: html.substring(0, 50000), truncated: html.length > 50000 };
    },
  });
  return result;
}

// ── fill_input ──

async function doFillInput({ selector, value, tabId }) {
  if (!selector || value === undefined) return { error: 'selector and value are required' };
  const tab = await getTab(tabId);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false };
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(el, val);
      else el.value = val;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { found: true, tag: el.tagName };
    },
    args: [selector, value],
  });

  if (!result.found) return { error: `Input not found: ${selector}` };
  return { filled: true, element: result.tag };
}

// ── type_editor ──
//
// Writes text into a contenteditable rich-text editor (LinkedIn comment boxes
// and the connection-request note are Quill/Draft editors, NOT inputs — so
// fill_input's value setter is a no-op on them). The reliable way to enter text
// such that the framework's listeners fire (and the disabled "Post"/"Send"
// button becomes enabled) is to focus the element, place the caret, and use
// execCommand('insertText'), which dispatches the native beforeinput/input
// InputEvent sequence React/Quill listen for. We also dispatch a fallback input
// event. Returns the editor's resulting text so the caller can verify the write.
async function doTypeEditor({ selector, value, tabId }) {
  if (!selector || value === undefined) return { error: 'selector and value are required' };
  const tab = await getTab(tabId);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, val) => {
      const el = document.querySelector(sel);
      if (!el) return { found: false };
      if (el.isContentEditable === false && el.getAttribute('contenteditable') !== 'true') {
        return { found: true, editable: false, tag: el.tagName };
      }
      el.focus();
      // Place the caret at the end of any existing content.
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const selObj = window.getSelection();
      selObj.removeAllRanges();
      selObj.addRange(range);
      // Primary path: execCommand fires the native input pipeline.
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, val); } catch { inserted = false; }
      if (!inserted) {
        // Fallback: set text + dispatch a synthetic InputEvent.
        el.textContent = val;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: val }));
      }
      return { found: true, editable: true, tag: el.tagName, text: (el.innerText || el.textContent || '').trim() };
    },
    args: [selector, value],
  });

  if (!result.found) return { error: `Editor not found: ${selector}` };
  if (result.editable === false) return { error: `Element ${selector} (${result.tag}) is not contenteditable — use fill_input for inputs/textareas.` };
  await sleep(800);
  return { typed: true, element: result.tag, text: result.text };
}

// ── submit_form ──

async function doSubmitForm({ selector, tabId }) {
  const tab = await getTab(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel) => {
      let form = sel ? document.querySelector(sel) : document.querySelector('form');
      if (!form) return { found: false };
      if (form.tagName === 'FORM') form.submit();
      else form.click();
      return { found: true, tag: form.tagName };
    },
    args: [selector || null],
  });

  if (!result.found) return { error: 'Form not found' };
  await sleep(2000);
  const updatedTab = await chrome.tabs.get(tab.id);
  return { submitted: true, currentUrl: updatedTab.url, currentTitle: updatedTab.title };
}

// ── wait_for_selector ──

async function doWaitForSelector({ selector, timeout, tabId }) {
  if (!selector) return { error: 'selector is required' };
  const tab = await getTab(tabId);
  const timeoutMs = timeout || 10000;
  const maxAttempts = Math.ceil(timeoutMs / 500);

  for (let i = 0; i < maxAttempts; i++) {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (sel) => {
        const el = document.querySelector(sel);
        return el ? { found: true, tag: el.tagName, text: (el.innerText || '').substring(0, 200) } : { found: false };
      },
      args: [selector],
    });
    if (result.found) return result;
    await sleep(500);
  }
  return { error: `Timeout waiting for: ${selector}` };
}

// ── get_current_url ──

async function doGetCurrentUrl({ tabId }) {
  const tab = await getTab(tabId);
  return { url: tab.url, title: tab.title };
}

// ── list_tabs ──

async function doListTabs() {
  const tabs = await chrome.tabs.query({});
  return { count: tabs.length, tabs: tabs.map(t => ({ id: t.id, title: t.title || '', url: t.url || '', active: t.active })) };
}

// ── switch_tab ──

async function doSwitchTab({ tabId }) {
  if (!tabId) return { error: 'tabId is required' };
  await chrome.tabs.update(tabId, { active: true });
  const tab = await chrome.tabs.get(tabId);
  return { switched: true, title: tab.title, url: tab.url };
}

// ── close_tab ──

async function doCloseTab({ tabId }) {
  if (!tabId) return { error: 'tabId is required' };
  try {
    await chrome.tabs.remove(tabId);
    return { closed: true };
  } catch {
    return { closed: false, error: 'Tab not found or already closed' };
  }
}

// ── Boot ──

ensureOffscreen();
console.log('[assistant-bg] Service worker started');
