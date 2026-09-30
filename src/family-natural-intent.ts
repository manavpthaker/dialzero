import type { MessageRow } from './db.js';

export const FAMILY_INTENT_TTL_MS = 30 * 60 * 1000;
export const FAMILY_CORRECTION_TTL_MS = 10 * 60 * 1000;

export type FamilyIntentSurface =
  | 'calendar'
  | 'lists'
  | 'memory'
  | 'web'
  | 'instacart'
  | 'spotify';

export interface FamilyIntentContext {
  currentMessage: string;
  recentMessages?: ReadonlyArray<Pick<MessageRow, 'role' | 'content' | 'created_at'>>;
  nowMs?: number;
}

const NEGATED = /\b(?:do not|don't|dont|never|not yet|no need to|hold off|not a request|not a directive|not asking you to|do not actually|don't actually)\b/i;
const TENTATIVE = /\b(?:should we|could we|would we|what if|maybe|might|considering|thinking about|just discussing|for example|example|hypothetical|hypothetically|pretend|suppose)\b/i;
const REPORTED = /\b(?:said|says|wrote|texted|mentioned|quoted)\b/i;
// "when" and "if" are only conditions when something actually hangs on them.
// Addressed to the assistant they are politeness — "when you get a chance",
// "if you can" — and refusing those refused most of how a person asks.
const POLITE_SOFTENER = /\b(?:if|when)\s+you\s+(?:can|could|would|get|have|see|next|remember|don'?t mind)\b|\b(?:let|tell|text|ping|remind)\s+(?:me|us)\s+(?:know\s+)?when\b|\bwhenever\s+you\b|\bonce\s+(?:a|per)\s+(?:day|week|month|year)\b/i;
const CONDITIONAL = /\b(?:unless|provided(?: that)?|assuming(?: that)?|depending on|as soon as)\b|(?:^|[,;]\s*)\s*(?:if|when|once)\b|\b(?:if|when|once)\s+(?!you\b)/i;
const CONTEXT_CLAIM = /\b(?:is|was|would be|could be|might be)\s+(?:(?:just|only)\s+)?(?:(?:an?|one|the)\s+)?(?:idea|option|suggestion|possibility|example|plan|thought|worth discussing)\b/i;
// A message that opens with a household imperative is the sender asking, in
// their own voice, whatever else the sentence goes on to mention.
const DIRECT_IMPERATIVE = /^(?:please\s+)?(?:add|arrange|book|bring|buy|call|cancel|change|check|complete|create|delete|edit|find|get|grab|mail|make|mark|move|order|pack|pay|pick up|drop off|plan|play|print|put|refill|remove|reopen|reschedule|restore|schedule|send|set|start|take|text|update|wash)\b/i;
// A quoted span with an action verb inside it is someone quoting an
// instruction; a quoted name — `add "everything" bagels` — is not.
const QUOTED_DIRECTIVE = /["“][^"”\n]{0,240}\b(?:add|book|buy|cancel|create|delete|get|make|order|pick up|put|remove|schedule|send|set)\b[^"”\n]{0,240}["”]/i;
// The numeric branch covers how people actually type a date in a text — 9/4,
// 9-4, 09/04/26 — which the month-name/ordinal/ISO forms all missed, so a
// message reading "9/4 10am" contained no date as far as the gate was
// concerned. The trailing lookahead keeps a recipe fraction ("1/2 cup sugar")
// from reading as September 4th.
const NUMERIC_DATE = String.raw`\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b(?!\s*(?:c|cups?|tsp|tbsp|teaspoons?|tablespoons?|lbs?|pounds?|oz|ounces?|gallons?|quarts?|pints?|sticks?|cloves?|inch(?:es)?|ft|feet|miles?|kg|g|mg|ml|l|liters?|litres?))`;
// Weekdays get the same optional tails the months already have, so "fri" and
// "thurs" are dates like "friday" is.
const WEEKDAY = String.raw`mon(?:day)?|tue(?:s|sday)?|wed(?:s|nesday)?|thu(?:r|rs|rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?`;
const DATE_CUE = new RegExp(String.raw`\b(?:today|tomorrow|tonight|${WEEKDAY}|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec|\d{4}-\d{2}-\d{2}|${NUMERIC_DATE}|\d{1,2}(?:st|nd|rd|th))\b`, 'i');
// A spoken clock ("noon"), a colon time ("9:30"), an o'clock, or a bare hour
// after a word that can only introduce one ("at 11", "make it 11"). The old
// pattern demanded am/pm on every bare hour, so an ordinary correction like
// "make it 11 instead" contained no time at all.
const TIME_CUE = /\b(?:noon|midday|midnight)\b|\b(?:all[ -]?day|morning|afternoon|evening|between|from|at)\b.*\b\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b|\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\b\d{1,2}\s*o'?clock\b|\b(?:at|by|til|till|until|around|make it|move it to|push it to|change it to)\s+\d{1,2}\b/i;
const LOCATION_CUE = /\b(?:at|location(?: is|:)?|address(?: is|:)?)\s+[a-z0-9]/i;
// "an hour", "one hour long", "30 minutes", "1.5 hrs", "half an hour".
const DURATION_CUE = /\b(?:\d+(?:\.\d+)?|an?|one|two|three|four|five|six|half|couple(?: of)?)\s*(?:-|\s)?\s*(?:hour|hr|minute|min)s?\b|\bhalf\s+an\s+hour\b/i;

// Plain assent to something the assistant just proposed. Kept to unambiguous
// agreement: a word that merely *could* be agreement in a household thread
// ("great", "right", "please") is filler here, never the whole signal.
const STRONG_AFFIRMATIONS = [
  'yes', 'yeah', 'yep', 'yup', 'ok', 'okay', 'kk', 'sure', 'confirmed', 'confirm',
  'correct', 'do it', 'go ahead', 'go for it', 'send it', 'add it', 'create it',
  'make it', 'book it', 'schedule it', 'that works', 'works for me', 'perfect',
  'exactly', 'affirmative', 'yes please', 'please do',
];
// Deliberately absent: "sounds good" / "looks good". Elsewhere the Family gate
// reads those as someone calling an idea good rather than authorizing it
// (CONTEXT_ONLY_FAMILY_CLAIM in agent.ts), and one module should not quietly
// disagree with another about what a sentence means.
const AFFIRMATION_FILLER = [
  'please', 'thanks', 'thank you', 'and', 'then', 'also', 'great', 'cool',
  'right', 'good', 'all good', 'now', 'it',
];

/** True when the message is nothing but agreement.
 *
 * The gate used to accept only an exact `yes|ok|okay|confirmed|do it|please do`,
 * so "Yes, confirmed" — a real reply from a real thread — was refused, and the
 * refusal taught the assistant to demand a dictated sentence instead. Requiring
 * the whole message to be assent is what keeps this safe: "yes but move it to
 * Friday" still fails, because a modification is not a confirmation. */
export function isFamilyAffirmation(message: string): boolean {
  let text = String(message ?? '')
    .toLowerCase()
    .replace(/[’]/g, "'")
    // Punctuation and emoji are noise around assent, not part of it.
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return false;

  // Longest first, so "yes please" wins over "yes" and cannot leave a stray tail.
  const phrases = [...STRONG_AFFIRMATIONS, ...AFFIRMATION_FILLER]
    .sort((a, b) => b.length - a.length);
  const strong = new Set(STRONG_AFFIRMATIONS);
  let sawStrong = false;
  while (text) {
    const match = phrases.find((phrase) => text === phrase || text.startsWith(`${phrase} `));
    if (!match) return false;
    if (strong.has(match)) sawStrong = true;
    text = text.slice(match.length).trim();
  }
  return sawStrong;
}

export function normalizeFamilyIntentText(value: unknown): string {
  return typeof value === 'string'
    ? value.toLowerCase().replace(/[’]/g, "'").replace(/[^a-z0-9#@]+/g, ' ').trim()
    : '';
}

export function isUnsafeFamilyActionContext(message: string): boolean {
  const text = message.trim();
  if (!text) return true;
  if (NEGATED.test(text) || CONTEXT_CLAIM.test(text)) return true;
  if (CONDITIONAL.test(text) && !POLITE_SOFTENER.test(text)) return true;
  const directRequest = /\b(?:please|can you|could you|will you|would you)\b/i.test(text)
    || DIRECT_IMPERATIVE.test(text);
  if (TENTATIVE.test(text) && !directRequest) return true;
  // Reported speech ("Sam said…") only removes authority when the message
  // is relaying someone else's words. A plain imperative that happens to cite
  // where the item came from is still the sender asking, in their own voice.
  if (REPORTED.test(text) && !directRequest) return true;
  // A quoted span matters when it wraps a directive — that is someone quoting
  // an instruction. A quoted product name is just a product name.
  if (QUOTED_DIRECTIVE.test(text)) return true;
  return false;
}

function recentFamilyMessages(context: FamilyIntentContext, ttlMs: number) {
  const nowMs = context.nowMs ?? Date.now();
  return (context.recentMessages || []).filter((message) => {
    if (!message.created_at) return true;
    const timestamp = Date.parse(message.created_at.endsWith('Z') ? message.created_at : `${message.created_at}Z`);
    return Number.isFinite(timestamp) && timestamp >= nowMs - ttlMs && timestamp <= nowMs + 60_000;
  });
}

export function familyIntentTranscript(
  context: FamilyIntentContext,
  ttlMs = FAMILY_INTENT_TTL_MS,
): string {
  return [...recentFamilyMessages(context, ttlMs).map((message) => message.content), context.currentMessage]
    .join('\n');
}

function meaningfulTokens(value: unknown): string[] {
  const stop = new Set(['add', 'and', 'appointment', 'calendar', 'create', 'event', 'family', 'for', 'from', 'make', 'please', 'schedule', 'the', 'to', 'with']);
  return normalizeFamilyIntentText(value).split(' ').filter((token) => token.length >= 3 && !stop.has(token));
}

export function naturalTargetScore(message: string, target: unknown): number {
  const normalizedMessage = ` ${normalizeFamilyIntentText(message)} `;
  const normalizedTarget = normalizeFamilyIntentText(target);
  if (!normalizedTarget) return 0;
  if (normalizedMessage.includes(` ${normalizedTarget} `)) return 100;
  const tokens = [...new Set(meaningfulTokens(target))];
  if (tokens.length === 0) return 0;
  // "Add two playdates" is how the request gets written; "Playdate" is how the
  // event gets titled. Matching whole tokens only, those never met.
  const hits = tokens.filter((token) => {
    const forms = new Set([token, `${token}s`, `${token}es`]);
    if (token.endsWith('s')) forms.add(token.slice(0, -1));
    if (token.endsWith('es')) forms.add(token.slice(0, -2));
    return [...forms].some((form) => normalizedMessage.includes(` ${form} `));
  }).length;
  return hits === 0 ? 0 : hits / tokens.length;
}

function proposedCalendarFieldsAreGrounded(
  transcript: string,
  input: Record<string, unknown>,
): boolean {
  if (naturalTargetScore(transcript, input.title) <= 0) return false;
  if (input.location && naturalTargetScore(transcript, input.location) < 100) return false;
  if (input.description) {
    const descriptionTokens = meaningfulTokens(input.description);
    const transcriptText = ` ${normalizeFamilyIntentText(transcript)} `;
    if (descriptionTokens.length > 0
      && descriptionTokens.filter((token) => transcriptText.includes(` ${token} `)).length / descriptionTokens.length < 0.5) {
      return false;
    }
  }
  if (input.date && !DATE_CUE.test(transcript)) return false;
  const timeIsGrounded = (value: unknown): boolean => {
    if (typeof value !== 'string' || !/^(\d{2}):(\d{2})$/.test(value)) return false;
    const [hour, minute] = value.split(':').map(Number);
    const twelveHour = hour % 12 || 12;
    const suffix = hour >= 12 ? 'pm' : 'am';
    const candidates = [
      `${value}`,
      // The unpadded form: a transcript says "9:30", never "09:30", so every
      // single-digit hour used to be ungroundable while 10:30 was fine.
      `${twelveHour}:${String(minute).padStart(2, '0')}`,
      `${twelveHour}:${String(minute).padStart(2, '0')} ${suffix}`,
      `${twelveHour}:${String(minute).padStart(2, '0')}${suffix}`,
      ...(minute === 0 ? [`${twelveHour} ${suffix}`, `${twelveHour}${suffix}`, `${twelveHour} o'clock`, `${twelveHour} oclock`] : []),
    ];
    const compactTranscript = transcript.toLowerCase().replace(/\s+/g, ' ');
    if (candidates.some((candidate) => compactTranscript.includes(candidate))) return true;
    // People say "noon", not "12:00". Word-bounded so "afternoon" is not noon.
    if (value === '12:00' && /\b(?:noon|midday)\b/i.test(compactTranscript)) return true;
    if (value === '00:00' && /\bmidnight\b/i.test(compactTranscript)) return true;
    if (minute !== 0) return false;
    // A written range grounds the hour on either end. "10 to 11am" and
    // "10 - 11am" are the same sentence; only the dash form used to count.
    const SEPARATOR = String.raw`(?:\s*[-–—]\s*|\s+(?:to|til|till|until|thru|through)\s+)`;
    if (new RegExp(String.raw`\b${twelveHour}${SEPARATOR}\d{1,2}\s*${suffix}\b`, 'i').test(compactTranscript)) return true;
    if (new RegExp(String.raw`\b\d{1,2}\s*${suffix}${SEPARATOR}${twelveHour}\s*${suffix}\b`, 'i').test(compactTranscript)) return true;
    // "11-1pm" means 11am to 1pm: the meridiem is written once, on the far end,
    // and the range crosses noon. Only an am start may borrow a pm end.
    if (suffix === 'am') {
      const crossesNoon = compactTranscript.match(new RegExp(String.raw`\b${twelveHour}${SEPARATOR}(\d{1,2})\s*pm\b`, 'i'));
      if (crossesNoon && Number(crossesNoon[1]) < twelveHour) return true;
    }
    return false;
  };
  if (input.start_time && !timeIsGrounded(input.start_time)) return false;
  // An end time is often agreed as a LENGTH rather than a clock time — the bot
  // asks "should I make each one an hour?", the answer is "yes", and 11:00
  // then appears nowhere in the thread. Requiring it literally refused the
  // whole event over a detail both people had just settled. A discussed
  // duration counts as evidence, provided the start is itself grounded and
  // the result is a sane same-day span.
  if (input.end_time && !timeIsGrounded(input.end_time)) {
    const endsAfterGroundedStart = (): boolean => {
      const start = typeof input.start_time === 'string' ? input.start_time : '';
      const end = typeof input.end_time === 'string' ? input.end_time : '';
      if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end)) return false;
      if (!timeIsGrounded(start)) return false;
      const minutes = (value: string) => {
        const [hour, minute] = value.split(':').map(Number);
        return (hour * 60) + minute;
      };
      const span = minutes(end) - minutes(start);
      return span > 0 && span <= 12 * 60;
    };
    if (!DURATION_CUE.test(transcript) || !endsAfterGroundedStart()) return false;
  }
  if (input.all_day === true && !/\ball[ -]?day\b/i.test(transcript)) return false;
  return true;
}

export function authorizeNaturalCalendarCreate(
  context: FamilyIntentContext,
  input: Record<string, unknown>,
): boolean {
  if (isUnsafeFamilyActionContext(context.currentMessage)) return false;
  if (/^(?:task|to[ -]?do)\s*:/i.test(context.currentMessage)
    || /\b(?:to|on|in)\s+(?:the\s+)?(?:family tasks?|groceries|errands|[a-z0-9 -]+ list)\b/i.test(context.currentMessage)) {
    return false;
  }
  const recent = recentFamilyMessages(context, FAMILY_INTENT_TTL_MS);
  const transcript = familyIntentTranscript(context);
  const isCalendarStart = (message: string) =>
    /\b(?:add|arrange|book|block|create|make|plan|put|schedule|send|set up)\b/i.test(message)
      // Plurals matter: "Add two eye appointments" is the normal way to ask,
      // and \bappointment\b does not match "appointments".
      && (/\b(?:calendars?|events?|appointments?|appts?|invitations?|invites?|meetings?)\b/i.test(message)
        || (DATE_CUE.test(message) && TIME_CUE.test(message)));
  if (isCalendarStart(context.currentMessage)) {
    return proposedCalendarFieldsAreGrounded(context.currentMessage, input);
  }
  // Collapse a re-ask to one start. Requiring EXACTLY one match meant asking
  // twice — which is what a person does after a refusal — locked the natural
  // path for the rest of the half hour, and so did wanting two of the same
  // kind of appointment in one sitting.
  const byText = new Map<string, string>();
  for (const message of recent) {
    if (message.role !== 'user') continue;
    if (!isCalendarStart(message.content)) continue;
    if (naturalTargetScore(message.content, input.title) <= 0) continue;
    byText.set(normalizeFamilyIntentText(message.content), message.content);
  }
  const sessionStarts = [...byText.values()];
  if (sessionStarts.length === 0 || !proposedCalendarFieldsAreGrounded(transcript, input)) return false;
  if (sessionStarts.length > 1) {
    // Several distinct requests are open. Authorize only when the proposal
    // belongs to exactly one of them, so a single "yes" still cannot invent a
    // detail that no one request supports.
    const owning = sessionStarts.filter((start) =>
      proposedCalendarFieldsAreGrounded(`${start}\n${context.currentMessage}`, input));
    if (owning.length !== 1) return false;
  }
  const currentContributes = DATE_CUE.test(context.currentMessage)
    || TIME_CUE.test(context.currentMessage)
    || LOCATION_CUE.test(context.currentMessage)
    || DURATION_CUE.test(context.currentMessage)
    || naturalTargetScore(context.currentMessage, input.title) > 0
    // Answering "where?" with nothing but the address: the proposed location
    // has to appear in this message verbatim, and be more than one word.
    || (typeof input.location === 'string'
      && input.location.trim().split(/\s+/).length > 1
      && naturalTargetScore(context.currentMessage, input.location) === 100)
    || isFamilyAffirmation(context.currentMessage);
  return currentContributes;
}

export function authorizeNaturalCalendarUpdate(
  context: FamilyIntentContext,
  input: Record<string, unknown>,
): boolean {
  if (isUnsafeFamilyActionContext(context.currentMessage)) return false;
  const eventId = typeof input.event_id === 'string' ? input.event_id.trim() : '';
  if (!eventId) return false;
  const recent = recentFamilyMessages(context, FAMILY_CORRECTION_TTL_MS);
  const eventWasRecentlyCreated = recent.some((message) =>
    message.role === 'assistant'
      && message.content.includes(`[event_id:${eventId}]`)
      && /\b(?:created|updated)\b/i.test(message.content),
  );
  const directUpdate = /\b(?:change|correct|edit|make that|move|reschedule|set|update)\b/i.test(context.currentMessage);
  if (!eventWasRecentlyCreated && !directUpdate) return false;
  const changedValues = ['title', 'description', 'location', 'date', 'start_time', 'end_time', 'end_date']
    .filter((field) => Object.prototype.hasOwnProperty.call(input, field));
  if (changedValues.length === 0 && !Object.prototype.hasOwnProperty.call(input, 'all_day')) return false;
  const current = context.currentMessage;
  const transcript = familyIntentTranscript(context, eventWasRecentlyCreated
    ? FAMILY_CORRECTION_TTL_MS
    : FAMILY_INTENT_TTL_MS);
  const grounded = changedValues.every((field) => {
    if (field === 'date' || field === 'end_date') return DATE_CUE.test(transcript);
    if (field === 'start_time' || field === 'end_time') return TIME_CUE.test(transcript);
    return naturalTargetScore(transcript, input[field]) > 0;
  });
  // Assent to a correction the assistant just proposed counts as contributing.
  // `grounded` still requires every changed field to be evidenced in the
  // transcript, so "yes" can only confirm a change already spelled out.
  const currentContributes = isFamilyAffirmation(current)
    || changedValues.some((field) => {
      if (field === 'date' || field === 'end_date') return DATE_CUE.test(current);
      if (field === 'start_time' || field === 'end_time') return TIME_CUE.test(current);
      return naturalTargetScore(current, input[field]) > 0;
    });
  return grounded && currentContributes;
}

export function isNaturalDirectRequest(message: string): boolean {
  if (isUnsafeFamilyActionContext(message)) return false;
  const text = message.trim();
  return /^(?:please\s+)?(?:add|apply|archive|arrange|book|bring|build|buy|call|cancel|change|check|complete|create|delete|drop off|edit|file|find|follow up|get|grab|look up|make|mark|move|pack|pick up|play|print|put|refill|remove|reopen|restore|resume|return|review|rsvp|schedule|search|send|set|show|start|submit|take|tell|text|update|upload|wash)\b/i.test(text)
    || /^(?:can|could|will|would) you\b/i.test(text)
    || /^(?:we|i)\s+(?:need|have) to\b/i.test(text)
    || /^(?:task|to[ -]?do)\s*:/i.test(text)
    || /^(?:remember|remind)\b/i.test(text);
}
