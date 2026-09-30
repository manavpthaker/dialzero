# Privacy

Plain answers to "where does my stuff go?"

## What stays on your Mac

- **Everything it remembers**: facts about you and your people, your to-do list, reminders, conversation history, the log of what it did. One SQLite file in the project folder (`assistant.db` by default).
- **Your profile and prompts**: `config/profile.json` and the files in `context/`.
- **Your keys**: `.env`.
- **Call transcripts**, only if you asked to keep them.

None of these are in the project's git history, and they're listed in `.gitignore` so you can't commit them by accident.

## What leaves your Mac

- **To your AI provider (Anthropic for Claude, or OpenAI):** each message you send it, plus the relevant memories it pulls in to answer, and the results of tools it uses (for example, the calendar events it read). That's how the model understands and answers. Your provider's API data policy applies; both Anthropic and OpenAI state that API data isn't used to train their models by default. If you turn on a local model (Ollama), background work like reading your messages for facts happens on your Mac instead.
- **To Google:** calendar, to-do and email requests, when you've connected Google.
- **To Twilio and OpenAI's voice model:** call audio, when you've set up phone calls. The audio goes straight from Twilio to OpenAI; it doesn't pass through your Mac.
- **To the people and businesses you ask it to contact:** the texts, emails and calls you asked for, with only the details you approved.

## What it does without asking

- Reads new messages sent to it (and, if you turn on memory extraction, messages in your Messages app on this Mac) to remember things.
- Sends you check-ins and urgent nudges, if you turned those features on.
- Watches your email for deliveries, bills and failed payments, if you turned that on.

## What it never does without you

- Spend money. Purchases wait for your "go", with daily and weekly caps.
- Text, email or call someone you didn't ask it to contact. When it's its own idea, it asks first.
- Enter card, bank, ID or password details anywhere.
- Call a person (not a business) without their OK.

## See and delete what it knows

- Local dashboard: `http://127.0.0.1:4000` (only reachable from your Mac) shows facts, people, tasks and messages, with search.
- Text it: "what do you know about me?", "forget that", "delete what you know about Sam".
- Delete everything: stop the service (`npm run uninstall:service`) and delete the database file.
