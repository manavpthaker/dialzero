// "How they like things done": the owner's standing preferences, pulled into
// every job's prompt (website jobs, bookings, calls, email errands) so a job
// doesn't ask them something they already answered once ("transcripts, not
// audio", "always turn down offers to stay").
//
// Saved by the main agent with save_fact (fact_type preference, subject
// `how-i-like-things`, predicate = the topic) whenever they correct how
// something was done or says "always/never ...".

import { factsAbout, searchFacts, type Fact } from '../db.js';

export const PREFS_SUBJECT = 'how-i-like-things';
const MAX = 8;

/** Preferences relevant to a job, as prompt lines ("- topic: what they want"). Empty when none. */
export function preferencesFor(jobText: string): string {
  const seen = new Set<number>();
  const pick: Fact[] = [];
  const add = (f: Fact) => {
    if (seen.has(f.id) || f.sensitive || !f.active) return;
    if (!['preference', 'feedback', 'decision'].includes(f.fact_type)) return;
    seen.add(f.id);
    pick.push(f);
  };
  try {
    factsAbout(PREFS_SUBJECT, 20).forEach(add);
    if (jobText.trim()) searchFacts(jobText, 12).forEach(add);
  } catch {
    return '';
  }
  if (!pick.length) return '';
  const lines = pick.slice(0, MAX).map((f) => `- ${f.subject === PREFS_SUBJECT ? f.predicate.replace(/_/g, ' ') : `${f.subject} ${f.predicate.replace(/_/g, ' ')}`}: ${f.object}`);
  return `HOW THEY LIKE THINGS DONE (follow these; don't ask them about anything they already answer):\n${lines.join('\n')}`;
}
