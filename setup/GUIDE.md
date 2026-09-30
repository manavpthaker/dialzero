# Setup guide

This is the checklist Claude follows when someone says **"set me up"**. It's also readable by a person doing it by hand.

## How to run this (for Claude)

The person you're helping may never have used a terminal. Your job is to get them from "downloaded the folder" to "my assistant texted me back", one small step at a time.

- **One step per turn.** Say what the step is for in one plain sentence, do it (or tell them exactly what to click), then check it worked. Don't dump the whole list on them.
- **Check, don't assume.** After each step, run `npm run doctor -- --setup --json` and read the result. Only move on when the check for that step is `ok`. The `fix` field on each check is a plain-English instruction you can pass along.
- **Resume, don't restart.** Always start by running the checker. If steps are already `ok`, say so briefly and pick up at the first one that isn't.
- **Ask before installing or changing anything** on their Mac (Homebrew packages, system settings). Explain what it is and why in one sentence.
- **Never ask them to paste a secret into the chat.** For API keys and tokens, tell them to paste it into the `.env` file yourself opened for them, or run the interactive command that asks for it. Never echo a key back.
- **No jargon.** Say "the folder" not "the repo", "the background service" not "launchd agent", "your assistant's Apple ID" not "the iMessage handle". If a term is unavoidable, explain it in five words.
- **Celebrate the finish.** The last step is a real text from their phone and a real reply.

If something fails in a way this guide doesn't cover, read the error, check `docs/` and the source, fix it if it's clearly a setup problem, and tell them plainly what happened.

---

## Step 0: Check the Mac

**Why:** the assistant runs on this Mac, so it needs a few basic tools.

Check with the setup checker, then:
- **macOS 14+.** `sw_vers -productVersion`.
- **Homebrew** (the standard way to install developer tools on a Mac). If `brew` isn't found, ask permission, then install it from https://brew.sh (it asks for their Mac password; that's expected).
- **Node.js 20+.** `node -v`. If missing or old: `brew install node`.
- **Project packages.** `npm install`, then `npm run build`.
- **Keep the Mac awake.** Walk them through System Settings → Battery (or Energy) → turn on "Prevent automatic sleeping when the display is off" (desktop Macs) and, on laptops, suggest keeping it plugged in. Explain: if the Mac sleeps, the assistant can't read or send texts.

## Step 1: Choose how people will text the assistant

**Why:** the assistant reads and sends messages through this Mac's Messages app.

Two options. Explain both and let them choose:
1. **A separate Apple ID for the assistant (recommended).** They create a free Apple ID (a new email address works, e.g. a Gmail alias), sign into Messages on this Mac with it, and then text that address from their phone. The assistant feels like its own contact, and their personal texts stay separate.
2. **Their own Apple ID.** Quicker, but the assistant sees their own message history on this Mac and they text themselves to reach it. Fine for trying it out.

Walk them through Messages → Settings → iMessage → sign in. Confirm with the checker (it verifies Messages can be controlled; see Step 4 for the permission prompt).

## Step 2: Choose the AI and get a key

**Why:** the assistant's "brain" is an AI model on their account: Claude (Anthropic) or OpenAI. Either runs everything except phone calls, which always use OpenAI's voice model.

Explain plainly: this key is **pay-as-you-go and separate from any Claude or ChatGPT subscription**. The subscription only covers the coding assistant they're using right now for setup; the assistant runs around the clock and bills by use (usually a few dollars to a few tens of dollars a month).

Ask which they prefer. If they don't mind, suggest Claude.

- **Claude:** open https://console.anthropic.com/settings/keys (sign up if needed; add credits or a payment method under Billing). Suggest a monthly spend limit (for example $20). Create a key.
- **OpenAI:** open https://platform.openai.com/api-keys (add a payment method under Billing). Suggest a monthly limit under Billing → Limits (for example $20). Create a key.

`npm run onboard` asks which one and for the key (it saves `LLM_PROVIDER` and `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` to `.env`). Never ask them to paste the key into this chat. The checker verifies the key works.

The Claude default is Claude Opus 5 for replies and Claude Haiku 4.5 for quick background work. To spend less, set `CLAUDE_MODEL=claude-sonnet-5` in `.env`.

## Step 3: The interview

**Why:** this is where the assistant learns who they are.

Run `npm run onboard`. It's a short conversation. Tell them to answer naturally; they can skip anything. It covers:
- **"The list"**: who's in their life, what they tend to forget, what they'd hand off to an assistant if they had one. Encourage them here; this is what makes it useful.
- The assistant's name and personality.
- Who they live with (if they want a family chat).
- Which features they want. Describe each in one sentence and recommend starting small: core chat, memory, calendar and to-dos. They can turn more on later by saying "set me up" again.

It writes `config/profile.json` and a few files in `context/`. The checker confirms them.

**Optional quick try:** right after the interview, `npm run chat` lets them talk to the assistant in the terminal (nothing is texted to anyone). It's a nice moment: it already knows their people and can set a reminder or search the web. Suggest it, then continue.

