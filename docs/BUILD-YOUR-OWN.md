# Build your own

You don't have to use all of this. The project is a set of modules, and you can take just the parts you want, or add your own.

## Take only what you want

Every feature is a module listed in `src/modules.ts`, each with a one-line description. Turn modules on or off in `config/profile.json`:

```json
{
  "modules": {
    "phone": true,
    "family": false,
    "checkins": true
  }
}
```

Or ask Claude Code: "turn on phone calls", "turn off the check-ins". `npm run doctor -- --setup` shows what each enabled module still needs.

## Change how it talks and what it knows

- `context/shared/identity.md`: who the assistant is.
- `context/shared/voice.md`: how it writes.
- `context/shared/profile.md`: who you are, what matters to you, what to never do.
- `context/admin/CLAUDE.md`: rules for your one-on-one chat.

These are plain text files. Edit them and the change takes effect on the next message. `npm run onboard` regenerates them from the interview.

## Add a tool

A tool is something the assistant can do: look something up, change something, call a service.

1. Create `src/tools/my-thing.ts` exporting an array of tools. Each has a `definition` (name, a description written for the model, and a JSON schema for its input) and a `handler` that returns text. Look at `src/tools/web.ts` for a small example.
2. Register it in `src/tools/index.ts` under a new key.
3. Add the key to a module in `src/modules.ts` so it's switched on with that module.
4. Write the description like instructions to a sharp assistant: when to use it, what it needs, what it must never do.

If your tool spends money or speaks for the owner, don't let it act directly. Stage it through the approval gate in `src/tools/actions.ts` (`propose_action` + an executor), so it waits for "go".

## Add something it does on a schedule

1. Write a function that does the work and, if the owner should hear about it, sends it through `stageSection` (the next check-in) or `sendInterrupt` (only for things that truly can't wait). Never call `sendMessage` directly for proactive messages; the outbound layer is what keeps it from becoming noisy.
2. Schedule it with `scheduleCron` from `src/lib/cron.ts` (it uses the owner's timezone).
3. Add a start function to a module in `src/modules.ts`.

## Add a whole new ability

Look at how an existing one is built end to end:
- **Wake-up calls** (`src/wakeup.ts`, `src/tools/wakeup.ts`): a table, a scheduler tick, a phone call, retries.
- **Errands** (`src/errands.ts`): a goal the owner approves once, then a background runner.
- **Web booking** (`src/web-booking.ts`): a time-boxed browser session with guardrails.

Each has a `scripts/test-*.ts` with a temporary database. Copy that pattern for yours.

## Keep your changes when you update

Keep your own tools and modules in their own files, so `git pull` rarely conflicts. Your personal data (`.env`, `config/`, `context/`, the database) is never touched by an update.
