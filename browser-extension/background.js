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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'bridge_command') {
    handleAction(msg.action, msg.params || {})
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

async function doClick({ selector, text, tabId }) {
  if (!selector && !text) return { error: 'selector or text is required' };
  const tab = await getTab(tabId);

  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (sel, txt) => {
      let el = null;
      if (sel) el = document.querySelector(sel);
      if (!el && txt) {
        const all = document.querySelectorAll('a, button, [role="button"], input[type="submit"], [onclick]');
        for (const c of all) {
          if (c.textContent && c.textContent.trim().toLowerCase().includes(txt.toLowerCase())) { el = c; break; }
        }
      }
      if (!el) return { found: false };
      el.click();
      return { found: true, tag: el.tagName, text: el.textContent?.trim().substring(0, 100) || '' };
    },
    args: [selector || null, text || null],
  });

  if (!result.found) return { error: `Element not found: ${selector || text}` };
  await sleep(2000);
  const updatedTab = await chrome.tabs.get(tab.id);
  return { clicked: true, element: result.tag, elementText: result.text, currentUrl: updatedTab.url, currentTitle: updatedTab.title };
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
