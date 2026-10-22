// What is on the line right now. Left alone, one AI voice session has to work out
// whether it is hearing a person, a phone menu, hold music or a voicemail greeting, and
// it talks to all of them: it gives its intro to a menu, says "Sure, I'll hold." to a
// recording, and sits out a voicemail greeting until the mailbox hangs up. The call
// code keeps the stage instead, from what they say (each transcribed turn) and
// Twilio's answering-machine verdict, and phone.ts lets the assistant speak only when
// a person (or, after the beep, a voicemail) is listening.

export type Stage = 'greeting' | 'person' | 'menu' | 'hold' | 'voicemail' | 'recording';

const VOICEMAIL = /\b(leave (a |your |us a )?(brief |short )?(message|name)|after the (tone|beep)|at the (tone|beep)|record your message|voice ?mail|mailbox|(is |are )?not available (to take|right now)|can'?t (come to|take) (the|your) (phone|call)|unable to (come to the phone|take your call)|away from the (phone|desk))\b/i;
const MENU = /\b(press (\d|star|pound)|(say|press) (yes|no|one|two)\b|if (this|that) is correct|to continue in english|para espa|for [^.?!]{1,60}, (press|dial|say)|(please )?say or (press|enter)|(please )?enter (your|the) [^.?!]{1,40}(number|code|extension)|if you know your party'?s extension|dial (by name|the extension)|main menu|(our )?menu options have changed|to repeat (these|this|the) options?)\b/i;
const HOLD = /\b(please (hold|stay on the line|continue to hold)|your call is (very )?important|all (of )?our [^.?!]{0,30}(agents|representatives|associates|team members|staff)[^.?!]{0,30} (are|is) (busy|currently|with|assisting|helping)|next available|estimated (wait|hold) time|in (the )?queue|you are (caller )?number \d|thank you for (your )?(patience|waiting)|while (you|we) (wait|hold|connect)|transferring your call|one moment while)\b/i;
const CLOSED = /\b((we are|we'?re|the office is|our office is|the store is) (currently )?closed|our (business |office |normal )?hours are|outside (of )?(our )?(normal |business )?hours|during (normal |regular )?business hours)\b/i;
/** A live person, not a recording: greetings, questions back, names. */
const PERSON = /\b(hello\??|hi|hey|yes|yeah|speaking|this is [a-z]+|how (can|may) i help|what can i (do|help)|thanks for (holding|waiting)|good (morning|afternoon|evening)|can i help|who'?s calling|go ahead|sorry\??)\b/i;

/** Ordinary talk back from a person (not hold music lyrics or a recording). */
const CONVERSATIONAL = /\b(you|your|what|when|which|how|so|okay|ok|alright|sure|sorry|still there)\b/i;

/** After a voicemail message: "To send your message, press 1." → the key, else null. */
export function sendMessageKey(text: string): string | null {
  return text.match(/\bto (send|deliver|save) (your|this|the) message,? press (\d|pound|#)/i)?.[3]?.replace(/pound/i, '#') ?? null;
}

/** The stage a single heard turn points to, or null when it says nothing decisive. */
export function classifyLine(text: string): Stage | null {
  const t = text.trim();
  if (!t) return null;
  if (VOICEMAIL.test(t)) return 'voicemail';
  if (MENU.test(t)) return 'menu';
  // A person coming back from hold says "thanks for holding", which isn't hold.
  if (/\bthanks? (you )?for (holding|waiting)\b/i.test(t)) return 'person';
  if (HOLD.test(t)) return 'hold';
  if (CLOSED.test(t)) return 'recording';
  if (PERSON.test(t)) return 'person';
  return null;
}

/**
 * They said goodbye ("Perfect, you're all set. Bye now."). Not "thanks for calling",
 * which opens most greetings. Exported for phone.ts and tests.
 */
export function isGoodbye(text: string): boolean {
  return /\b(bye( now| bye)?|good ?bye|have a (good|great|nice|wonderful) (one|day|night|evening|weekend)|take care)\b/i.test(text);
}

export interface StageChange { from: Stage; to: Stage; atMs: number; why: string }

/** Twilio answering-machine verdicts (AnsweredBy) that mean a machine finished its greeting. */
const MACHINE_END = /^machine_end_(beep|silence|other)$/;

export class CallStage {
  stage: Stage = 'greeting';
  /** A heard turn has been classified (until then a reply waits for it). */
  heardLine = false;
  /** The voicemail greeting is over (the beep, or Twilio said the message ended). */
  beep = false;
  /** Twilio's verdict, when it came. */
  answeredBy = '';
  /** Twilio said "machine" before we heard any words: the words decide (see amd). */
  machineSuspected = false;
  readonly changes: StageChange[] = [];
  onChange?: (c: StageChange) => void;
  private start: number;

  constructor(private now: () => number = Date.now) { this.start = now(); }

  /** Restart the clock at pickup, like the call timeline. */
  pickedUp(): void { if (!this.changes.length && !this.heardLine) this.start = this.now(); }

  private set(to: Stage, why: string): void {
    if (to === this.stage) return;
    const c: StageChange = { from: this.stage, to, atMs: this.now() - this.start, why };
    this.stage = to;
    this.changes.push(c);
    this.onChange?.(c);
  }

  /** One of their turns, transcribed. Returns the stage after it. */
  line(text: string): Stage {
    const c = classifyLine(text);
    this.heardLine = true;
    if (this.machineSuspected) {
      this.machineSuspected = false;
      // Twilio's "machine" stands unless the words say a person (or a menu/hold) answered.
      if (c === null || c === 'voicemail') { this.beep = true; this.set('voicemail', `answering-machine check: ${this.answeredBy}`); return this.stage; }
    }
    if (c) this.set(c, text.slice(0, 60));
    // Undecided first words ("ABC Roofing.") are a person until something says otherwise.
    else if (this.stage === 'greeting') this.set('person', 'first words');
    // Back from a hold someone put us on ("Okay, so what time works?"): ordinary talk,
    // a few words, is the person, not the music.
    else if (this.stage === 'hold' && text.trim().split(/\s+/).length >= 3 && CONVERSATIONAL.test(text)) this.set('person', text.slice(0, 60));
    return this.stage;
  }

  /**
   * Twilio's answering-machine verdict. A machine verdict only counts while nothing
   * we heard says otherwise: a phone menu is a "machine" too, and a long, cheerful
   * greeting from a real person can be mistaken for one.
   */
  amd(answeredBy: string): void {
    this.answeredBy = answeredBy;
    if (answeredBy === 'human') {
      if (this.stage === 'greeting') this.set('person', 'answering-machine check: human');
      return;
    }
    if (!MACHINE_END.test(answeredBy)) return;
    if (this.stage === 'voicemail') { this.beep = true; return; }
    if (this.stage !== 'greeting') return;
    // Nothing heard yet: a long, cheerful greeting from a real person can look like a
    // machine, so wait for the words (phone.ts forces the greeting closed to get them).
    if (!this.heardLine) { this.machineSuspected = true; return; }
    this.beep = true;
    this.set('voicemail', `answering-machine check: ${answeredBy}`);
  }

  /** Twilio said "machine" and no words came to say otherwise: it's voicemail. */
  machineConfirmed(): void {
    if (!this.machineSuspected) return;
    this.machineSuspected = false;
    this.beep = true;
    this.set('voicemail', `answering-machine check: ${this.answeredBy} (no words heard)`);
  }

  /** The greeting went quiet after a voicemail line: treat it as the beep. */
  greetingOver(): void { if (this.stage === 'voicemail') this.beep = true; }

  /** May the assistant speak now? Never to a menu or hold; to voicemail only after the beep. */
  get mayTalk(): boolean {
    if (this.stage === 'menu' || this.stage === 'hold') return false;
    if (this.stage === 'voicemail') return this.beep;
    return true;
  }

  /** "greeting → menu 0:11 → person 0:25", for the call log. */
  path(): string {
    const clock = (ms: number) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    return ['greeting', ...this.changes.map((c) => `${c.to} ${clock(c.atMs)}`)].join(' → ');
  }
}
