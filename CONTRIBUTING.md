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
| `bun run test` | `bun test` (all 108 tests, ~5s) |
| `bun run test:watch` | re-run tests on file change |
| `bun run test:fast <pattern>` | filter tests by name |
| `bun run lint` | alias for typecheck |
| `bun run ci` | typecheck + test (the CI gate) |
| `bun run build` | compile single binary → `dist/linearctl` |
| `bun run dev:all` | typecheck + test + build (full pipeline) |

## Adding a new command

1. Create `src/core/<name>.ts` — pure functions that talk to Linear (via `src/client.ts`); no I/O or formatting
2. Create `src/commands/<name>.ts` — a thin layer that parses opts, calls the core function, and formats output (`--json` via `lib/output.ts`)
3. Wire it in `src/index.ts` — import the command, add a `program.command(...).option(...).action(...)` entry
4. Add `test/<name>.test.ts` — at least one happy-path test
5. `bun run typecheck` — clean
6. `bun test` — green
7. `bun run dev -- <name> --help` — verify help text

## Conventions

- TypeScript strict mode (tsc is the only check — bun strips types)
- Commands export named async functions and accept a typed `<Name>Options` interface; they never call the Linear API directly — that goes in `src/core/*`
- All API calls go through `src/client.ts` (the Linear SDK wrapper)
- Rendering is split: `src/lib/output.ts` (`printJson`, `printTable`), `src/lib/io.ts` (`readStdin`), `src/lib/prompts.ts` (interactive)
- `--json` flag on every command
- Conventional Commits (GPG-signed, no AI attribution)
