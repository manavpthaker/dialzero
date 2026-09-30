# Dial Zero

**Dial zero for the operator.** A personal assistant you text. It lives on your own Mac, remembers your life, and gets things done for you, powered by Claude or OpenAI (your choice): it keeps your calendar and to-dos straight, reminds you of what you'd forget, texts and emails people for you, and can even make phone calls.

It's not an app you open. It's a contact in your phone.

- **You own the part that knows you.** Your memories, people and messages stay in one file on your Mac. Nothing is stored on anyone else's server except the AI model's normal processing of each request.
- **A chatbot waits for you. An assistant comes back to you.** Two short check-ins a day, a nudge when something's slipping, quiet the rest of the time.
- **It asks before it spends or commits.** Anything that costs money or speaks for you in a way you didn't ask for waits for your "go".

> Website: [dialzero.dev](https://dialzero.dev). Status: early open-source release. It works well for its author. Expect rough edges and read [What it can't do](#what-it-cant-do-yet).

---

## What it can do

| You text | It does |
|---|---|
| "What's my day look like?" | Reads your calendar and to-dos and answers in two lines. |
| "Remind me to call the plumber Thursday" | Adds a to-do (synced to your phone's Google Tasks) and brings it up at the right time. |
| "Tell Sam I'm running 10 late" | Texts Sam for you, as you. |
| "Email the landlord about the leak" | Writes and sends the email from your Gmail. |
| "Call the dentist and move my cleaning to next week" | Phones them, handles the menu, talks to the front desk, texts you the result, and puts the new time on your calendar. |
| "Book a table for 4 Saturday at 7" | Books it online (never enters a card), or calls if it can't. |
| "Wake me up at 6:45" | Calls you and keeps you talking until you're actually awake. |
| A voice memo | Transcribes it and files away what matters. |

Plus a shared **family chat**: add it to a group text with your partner and it keeps a shared calendar and grocery list.

Every feature is optional. You pick what you want during setup.

## What you need

- **A Mac that stays on** (a Mac mini is ideal; a laptop that's usually open works to start). macOS 14 or newer.
- **About an hour** for setup, most of it clicking "Allow" in System Settings.
- **An API key from Anthropic (Claude) or OpenAI**, your choice. This is pay-as-you-go and separate from any Claude or ChatGPT subscription, because the assistant runs around the clock. For most people it's a few dollars to a few tens of dollars a month, and you can set a hard monthly limit in the billing settings. (Phone calls always use OpenAI's voice model, so they need an OpenAI key even if Claude runs everything else.)
- **A Google account**, if you want calendar, to-dos and email.
- Optional: a phone number from Twilio (a small monthly fee plus per-minute charges) if you want it to make and take calls.

## Setup: let Claude Code or Codex walk you through it

You don't need to know how to code. You need a coding assistant: [Claude Code](https://claude.com/claude-code) (in the Claude desktop app's Code tab) or OpenAI's [Codex](https://openai.com/codex). Use whichever subscription you already have; it's only needed for setup.

1. Download this project: click **Code → Download ZIP** above, unzip it, and move the folder somewhere you'll keep it (for example, your home folder).
2. Open the folder in Claude Code or Codex.
3. Type: **set me up**

It goes one step at a time: check your Mac, pick Claude or OpenAI and get your key, interview you so the assistant knows you, walk you through each permission, connect Google, and send you your first text. It explains every step in plain words and checks that each one worked before moving on. You can stop and pick it back up any time: say "set me up" again and it continues where you left off.

**Comfortable in a terminal?** `npm install && npm run setup` runs the same checklist as a wizard. See [setup/GUIDE.md](setup/GUIDE.md) for every step.

## How it works (in one paragraph)

Your Mac signs into Messages with an Apple ID. When you text that Apple ID, the assistant reads the message from the Mac's own Messages database, decides what to do using Claude or an OpenAI model, uses tools (calendar, email, a browser, the phone) to do it, and replies by text. What it learns about you is saved as small facts in a local database, so it gets more useful the more you use it. A few background jobs handle check-ins, reminders and watching your email. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What it can't do (yet)

Honest list, compared with commercial assistants like Meta's Muse or Instinct:

- It doesn't pay bills, cancel subscriptions, or talk to other companies' AI agents.
- Purchases are limited: it can reorder something online behind your approval, and it stops at the cart for groceries.
- No app, no hardware, no avatar. It's a contact you text.
- It needs a Mac that stays on. No Mac, no assistant.
- Setup takes about an hour and some patience.

## Privacy

Read [docs/PRIVACY.md](docs/PRIVACY.md). Short version: everything it knows lives on your Mac; your messages and requests go to the AI provider you chose (Anthropic or OpenAI) to be understood; texts, emails, calls and bookings only happen when you ask or approve; you can see and delete everything it remembers from a local dashboard.

## Build your own

Take the parts you want. Every feature is a module you can turn on or off, and adding your own is documented in [docs/BUILD-YOUR-OWN.md](docs/BUILD-YOUR-OWN.md).

## License

MIT. See [LICENSE](LICENSE).
