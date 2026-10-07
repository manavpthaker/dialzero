// Calls, bookings and website jobs asked for in the Family chat.
//
// Those run as the owner (their phone number, their Chrome and logins), so the
// Family chat can't run them itself. Instead:
//   - A family member asks in the Family chat → ask_owner records their exact
//     words and texts the owner ("👪 Sam asked: … Reply go to run it.").
//   - The owner says go in their DM → family_request approve marks it approved;
//     for 30 minutes the member's exact words count as the owner's own for
//     call_now / book_online / do_online (lib/owner-request.ts), so the usual
//     run-now path is used.
//   - The owner asks in the Family chat themselves → that is their OK; the
//     assistant starts it in the owner's DM thread right away.
//   - When the call or job finishes, the result is posted back to the Family
//     chat (only the result line, nothing else from the owner's side).

import { getMemory, setMemory, getRecentMemory, getErrand, getAction } from './db.js';
import { getOwner, getTimezone } from './config.js';
import { withLlmContext } from './lib/llm-context.js';
import { toPlainText } from './lib/plaintext.js';

const GROUP = 'family-requests';
const APPROVAL_WINDOW_MS = 30 * 60_000;
const PENDING_TTL_MS = 24 * 3600_000;

export type FamilyRequestKind = 'call' | 'booking' | 'website';
export interface FamilyRequest {
  id: string;
  requesterId: string;
  requesterName: string;
  kind: FamilyRequestKind;
  /** The requester's exact words. */
  words: string;
  /** One-line plain summary. */
  what: string;
  status: 'pending' | 'approved' | 'running' | 'done' | 'declined';
  createdAt: string;
  approvedAt?: string;
  link?: { type: 'errand' | 'action'; id: number };
  result?: string;
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function save(r: FamilyRequest): void { setMemory(GROUP, `req:${r.id}`, JSON.stringify(r)); }
export function getFamilyRequest(id: string): FamilyRequest | null {
  try { return JSON.parse(getMemory(GROUP, `req:${id}`) ?? 'null') as FamilyRequest | null; } catch { return null; }
}
export function listFamilyRequests(): FamilyRequest[] {
  return getRecentMemory(GROUP, { prefix: 'req:', limit: 50 })
    .map((e) => { try { return JSON.parse(e.value) as FamilyRequest; } catch { return null; } })
    .filter((r): r is FamilyRequest => !!r)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
export function pendingFamilyRequests(now = Date.now()): FamilyRequest[] {
  return listFamilyRequests().filter((r) => r.status === 'pending' && now - Date.parse(r.createdAt) < PENDING_TTL_MS);
}

// ── Standing OKs ("Sam can book dinners under $150 this week") ────────────────

export interface FamilyGrant {
  id: string;
  personId: string;
  personName: string;
  kinds: FamilyRequestKind[];
  /** What it covers, in the owner's words ("dinner", "the pool", "groceries"); '' = anything of these kinds. */
  about: string;
  until: string;
  maxUsd?: number;
  note: string;
  createdAt: string;
}

const STOP = new Set(['the', 'and', 'for', 'with', 'any', 'all', 'our', 'out', 'book', 'booking', 'call', 'calls', 'calling', 'website', 'stuff', 'things']);
const tokens = (t: string) => norm(t).split(' ').filter((w) => w.length >= 3 && !STOP.has(w));

export function listGrants(now = Date.now()): FamilyGrant[] {
  try {
    const all = JSON.parse(getMemory(GROUP, 'grants') ?? '[]') as FamilyGrant[];
    return all.filter((g) => Date.parse(g.until) > now);
  } catch { return []; }
}

function saveGrants(gs: FamilyGrant[]): void { setMemory(GROUP, 'grants', JSON.stringify(gs)); }

export function addGrant(g: Omit<FamilyGrant, 'id' | 'createdAt'>, now = Date.now()): FamilyGrant {
  const grant: FamilyGrant = { ...g, id: Math.random().toString(36).slice(2, 6), createdAt: new Date(now).toISOString() };
  saveGrants([...listGrants(now), grant]);
  return grant;
}

/** Revoke by id, or every grant for a person ("sam"). Returns how many were removed. */
export function revokeGrants(which: string, now = Date.now()): number {
  const w = norm(which).replace(/^#/, '');
  const all = listGrants(now);
  const keep = all.filter((g) => g.id !== w && norm(g.personName) !== w && g.personId !== w && !(w && norm(g.personName).startsWith(w)));
  saveGrants(keep);
  return all.length - keep.length;
}

/** The standing OK that covers this request, if any: same person, same kind, about matches, not expired. */
export function grantFor(requesterId: string, kind: FamilyRequestKind, words: string, now = Date.now()): FamilyGrant | null {
  const said = tokens(words);
  return listGrants(now).find((g) => {
    if (g.personId !== requesterId || !g.kinds.includes(kind)) return false;
    const want = tokens(g.about);
    if (!want.length) return true;
    // "dinner" covers "dinners"/"dinner reservation": compare word stems.
    return want.some((w) => said.some((x) => x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5))));
  }) ?? null;
}

function untilLabel(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { timeZone: getTimezone(), weekday: 'short', month: 'short', day: 'numeric' });
}

