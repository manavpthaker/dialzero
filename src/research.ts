// Deep, personalized research for open-ended asks: things to do, travel plans,
// where to eat, camps and classes, gifts, services. web_search stays for quick
// facts (a phone number, today's hours); this is for "help me plan".
//
// Why: activity answers from the quick search were thin and generic. It ran one
// query on the cheapest model with "find the phone number" instructions, and
// knew nothing about who was asking.
//
// Pipeline:
//   1. who's asking: a profile built from what the assistant already knows
//      (owner chats: facts about the owner, the kids, home, saved likes and
//      dislikes, their live location; Family chat: Family memory only).
//   2. plan: 3-5 targeted searches (places, this week's events, logistics,
//      reviews from people like them).
//   3. search them in parallel on the main model with the hosted web_search tool.
//   4. write one answer: real options with why each fits them, timing against
//      their window, travel time, cost, booking, sources, then a suggested plan.

import { factsAbout, searchFacts, getFactsByType, getLatestLocation, getRecentMemory, type Fact } from './db.js';
import { createOpenAIResponse, openAITextFromResponse, OPENAI_MODEL } from './lib/openai.js';
import { extractFirstJson } from './lib/daemon.js';
import { getProfileConfig, getTimezone } from './config.js';
import { tzAbbrev } from './lib/time.js';

export type ResearchKind = 'activities' | 'travel' | 'food' | 'shopping' | 'services' | 'other';
export interface ResearchInput {
  question: string;
  kind?: ResearchKind;
  when?: string;
  where?: string;
  who?: string;
  budget?: string;
  constraints?: string;
}

export interface ResearchDeps {
  /** One model call; tools: [{type:'web_search'}] when searching. */
  call: (o: { instructions: string; input: string; search: boolean; maxOutputTokens: number; reasoning: 'low' | 'medium' }) => Promise<{ text: string; urls: string[] }>;
  now: () => Date;
}

const defaultDeps: ResearchDeps = {
  call: async (o) => {
    const res = await createOpenAIResponse({
      model: process.env.OPENAI_RESEARCH_MODEL || OPENAI_MODEL,
      instructions: o.instructions,
      input: o.input,
      ...(o.search ? { tools: [{ type: 'web_search' }] } : {}),
      maxOutputTokens: o.maxOutputTokens,
      reasoningEffort: o.reasoning,
    });
    const urls = new Set<string>();
    for (const item of res.output || []) {
      if (item.type !== 'message' || !Array.isArray(item.content)) continue;
      for (const part of item.content as Array<Record<string, unknown>>) {
        for (const a of (part.annotations as Array<Record<string, unknown>> | undefined) || []) {
          if (a.type === 'url_citation' && typeof a.url === 'string') urls.add(a.url);
        }
      }
    }
    return { text: openAITextFromResponse(res), urls: [...urls] };
  },
  now: () => new Date(),
};
let deps = defaultDeps;
export function setResearchDeps(over: Partial<ResearchDeps> | null): void { deps = over ? { ...defaultDeps, ...over } : defaultDeps; }

const line = (f: Fact) => `- ${f.subject} ${f.predicate.replace(/_/g, ' ')}: ${f.object}`;

/** Owner chats: what the assistant knows that should shape the answer. Never sensitive facts. */
export function ownerProfile(input: ResearchInput, now: Date): string {
  const seen = new Set<number>();
  const keep: Fact[] = [];
  const add = (fs: Fact[]) => { for (const f of fs) if (!f.sensitive && f.active && !seen.has(f.id)) { seen.add(f.id); keep.push(f); } };
  const profile = getProfileConfig();
  const ownerFirst = profile.owner.name.split(' ')[0].toLowerCase();
  try {
    // Home and household.
    add(factsAbout(ownerFirst, 30).filter((f) => /lives|home|house|address|town|airport|car|drives|diet|allerg|vegetarian|budget|travel|vacation|likes|loves|hates|prefers/i.test(`${f.predicate} ${f.object}`)));
    // The family members named in the profile, and whoever the facts say is a
    // son/daughter/child.
    const kids = searchFacts('son daughter child kid', 12)
      .filter((f) => /\b(son|daughter|child|kid)\b/i.test(f.object) && f.subject.length < 30)
      .map((f) => f.subject);
    for (const m of new Set([...profile.members.map((x) => x.name.split(' ')[0].toLowerCase()), ...kids])) add(factsAbout(m, 15));
    // Saved likes and dislikes for this kind of thing, and anything matching the question.
    for (const s of ['how-i-like-things', 'activities', 'travel', 'food', 'restaurants', 'family', 'weekend']) add(factsAbout(s, 15));
    add(searchFacts(`${input.question} ${input.where ?? ''}`, 12));
    add(getFactsByType(['preference'], 30).filter((f) => /activit|travel|trip|hotel|flight|restaurant|food|kid|park|museum|play|beach|drive/i.test(`${f.subject} ${f.predicate} ${f.object}`)));
  } catch { /* profile is best-effort */ }
  const loc = getLatestLocation();
  const fresh = loc && now.getTime() - Date.parse(`${loc.received_at.replace(' ', 'T')}Z`) < 6 * 3600_000;
  return [
    keep.length ? `What the assistant knows about the owner and their family:\n${keep.slice(0, 40).map(line).join('\n')}` : '',
    fresh ? `The owner's phone's last location (${loc!.received_at} UTC): ${loc!.label || loc!.address || `${loc!.lat},${loc!.lon}`}` : '',
  ].filter(Boolean).join('\n\n');
}

