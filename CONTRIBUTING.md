# linearctl — Dev Guide

## Quick start

```bash
mise use -g "github:cerebral-work/linearctl"  # install (or mise install after pull)
bun install                                     # deps (if any new)
bun run dev -- whoami                          # smoke test
```

## Dev loop scripts

| command | what it does |
|---|---|
| `bun run dev -- <cmd>` | run from source (no build) |
| `bun run dev:watch -- <cmd>` | hot-restart on file change |
| `bun run quick <cmd>` | alias for `bun run src/index.ts` |
| `bun run typecheck` | `tsc --noEmit` (the type checker) |
| `bun run test` | `bun test` (all tests, ~5s) |
| `bun run test:watch` | re-run tests on file change |
| `bun run test:fast <pattern>` | filter tests by name |
| `bun run lint` | alias for typecheck |
| `bun run ci` | typecheck + test (the CI gate) |
| `bun run build` | compile single binary → `dist/linearctl` |
| `bun run dev:all` | typecheck + test + build (full pipeline) |

## Adding a new command

1. Create `src/commands/<name>.ts` — export an async function (e.g. `export async function foo(opts)`)
2. Wire it in `src/index.ts` — import the function, register via `program.command("foo").action((opts) => foo(opts))`
3. Add `test/<name>.test.ts` — at least one happy-path test (stub the `LinearClient`, see `test/create-issue.test.ts` for the pattern)
4. `bun run typecheck` — clean
5. `bun test` — green
6. `bun run dev -- <name> --help` — verify help text

## Conventions

- TypeScript strict mode (tsc is the only check — bun strips types)
- Commands export async functions, wired via `.action()` in `src/index.ts`
- All API calls go through `src/client.ts` (the Linear SDK wrapper)
- JSON output via `--json` flag on every command
- Conventional Commits (GPG-signed, no AI attribution)
