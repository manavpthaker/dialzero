import { readFileSync, existsSync } from 'fs';
import { basename, resolve as resolvePath } from 'path';
import { sendCommand, isBrowserConnected } from '../browser-bridge.js';
import type { ToolDef, ToolContext } from './index.js';
import { saveFact } from '../db.js';

// Track one tab per group so concurrent sessions don't collide
const sessionTabs = new Map<string, number>();

// upload_file path allowlist: only image files under BROWSER_UPLOAD_ROOTS
// (comma-separated directories; empty = uploads disabled), so a path param can
// never read arbitrary files (e.g. .env, ~/.ssh).
const UPLOAD_ROOTS = (process.env.BROWSER_UPLOAD_ROOTS || '')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean)
  .map((r) => resolvePath(r));

function resolveUploadPath(p: string): string | null {
  const abs = resolvePath(p);
  if (!/\.(png|jpe?g)$/i.test(abs)) return null;
  if (abs.includes('..')) return null;
  return UPLOAD_ROOTS.some((root) => abs === root || abs.startsWith(root + '/')) ? abs : null;
}

const FILE_ROOTS = ['Downloads', 'Desktop', 'Documents'].map((d) => resolvePath(`${process.env.HOME}/${d}`));
const SECRET_FILE = /(^|\/)(\.env[^/]*|\.ssh|\.aws|\.gnupg|keychains?|id_rsa[^/]*|[^/]*\.(pem|key|p12|pfx|kdbx))(\/|$)/i;
/** Why these upload paths aren't allowed, or null when they're fine. */
export function checkUploadPaths(paths: unknown): string | null {
  if (!Array.isArray(paths) || !paths.length) return 'paths must be a list of files.';
  for (const raw of paths) {
    const abs = resolvePath(String(raw));
    if (abs.includes('..') || SECRET_FILE.test(abs)) return `${raw} is not allowed.`;
    const roots = [...FILE_ROOTS, ...UPLOAD_ROOTS];
    if (!roots.some((r) => abs === r || abs.startsWith(`${r}/`))) return `${raw} is outside Downloads, Desktop and Documents.`;
    if (!existsSync(abs)) return `${raw} doesn't exist.`;
  }
  return null;
}

function hostnameOf(url: string): string {
  try { return new URL(url).hostname; } catch { return 'browser_clip'; }
}