## Step 4: Permissions

**Why:** macOS protects Messages and the screen; the assistant needs explicit permission.

For each one, open the exact settings page, tell them what to toggle, then re-check. The app to allow is whatever runs the assistant: **Terminal** (or iTerm/Claude Code) while testing, and **node** once it runs in the background (the checker names it).

| Permission | Why it's needed | Open with |
|---|---|---|
| Full Disk Access | To read incoming messages | `open "x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles"` |
| Automation → Messages | To send replies | Triggered by the first send; click **OK** on the prompt. Re-check under Privacy & Security → Automation. |
| Accessibility | Only for desktop control | `open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"` |
| Screen Recording | Only for desktop control / screenshots | `open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"` |

Only ask for Accessibility and Screen Recording if they turned on desktop control.

## Step 5: Connect Google (calendar, to-dos, email)

**Why:** so it can read and add calendar events, keep a to-do list on their phone, and read/send email.

Google requires a one-time "OAuth client" so their assistant can sign in as them. Walk them through it slowly; this is the fiddliest step.

1. Go to https://console.cloud.google.com/, create a project (any name, e.g. "My assistant").
2. **APIs & Services → Library**: enable **Google Calendar API**, **Google Tasks API**, **Gmail API**.
3. **OAuth consent screen**: choose **External**, fill in the app name and their email, and add their own Google address under **Test users**.
4. **Credentials → Create credentials → OAuth client ID → Desktop app**. Copy the client ID and secret into `.env` as `GOOGLE_CALENDAR_CLIENT_ID` and `GOOGLE_CALENDAR_CLIENT_SECRET` (open the file for them).
5. Add `http://localhost:3333/callback` as an authorized redirect URI if the client type asks for one.
6. Run `npm run auth:google`, open the link it prints, sign in, and allow access. Google may warn the app is unverified: that's their own app, so click **Advanced → Go to (app)**.

The checker confirms the refresh token is saved.

## Step 6: Say hi

**Why:** this connects their phone to the assistant.

1. Start the assistant in the foreground: `npm run dev`.
2. Ask them to text the assistant's Apple ID (Step 1) from their phone: "hi".
3. It should reply within a few seconds. If it logs an "Unmapped chat", the checker explains how to map it; direct messages from the owner need no mapping.
4. Set `USER_OWNER` in `.env` to the phone number or email they texted from, if onboarding didn't already.

## Step 7: Optional features

Only for features they turned on. Each is its own short walkthrough; do them one at a time and re-run the checker after each.

- **Voice notes:** `brew install whisper-cpp ffmpeg`, then download a speech model: `mkdir -p ~/whisper-models && curl -L -o ~/whisper-models/ggml-small.en.bin https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin` and set `WHISPER_MODEL` in `.env`.
- **Family chat:** create a group text with their partner and the assistant, have someone send a message, then run `npm run family:configure`. See `docs/FAMILY.md`.
- **Phone calls, errands and wake-up calls:** needs an OpenAI API key (even if Claude runs the assistant), a Twilio number, Tailscale Funnel (to give the Mac a public web address for call events), and an OpenAI webhook. Follow `docs/PHONE.md` step by step. Afterward, suggest they save the assistant's phone number as a contact and turn on **Ringtone → Emergency Bypass** for it, so wake-up calls ring even on silent.
- **Ask from Siri:** needs Tailscale on the Mac and their iPhone (same account). Set `VOICE_TOKEN` to a long random password, run `tailscale serve --bg --https=8443 http://127.0.0.1:4010`, then help them build the four-action Shortcut. Follow `docs/VOICE.md` step by step. Never use `tailscale funnel` for `/voice`.
- **Browser (online booking, reading web pages logged in as them):** install the Chrome extension from `browser-extension/` (see `browser-extension/SETUP.md`).
- **Desktop control:** `brew install cliclick`, then the Accessibility and Screen Recording permissions from Step 4.
- **Local model (cheaper background work):** `brew install ollama && ollama pull qwen3:8b`, then set `LOCAL_LLM_BASE_URL=http://127.0.0.1:11434` and `LOCAL_LLM_MODEL=qwen3:8b`.

## Step 8: Run it in the background

**Why:** so it keeps working after they close the terminal and restarts on its own.

1. Stop `npm run dev` (Ctrl-C).
2. `npm run install:service`: installs the background service for the features they chose.
3. Re-grant Full Disk Access to **node** if the checker says so (background runs use node directly, not the terminal).
4. Ask them to text: **"What's on my calendar tomorrow?"**

When it answers, they're done. Tell them the handful of things worth knowing:
- Text it like a person. "Remind me…", "Tell Sam…", "What did I say about…".
- It checks in twice a day if they turned check-ins on; otherwise it only speaks when spoken to or when something's urgent.
- `npm run pause` / `npm run resume` quiets or wakes the background features.
- They can come back to Claude and say "set me up" any time to turn on more features.