/** Family chat: Family memory only (the Family data boundary). */
export function familyProfile(): string {
  try {
    // Same view as the Family prompt: no digest receipts or security state.
    const rows = getRecentMemory('family', { excludePrefixes: ['delivery_', 'security_', 'coordination_'], limit: 60 });
    return rows.length ? `What the Family chat has saved about the household:\n${rows.map((r) => `- ${r.key.replace(/_/g, ' ')}: ${String(r.value).slice(0, 200)}`).join('\n')}` : '';
  } catch { return ''; }
}

const KIND_GUIDE: Record<ResearchKind, string> = {
  activities: 'Cover places AND what is happening on that date (library and park calendars, museum programs, seasonal events, kid and family event listings, local town sites). Check hours against their window, age fit for the kids, indoor/outdoor vs weather, how busy, cost, and whether it needs booking.',
  travel: 'Cover: where (if not fixed) with why; how to get there (drive time from home, nearest airports and typical nonstop options, train), when to book, where to stay (neighborhoods and 2-3 specific family-friendly hotels or rentals with rough nightly prices), a day-by-day plan that fits the kids (nap/bedtime, short legs, playgrounds), food near each stop, rough total budget, and what to book now vs later. Note seasonal closures, events, and weather for the dates.',
  food: 'Cover specific places with what to order, kid-friendliness (high chairs, kids menu, noise, space), wait/reservation situation, hours for their time, price range, and distance.',
  shopping: 'Cover specific products or stores with prices, where to buy (and in stock nearby if possible), reviews from people with the same needs, and delivery timing.',
  services: 'Cover specific providers with reviews, pricing, availability, licensing where it matters, and how to book.',
  other: 'Cover the concrete options with the details someone needs to decide and act.',
};

function guessKind(q: string): ResearchKind {
  if (/\b(trips?|travel|vacation|getaway|flights?|hotels?|airbnb|itinerary|visit|weekend away|road trip|long weekend|weekend in|spring break|summer break|holiday break|staycation|fly to|drive to)\b/i.test(q)) return 'travel';
  if (/\b(eat|restaurant|dinner|lunch|brunch|breakfast|food|cafe|pizza)\b/i.test(q)) return 'food';
  if (/\b(buy|gift|present|best .* for|shop|store)\b/i.test(q)) return 'shopping';
  if (/\b(plumber|electrician|contractor|cleaner|tutor|doctor|dentist|vet|mechanic|service)\b/i.test(q)) return 'services';
  return 'activities';
}

