# AGENTS.md

Guidance for coding agents (Codex and others) working in this folder. Claude Code reads the same guidance from `CLAUDE.md`.

## If the user says "set me up"

Follow [setup/GUIDE.md](setup/GUIDE.md) step by step. The person is probably not technical. Start by running `npm run doctor -- --setup --json` (run `npm install` first if that fails) to see what's already done, then continue from the first step that isn't `ok`.

- One step per turn: say why in one plain sentence, do it or tell them exactly what to click, then re-run the checker and confirm.
- Ask before installing anything or changing system settings.
- Never ask for an API key or password in the chat. Open `.env` for them, or run the command that prompts for it (`npm run onboard`).
- No jargon. Finish with a real text from their phone and a real reply.

The same applies to "turn on <feature>", "add phone calls", "set up the family chat": find the matching step in the guide.

## For code changes

Read `CLAUDE.md` for the project layout, commands and rules (they apply to any agent). Key points: imports use `.js` extensions, never write to `chat.db`, keep personal data out of the repo, use `getTimezone()` for times, and route proactive messages through `src/cos-outbound.ts`. Typecheck with `npm run build`; tests are `npm run test:<name>` (see `package.json`).
