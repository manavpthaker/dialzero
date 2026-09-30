# Customizing assistant

Onboarding (`npm run onboard`) generates everything below. This doc is for when you
want to hand-edit afterward, or understand what onboarding produced.

## The two sources of truth

| File | What it holds | Committed? |
|------|---------------|-----------|
| `config/profile.json` | Who the assistant is and who it serves: bot name, trigger word, owner, household members, inner-circle people, which groups are on. | No (gitignored) |
| `.env` | Secrets and wiring: API keys, phone/email handles, group chat IDs, integration URLs. | No (gitignored) |

The repo ships `config/profile.example.json` and `.env.example` as starting points. Code
reads `config/profile.json` through `src/config.ts`; if it's absent, generic defaults keep
the project booting (nothing personal is hardcoded anywhere).

## `config/profile.json`

```jsonc
{
  "botName": "Robin",                // what the assistant is called
  "triggerWord": "@robin",           // @-trigger for group chats
  "householdName": "Rivera family",  // collective noun used in the soul line
  "timezone": "America/Chicago",     // IANA zone for crons, dates, quiet hours
  "quietHours": { "start": 21, "end": 7 }, // local hours proactive texts wait
  "owner": {
    "id": "owner",
    "name": "Alex",
    "fullName": "Alex Rivera",       // used on phone calls and bookings
    "shortName": "Alex",
    "pronouns": { "subject": "they", "object": "them", "possessive": "their" },
    "tone": "direct",                // direct | warm | playful
    "role": "admin",
    "allowedGroups": ["admin", "home", "work", "health"],
    "phoneEnv": "USER_OWNER",        // env var holding the phone secret
    "emailEnv": "USER_OWNER_EMAIL"
  },
  "members": [                        // additional people who can message the bot
    { "id": "partner", "name": "Sam", "tone": "warm", "role": "member",
      "allowedGroups": ["home"], "phoneEnv": "USER_PARTNER", "emailEnv": "USER_PARTNER_EMAIL" }
  ],
  "people": [                         // CRM seed (need not be messaging users)
    { "name": "Sam", "relationship": "partner", "notes": "..." }
  ],
  "groupsEnabled": ["admin", "home", "work"]
}
```

The timezone falls back to `ASSISTANT_TIMEZONE` in `.env`, then the machine's own
zone. Every cron, date lookup, calendar write, and quiet-hours check uses it.

`phoneEnv`/`emailEnv` keep PII out of the committed profile — the names live here, the
handles live in `.env`. After editing the profile, run `npm run seed:facts` to push any
new `people` into the brain.

## The context files

The assistant's system prompt is assembled from markdown on disk (`src/context-resolver.ts`):

| File | Role | Generated where |
|------|------|-----------------|
| `context/shared/identity.md` | The "soul" — name, role, operating principles. | onboarding (gitignored) |
| `context/shared/voice.md` | How it talks to you, in your chosen tone, with a banned-phrase list. | onboarding (gitignored) |
| `context/shared/profile.md` | Always-on narrative about you (gated to `direct` tone). | onboarding (gitignored) |
| `context/<group>/CLAUDE.md` | Per-group behavior + tool routing. | onboarding (gitignored) |
| `context/shared/security.md` | Cross-group security rules. | committed (generic) |
| `context/{brain-pulse,idea-pulse,reflection,relationship-pulse}/CLAUDE.md` | Proactive-loop behavior. | committed (generic) |

Edit any of these to change behavior. The generic starting templates live in
`context/_examples/` (with `{{BOT_NAME}}`, `{{OWNER_NAME}}`, `{{PARTNER_NAME}}`, etc.
placeholders); onboarding copies and fills them in.

## Adding or renaming a group

1. Add it in `src/group-resolver.ts` (env key + `tools[]` + `contextPath`).
2. Add a generic template at `context/_examples/groups/<group>.md`.
3. Add the group key to `groupsEnabled` and the relevant users' `allowedGroups` in
   `config/profile.json`, and set its `GROUP_<NAME>` chat ID in `.env`.

## Re-running onboarding

Safe to re-run. It restores a saved profile from `.onboard-state.json` and overwrites
generated files. Delete `.onboard-state.json` to start the conversation fresh.
