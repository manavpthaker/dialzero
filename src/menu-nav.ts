// Phone menus, handled by the call code. Menus are where many business calls die, and
// a voice model left alone gives its intro to the menu before pressing anything.
// Here the voice model never hears a turn while a menu is playing: once the menu
// goes quiet, a cheap text model reads what it offered and picks one action (press
// keys, say a word, wait, or give up), and the call code carries it out. The rules the
// voice platforms converged on are kept here, not in a prompt: one key string per
// step, no repeat of the same keys within 3 seconds, and when the same menu comes back,
// a ladder of "0", then "representative", then stop and report it stuck.

import { OPENAI_ROUTER_MODEL, openAIText } from './lib/openai.js';
import { extractFirstJson } from './lib/daemon.js';
import { withLlmContext } from './lib/llm-context.js';

export interface MenuChoice {
  action: 'press' | 'say' | 'wait' | 'stuck';
  digits?: string;
  words?: string;
  reason: string;
}

export interface MenuInput { goal: string; menu: string; pressed: string[] }
type Chooser = (i: MenuInput) => Promise<MenuChoice>;

const RULES = `You pick the next step through an automated phone menu for an assistant calling a business. You only read what the menu said; you never talk to it.
Choose ONE action:
- "press": the key(s) for the option that best fits the GOAL, as digits (0-9, *, #). If no option fits, the operator, "all other questions" or "speak to a representative" option. Only keys the menu actually offered.
- "say": when the menu asks you to say something ("say representative", "say billing"): the few words to say.
- "wait": the menu is still mid-sentence, says to hold or wait, or offered nothing you can use yet.
- "stuck": it asks for something the assistant doesn't have (an account or PIN number) and offers no way to a person.
Reply with JSON only: {"action": "press"|"say"|"wait"|"stuck", "digits": "...", "words": "...", "reason": "a few words"}`;

const defaultChooser: Chooser = async (i) => {
  // Isolated test runs never call a model unless they stub one in.
  if (process.env.ASSISTANT_DB_PATH && !process.env.MENU_NAV_LIVE) return { action: 'wait', reason: 'no model in tests' };
  const raw = await withLlmContext({ caller: 'menu-nav', lane: 'batch' }, () => openAIText({
    model: process.env.MENU_NAV_MODEL || OPENAI_ROUTER_MODEL,
    system: RULES,
    prompt: `GOAL: ${i.goal}\n\nALREADY PRESSED: ${i.pressed.join(', ') || 'nothing'}\n\nTHE MENU SAID:\n${i.menu.slice(-3000)}`,
    maxOutputTokens: 200,
  }));
  return parseChoice(raw);
};

export function parseChoice(raw: string): MenuChoice {
  const json = extractFirstJson(raw, '{', '}');
  if (!json) return { action: 'wait', reason: 'no answer' };
  const p = JSON.parse(json) as Record<string, unknown>;
  const action = ['press', 'say', 'wait', 'stuck'].includes(String(p.action)) ? String(p.action) as MenuChoice['action'] : 'wait';
  const digits = String(p.digits ?? '').replace(/[^0-9*#]/g, '').slice(0, 10);
  const words = String(p.words ?? '').trim().slice(0, 40);
  const reason = String(p.reason ?? '').slice(0, 80);
  if (action === 'press' && !digits) return { action: 'wait', reason: 'no keys given' };
  if (action === 'say' && !words) return { action: 'wait', reason: 'no words given' };
  return { action, ...(action === 'press' ? { digits } : {}), ...(action === 'say' ? { words } : {}), reason };
}

let chooser: Chooser = defaultChooser;
/** Tests swap in a stub. */
export function setMenuChooser(fn: Chooser | null): void { chooser = fn ?? defaultChooser; }

const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2));
/** Two menu readings are the same menu (it came back after a press). */
export function sameMenu(a: string, b: string): boolean {
  const x = words(a); const y = words(b);
  // A short line ("Thank you.") isn't a menu coming back: its two words sit inside any
  // menu ("Thank you." after a press would otherwise count as the menu again).
  if (x.size < 4 || y.size < 4) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / Math.min(x.size, y.size) >= 0.7;
}

export const MAX_PRESSES = 8;
const REPEAT_BLOCK_MS = 3_000;

export class MenuNav {
  /** What the menu has said since the last action. */
  private heardSince: string[] = [];
  /** Each menu reading we acted on. */
  private seen: string[] = [];
  private loops = 0;
  private lastPress = { digits: '', at: 0 };
  readonly pressed: string[] = [];

  constructor(private goal: string, private now: () => number = Date.now) {}

  heard(text: string): void { if (text.trim()) this.heardSince.push(text.trim()); }

  get hasNew(): boolean { return this.heardSince.length > 0; }

  /** The next step, with the loop ladder and repeat block applied over the model's pick. */
  async decide(): Promise<MenuChoice> {
    const menu = this.heardSince.join(' ');
    if (!menu) return { action: 'wait', reason: 'nothing new heard' };
    if (this.pressed.length >= MAX_PRESSES) return { action: 'stuck', reason: `pressed ${MAX_PRESSES} times without reaching a person` };
    // The same menu again after we acted: the ladder, not another guess.
    if (this.seen.some((m) => sameMenu(m, menu))) {
      this.loops++;
      this.consume(menu);
      if (this.loops === 1) return this.press('0', 'same menu again: operator');
      if (this.loops === 2) return { action: 'say', words: 'representative', reason: 'same menu again: asked for a person' };
      return { action: 'stuck', reason: 'the same menu kept coming back' };
    }
    let choice: MenuChoice;
    try {
      choice = await chooser({ goal: this.goal, menu, pressed: this.pressed });
    } catch (err) {
      choice = { action: 'wait', reason: `chooser failed: ${err instanceof Error ? err.message : err}` };
    }
    if (choice.action === 'wait') return choice;
    this.consume(menu);
    if (choice.action === 'press') {
      if (choice.digits === this.lastPress.digits && this.now() - this.lastPress.at < REPEAT_BLOCK_MS) {
        return { action: 'wait', reason: `just pressed ${choice.digits}` };
      }
      return this.press(choice.digits!, choice.reason);
    }
    return choice;
  }

  private consume(menu: string): void { this.seen.push(menu); this.heardSince = []; }

  private press(digits: string, reason: string): MenuChoice {
    this.lastPress = { digits, at: this.now() };
    this.pressed.push(digits);
    return { action: 'press', digits, reason };
  }
}
