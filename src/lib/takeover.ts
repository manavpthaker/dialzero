/**
 * "Take over" for the one step only the owner can do (a login, a 2FA prompt, a
 * "prove you're human" box): the assistant brings the job's Chrome tab to the
 * front on this Mac and texts a link that opens this Mac's screen on the owner's
 * phone (the take-over page in src/takeover-server.ts, or macOS Screen Sharing
 * over Tailscale in a VNC app). They do the step, tap Done (or reply "done"),
 * and the job carries on.
 */

import { randomBytes } from 'node:crypto';
import { setMemory } from '../db.js';

/** The take-over page (src/takeover-server.ts), e.g. https://my-mac.example.ts.net:8443 (tailnet only). */
export function takeoverBase(): string {
  return (process.env.TAKEOVER_BASE_URL || '').trim().replace(/\/+$/, '');
}

export function takeoverWebEnabled(): boolean {
  return !!takeoverBase() && process.env.TAKEOVER_WEB !== 'false';
}

/** A one-time page link for this job's step (30 min), or '' when the page isn't set up. */
export function createTakeover(jobId: number, label: string, host: string | null): string {
  if (!takeoverWebEnabled()) return '';
  const token = randomBytes(18).toString('base64url');
  setMemory('takeover', token, JSON.stringify({ jobId, label: label.slice(0, 160), host, expires: Date.now() + 30 * 60_000 }));
  return `${takeoverBase()}/t/${token}`;
}

/** Fallback when the page isn't set up: e.g. vnc://100.64.0.1 for a VNC app. Empty = no link. */
export function takeoverUrl(): string {
  return (process.env.TAKEOVER_URL ?? '').trim();
}

/** Steps a person has to do on the page itself, as opposed to answering by text. */
export function needsHands(text: string): boolean {
  return /\b(log ?in|sign ?in|password|passcode|captcha|recaptcha|human|verify|verification|robot|security check|2fa|two-factor|passkey|approve (the|this) (sign|login))\b/i.test(text);
}

/** One line to add to the owner's text, or '' when there's no takeover link set up. */
export function takeoverLine(host?: string | null, job?: { id: number; label: string }): string {
  const page = job ? createTakeover(job.id, job.label, host ?? null) : '';
  if (page) return `\n🖥️ Do it from your phone: ${page} (this Mac's screen${host ? `, on ${host}` : ''}). Tap Done there when you're through.`;
  const url = takeoverUrl();
  if (!url) return '';
  return `\n🖥️ Do it from your phone: ${url} opens the Mac's screen${host ? ` (Chrome is on ${host})` : ''}. Reply "done" when you're through.`;
}

/** Put the job's tab in front so the owner lands on the right page. Best effort. */
export async function showJobTab(): Promise<void> {
  try {
    const { quietCommandInGroupTab } = await import('../tools/browser.js');
    await quietCommandInGroupTab('booking', 'switch_tab', {});
  } catch { /* no tab: they'll find it */ }
  try {
    const { execFile } = await import('node:child_process');
    execFile(process.env.OPEN_BIN || '/usr/bin/open', ['-a', 'Google Chrome'], () => {});
  } catch { /* fine */ }
}

/** The question plus the take-over line, kept under the 320-char text limit so the link is never trimmed off. */
export function withTakeover(text: string, host?: string | null, job?: { id: number; label: string }): string {
  const line = takeoverLine(host, job);
  if (!line) return text;
  const room = 315 - line.length;
  const body = text.length > room ? `${text.slice(0, room - 1).replace(/\s+\S*$/, '')}…` : text;
  return body + line;
}
