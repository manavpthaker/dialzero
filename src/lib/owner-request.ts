// "The owner already said it": lets a tool skip the go-gate when the model can
// quote the owner's own words asking for exactly this kind of action. Shared by
// call_now (tools/errands.ts), send_now (tools/send-now.ts), and book_online
// (tools/web-booking.ts).

import type { ToolContext } from '../tools/index.js';
import { getRecentMessagesWithMetadata } from '../db.js';
import { getOwner } from '../config.js';

const WINDOW_MS = 30 * 60_000;
const CALL_WORDS = /\b(call|calling|ring|phone|dial|voicemail|leave (a |them a )?(message|vm))\b/i;
const BOOKING_WORDS = /\b(book|booking|reserve|reservation|table for|appointment|appt|sign (me|us) up|get (me|us) (a|an|in))\b/i;
const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * True when `quote` is the owner's own words, from this message or one they sent
 * in the last 30 minutes, and those words match `words` (the action they asked
 * for). Only the owner's turns count; a quote the model made up, or one from
 * anyone else, fails.
 */
export function ownerAsked(quote: string, context: ToolContext | undefined, words: RegExp): boolean {
  const q = norm(quote);
  if (q.length < 8 || !words.test(quote)) return false;
  if (!context?.userId || context.userId !== getOwner().id) return false;
  const texts = [context.currentMessage ?? ''];
  const cutoff = Date.now() - WINDOW_MS;
  for (const m of getRecentMessagesWithMetadata(context.groupKey || 'admin', 20)) {
    if (m.role === 'user' && new Date(`${m.created_at.replace(' ', 'T')}Z`).getTime() >= cutoff) texts.push(m.content);
  }
  return texts.some((t) => norm(t).includes(q));
}

/** The owner's own words asking for a phone call. */
export function ownerAskedForCall(quote: string, context?: ToolContext): boolean {
  return ownerAsked(quote, context, CALL_WORDS);
}

/** The owner's own words asking for a booking, reservation, or appointment. */
export function ownerAskedForBooking(quote: string, context?: ToolContext): boolean {
  return ownerAsked(quote, context, BOOKING_WORDS);
}
