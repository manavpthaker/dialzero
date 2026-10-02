// 1Password for website jobs, through the `op` CLI with a read-only service
// account limited to one vault (OP_VAULT, default "Assistant"). Only the logins the
// owner put in that vault are reachable; banks and email stay out.
//
// Secrets never leave this process except into the page: tools/web-task.ts
// (fill_login, fill_2fa_code) fetch them here and type them with quiet bridge
// commands, and the model only ever sees "filled" or a refusal. A login is
// only used on a page whose host matches one of the item's saved URLs.

import { execFile } from 'child_process';
import { existsSync } from 'fs';

const OP_BIN = process.env.OP_BIN || '/opt/homebrew/bin/op';
const vault = () => process.env.OP_VAULT || 'Assistant';

export function onePasswordReady(): boolean {
  return !!process.env.OP_SERVICE_ACCOUNT_TOKEN && (runner !== null || existsSync(OP_BIN));
}

let runner: ((args: string[]) => Promise<string>) | null = null;
/** Tests swap in a fake `op`. */
export function setOpRunnerForTests(fn: ((args: string[]) => Promise<string>) | null): void { runner = fn; }

function op(args: string[]): Promise<string> {
  if (runner) return runner(args);
  return new Promise((resolve, reject) => {
    execFile(OP_BIN, args, {
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
      // Only what op needs: the token, HOME for its config, a plain PATH.
      env: { OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN ?? '', HOME: process.env.HOME ?? '', PATH: '/usr/bin:/bin' },
    }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).split('\n')[0].slice(0, 200)));
      else resolve(stdout);
    });
  });
}

/** example.co.uk-safe enough: the last two labels, or three for common 2-letter TLD pairs. */
export function siteOf(host: string): string {
  const parts = host.toLowerCase().replace(/^\.+|\.+$/g, '').split('.');
  const n = parts.length >= 3 && /^(co|com|org|net|ac|gov)$/.test(parts[parts.length - 2]) && parts[parts.length - 1].length === 2 ? 3 : 2;
  return parts.slice(-n).join('.');
}

export interface LoginMatch { id: string; title: string; hasTotp?: boolean }

/** The vault login whose saved URL is this page's site. No secrets. */
export async function findLoginFor(pageHost: string): Promise<LoginMatch | { error: string }> {
  if (!onePasswordReady()) return { error: '1Password is not connected on this Mac.' };
  let items: Array<{ id: string; title: string; urls?: Array<{ href: string }> }>;
  try {
    items = JSON.parse(await op(['item', 'list', '--vault', vault(), '--categories', 'Login', '--format', 'json']));
  } catch (err) {
    return { error: `1Password: ${err instanceof Error ? err.message : String(err)}` };
  }
  const want = siteOf(pageHost);
  const hits = items.filter((it) => (it.urls ?? []).some((u) => {
    try { return siteOf(new URL(u.href.includes('://') ? u.href : `https://${u.href}`).hostname) === want; } catch { return false; }
  }));
  if (!hits.length) return { error: `No login for ${want} in the ${vault()} vault.` };
  if (hits.length > 1) return { error: `More than one login for ${want} in the ${vault()} vault (${hits.map((h) => h.title).join(', ')}).` };
  return { id: hits[0].id, title: hits[0].title };
}

/** username / password of an item, for typing into the page only. */
export async function loginSecrets(id: string): Promise<{ username: string; password: string }> {
  const out = JSON.parse(await op(['item', 'get', id, '--vault', vault(), '--fields', 'label=username,label=password', '--reveal', '--format', 'json'])) as Array<{ label?: string; value?: string }>;
  const val = (l: string) => out.find((f) => (f.label ?? '').toLowerCase() === l)?.value ?? '';
  return { username: val('username'), password: val('password') };
}

/** The current 2FA code 1Password generates for an item, if it has one. */
export async function totpCode(id: string): Promise<string | null> {
  try {
    const code = (await op(['item', 'get', id, '--vault', vault(), '--otp'])).trim();
    return /^\d{6,8}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}
