# CLAUDE.md

Guidance for Claude Code working in this folder.

## If the user says "set me up"

Follow [setup/GUIDE.md](setup/GUIDE.md) step by step. The person is probably not technical. Start by running `npm run doctor -- --setup --json` to see what's already done, then continue from the first step that isn't `ok`. Plain language, one step per turn, check each step before moving on, never ask for secrets in the chat.

The same applies to "turn on <feature>", "add phone calls", "set up the family chat", etc.: find the matching step in the guide.

## What this is

A personal assistant people text over iMessage. It runs on their own Mac: it polls `~/Library/Messages/chat.db`, runs a tool-use agent on Claude or OpenAI (`LLM_PROVIDER`), and replies via AppleScript. Memory lives in a local SQLite file. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Commands

```bash
npm run build                    # typecheck + compile to dist/
npm run dev                      # run in the foreground (tsx, no build)
npm run onboard                  # the setup interview → config/profile.json, context/, .env
npm run doctor -- --setup        # is this Mac ready? (--json for machine-readable)
npm run doctor                   # is it running healthily?
npm run install:service          # install/refresh the background service (launchd)
npm run restart | pause | resume
npm run auth:google              # connect Google (calendar, tasks, Gmail)
npm run test:<name>              # isolated tests; see package.json
```

There's no test runner; each `scripts/test-*.ts` is a standalone script with its own temporary database.

## Where things are

- `src/index.ts`: boot + the inbound message handler.
- `src/modules.ts`: every feature as a module; `config/profile.json` `modules` switches them on/off.
- `src/lib/openai.ts`: the one place model calls go. `createOpenAIResponse` switches to `src/lib/anthropic.ts` when Claude is the provider, translating the request/response shape both ways (Claude's thinking blocks are replayed verbatim across tool turns). Phone calls (`src/phone.ts`) always use OpenAI's realtime voice API.
- `src/agent.ts`: the agent loop. `src/context-resolver.ts`: builds the system prompt.
- `src/tools/`: agent tools, registered in `src/tools/index.ts`.
- `src/cos-outbound.ts` + `src/checkins.ts`: all proactive messages go through here (short check-ins, a small daily interrupt budget). New proactive code must not call `sendMessage` directly.
- `src/tools/actions.ts`: the approval gate for anything that spends money or speaks for the owner; `send_now` / `call_now` / `book_online` / `do_online` skip it only when the owner's own words asked for it. Proposals reach the owner as the plan in plain words + "Go?" (`src/lib/proposal-text.ts`); action ids stay with the model.
- `src/phone.ts`, `src/errands.ts`, `src/wakeup.ts`, `src/web-booking.ts`, `src/web-task.ts`: things it does in the world.
- Website jobs (`src/web-task.ts`, tool `do_online`): cancel, export, change a setting in the owner's Chrome. Each browser run is time-boxed; the job keeps going run after run (progress carried into the next prompt, resumed after a restart) until done, blocked on the owner (`needsOwner`: login, payment, decision, phone-only), or out of runs. Website work never goes through `computer_use`; its `start_task` refuses website plans while Chrome is connected. The Chrome extension offers `snapshot` (numbered clickable elements), click by index or visible text, `scroll`, and an in-page pay-button guard. There is deliberately no run-page-JavaScript action.
- The job tracker (`src/jobs.ts`, tools `whats_going_on` / `stop_job` / `answer_job`): one plain-words list of everything in progress across website jobs, errands, follow-ups and email threads. Jobs wait for the owner (a login, a texted code, a decision) instead of failing; texted codes are typed by `enter_owner_code` and never reach the model (single-use, 10 minutes, same site only). Check-ins list open jobs, waiting-on-you first.
- Follow-ups (`src/followups.ts`, tools `watch_for` / `email_errand`): watches that check email until something happens (after a cancellation: the confirmation email, and no new charge where the site showed a billing date), and email threads with companies that answer simple questions, follow up once after 3 business days, then offer a call.
- `src/lib/preferences.ts`: the owner's saved "how I like things done" go into every job's prompt. `src/lib/photo-caption.ts`: a one-line caption is kept with any photo the owner sends.
- Sign-ins inside website jobs: `src/lib/code-finder.ts` fetches a fresh code or emailed sign-in link from the owner's email (through the configured email source) or a code text their iPhone forwards, and finds which address a company emails them at. The job types codes with `enter_owner_code` and opens links with `open_sign_in_link`; neither reaches the model, both are single-use, 10 minutes, same site or its billing provider. Pop-ups a page opens become the job's tab.
- Browser control (extension 1.4.0): snapshot reads every frame and open shadow root; screenshot + click_at for screens the page map can't explain; real_click / real_type / real_key send trusted input through Chrome's DevTools protocol (Chrome shows a "being controlled" bar). Pay buttons and card fields are guarded on every path. No run-page-JavaScript action, on purpose.
- `src/lib/chrome-health.ts`: pings the extension each minute, reopens Chrome, reloads an outdated extension, alerts once a day if a website job is paused on it.
- `src/family-*.ts`: the shared family chat. It has strict privacy boundaries; `npm run test:family-access` must keep passing.
- `context/`: prompt files. Personal ones are generated by onboarding and gitignored; `context/_examples/` holds templates.

## Rules

- Imports use `.js` extensions even for `.ts` files (NodeNext ESM).
- Never write to `chat.db`.
- Keep personal data out of the repo: `config/profile.json`, `.env`, `context/<group>/`, `context/shared/{identity,voice,profile}.md` and the database are gitignored. Examples use made-up names.
- Times: use `getTimezone()` / `src/lib/time.ts`, never a hardcoded zone.
