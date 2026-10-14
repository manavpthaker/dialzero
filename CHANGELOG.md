# Changelog

What changed in each release, in plain words.

Dial Zero's code is ported most nights from the author's own assistant, so `main` changes often. A release marks a tested point. New changes collect under **Unreleased** until the next release.

## Unreleased

Nothing yet.

## v0.1.0 (2026-10-20)

The first numbered release. It is beta: it works well for its author, and you should expect rough edges. This is the code as it stood on 2026-10-14, two weeks after it went public.

**What it does**

- **You text it.** It reads and answers your texts over iMessage on your own Mac, using Claude or OpenAI (your choice). `npm run chat` lets you talk to it in the terminal without Messages.
- **Phone errands.** It calls businesses for you while they're open, works the phone menu, talks to the front desk, and texts you the result with who it spoke with and any reference number. On the call it waits out the greeting, asks one thing at a time, and is told never to make up a detail. It can also answer its own number as your receptionist and call you for wake-up calls. Needs an OpenAI key, a Twilio number and Tailscale Funnel.
- **Website jobs in your Chrome.** Cancel a subscription, export your data, change a setting, book a table (it never enters a card), set up an Uber or Lyft ride for your yes, or fill an Instacart cart and stop before checkout. Optional 1Password sign-ins, a one-time link to take over the screen when it needs your hands, and per-site "look only" rules.
- **Calendar, to-dos and email** through your Google account, with time-to-leave texts and a heads-up when two things overlap.
- **It comes back to you.** Two short check-ins a day if you turn them on. "What are you working on?" lists every job in progress. Long jobs send a short update now and then. Follow-ups watch your email until something happens. A checker reads the evidence before it tells you a job is done.
- **Memory that stays home.** Facts, people and ongoing topics live in one file on your Mac, with a local dashboard to see and delete them. Optional: Omi recordings, voice notes, and asking it from Siri.
- **Family chat.** Add it to a group text for a shared calendar and grocery list, with its own privacy limits.

**Safety**

- Anything that spends money or speaks for you in a way you didn't ask for waits for your "go". That check is in the code, and there are daily and weekly spend caps. See the Security section of the README.
- It only listens to the phone numbers and emails in your profile.

**Setup**

- Open the folder in Claude Code or Codex and type "set me up". Plan on about an hour, plus about 30 minutes for phone calls.

**Limits:** see "What it can't do (yet)" in the README.
