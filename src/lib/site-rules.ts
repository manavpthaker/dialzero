// Per-site permission levels (idea from the Personal Agent Protocol's graded
// access). The owner sets them once by text; website jobs follow them.
//   read → look only: the assistant never changes anything there (a bank, a brokerage)
//   ask  → the default: the assistant does what the owner asks, never pays on the site itself
// No rule = "ask", which is exactly how website jobs work without rules.

import { getMemory, setMemory } from '../db.js';

export type SiteLevel = 'read' | 'ask';
export interface SiteRule { site: string; level: SiteLevel; note?: string; set_at: string }

const GROUP = 'site-rules';
const KEY = 'rules';

/** "https://www.example.com/a/b", "shop.example.com", "Example" → "example". */
export function siteKey(input: string): string {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return '';
  let host = raw;
  try { host = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).hostname; } catch { /* a plain name */ }
  if (!host.includes('.')) return host.replace(/[^a-z0-9]+/g, '');
  const parts = host.replace(/^(www|web|app|smile|shop|m|account|accounts|my|secure|online)\./, '').split('.');
  // co.uk-style endings keep one more label
  const core = parts.length >= 3 && parts.at(-2)!.length <= 3 && parts.at(-1)!.length === 2 ? parts.at(-3)! : parts.at(-2) ?? parts[0];
  return core.replace(/[^a-z0-9]+/g, '');
}

export function listRules(): SiteRule[] {
  try { return JSON.parse(getMemory(GROUP, KEY) ?? '[]') as SiteRule[]; } catch { return []; }
}

export function ruleFor(siteOrUrl: string | null | undefined): SiteRule | null {
  const k = siteKey(siteOrUrl ?? '');
  if (!k) return null;
  return listRules().find((r) => r.site === k) ?? null;
}

export function setRule(site: string, level: SiteLevel, note?: string): SiteRule | { error: string } {
  const k = siteKey(site);
  if (!k) return { error: 'Which site?' };
  if (!['read', 'ask'].includes(level)) return { error: 'level must be read or ask' };
  const rule: SiteRule = { site: k, level, ...(note ? { note: note.slice(0, 200) } : {}), set_at: new Date().toISOString() };
  setMemory(GROUP, KEY, JSON.stringify([...listRules().filter((r) => r.site !== k), rule]));
  return rule;
}

export function removeRule(site: string): boolean {
  const k = siteKey(site);
  const before = listRules();
  const after = before.filter((r) => r.site !== k);
  setMemory(GROUP, KEY, JSON.stringify(after));
  return after.length !== before.length;
}

export function describeRule(r: SiteRule): string {
  return r.level === 'read' ? `${r.site}: look only, never change anything` : `${r.site}: ask (default)`;
}

/** Words that mean the job would change something on the site. */
export const CHANGE_WORDS = /\b(cancel|order|buy|purchase|pay|transfer|send|wire|withdraw|deposit|delete|close|remove|change|update|edit|submit|book|return|move|sell|trade|upgrade|downgrade|sign up|subscribe|unsubscribe|reset)\b/i;

/** Refusal for a job a site's rule doesn't allow, or null. */
export function siteRuleRefusal(site: string, task: string): string | null {
  const r = ruleFor(site);
  if (r?.level === 'read' && CHANGE_WORDS.test(task)) {
    return `The owner's rule for ${r.site} is look only, and this would change something there. Tell the owner that in one line; they can change the rule with site_permissions.`;
  }
  return null;
}

/** The rule line for a website job's prompt. */
export function siteRulePrompt(site: string): string {
  const r = ruleFor(site);
  if (!r || r.level !== 'read') return '';
  return `SITE RULE (the owner's): ${r.site} is LOOK ONLY. Read and report; never submit, change, cancel, buy or move anything there.`;
}
