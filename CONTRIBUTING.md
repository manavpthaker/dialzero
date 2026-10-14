# Contributing

Thanks for taking a look. Dial Zero is a personal assistant built for one person and opened up so anyone can run their own.

## How the code moves (read this first)

Dial Zero is ported from the author's own private assistant. Most nights, a job run with Claude Code re-applies generic fixes and features from that assistant here, and pushes them only after the build, the related tests and a check for personal data pass. So `main` changes often, and the private assistant is where changes start.

That shapes how pull requests work:

- **Pull requests are welcome**, but a merged change here could be overwritten by the next port. So a good change gets re-applied by hand in the author's assistant and comes back to Dial Zero through the port.
- That means your pull request may be closed instead of merged, even when the change is accepted. Your change isn't lost, and you'll be credited by your GitHub handle in the release notes (tell us if you'd rather not be).
- Small, focused changes are much easier to re-apply than large ones. For anything big, open an issue first.

## The most useful contributions right now

1. **Tell us where setup broke.** Open a "Setup got stuck" issue. Every report like that becomes a fix in the next release.
2. **Setup on other Macs and macOS versions.** What was different on yours, and what you did about it.
3. **Docs.** Anything in the README, `setup/GUIDE.md` or `docs/` that was wrong, missing or confusing.
4. **A new tool** under `src/tools/` (register it in `src/tools/index.ts` and add its key to a module in `src/modules.ts`). See [docs/BUILD-YOUR-OWN.md](docs/BUILD-YOUR-OWN.md).
5. **A new group template** under `context/_examples/groups/`.

Security problems: please don't open a public issue. See [SECURITY.md](SECURITY.md).

## Ground rules

- **Never commit personal data.** `config/profile.json`, the generated `context/` files, `.env` and `*.db` are gitignored for a reason. If you add a new generated or personal file, add it to `.gitignore`. Keep the repo person-free.
- **Never hardcode a timezone.** Use `getTimezone()` (`src/config.ts`), the helpers in `src/lib/time.ts`, and `scheduleCron()` (`src/lib/cron.ts`). `npm run check:portable` fails on a hardcoded zone.
- **Anything that spends money or speaks for the owner goes through the approval gate** (`propose_action` in `src/tools/actions.ts`). Don't add a path around it.
- **Typecheck before you push.** `npm run build` must pass. There's no test runner or linter; each `scripts/test-*.ts` is a standalone test you run with `npm run test:<name>` (see `package.json`).
- **Match the surrounding code.** Same idioms, comment density and naming. ESM imports use `.js` extensions even in `.ts` source; that's intentional (NodeNext).

## Getting set up

```bash
npm install
npm run onboard:dry     # see what onboarding generates, without writing anything real
npm run build           # typecheck
npm run check:portable  # no hardcoded timezone or personal identifiers
```

## Opening a pull request

Say what changed and why, and confirm `npm run build` passes. If your change touches onboarding or how the prompt is built, say how you checked it (for example `npm run onboard:dry`).
