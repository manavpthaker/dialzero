# Changelog

What changed in each release, in plain words.

Dial Zero's code is ported most nights from the author's own assistant, so `main` changes often. A release marks a tested point. New changes collect under **Unreleased** until the next release.

## Unreleased

- **Wake-up calls go through your day.** Before dialing, the assistant gathers today's calendar (duplicates merged, overlapping meetings flagged), your overdue and due-today tasks, and anything its jobs are waiting on you for. Once you're awake it walks the day with you, gets decisions made on the call (move, add, remind, answer), and ends with a one-line plan. The call cap (`WAKEUP_MAX_CALL_MIN`) goes from 5 to 15 minutes. With nothing on the day it asks the old simple questions.
- **Calls respect the business.** At most two real calls a day to any one number across all errands (`ERRAND_PER_BUSINESS_DAILY_CAP`); "stop calling" / "take us off your list" puts the number on a do-not-call list every errand respects; a stuck phone menu moves on to the next place, and a voicemail or closed recording waits about a day for the callback instead of redialing in two hours. The daily time-line check now only listens and logs the time in the recording's own words.
- **The browser stays out of your way.** Extension 1.7.0: the assistant's tabs live in their own Chrome window opened behind yours, screenshots come from DevTools (no focus, no tab switching), Chrome relaunches in the background, and a step that needs you brings Chrome forward only when nobody has used the Mac for 2 minutes. The website job's desktop tool won't move the real mouse or type while you're using the Mac.
- **"I didn't get a code"** on a job waiting for a code or sign-in link now asks the site to resend it instead of asking you for the code again.
- **People: merge duplicates.** `npx tsx scripts/people-merge.ts plan.json [--apply]` folds duplicate person records into one (emails, phones, facts, conversations) after backing up the database. Omi's first-name match picks the person you're in touch with far more often and never files talks under a different person who has their own number.
- **Calls know what's on the line.** On business calls the code now tracks whether it hears a person, a phone menu, hold music or a voicemail greeting: it speaks only to a person (or after the voicemail beep), works phone menus itself (a cheap model picks the key; a looping menu climbs to 0, then "representative", then gives up), waits out hold in silence, leaves voicemail right after the greeting with your callback number twice, and presses "send" when a mailbox asks. It waits for the business to confirm a booking before hanging up, a call they hang up after confirming counts as done, a hang-up on the intro moves on to the next place, and a voicemail with other places left goes on to the next one. `PHONE_CALL_STAGES=false` turns it off.
- **It can check with you mid-call.** When a business asks something only you can answer, the assistant texts you the question and waits (`PHONE_ASK_WAIT_MS`, 2.5 minutes); your next text is the answer. When they ask for you, it rings you into the call and hands over when you pick up. `PHONE_SAFETY_NET=false` turns it off.
- **Practice calls have their own cap** (`PRACTICE_DAILY_CALL_CAP`), so testing never uses up the day's real calls.
- **Fewer freezes.** The watchdog's health check runs in its own process and waits while a call is live; a stall watch logs any freeze with what ran just before it (`npm run stalls`).
- **Omi stops losing conversations and work to-dos.** Conversations Omi hasn't finished transcribing are retried instead of skipped, long meetings are read to the end, to-dos a colleague gives you or that you promise to deliver are kept, short voice notes ("remember to…") become to-dos, and family nicknames stay on one person (`fullName` / `aliases` on profile people). `npm run omi:reread` re-reads a conversation for review before anything is saved.
- **Texts you owe.** Optional (`text-loops` module, for a Mac signed in to your own Apple ID): it notices texts you haven't answered, things you said you'd do and plans you agreed to, and lists them with your other open items. Your reply closes them; untouched ones drop off after a week. Nothing is sent. `npm run texts:loops` previews it.
- **Calls: a better first few seconds.** One opening sentence that says it's an AI assistant (and "on a recorded line" when you record calls) and ends on the question; it introduces itself once, enforced in code; it waits a short beat when the other side pauses (`PHONE_YIELD_MS`) instead of talking over them; noise reduction on business calls; voicemail always gets a callback number (`PHONE_CALLBACK_NUMBER`, else its own). It ends the call when they say goodbye and doesn't re-ask a name they already gave.
- **Call review.** Every business call is kept in a call log (timed transcript for 30 days, who ended it, reply delays, talk-over) and read by a separate review step, so what a dropped call learned isn't thrown away. `npm run calls:review`; the scorecard now counts "a person spoke", "wrapped up" and "goal met" separately.
- **Practice line.** A scripted test business with six scenes (hello, greeting, menu, hold, voicemail, hang-up), graded from the call log. `npm run practice`, or one scene a day with `PRACTICE_LINE_ENABLED=true`. Practice and test calls never show in your job list.
- **It remembers what it texted you**, so "what did you say on that call?" gets the real answer; and a business saved in your contacts ("… Dental", "… LLC") is called like any business, with `call_now` able to carry your OK for a real person.
- **Setup in three steps** at the top of the README: try it in the terminal in about 10 minutes, make it textable, then add phone calls. Get the code with GitHub Desktop or `git clone` instead of a ZIP.
- **Updating.** Say "update me" in Claude Code or Codex. It pulls the latest code, keeps your personal files, rebuilds, restarts the background service, re-runs the checker and tells you what changed. A folder downloaded as a ZIP can be turned into one that updates, in place.
- **Security pass.** A bare "ok" no longer approves an action proposed in the same turn (say, after reading an email that asked for it); Codex starts only when you ask for code work, sees none of the assistant's keys, and opens the assistant's own folder read-only; context files can't leave context/; fetch_url checks where a name really points and every redirect; the browser bridge accepts only a Chrome extension; the dashboard refuses other host names; iMessage recipients are escaped.
- **SECURITY.md.** What the approval gate stops, what it doesn't, and how to report a problem privately.
- **Issue forms** for "Setup got stuck" and "A call went wrong".
- **"Call me" works any hour** when you ask for it (the assistant's own calls still respect quiet hours). It speaks first when you pick up, hangs up and texts you if it reaches voicemail or a silent line, and picks up what you set up by text in the last few hours.
- **Desktop tasks finish.** One "go" covers the whole task, it gets enough steps, and if it runs out it says what's done instead of promising work.
- **"X done" closes the task.** Saying something is finished closes the matching open task even if the reply forgot to.
- **Omi is read more carefully**: once a conversation has settled, skipping tiny fragments and double recordings, and reusing the contact you meant by a first name.
- **Speaking coach** (with Omi): how much you talked vs listened, questions and fillers per conversation, a debrief after long work calls, a Sunday summary, and "how did I do in that call?".
- **Business calls stop answering themselves.** Phone lines can echo the assistant's own voice back; a turn that is mostly its own words is now dropped instead of answered, which ended the doubled intros and "Hi, yes" loops that made businesses hang up. `PHONE_ECHO_GUARD=false` turns it off.
- **Grocery list matches whole words.** "team" no longer lands in Groceries because of "tea", nor "price" because of "rice".
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
