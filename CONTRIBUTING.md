# Contributing

Thanks for taking a look. assistant is a personal-AI-assistant template — built for one
person, generalized so anyone can run their own.

## Ground rules

- **Never commit personal data.** `config/profile.json`, the generated `context/` files,
  `.env`, and `*.db` are gitignored for a reason. If you add a new generated/personal
  artifact, add it to `.gitignore`. Keep the committed repo person-free.
- **Never hardcode a timezone.** Use `getTimezone()` (src/config.ts), the helpers in
  `src/lib/time.ts`, and `scheduleCron()` (src/lib/cron.ts). `npm run check:portable`
  fails on a hardcoded zone.
- **Typecheck before you push.** `npm run build` (tsc) is the only checker; there is no
  test runner or linter. The build must pass.
- **Match the surrounding code.** Same idioms, comment density, and naming. ESM imports
  use `.js` extensions even in `.ts` source — that's intentional (NodeNext).

## Getting set up

```bash
npm install
npm run onboard:dry   # see what onboarding generates, without writing anything real
npm run build         # typecheck
npm run check:portable  # no hardcoded timezone or personal identifiers
```

## Good first contributions

- A new tool under `src/tools/` (register it in `tools/index.ts` and add its key to a
  group in `group-resolver.ts`).
- A new group template under `context/_examples/groups/`.
- Docs fixes, especially around setup on different macOS versions.

## Opening a PR

Describe what changed and why, and confirm `npm run build` passes. If your change touches
onboarding or the context assembly, note how you verified it (e.g. `npm run onboard:dry`).
