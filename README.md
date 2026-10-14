# Dial Zero

**Dial zero for the operator.** An open-source assistant that lives on your own Mac and handles the errands you keep putting off. It can make careful phone calls for you and check in with you on its own, and it asks before it spends money or speaks for you. You reach it by text from your phone, and it runs on Claude or OpenAI, your choice.

It's not an app you open. It's a contact in your phone.

Built by one person with Claude Code. Read [SECURITY.md](SECURITY.md) before you connect your accounts.

<!-- TODO(before launch): make the demo play inline. Edit this README on github.com, drag docs/media/demo.mp4 into the editor, and replace the link on the next line with the github.com/user-attachments URL GitHub inserts (keep the caption). -->
**[▶ Watch a 40-second demo](docs/media/demo.mp4)**: two real errands from the author's own texts. It calls a cafe about the wait, and when an online booking fails, it asks before calling the restaurant instead. Business names changed.

- **It makes the call.** Text "call the dentist and move my cleaning to next week." It looks up their hours and calls while they're open, works the phone menu, lets them finish their hello, asks one thing at a time, and texts you back who it spoke with and any reference number. It calls businesses, not people, unless you confirm the person is OK with it.
- **It comes back to you.** A chatbot waits for you; an assistant comes back to you. Turn on two short check-ins a day, a nudge when something's slipping, and a text when it's time to leave. Quiet the rest of the time.
- **It asks before it acts.** Anything that costs money or speaks for you in a way you didn't ask for waits for your "go". That check is in the code, not just the prompt.
- **You own the part that knows you.** Your memories, people and messages stay in one file on your Mac. Nothing is stored on anyone else's server except the AI model's normal processing of each request.