export interface FamilyRequestDeps {
  notifyOwner: (text: string, id: string) => Promise<void>;
  runOwnerTurn: (prompt: string) => Promise<string>;
  postToFamily: (text: string) => Promise<void>;
  now: () => number;
}
const defaultDeps: FamilyRequestDeps = {
  notifyOwner: async (text, id) => {
    const { sendInterrupt } = await import('./cos-outbound.js');
    // A person is waiting on the owner: the 'reply' lane.
    await sendInterrupt({ source: 'family-request', subject: `family-request:${id}`, kind: 'reply', text });
  },
  runOwnerTurn: async (prompt) => {
    const { ownerSession } = await import('./voice.js');
    const { runAgent } = await import('./agent.js');
    const s = ownerSession();
    if (!s) throw new Error('owner session not configured');
    return withLlmContext({ caller: 'family-request', lane: 'interactive', groupKey: s.group.key }, () =>
      runAgent(s.group, s.user, prompt, undefined, undefined, undefined, s.ownerHandle));
  },
  postToFamily: async (text) => {
    const chat = process.env.GROUP_FAMILY?.trim();
    if (!chat) return;
    const { sendMessage } = await import('./channels/imessage.js');
    await sendMessage(chat, text);
  },
  now: () => Date.now(),
};
let deps = defaultDeps;
export function setFamilyRequestDeps(over: Partial<FamilyRequestDeps> | null): void { deps = over ? { ...defaultDeps, ...over } : defaultDeps; }

const TOOL_FOR: Record<FamilyRequestKind, string> = { call: 'call_now', booking: 'book_online', website: 'do_online (for groceries on Instacart: instacart_cart, from_family_list true if they mean the Groceries list)' };

function runPrompt(r: FamilyRequest, grant?: FamilyGrant | null): string {
  const limits = grant
    ? ` This is covered by ${ownerFirst()}'s standing OK ("${grant.note}"). Stay inside it${grant.maxUsd ? `: nothing over $${grant.maxUsd}, and no deposit or charge without asking ${ownerFirst()}` : ''}; if it needs more than that, stop and ask ${ownerFirst()}.`
    : '';
  return `[Family chat request #${r.id}, approved] ${r.requesterName} asked in the Family chat: "${r.words}". Run it now: look up what you need (the business's real number or site with web_search), then use ${TOOL_FOR[r.kind]} with owner_request set to exactly: "${r.words}".${limits} The result is posted to the Family chat automatically. Reply to me in one short line.`;
}

/** From the Family chat. Returns the line to say there. */
const ownerFirst = () => getOwner().name.split(' ')[0] || 'the owner';

export async function requestFromFamily(input: { requesterId: string; requesterName: string; kind: FamilyRequestKind; words: string; what: string }): Promise<string> {
  const now = deps.now();
  const r: FamilyRequest = {
    id: Math.random().toString(36).slice(2, 7),
    requesterId: input.requesterId, requesterName: input.requesterName,
    kind: input.kind, words: input.words.trim().slice(0, 500), what: input.what.trim().slice(0, 200),
    status: 'pending', createdAt: new Date(now).toISOString(),
  };
  if (input.requesterId === getOwner().id) {
    // The owner's own words in the Family chat are their OK.
    r.status = 'approved'; r.approvedAt = r.createdAt;
    save(r);
    deps.runOwnerTurn(runPrompt(r)).catch((err) => console.error('[family-request] owner run failed:', err));
    return `On it: ${r.what}. I'll post what I find here.`;
  }
  // The owner already said yes to this kind of thing for this person, for now.
  const grant = grantFor(input.requesterId, input.kind, `${r.words} ${r.what}`, now);
  if (grant) {
    r.status = 'approved'; r.approvedAt = r.createdAt;
    save(r);
    deps.runOwnerTurn(runPrompt(r, grant)).catch((err) => console.error('[family-request] grant run failed:', err));
    await deps.notifyOwner(`👪 ${r.requesterName} asked: "${r.words}". Running it under your OK (${grant.note}, until ${untilLabel(grant.until)}).`, r.id).catch(() => {});
    return `On it: ${r.what}. ${ownerFirst()} already OK'd these, so I'll post what happens here.`;
  }
  save(r);
  await deps.notifyOwner(`👪 ${r.requesterName} asked in the family chat: "${r.words}". Reply go to run it, or no.`, r.id);
  return `Asked ${ownerFirst()} to OK it (${r.what}). I'll post the answer here.`;
}