// Shared core for navigation — both `browser_action({action:'navigate'})`
// and the convenience `browser_navigate` tool flow through this.
async function navigateToUrl(url: string, groupKey: string): Promise<string> {
  if (!isBrowserConnected()) {
    return 'Chrome extension not connected — open Chrome on the Mac mini and ensure the Assistant Bridge extension is loaded.';
  }
  if (!url || typeof url !== 'string') return 'browser_navigate: missing or non-string url';

  const params: Record<string, unknown> = { url };
  const existingTabId = sessionTabs.get(groupKey);
  if (existingTabId) params.tabId = existingTabId;
  else params.newTab = true;

  try {
    const result = await sendCommand('navigate', params) as Record<string, unknown> & { tabId?: number; title?: string; url?: string; text?: string; links?: Array<{ text: string; url: string }> };
    if (typeof result?.tabId === 'number') sessionTabs.set(groupKey, result.tabId);
    const text = (result.text as string) || '';
    const truncNote = text.length >= 12000 ? '\n\n[Content truncated — page has more text]' : '';
    const links = result.links || [];
    const linkSection = links.length > 0 ? '\n\n## Links on page:\n' + links.map((l) => `- ${l.text}: ${l.url}`).join('\n') : '';
    return `Title: ${result.title}\nURL: ${result.url}\n\n${text}${truncNote}${linkSection}`;
  } catch (err) {
    if (err instanceof Error && (err.message.includes('No tab') || err.message.includes('disconnected'))) {
      sessionTabs.delete(groupKey);
    }
    return `browser_navigate failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export const browserTools: ToolDef[] = [
  {
    definition: {
      name: 'browser_action',
      description: `Control the Chrome browser on the Mac mini. Uses real Chrome with all active login sessions (LinkedIn, Gmail, Airtable, etc). Each group gets its own tab automatically.

Actions:
- navigate: Go to a URL, returns page title + text
- snapshot: A numbered list of everything visible and clickable on the page ([12] row "Sep 24 meeting"). Use it whenever you don't know what to click, then click by index.
- click: Click an element by index (from snapshot, most reliable), CSS selector, or text (matches buttons, links, list rows, anything showing that text)
- screenshot: See the page as an image. Use it when snapshot/extract_text don't explain what's on screen (a popup, a confirmation step, a canvas, an odd layout). Coordinates in the image are page coordinates for click_at.
- click_at: Click whatever is at x,y in the last screenshot (works inside embedded frames and popups). Use when there's no snapshot index for it.
- real_click: A REAL mouse click (index from snapshot, or x,y from screenshot). Use only when click/click_at did nothing: some pages ignore scripted clicks. Chrome shows a "being controlled" bar on the tab while it's used.
- real_type: Type value with the real keyboard into whatever has focus (real_click the field first). For fields that ignore fill_input.
- real_key: Press a real key: enter, tab, escape, backspace, space, arrowdown, arrowup.
- set_files: Attach files to an upload (paths = absolute file paths). Give the file input's selector, or the upload button (index or selector); the file picker is handled for you, it never opens. Only files the owner gave for this job.
- scroll: Scroll down/up/top/bottom (amount = screens, default 1). Scrolls the page's main list if it has one. Long lists load more as you scroll; snapshot again after.
- extract_text: Extract text from elements by CSS selector
- get_page_source: Get raw HTML (truncated to 50k chars)
- fill_input: Fill a real <input>/<textarea> field by selector (sets .value). NO-OP on contenteditable rich-text editors — use type_editor for those.
- type_editor: Type into a contenteditable rich-text editor (LinkedIn DM box, comment box, and connect-with-note are Quill/Draft editors, NOT inputs). Focuses the element and uses execCommand('insertText') so the framework's listeners fire and the disabled Send/Post button enables. Returns the editor's resulting text so you can verify the write. Use this for ALL LinkedIn message/comment/note entry; fall back to fill_input only if it reports the element is a plain input/textarea.
- submit_form: Submit a form by selector
- wait_for_selector: Wait for an element to appear
- get_current_url: Get active tab URL and title
- list_tabs: List all open tabs
- switch_tab: Switch to a tab by ID
- upload_file: Attach a file (image) to a hidden <input type=file> — how LinkedIn's composer takes media. First click the photo/media button so the file input exists, then call upload_file with that input's selector and the image's local PATH (e.g. the day's charter image PNG). Assistant reads the file. Params: selector, path (preferred) OR base64, optional filename/mimeType.

Logins: if the owner's password manager fills a login page, click its sign-in button. If a login page stays empty, or asks for a password, a master password, or a code, STOP and tell the owner which site needs them to log in. Never type a password or code, never guess one, and never try to open the password manager itself.`,
      input_schema: {
        type: 'object' as const,
        properties: {
          action: {
            type: 'string',
            enum: [
              'navigate', 'click', 'extract_text', 'get_page_source',
              'fill_input', 'type_editor', 'submit_form', 'wait_for_selector',
              'get_current_url', 'list_tabs', 'switch_tab', 'upload_file', 'snapshot', 'scroll', 'screenshot', 'click_at', 'real_click', 'real_type', 'real_key', 'set_files',
            ],
            description: 'The browser action to perform',
          },
          url: { type: 'string', description: 'URL to navigate to (for navigate action)' },
          selector: { type: 'string', description: 'CSS selector (for click, extract_text, fill_input, type_editor, submit_form, wait_for_selector, upload_file)' },
          text: { type: 'string', description: 'Text content to find element by (for click action, alternative to selector)' },
          index: { type: 'number', description: 'Element number from the last snapshot (for click)' },
          x: { type: 'number', description: 'For click_at: x in the last screenshot' },
          y: { type: 'number', description: 'For click_at: y in the last screenshot' },
          key: { type: 'string', description: 'For real_key: enter, tab, escape, backspace, space, arrowdown, arrowup' },
          paths: { type: 'array', items: { type: 'string' }, description: 'For set_files: absolute paths of the files to attach' },
          direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'For scroll' },
          amount: { type: 'number', description: 'Screens to scroll (for scroll, default 1)' },
          value: { type: 'string', description: 'Value to fill (for fill_input) or type (for type_editor)' },
          path: { type: 'string', description: 'Local image path to attach (for upload_file, preferred over base64) — must be a .png/.jpg under BROWSER_UPLOAD_ROOTS' },
          base64: { type: 'string', description: 'Base64-encoded file bytes (for upload_file, alternative to path)' },
          filename: { type: 'string', description: 'File name for the upload (for upload_file, e.g. "tuesday-image.png")' },
          mimeType: { type: 'string', description: 'MIME type for the upload (for upload_file, e.g. "image/png")' },
          tabId: { type: 'number', description: 'Tab ID (for switch_tab, or to target a specific tab in any action)' },
          timeout: { type: 'number', description: 'Timeout in ms (for wait_for_selector, default 10000)' },
        },
        required: ['action'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      if (!isBrowserConnected()) {
        console.log('[browser] tool called but extension not connected');
        return 'Chrome extension not connected — open Chrome on the Mac mini and ensure the Assistant Bridge extension is loaded.';
      }

      const action = input.action as string;
      const groupKey = context?.groupKey || 'default';
      const params: Record<string, unknown> = {};

      // Pass through all params except action
      for (const [k, v] of Object.entries(input)) {
        if (k !== 'action' && v !== undefined) params[k] = v;
      }

      console.log(`[browser] action=${action} group=${groupKey} input=${JSON.stringify(input).slice(0, 200)}`);

      // upload_file by PATH: read the file server-side → base64 so the agent
      // passes a small path, not a megabyte of base64 through its prompt. Guard
      // to image files under BROWSER_UPLOAD_ROOTS (no arbitrary file reads).
      if (action === 'upload_file' && typeof params.path === 'string' && !params.base64) {
        const safe = resolveUploadPath(params.path as string);
        if (!safe) return `upload_file refused: ${params.path} is not an allowed image path.`;
        try {
          params.base64 = readFileSync(safe).toString('base64');
        } catch (err) {
          return `upload_file: could not read ${safe}: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (!params.filename) params.filename = basename(safe);
        if (!params.mimeType) params.mimeType = safe.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        delete params.path;
      }

      // set_files: real files only, from the owner's usual folders, never secrets.
      if (action === 'set_files') {
        const bad = checkUploadPaths(params.paths);
        if (bad) return `set_files refused: ${bad}`;
      }

      // Auto-inject the group's tab if no explicit tabId was provided
      if (!params.tabId && action !== 'list_tabs') {
        const existingTabId = sessionTabs.get(groupKey);
        if (existingTabId) {
          params.tabId = existingTabId;
        } else if (action === 'navigate') {
          // First navigation for this group — create a new tab
          params.newTab = true;
        }
      }

      try {
        const result = await sendCommand(action, params);

        if (result && typeof result === 'object') {
          const r = result as Record<string, unknown>;

          // Track the tab ID for this group's session
          if (r.tabId && typeof r.tabId === 'number') {
            sessionTabs.set(groupKey, r.tabId as number);
          }

          // The page opened a pop-up or new tab (e.g. "Manage billing" → Stripe):
          // follow it, so the next action works where the page went.
          const opened = r.openedTab as { tabId?: number; url?: string; title?: string } | undefined;
          if (opened && typeof opened.tabId === 'number') {
            sessionTabs.set(groupKey, opened.tabId);
            delete r.openedTab;
            const note = `A new window opened (${opened.title || opened.url || 'untitled'}${opened.url ? ` — ${opened.url.split('?')[0]}` : ''}). You're now working in it; take a snapshot.`;
            return `${note}\n\n${JSON.stringify(result, null, 2)}`;
          }

          // Format navigate results nicely
          if (action === 'navigate' && r.title) {
            const text = r.text as string || '';
            const truncNote = text.length >= 12000 ? '\n\n[Content truncated — page has more text]' : '';
            const links = r.links as Array<{ text: string; url: string }> || [];
            const linkSection = links.length > 0
              ? '\n\n## Links on page:\n' + links.map(l => `- ${l.text}: ${l.url}`).join('\n')
              : '';
            return `Title: ${r.title}\nURL: ${r.url}\n\n${text}${truncNote}${linkSection}`;
          }

          // Format extract_text results
          if (action === 'extract_text' && r.text) {
            const note = r.truncated ? '\n\n[Truncated]' : '';
            return `Found ${r.count} element(s):\n\n${r.text}${note}`;
          }

          // Format get_page_source
          if (action === 'get_page_source' && r.html) {
            const note = r.truncated ? `\n\n[Truncated — full page is ${r.length} chars]` : '';
            return `${r.html}${note}`;
          }

          if (action === 'screenshot' && typeof r.base64 === 'string') {
            return [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: r.base64 } },
              { type: 'text', text: `Screenshot of the page (${r.width}×${r.height}; click_at uses these coordinates).` },
            ] as unknown as string;
          }
          if (action === 'snapshot' && typeof r.items === 'string') {
            return `${r.title}\n${r.url}\nScroll: ${r.scroll || 'n/a'} · ${r.count} clickable\n\n${r.items || '(nothing clickable found)'}`;
          }

          // Format list_tabs
          if (action === 'list_tabs' && r.tabs) {
            const tabs = r.tabs as Array<{ id: number; title: string; url: string; active: boolean }>;
            const lines = tabs.map(t => `${t.active ? '→ ' : '  '}[${t.id}] ${t.title}\n    ${t.url}`);
            return `${r.count} tab(s):\n\n${lines.join('\n\n')}`;
          }

          return JSON.stringify(result, null, 2);
        }

        return String(result);
      } catch (err) {
        // If tab was closed/crashed, clear it so next request creates a new one
        if (err instanceof Error && (err.message.includes('No tab') || err.message.includes('disconnected'))) {
          sessionTabs.delete(groupKey);
        }
        return `Browser action failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
  {
    definition: {
      name: 'browser_navigate',
      description: 'Open a URL in the group\'s Chrome tab. Convenience alias around browser_action({action:"navigate"}). USE WHEN: you have a specific URL to load (a job posting, a LinkedIn profile, a doc). Returns the page title + extracted text + on-page links.',
      input_schema: {
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: 'Full URL to open (http:// or https://)' },
        },
        required: ['url'],
      },
    },
    handler: async (input, context?: ToolContext) => {
      const { url } = input as { url: string };
      return navigateToUrl(url, context?.groupKey || 'admin');
    },
  },
  {
    definition: {
      name: 'clip_to_facts',
      description: 'Clip the currently-open browser tab into the knowledge store. Saves a clip fact (subject=domain, predicate=clipped, source_ref=URL) and returns the page text so you can structure additional facts via save_fact. USE WHEN: user says "save this", "clip this page", "remember this article", or shares a URL they want stored.',
      input_schema: {
        type: 'object' as const,
        properties: {
          subject: { type: 'string', description: 'Optional subject for the clip fact. Defaults to the page domain (e.g., "techcrunch.com").' },
          note: { type: 'string', description: 'Optional one-line note about why this is being clipped.' },
        },
        required: [],
      },
    },
    handler: async (input, context?: ToolContext) => {
      if (!isBrowserConnected()) return 'Chrome extension not connected — open Chrome on the Mac mini.';
      const groupKey = context?.groupKey || 'admin';
      const tabId = sessionTabs.get(groupKey);
      const { subject, note } = input as { subject?: string; note?: string };

      try {
        const current = await sendCommand('get_current_url', tabId ? { tabId } : {}) as { url?: string; title?: string };
        const url = current.url || '';
        const title = current.title || url || '(no title)';
        if (!url) return 'No active page to clip — navigate first or pass tabId.';

        const factId = saveFact({
          subject: subject || hostnameOf(url),
          predicate: 'clipped',
          object: note ? `${title} — ${note}` : title,
          fact_type: 'fact',
          source: 'clip',
          source_ref: url,
          group_id: groupKey,
        });

        let preview = '';
        try {
          const extract = await sendCommand('extract_text', { selector: 'body', tabId }, 10000) as { text?: string };
          preview = (extract.text || '').slice(0, 4000);
        } catch { /* extract failure is non-fatal — the clip fact is still saved */ }

        const body = preview
          ? `\n\n--- Page text (first 4000 chars) ---\n${preview}\n\nIf there are durable facts in this content, save them via save_fact with source='clip' and source_ref='${url}'.`
          : '\n\n(Could not extract page text — clip fact saved with title only.)';
        return `Clipped #${factId}: ${title}\n${url}${body}`;
      } catch (err) {
        return `clip_to_facts failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  },
];
