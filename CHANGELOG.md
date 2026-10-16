# Changelog

What changed in each release, in plain words.

Dial Zero's code is ported most nights from the author's own assistant, so `main` changes often. A release marks a tested point. New changes collect under **Unreleased** until the next release.

## Unreleased

- **Setup in three steps** at the top of the README: try it in the terminal in about 10 minutes, make it textable, then add phone calls. Get the code with GitHub Desktop or `git clone` instead of a ZIP.
- **Updating.** Say "update me" in Claude Code or Codex. It pulls the latest code, keeps your personal files, rebuilds, restarts the background service, re-runs the checker and tells you what changed. A folder downloaded as a ZIP can be turned into one that updates, in place.
- **SECURITY.md.** What the approval gate stops, what it doesn't, and how to report a problem privately.
- **Issue forms** for "Setup got stuck" and "A call went wrong".
- **"Call me" works any hour** when you ask for it (the assistant's own calls still respect quiet hours). It speaks first when you pick up, hangs up and texts you if it reaches voicemail or a silent line, and picks up what you set up by text in the last few hours.
- **Desktop tasks finish.** One "go" covers the whole task, it gets enough steps, and if it runs out it says what's done instead of promising work.
- **"X done" closes the task.** Saying something is finished closes the matching open task even if the reply forgot to.
- **Omi is read more carefully**: once a conversation has settled, skipping tiny fragments and double recordings, and reusing the contact you meant by a first name.
- **Speaking coach** (with Omi): how much you talked vs listened, questions and fillers per conversation, a debrief after long work calls, a Sunday summary, and "how did I do in that call?".
- **CONTRIBUTING** explains that code is ported nightly from the author's own assistant, so pull requests are welcome but re-applied by hand, and lists the most useful first contributions.

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