/** The owner's decision, from their DM. Returns what to tell them. */
export async function decideFamilyRequest(id: string | undefined, decision: 'approve' | 'decline'): Promise<string> {
  const pending = pendingFamilyRequests(deps.now());
  const r = id ? getFamilyRequest(id) : pending.length === 1 ? pending[0] : null;
  if (!r) return pending.length ? `Which one? ${pending.map((p) => `#${p.id} ${p.what}`).join('; ')}` : 'No family request is waiting.';
  if (r.status !== 'pending') return `That one is already ${r.status}.`;
  if (decision === 'decline') {
    r.status = 'declined'; save(r);
    await deps.postToFamily(`${ownerFirst()} passed on that one (${r.what}).`).catch(() => {});
    return 'Told the family chat you passed.';
  }
  r.status = 'approved'; r.approvedAt = new Date(deps.now()).toISOString(); save(r);
  return `Approved. Now do it: ${runPrompt(r)}`;
}

/** For lib/owner-request.ts: a member's exact words, approved by the owner in the last 30 minutes, count as the owner's. */
export function approvedFamilyWords(quote: string, now = Date.now()): FamilyRequest | null {
  const q = norm(quote);
  if (q.length < 8) return null;
  return listFamilyRequests().find((r) => (r.status === 'approved' || r.status === 'running')
    && r.approvedAt && now - Date.parse(r.approvedAt) < APPROVAL_WINDOW_MS
    && norm(r.words).includes(q)) ?? null;
}

/** call_now / book_online / do_online report what they started for a family request. */
export function linkFamilyRequest(quote: string, link: { type: 'errand' | 'action'; id: number }): void {
  const r = approvedFamilyWords(quote, deps.now());
  if (!r || r.link) return;
  r.link = link; r.status = 'running'; save(r);
}

/** Post finished results back to the Family chat. Returns how many were posted. */
export async function familyRequestTick(): Promise<number> {
  let posted = 0;
  for (const r of listFamilyRequests().filter((x) => x.status === 'running' && x.link)) {
    let line: string | null = null;
    if (r.link!.type === 'errand') {
      const e = getErrand(r.link!.id);
      if (e && (e.status === 'done' || e.status === 'failed' || e.status === 'cancelled' || e.status === 'waiting')) {
        const said = e.outcome?.trim() || (e.status === 'done' ? 'done.' : e.status === 'waiting' ? `couldn't get through yet; ${ownerFirst()} has the details.` : "couldn't get an answer.");
        line = `📞 ${r.what}: ${toPlainText(said)}`;
      }
    } else {
      const a = getAction(r.link!.id);
      if (a && (a.status === 'done' || a.status === 'failed' || a.status === 'cancelled')) {
        const outcome = a.outcome ?? '';
        line = `${a.status === 'done' ? '✅' : '⚠️'} ${r.what}: ${toPlainText(String(outcome || (a.status === 'done' ? 'done.' : "it didn't go through.")))}`;
      }
    }
    if (!line) continue;
    r.status = 'done'; r.result = line.slice(0, 600); save(r);
    await deps.postToFamily(r.result).catch((err) => console.error('[family-request] post failed:', err));
    posted++;
  }
  return posted;
}

export function startFamilyRequests(): void {
  setInterval(() => { familyRequestTick().catch((err) => console.error('[family-request] tick failed:', err)); }, 60_000);
}

/** For the owner's prompt: what the family is waiting on them to OK. */
export function familyRequestBlock(now = Date.now()): string {
  const p = pendingFamilyRequests(now);
  if (!p.length) return '';
  return `--- Family chat is waiting on your OK ---\n${p.map((r) => `#${r.id} ${r.requesterName}: "${r.words}" (${r.kind})`).join('\n')}\nThe owner's "go" / "yes" / "do it" approves (family_request approve), "no" declines. Then run it as the approval result says.`;
}
