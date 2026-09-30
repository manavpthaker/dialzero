# Family group

Family is a fresh, shared iMessage space for ordinary household coordination. It is deliberately separate from the owner's Admin, Home, Work, Finance, Health, Job Search, email, contacts, messages, global tasks, and private memory.

## What it can do

- Read and manage events on one verified secondary Google calendar.
- Keep Family-only lists, seeded with `Family Tasks`, `Groceries`, and `Errands`.
- Remember household notes, recurring logistics, preferences, and decisions in a Family-only namespace.
- Use public web and weather lookup, Instacart search/recipes/cart building, and Spotify search/playback.
- Send a daily update at 7:00 AM and a Sunday review at 7:30 PM, local time.

It cannot access owner email, contacts, other iMessages, global tasks or memory, another group's context, Finance, Work, GitHub, Codex, desktop/browser control, checkout, purchases, or any other spending action.

## One-time setup

1. Run Google OAuth for the calendar-owning account if it is not already connected. Set `FAMILY_CALENDAR_ACCOUNT` to that exact account so setup fails if OAuth points somewhere else:

   ```bash
   npm run auth:google
   ```

   ```dotenv
   FAMILY_CALENDAR_ACCOUNT=your-calendar-account@example.com
   ```

   This pin is required. `npm run family:configure` verifies it against the authenticated primary calendar and stops without changing settings if they differ.

2. In that Google Calendar account, manually create a new secondary calendar named exactly `Family`. Share it with your partner as an editor. Assistant does not create calendars or manage sharing. Before continuing, open Google Calendar as your partner and make one disposable event on `Family`, then remove it; this is the manual proof that their editor access works.

3. Resolve and store the calendar ID:

   ```bash
   npm run family:configure
   ```

   The command lists calendars available to the authenticated account and succeeds only when there is exactly one writable, non-primary calendar named `Family`. It writes the verified ID to `FAMILY_CALENDAR_ID` and pins the authenticated account in `FAMILY_CALENDAR_ACCOUNT`. It never guesses between duplicates and never uses `primary` for an event operation.

4. Create a brand-new iMessage group containing exactly three participants: the bot account, the owner, and the configured Family member. Do not reuse an existing Home group.

5. Before `GROUP_FAMILY` exists, the new chat is still treated like an ordinary unmapped group. Send one temporary message containing the configured trigger, such as `@assistant setup`, and copy the logged unmapped chat identifier into `.env`:

   ```dotenv
   GROUP_FAMILY=<generated iMessage chat identifier>
   ```

   After the mapping is saved and Assistant is restarted, the Family group never needs the trigger again.

6. Confirm `config/profile.json` gives the owner `family` access and gives the other member only `family` access. A minimal member entry looks like:

   ```json
   {
     "id": "partner",
     "name": "Partner",
     "tone": "warm",
     "role": "member",
     "allowedGroups": ["family"],
     "phoneEnv": "USER_PARTNER",
     "emailEnv": "USER_PARTNER_EMAIL"
   }
   ```

7. If the repository has an `AUTOMATIONS_OFF` sentinel, preserve its existing comma-separated allowlist and add `family-scheduler`:

   ```dotenv
   AUTOMATIONS_ON=family-scheduler
   ```

   For example, an existing `AUTOMATIONS_ON=hygiene` becomes `AUTOMATIONS_ON=hygiene,family-scheduler`. Without the sentinel, no allowlist entry is needed.

8. Verify, rebuild, and restart the real launchd service:

   ```bash
   npm run family:configure:dry
   npm run test:family-access
   npm run build
   npm run restart
   launchctl print "gui/$(id -u)/com.assistant.agent" | grep -E 'state =|pid =|last exit code ='
   tail -n 160 /tmp/assistant.log | grep -E 'FamilyScheduler|Family-safe MCP|automations|Suspended Family|Ready'
   npm run doctor
   ```

   Do not call it live unless launchd reports `state = running`, the new log slice registers the two Family schedules, the automation summary starts `family-scheduler`, and there is no post-restart `Suspended Family` line. Instacart and Spotify are available only when their Family-safe registration lines report nonzero tool counts.

## Private settings

```dotenv
GROUP_FAMILY=
FAMILY_CALENDAR_ID=
FAMILY_CALENDAR_ACCOUNT=
FAMILY_WEATHER_LOCATION=
FAMILY_DAILY_CRON="0 7 * * *"
FAMILY_WEEKLY_CRON="30 19 * * 0"
```

The schedules run in the configured timezone (`timezone` in `config/profile.json`, else `ASSISTANT_TIMEZONE`, else the machine's zone). If either the group ID or calendar ID is missing, the affected Family capability remains disabled instead of falling back to another group or calendar. `FAMILY_WEATHER_LOCATION` is optional; when present, only that place name or postal code and resolved coordinates are sent to the fixed Open-Meteo geocoding and forecast endpoints.

## Conversation behavior

No trigger word is required. Every substantive incoming message from either configured Family member may be processed by OpenAI.

The assistant replies when a response is useful: a question, directive, decision, coordination request, or continuing discussion. It can learn durable Family context from an ordinary statement and remain silent. Silent learning may only write Family memory; it may not change a calendar event, list item, cart, playback state, or any other external state. Reactions, empty messages, the assistant's outgoing messages, and unknown senders are ignored.

The live iMessage participant set must continue to match the two configured human members. If someone is added or removed, Assistant suspends Family processing and alerts the owner privately. The other Family member has no Assistant DM access.

## Calendar safety

Every list, create, update, and delete operation is bound to `FAMILY_CALENDAR_ID`. Event details from the primary calendar or any other connected calendar are never exposed to Family.

Deleting an event is a two-step action. The same requester must confirm in the same Family chat for the same calendar and event within ten minutes. A confirmation from another person, chat, calendar, or an expired request is rejected.

## Lists and memory

Family lists live locally in Assistant and do not sync to Google Tasks or the owner's task system. Named lists can hold assignments, quantities, notes, due dates, completion state, reopening, and recoverable archives.

Family history and memory use their own `family` namespace. Existing Home data is neither copied nor retrieved. Scheduled Family updates are assembled only from Family calendar events, Family lists, and Family memory, and deliveries are deduplicated across restarts.

## Live acceptance

After the restart, test from both phones without the trigger:

1. Continue an ordinary conversation and confirm the assistant replies only when useful.
2. Send one durable context-only statement and confirm it is remembered without a visible acknowledgment.
3. Add, edit, complete, reopen, archive, and restore a disposable Family list item.
4. Create and update a disposable Family event. Request deletion, then confirm it from the same phone within ten minutes.
5. From the other phone, confirm a deletion code requested by the first phone is rejected.
6. Ask for owner email, contacts, other messages, global tasks, Finance, Work, Health, GitHub, Codex, browser/desktop control, and checkout; each request must be refused.
7. Confirm the Sunday 7:30 PM review and next 7:00 AM update arrive only in Family. Restart once after a delivery and confirm it is not sent again.

If membership changes, Family must remain silent in-group, the owner must receive one private suspension alert, and `npm run doctor` must report Family as suspended until the approved participant set is restored.