/** The whole research run. Returns the answer text for the chat agent to reply from. */
export async function research(input: ResearchInput, opts: { family?: boolean } = {}): Promise<string> {
  const now = deps.now();
  const kind = input.kind ?? guessKind(input.question);
  const today = now.toLocaleString('en-US', { timeZone: getTimezone(), weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const profile = opts.family ? familyProfile() : ownerProfile(input, now);
  const ask = [
    `Request: ${input.question}`,
    input.when ? `When: ${input.when}` : '',
    input.where ? `Where: ${input.where}` : '',
    input.who ? `Who: ${input.who}` : '',
    input.budget ? `Budget: ${input.budget}` : '',
    input.constraints ? `Constraints: ${input.constraints}` : '',
    `Now: ${today} (${tzAbbrev()})`,
  ].filter(Boolean).join('\n');

  // 2. Plan the searches.
  let queries: string[] = [];
  try {
    const plan = await deps.call({
      instructions: `You plan web research for a personal assistant. Given the request and what is known about the person, write 3-5 web search queries that together give a complete, specific, current answer. ${KIND_GUIDE[kind]} Make queries concrete (place names, dates, ages), not generic. Include at least one query for what's happening on the specific dates if any. Reply with JSON only: {"queries": ["...", "..."]}`,
      input: `${ask}\n\n${profile || '(nothing known about the person)'}`,
      search: false, maxOutputTokens: 600, reasoning: 'low',
    });
    const json = extractFirstJson(plan.text, '{', '}');
    queries = json ? ((JSON.parse(json) as { queries?: string[] }).queries ?? []).filter((q) => typeof q === 'string' && q.trim()).slice(0, 5) : [];
  } catch (err) { console.warn('[research] planner failed:', err instanceof Error ? err.message : err); }
  if (!queries.length) queries = [input.question];

  // 3. Search in parallel.
  const findings = await Promise.all(queries.map(async (q) => {
    try {
      const r = await Promise.race([
        deps.call({
          instructions: `Research this on the web and report what you find as specific options with details: names, addresses or areas, hours (for the dates in question if given), prices, age fit, booking or reservation needs, what makes each good or bad, and recent reviews or notes. Include current events and dates when relevant. After each item put its source URL. Be thorough; list everything useful, not just one answer.`,
          input: `${q}\n\nContext: ${ask}`,
          search: true, maxOutputTokens: 2000, reasoning: 'low',
        }),
        new Promise<null>((r) => setTimeout(() => r(null), 75_000)),
      ]);
      return r ? `### Search: ${q}\n${r.text}${r.urls.length ? `\nSources: ${r.urls.slice(0, 8).join(' ')}` : ''}` : '';
    } catch (err) { console.warn(`[research] search failed (${q}):`, err instanceof Error ? err.message : err); return ''; }
  }));
  let material = findings.filter(Boolean).join('\n\n');
  if (!material) return "Research came back empty (search didn't answer). Try again in a minute, or I can do a quick search instead.";

  // 3b. Fill the gaps: prices, schedules for the dates, availability for the
  // strongest options the first round left unconfirmed.
  try {
    const gapPlan = await deps.call({
      instructions: 'You review web research before it is written up. List up to 3 follow-up web searches that would fill the most important missing details for the strongest options: prices or rates for the dates, schedules or hours on the specific days, availability, age rules. Only for details that matter to the decision. Reply with JSON only: {"queries": ["..."]} (empty list if nothing important is missing).',
      input: `${ask}\n\nRESEARCH SO FAR:\n${material.slice(0, 20_000)}`,
      search: false, maxOutputTokens: 400, reasoning: 'low',
    });
    const json = extractFirstJson(gapPlan.text, '{', '}');
    const gaps = json ? ((JSON.parse(json) as { queries?: string[] }).queries ?? []).filter((q) => typeof q === 'string' && q.trim()).slice(0, 3) : [];
    const more = await Promise.all(gaps.map(async (q) => {
      try {
        const r = await Promise.race([
          deps.call({ instructions: 'Find exactly the missing detail asked for (price, schedule, availability, rule) for the dates given, from the official site where possible. Report the number or fact with its source URL. If you cannot find it, say so.', input: `${q}\n\nContext: ${ask}`, search: true, maxOutputTokens: 1000, reasoning: 'low' }),
          new Promise<null>((r) => setTimeout(() => r(null), 60_000)),
        ]);
        return r ? `### Follow-up: ${q}\n${r.text}${r.urls.length ? `\nSources: ${r.urls.slice(0, 5).join(' ')}` : ''}` : '';
      } catch (err) { console.warn(`[research] follow-up failed (${q}):`, err instanceof Error ? err.message : err); return ''; }
    }));
    const extra = more.filter(Boolean).join('\n\n');
    if (extra) material += `\n\n${extra}`;
  } catch (err) { console.warn('[research] gap pass failed:', err instanceof Error ? err.message : err); }

  // 4. One personal answer.
  const answer = await deps.call({
    instructions: `You are ${getProfileConfig().botName}, a chief of staff who knows this family. Write the answer to their request from the research below and what you know about them.
- Personalize: use the kids' ages and interests, where they are or where home is, the date, time and weather, and their saved likes and dislikes. Say briefly why each pick fits THEM ("Sam's into fire trucks: the station open house"). Leave out anything their dislikes rule out.
- Depth: give 5-8 real options for activities/food/shopping (more for travel), each with the specifics needed to act: hours for their window, distance or drive time, cost, age fit, reservation or booking needs, and one source link. For travel, add a day-by-day plan, where to stay with rough prices, how to get there, rough total budget, and what to book now.
- Then a "Best plan" of 2-4 lines: what you'd actually do, in order, with times.
- Travel time: estimate it from where they are or home (e.g. "~15 min drive from home", "~1 hr by train"); never write "check navigation" or "not confirmed".
- Each option's source link must be the page that option came from; if you don't have one for it, leave the link off rather than reuse another option's.
- Only facts from the research; if something couldn't be confirmed (hours, price), say "check before going". Never invent.
- Plain text for a text message or email: short lines, no markdown tables, no headers with #. Bold is fine sparingly.`,
    input: `${ask}\n\n${profile || '(nothing known about them)'}\n\nRESEARCH:\n${material.slice(0, 40_000)}`,
    search: false, maxOutputTokens: 5000, reasoning: 'medium',
  });
  return answer.text.trim() || material.slice(0, 6000);
}
