# Security

Dial Zero reads your texts and email, works in your signed-in Chrome, and can text, email and phone people for you. That is a lot of reach. This page says plainly what protects you and what doesn't. It's beta and built by one person, so read the code that matters to you; the files are named below.

## Who it listens to

- Only the phone numbers and emails in your profile. A text from anyone else is ignored without a reply.
- Family members you add get only the Family chat, never your full assistant.
- When someone calls its number: your own number reaches your assistant (by default only when your carrier verifies your caller ID, `PHONE_REQUIRE_VERIFIED_CALLER`). Anyone else gets the receptionist, which can only take a message or put the call through to you.

## What the approval gate stops

- **Acting on its own idea without you.** Anything that spends money or speaks for you (a text, an email, a call, a booking, a website job) is staged as a plan in plain words and runs only after your "go". The check is in the code, not just the prompt (`src/tools/actions.ts`).
- **A "go" that didn't come from you.** A confirm is refused unless the message it's answering is yours. A "go" inside an email, a web page, a tool result or a background job does not count.
- **Skipping the go when you didn't ask.** Things you ask for directly ("tell Sam I'm running late", "call the dentist") skip the extra go, but only when the model can quote your own words asking for that kind of action, from your current message or one you sent in the last 30 minutes (`src/lib/owner-request.ts`).
- **Runaway spending.** Daily and weekly caps are checked when an action is proposed and again when it runs (`ACTIONS_DAILY_CAP_USD`, default 100; `ACTIONS_WEEKLY_CAP_USD`, default 400; `src/lib/spend-cap.ts`). `ACTIONS_ENABLED=false` turns off every action.
- **Card and password entry.** Website jobs never pay. The Chrome extension guards pay buttons and card fields. Optional 1Password sign-ins put the saved login straight into the page; the model only sees "filled". Sign-in codes texted or emailed to you are typed in without reaching the model, once, within 10 minutes, on the same site.
- **Calls at the wrong time or to the wrong kind of number.** Errand calls go only to businesses while they're open (when it found their hours) and inside your calling hours, with a daily cap (`ERRAND_DAILY_CALL_CAP`, default 10). It refuses to call a number saved as one of your people unless you confirm they're OK with it.
- **Changes on sites you only want it to read.** Mark a site "look only" and website jobs there refuse anything that would change something (`src/lib/site-rules.ts`).

## What it doesn't stop

- **Misreading.** The gate stops it acting without you. It doesn't stop it misunderstanding you, or summarizing an email wrong. Read the plan before you say go.
- **A loose "go".** The check looks for an approval word ("go", "yes", "ok", "sure", a thumbs-up and similar) or the action's number in your latest message. A "yes" you meant for something else can count, and if two actions are waiting, a bare "go" doesn't say which. When it matters, reply with the action's number.
- **Details inside "you asked for it".** For a text, email, call or booking you asked for, the code checks that your own recent words ask for that kind of action. It does not check that the person, number or details match what you said. Text planted in an email or web page could, in principle, steer those details.
- **Reading.** It reads your messages, email, calendar and the pages it visits without asking, and that text goes to your AI provider (Anthropic or OpenAI). Instructions hidden in that text can still change what it tells you or what it proposes.
- **Call behavior is mostly instructions.** Saying it's an AI when asked, never making up a detail, and never giving card or ID details are instructions to OpenAI's voice model, not hard checks. The hours, the daily cap and the saved-contact check are in code. It can't tell that an unsaved number is a person's cell.
- **A website job, once you approve it.** It works in your real, signed-in Chrome and acts on what it sees, short of paying. Use "look only" for sites like your bank.
- **Anyone with your Mac.** Its memory, your keys (`.env`) and its database are plain files on your Mac. Keep FileVault on and the Mac locked.
- **The services it uses.** Your AI provider, Google and Twilio see what they process. See [docs/PRIVACY.md](docs/PRIVACY.md).

What is reachable from outside your Mac: with phone calls on, Tailscale Funnel makes two paths public for call events, and each request is checked against Twilio's or OpenAI's signature ([docs/PHONE.md](docs/PHONE.md)). The dashboard listens only on your Mac. The take-over screen page and the Siri endpoint are reachable only inside your own Tailscale network.

## Report a problem privately

- Use GitHub's private reporting: the **Security** tab of this repo, then **Report a vulnerability**. Only the maintainer sees it.
- If that button isn't there, open an issue that says only "Security report, please contact me", with no details, and the maintainer will reach out.
- Please don't post details in public until there's a fix. Say what you did, what happened, and which version you run (the release number, or `git rev-parse --short HEAD`).

Fixes go to `main` and into the next release. Only the latest release and `main` are supported.
