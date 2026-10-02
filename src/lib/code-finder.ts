// Finds a sign-in code a website just sent the owner, so a website job doesn't
// have to stop and ask them. Two places it can land:
//   - email: read through Spark (a fresh message from that company with a code)
//   - text: if the Mac is on the assistant's own Apple ID, SMS codes reach it only
//     when the owner's iPhone forwards them (a Shortcuts automation: "message
//     contains code" → send to the assistant). Those arrive as their own messages in imessage_log.
// Only codes that arrived after the job asked, from a sender or text naming
// the company, are used; the job then types it with enter_owner_code (same
// site only, single use), so the code never reaches the model.

import db from '../db.js';

export interface FoundCode { code: string; source: 'email' | 'text'; from: string }
export interface FoundLink { link: string; host: string; from: string }

// Billing and sign-in providers that send links on a company's behalf.
const PROVIDER_HOSTS = ['stripe.com', 'shopify.com', 'myshopify.com', 'shop.app', 'paddle.com', 'chargebee.com', 'recurly.com', 'chargify.com', 'auth0.com', 'okta.com'];

const CODE_WORDS = /\b(code|verification|verify|one[- ]time|otp|passcode|security|sign[- ]?in|log[- ]?in|confirm)\b/i;

/** The code in a message: digits after a code word, a 4-8 digit token in the subject, or one on its own line. */
export function codeFromText(subject: string, body: string): string | null {
  const clean = (t: string) => t.replace(/\(https?:[^)]*\)/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const s = clean(subject);
  const b = clean(body);
  // "code: 123456", "code is 123456", "your code for X is 1234-56"... the
  // first 4-8 digit number within a few words after the code word. (The old
  // pattern allowed only punctuation between, so "code is 123456" — a common
  // wording — never matched.) Letter-and-digit codes must be uppercase.
  const near = (t: string) => {
    const joined = t.replace(/(\d)[ -](?=\d)/g, '$1');
    return joined.match(/\b(?:code|passcode|otp|pin)\b.{0,48}?\b(\d{4,8})\b/i)?.[1]
      ?? joined.match(/\b(?:code|passcode|OTP|PIN)\b.{0,48}?\b((?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{6,8})\b/)?.[1];
  };
  const subjDigits = CODE_WORDS.test(s) ? s.match(/\b(\d{4,8})\b/)?.[1] : undefined;
  const alone = b.match(/^[\s#*>\[]*(\d{4,8})[\s*\]]*$/m)?.[1];
  const hit = near(s) ?? subjDigits ?? near(b) ?? alone ?? null;
  if (!hit || /^(19|20)\d{2}$/.test(hit)) return null; // a year, not a code
  return hit;
}

/** Spark search output → messages. */
export function parseSparkResults(out: string): Array<{ id: string; subject: string; from: string; to: string; date: string; body: string }> {
  return out.split(/\n\s*─{10,}\s*\n/).map((block) => {
    const field = (k: string) => block.match(new RegExp(`^\\s*${k}:\\s*(.*)$`, 'm'))?.[1]?.trim() ?? '';
    const bodyStart = block.search(/^\s*Date:.*$/m);
    const body = bodyStart >= 0 ? block.slice(bodyStart).replace(/^\s*Date:.*$/m, '') : '';
    return { id: field('ID'), subject: field('Subject'), from: field('From'), to: field('To'), date: field('Date'), body };
  }).filter((m) => m.id);
}

export interface CodeFinderDeps {
  searchEmail: (query: string, filter: string) => Promise<string>;
  ownerHandles: () => string[];
}

const defaultDeps: CodeFinderDeps = {
  // Read through whichever email source is set up (Gmail or Spark), rendered
  // in the block format parseSparkResults reads.
  searchEmail: async (query, filter) => {
    const { getEmailSource } = await import('../email/source.js');
    const src = await getEmailSource();
    if (!src) return 'Spark error: no email source configured';
    const newerThan = filter.match(/newer_than:(\S+)/)?.[1];
    const msgs = await src.search(query, { newerThan, limit: 20 });
    const local = (d: string) => { const t = new Date(d); if (Number.isNaN(t.getTime())) return d; const p = (n: number) => String(n).padStart(2, '0'); return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`; };
    return msgs.map((m) => `  ID: ${m.id}\n  Subject: ${m.subject}\n  From: ${m.from}\n  To: ${m.to}\n  Date: ${local(m.date)}\n\n${m.body || m.snippet}`).join('\n──────────────────────────────\n');
  },
  ownerHandles: () => [process.env.USER_OWNER, process.env.USER_OWNER_EMAIL].filter((h): h is string => !!h && !!h.trim()),
};
let deps = defaultDeps;
export function setCodeFinderDeps(over: Partial<CodeFinderDeps> | null): void { deps = over ? { ...defaultDeps, ...over } : defaultDeps; }

const mentions = (text: string, brands: string[]) => brands.some((b) => b.length >= 3 && text.toLowerCase().includes(b.toLowerCase()));

/** A code from email sent after `sinceMs` by (or naming) one of `brands`. */
export async function findEmailCode(brands: string[], sinceMs: number): Promise<FoundCode | null> {
  for (const brand of brands.filter((b) => b.length >= 3)) {
    let out: string;
    try { out = await deps.searchEmail(`${brand} code`, 'newer_than:1d'); } catch { continue; }
    if (/^Spark error/.test(out)) continue;
    const fresh = parseSparkResults(out)
      .filter((m) => {
        const at = Date.parse(m.date.replace(' ', 'T')); // local time, like Spark shows it
        return Number.isFinite(at) && at >= sinceMs - 2 * 60_000;
      })
      .filter((m) => mentions(`${m.from} ${m.subject}`, brands) || mentions(m.body.slice(0, 600), brands))
      .sort((a, b) => Date.parse(b.date.replace(' ', 'T')) - Date.parse(a.date.replace(' ', 'T')));
    for (const m of fresh) {
      const code = codeFromText(m.subject, m.body);
      if (code) return { code, source: 'email', from: m.from };
    }
  }
  return null;
}

/** A code text the owner forwarded to the bot (from their iPhone) after `sinceMs`. */
export function findForwardedTextCode(brands: string[], sinceMs: number): FoundCode | null {
  const handles = deps.ownerHandles().map((h) => h.replace(/[^\d+@.a-z]/gi, ''));
  if (!handles.length) return null;
  const rows = db.prepare(
    `SELECT sender, text, ts FROM imessage_log WHERE direction = 'in' AND text IS NOT NULL AND ts >= ? ORDER BY ts DESC LIMIT 20`
  ).all(new Date(sinceMs - 60_000).toISOString()) as Array<{ sender: string; text: string; ts: string }>;
  for (const r of rows) {
    const sender = r.sender.replace(/[^\d+@.a-z]/gi, '');
    if (!handles.some((h) => sender.endsWith(h.slice(-10)) || h.endsWith(sender.slice(-10)))) continue;
    if (!CODE_WORDS.test(r.text)) continue;
    const brandOk = mentions(r.text, brands);
    const code = codeFromText('', r.text);
    // A forwarded code that doesn't name the company is still their, but only
    // trust it if it's the only code they're forwarded in the window.
    if (code && (brandOk || rows.filter((x) => CODE_WORDS.test(x.text) && codeFromText('', x.text)).length === 1)) {
      return { code, source: 'text', from: 'your phone' };
    }
  }
  return null;
}

/** Look in both places, a few times, for up to `waitMs`. */
export async function findFreshCode(brands: string[], sinceMs: number, waitMs = 120_000, everyMs = 15_000): Promise<FoundCode | null> {
  const until = Date.now() + waitMs;
  for (;;) {
    const hit = findForwardedTextCode(brands, sinceMs) ?? await findEmailCode(brands, sinceMs);
    if (hit) return hit;
    if (Date.now() + everyMs > until) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** The sign-in link in an email: a link whose text or address says sign in / log in / verify. */
export function signInLinkFrom(body: string, brands: string[]): { link: string; host: string } | null {
  const links: Array<{ text: string; url: string }> = [];
  for (const m of body.matchAll(/\[([^\]]{0,80})\]\((https:\/\/[^)\s]+)\)/g)) links.push({ text: m[1], url: m[2] });
  for (const m of body.matchAll(/(?<!\()https:\/\/[^\s)<>"]+/g)) links.push({ text: '', url: m[0] });
  const SIGN = /sign[ -]?in|log[ -]?in|login|verify|magic|session|access|continue|confirm|authenticate|manage/i;
  const NOT = /unsubscribe|privacy|terms|help|support|preferences|facebook|twitter|instagram|linkedin|apps\.apple|play\.google/i;
  for (const l of links) {
    let host = '';
    try { host = new URL(l.url).hostname.toLowerCase(); } catch { continue; }
    if (NOT.test(l.url) || NOT.test(l.text)) continue;
    if (!SIGN.test(l.text) && !SIGN.test(l.url)) continue;
    const ours = brands.some((b) => b.length >= 3 && host.includes(b.toLowerCase())) || PROVIDER_HOSTS.some((p) => host === p || host.endsWith(`.${p}`));
    if (ours) return { link: l.url, host };
  }
  return null;
}

/** A sign-in link emailed after `sinceMs` by (or naming) one of `brands`. */
export async function findEmailLink(brands: string[], sinceMs: number): Promise<FoundLink | null> {
  for (const brand of brands.filter((b) => b.length >= 3)) {
    let out: string;
    try { out = await deps.searchEmail(`${brand} sign in link`, 'newer_than:1d'); } catch { continue; }
    if (/^Spark error/.test(out)) continue;
    const fresh = parseSparkResults(out)
      .filter((m) => { const at = Date.parse(m.date.replace(' ', 'T')); return Number.isFinite(at) && at >= sinceMs - 2 * 60_000; })
      .filter((m) => mentions(`${m.from} ${m.subject}`, brands) || mentions(m.body.slice(0, 600), brands))
      .sort((a, b) => Date.parse(b.date.replace(' ', 'T')) - Date.parse(a.date.replace(' ', 'T')));
    for (const m of fresh) {
      const hit = signInLinkFrom(m.body, brands);
      if (hit) return { ...hit, from: m.from };
    }
  }
  return null;
}

/** A code or a sign-in link, whichever arrives, for up to `waitMs`. */
export async function findFreshSignIn(brands: string[], sinceMs: number, waitMs = 120_000, everyMs = 15_000): Promise<{ code?: FoundCode; link?: FoundLink } | null> {
  let until = Date.now() + waitMs;
  let extended = false;
  for (;;) {
    // The email source can be unreachable for minutes at a time (a code can
    // arrive while it's down). Give it longer.
    if (!extended && await emailUnreachable()) { until = Math.max(until, Date.now() + 5 * 60_000); extended = true; }
    const code = findForwardedTextCode(brands, sinceMs) ?? await findEmailCode(brands, sinceMs);
    if (code) return { code };
    const link = await findEmailLink(brands, sinceMs);
    if (link) return { link };
    if (Date.now() + everyMs > until) return null;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

async function emailUnreachable(): Promise<boolean> {
  try {
    const out = await deps.searchEmail('code', 'newer_than:1h');
    return /^Spark error|can't access/i.test(out) && !/no email source configured/.test(out);
  } catch { return true; }
}

/** The address a company emails them at (most common To: on its mail), so a sign-in page can use it. */
export async function findAccountEmail(brands: string[]): Promise<string | null> {
  const counts = new Map<string, number>();
  for (const brand of brands.filter((b) => b.length >= 3)) {
    let out: string;
    try { out = await deps.searchEmail(brand, 'newer_than:730d'); } catch { continue; }
    if (/^Spark error/.test(out)) continue;
    for (const m of parseSparkResults(out)) {
      if (!mentions(m.from, brands)) continue;
      const addr = m.to.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/)?.[0]?.toLowerCase();
      if (addr) counts.set(addr, (counts.get(addr) ?? 0) + 1);
    }
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : null;
}