> Website: [dialzero.dev](https://dialzero.dev). Status: beta. An early open-source release that works well for its author. Expect rough edges and read [What it can't do](#what-it-cant-do-yet). What changed in each release: [CHANGELOG.md](CHANGELOG.md).

---

## Start in three steps

Each step works on its own. Stop after any of them.

| Step | What you get | Time | What it costs |
|---|---|---|---|
| [1. Try it in 10 minutes](#1-try-it-in-10-minutes) | Talk to it in the terminal | About 10 minutes | AI usage only |
| [2. Make it textable](#2-make-it-textable) | Text it from your phone; calendar, to-dos and email | About an hour | AI usage; guided setup uses your Claude Code or Codex plan |
| [3. Add phone calls](#3-add-phone-calls) | It calls businesses for you and answers its own number | About 30 more minutes | A Twilio number and minutes, plus OpenAI's voice model |

**What it costs:** you pay your AI provider per use, so the bill depends on how often you use it and which model you pick. Phone calls add a Twilio number ($1.15 a month), about 1.4 cents a minute for each call, and OpenAI's per-minute charge for the voice model. Set a spending limit with each provider.

### 1. Try it in 10 minutes

You need a Mac with [Node.js](https://nodejs.org) 20 or newer, and an API key from [Anthropic](https://console.anthropic.com/settings/keys) (Claude) or [OpenAI](https://platform.openai.com/api-keys). The key is pay-as-you-go and separate from any Claude or ChatGPT subscription. Set a monthly limit in your billing settings.

**Get the code.** On this page, click the green **Code** button.

- **Easiest:** choose **Open with GitHub Desktop** (install [GitHub Desktop](https://desktop.github.com) first), let it clone, then pick **Repository → Open in Terminal**.
- **In Terminal:** copy the HTTPS address shown under **Code**, then run `git clone`, pasting the address in place of `<address>`. If your Mac offers to install "command line developer tools", say yes.

```bash
git clone <address> dialzero
cd dialzero
```

**Add your key and start it.** In Terminal, in that folder:

```bash
npm install
cp .env.example .env
open -e .env
```

The last line opens the settings file in TextEdit. Paste your key after `ANTHROPIC_API_KEY=` and save. (Using OpenAI? Paste it after `OPENAI_API_KEY=` instead, and change `LLM_PROVIDER=claude` to `LLM_PROVIDER=openai`.) Then:

```bash
npm run chat
```

Talk to it like a person. Nothing is texted to anyone, and you can type `exit` to stop. It doesn't know you yet: run `npm run onboard` first if you want it to know your people and how you like things done.

**Code → Download ZIP** also works, but a ZIP copy can't update itself, so use it only for a look.

### 2. Make it textable

Open the folder in [Claude Code](https://claude.com/claude-code) (in the Claude desktop app's Code tab) or OpenAI's [Codex](https://openai.com/codex) and type: **set me up**. Use whichever subscription you already have; it's only needed for setup.

It goes one step at a time and checks that each one worked before moving on:

- checks your Mac and keeps it from going to sleep;
- signs Messages in to an Apple ID for the assistant (a second Apple ID is best, so your own texts stay separate);
- interviews you so the assistant knows who you are;
- walks you through the Mac permissions: Full Disk Access to read its messages and Automation to send replies. This is most of the hour;
- connects Google for calendar, to-dos and email;
- starts it in the background and has you send your first text.

Stop any time and say "set me up" again later; it continues where you left off. Comfortable in a terminal? `npm run setup` runs the same checklist as a wizard. Every step is in [setup/GUIDE.md](setup/GUIDE.md).

### 3. Add phone calls

Calls are what Dial Zero is built around, and they take the most setup. Say **add phone calls** in Claude Code or Codex, or follow [docs/PHONE.md](docs/PHONE.md). You'll need:

- an **OpenAI API key**, even if Claude runs everything else, because calls use OpenAI's voice model;
- a **paid Twilio account and phone number** (a trial account can only call numbers you've verified, so it can't call a business);
- **Tailscale** with Funnel turned on, which gives your Mac a public address for call events (free);
- an **OpenAI project webhook** and its signing secret.

A Twilio number has a small monthly fee, plus per-minute charges, plus OpenAI's voice model usage. Check their current prices.

## Updating

Fixes land most nights. To get them, say **update me** in Claude Code or Codex. It pulls the latest code, keeps your personal files, rebuilds, restarts the background service, re-runs the checker and tells you what changed.

By hand, in the project folder:

```bash
git pull
npm install
npm run build
npm run restart            # if it runs in the background
npm run doctor -- --setup
```

Your personal files (`.env`, `config/profile.json`, your own `context/` files and the database) are never in git, so an update doesn't touch them. Downloaded the ZIP? Say "update me" anyway: it can turn the folder into one that updates, keeping your personal files.

## What it can do

| You text | It does |
|---|---|
| "What's my day look like?" | Reads your calendar and to-dos and answers in two lines. |
| "Remind me to call the plumber Thursday" | Adds a to-do (synced to your phone's Google Tasks) and brings it up at the right time. |
| "Tell Sam I'm running 10 late" | Texts Sam for you, as you. |
| "Email the landlord about the leak" | Writes and sends the email from your Gmail. |
| "Call the dentist and move my cleaning to next week" | Phones them, handles the menu, talks to the front desk, texts you the result, and puts the new time on your calendar. It notes who it spoke with and any reference number, and uses that on the next call. If the menu only leads to voicemail, it leaves the message. If it can't get through, it tells you exactly where it got stuck. While it works it sends a short update now and then (never a barrage) and tells you the real time of the next call. |
| "Cancel my gym membership" | Does it on their website in your signed-in Chrome, turning down every offer to stay, or calls them if it has to. It keeps at it until it's done and texts you the result. It signs in with logins you've saved for it in 1Password (optional; it never sees the password) and picks up texted or emailed codes on its own. It never pays, and if they want something only you have, it asks you once, not every five minutes. |
| "Book a table for 4 Saturday at 7" | Books it online (never enters a card), or calls if it can't (only while they're open). |
| (a website job hits a login it can't do) | Texts you a one-time link that opens this Mac's screen in your phone's browser; do the step, tap Done, and the job carries on (optional). Changed your mind mid-job ("make it 7:30")? Just say so. |
| "Download all my recordings from that app, then cancel it" | Works through the site one step at a time, checks the files landed in Downloads, and only cancels once the export is done. |
| (nothing, you're busy) | Texts you when it's time to leave for something on your calendar, or when two things overlap. |
| "Wake me up at 6:45" | Calls you and keeps you talking until you're actually awake. |
| "Hey Siri, ask Milo what's next" (whatever you named it) | Answers out loud from your iPhone, no Messages needed ([docs/VOICE.md](docs/VOICE.md)). |
| "What did Sam and I talk about on Aug 12?" | Searches your texts by person (every number and email it has for them) and by date. |
| "Ok, what about flights?" (days later) | Picks up the trip you were planning: it keeps a running record of each ongoing topic, so you never have to re-explain. |
| "What are you working on?" | One short list: what's waiting on you, what it's doing, and what it's keeping an eye on. Say "stop" about any of it. |
| "Make sure they refund me" | Keeps checking your email (and follows up on its own after a cancellation) and only texts you if something's wrong. |
| "What can we do with the kids Saturday morning?" | Researches it properly: real options for your dates, with hours, drive time, cost, why each fits your family, and a best plan. Remembers what you liked and didn't. |
| "Get me an Uber to the airport at 5" | Sets up the ride in your Chrome, texts you the price and wait, and only requests it after your yes. |
| (someone calls its number) | Answers as your receptionist: asks who's calling and why, puts contacts through (you press 1 to take it), and texts you a message from everyone else. Quiet hours and "messages only" are yours to set. |
| "Put the grocery list on Instacart" | Fills your Instacart cart in Chrome from the shared grocery list and stops before checkout. |
| A voice memo | Transcribes it and files away what matters. |
| "What did I tell Alex at lunch?" | If you use [Omi](https://omi.me) to record your conversations, it looks it up, and quietly keeps the promises, to-dos and people from each one (optional). |

Plus a shared **family chat**: add it to a group text with your partner and it keeps a shared calendar (including repeating events and flyers from a photo) and grocery list, researches plans, and can ask you to OK a call, booking or website job they need done.

Every feature is optional. You pick what you want during setup.

## How it's different

If you've looked at OpenClaw or the other open-source assistants, here's what Dial Zero is built around:

- **Phone calls are a first-class job.** It calls businesses for you, works the phone menu, talks to the front desk, and texts you the result with who it spoke to and any reference number. It can also answer its own number as your receptionist.
- **It asks before it spends or speaks for you.** Anything that costs money or speaks for you in a way you didn't ask for waits for your "go".
- **It comes back to you.** Two short check-ins a day and a nudge when something's slipping, quiet the rest of the time. A chatbot waits for you; an assistant comes back to you.
- **Setup is a conversation, not a config file.** Open the folder in Claude Code or Codex, type "set me up," and it interviews you. Plan on about an hour.
- **The part that knows you stays home.** Your memories, people and messages live in one file on your Mac.
- **Everyday errands, with honest limits.** It does a defined set of jobs and says plainly what it can't do yet (see below).

## What you need

- **A Mac that stays on** (a Mac mini is ideal; a laptop that's usually open works to start). macOS 14 or newer.
- **About an hour** for setup, most of it clicking "Allow" in System Settings.
- **An API key from Anthropic (Claude) or OpenAI**, your choice. This is pay-as-you-go and separate from any Claude or ChatGPT subscription, because the assistant runs around the clock. For most people it's a few dollars to a few tens of dollars a month, and you can set a hard monthly limit in the billing settings. (Phone calls always use OpenAI's voice model, so they need an OpenAI key even if Claude runs everything else.)
- **A Google account**, if you want calendar, to-dos and email.
- Optional: a phone number from Twilio (a small monthly fee plus per-minute charges) if you want it to make and take calls.
- Optional: a 1Password account, if you want it to sign in to websites for you. You give it one vault with only the logins you choose.

## How it works (in one paragraph)

Your Mac signs into Messages with an Apple ID. When you text that Apple ID, the assistant reads the message from the Mac's own Messages database, decides what to do using Claude or an OpenAI model, uses tools (calendar, email, a browser, the phone) to do it, and replies by text. What it learns about you is saved as small facts in a local database, so it gets more useful the more you use it. A few background jobs handle check-ins, reminders and watching your email. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## What it can't do (yet)

Honest list, compared with commercial assistants like Meta's Muse or Instinct:

- It doesn't pay bills or talk to other companies' AI agents. It can ask to cancel a subscription, but it can't force one through: if a company insists on identity checks or a retention call with you, it hands that back to you.
- Purchases are limited: it can reorder something online behind your approval, and it stops at the cart for groceries.
- No app, no hardware, no avatar. It's a contact you text.
- It needs a Mac that stays on. No Mac, no assistant.
- Setup takes about an hour and some patience.

## Privacy

Read [docs/PRIVACY.md](docs/PRIVACY.md). Short version: everything it knows lives on your Mac; your messages and requests go to the AI provider you chose (Anthropic or OpenAI) to be understood; texts, emails, calls and bookings only happen when you ask or approve; you can see and delete everything it remembers from a local dashboard.

## Security

- **Who it listens to.** Only the phone numbers and emails in your profile. A text from anyone else is ignored without a reply. Family members you add get only the Family chat, never your full assistant.
- **What a malicious email or web page can do.** It reads email and websites, so assume some of that text will try to give it orders. Anything that spends money or speaks for you (a text, an email, a call, a booking) is staged first and runs only on your own "go" in a message you sent. That check is in the code, not just the prompt: a "go" inside an email, a web page or a background job is refused. Things you asked for directly ("tell Sam I'm late") count as your go, and only when your own recent message says so. That is the protection. It doesn't stop the assistant from misreading something; it stops it from acting on it without you.
- **Claude or OpenAI.** Set `LLM_PROVIDER` to `claude` or `openai`. The code calls one adapter (`src/lib/openai.ts`) that sends every model call to the provider you picked. Phone calls always use OpenAI's voice model.

The full picture, including what the approval gate doesn't stop and how to report a problem privately: [SECURITY.md](SECURITY.md).

## Build your own

Take the parts you want. Every feature is a module you can turn on or off, and adding your own is documented in [docs/BUILD-YOUR-OWN.md](docs/BUILD-YOUR-OWN.md).

## License

MIT. See [LICENSE](LICENSE).
