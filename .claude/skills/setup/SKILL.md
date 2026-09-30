---
name: setup
description: Walk the user through installing and configuring their personal assistant on this Mac, step by step, in plain language. Use when they say "set me up", "install this", "help me get started", "turn on <feature>", or ask how to set up phone calls, the family chat, Google, or permissions.
---

Follow `setup/GUIDE.md` in this folder.

1. Run `npm run doctor -- --setup --json` first (run `npm install` first if that fails because packages are missing). Tell the user in one or two sentences what's already done.
2. Continue from the first step in the guide that isn't `ok`. One step per turn: say why in one sentence, do it or tell them exactly what to click, then re-run the checker and confirm.
3. Ask before installing anything or changing system settings. Never ask for a secret in the chat; open `.env` for them or run the command that prompts for it.
4. No jargon. The person may never have used a terminal.
5. Finish with a real text from their phone and a real reply.
