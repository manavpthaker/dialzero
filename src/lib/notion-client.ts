import { parseStrEnv } from './env.js';

// Shared low-level Notion client used by the capture tool (tools/notion.ts), the
// journal (journal.ts), and later the dashboard sync. Fetch-based, no SDK.

const NOTION_TOKEN = parseStrEnv('NOTION_TOKEN', '');
const NOTION_VERSION = '2022-06-28';
const API = 'https://api.notion.com/v1';

export function notionEnabled(): boolean {
  return Boolean(NOTION_TOKEN);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tappable link to a Notion page/database. iOS auto-linkifies a bare
 * `https://www.notion.so/<id>` URL and, with the Notion app installed, a tap
 * opens it in-app. MUST be emitted bare (never markdown `[text](url)`) — the
 * channel's plaintext sanitizer strips markdown link syntax. Accepts a dashed
 * or undashed id; Notion resolves the 32-char compact form.
 */
export function notionUrl(idOrEmpty: string): string | null {
  const id = (idOrEmpty || '').replace(/-/g, '').trim();
  if (!id) return null;
  return `https://www.notion.so/${id}`;
}

export async function notionFetch(path: string, method: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!NOTION_TOKEN) throw new Error('NOTION_TOKEN not set');
  // Retry on rate-limit (429) and transient 5xx with backoff; never crash on a
  // non-JSON body (gateway HTML, empty 5xx) — that was silently aborting syncs.
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after')) || 1;
      await sleep(retryAfter * 1000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    if (text) {
      try { json = JSON.parse(text) as Record<string, unknown>; }
      catch { throw new Error(`Notion ${res.status}: non-JSON body ${text.slice(0, 120)}`); }
    }
    if (!res.ok) throw new Error(`Notion ${res.status}: ${(json.message as string) || JSON.stringify(json).slice(0, 200)}`);
    return json;
  }
  throw new Error('Notion: retries exhausted (429/5xx)');
}

export async function createPage(
  parentDatabaseId: string,
  properties: Record<string, unknown>,
  children?: unknown[],
): Promise<Record<string, unknown>> {
  return notionFetch('/pages', 'POST', {
    parent: { database_id: parentDatabaseId },
    properties,
    ...(children && children.length ? { children } : {}),
  });
}

export async function appendBlocks(blockId: string, children: unknown[]): Promise<Record<string, unknown>> {
  return notionFetch(`/blocks/${blockId}/children`, 'PATCH', { children });
}

/** Find a page in a database whose title property equals `value`. Returns page id or null. */
export async function findPageByTitle(databaseId: string, value: string): Promise<string | null> {
  const res = await notionFetch(`/databases/${databaseId}/query`, 'POST', {
    filter: { property: 'Name', title: { equals: value } },
    page_size: 1,
  });
  const rows = (res.results as Array<{ id: string }>) || [];
  return rows.length ? rows[0].id : null;
}

export interface NotionRow {
  id: string;
  properties: Record<string, unknown>;
}

/** Fetch every row of a database, following pagination. */
export async function queryDatabaseAll(databaseId: string): Promise<NotionRow[]> {
  const out: NotionRow[] = [];
  let cursor: string | undefined;
  do {
    const res = await notionFetch(`/databases/${databaseId}/query`, 'POST', {
      page_size: 100,
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    out.push(...((res.results as NotionRow[]) || []));
    cursor = res.has_more ? (res.next_cursor as string) : undefined;
  } while (cursor);
  return out;
}

export async function updatePageProps(pageId: string, properties: Record<string, unknown>): Promise<Record<string, unknown>> {
  return notionFetch(`/pages/${pageId}`, 'PATCH', { properties });
}

export async function archivePage(pageId: string): Promise<Record<string, unknown>> {
  return notionFetch(`/pages/${pageId}`, 'PATCH', { archived: true });
}

// ── Block builders (Notion-flavored) ───────────────────────────────────────────
function rt(content: string, bold = false) {
  return { type: 'text', text: { content }, annotations: { bold } };
}
export function heading2(text: string) {
  return { object: 'block', type: 'heading_2', heading_2: { rich_text: [rt(text)] } };
}
export function paragraph(text: string) {
  return { object: 'block', type: 'paragraph', paragraph: { rich_text: [rt(text)] } };
}
/** "**Label:** value" as one paragraph. */
export function labeled(label: string, value: string) {
  return {
    object: 'block',
    type: 'paragraph',
    paragraph: { rich_text: [rt(`${label}: `, true), rt(value || '—')] },
  };
}
