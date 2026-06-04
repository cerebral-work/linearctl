# linearctl — Claude Code project guide

`linearctl` — a headless TypeScript CLI on **`@linear/sdk`** for recurring
Linear workflows (digest, file, triage, milestone). Built + shipped with **bun**.
Full design: `docs/spec.md`. Tooling rationale: `docs/decisions.md`.

## Status: M0 scaffold + early M2 dogfood

`whoami`, `project` (create / list), `file`, `update` / `close`, `digest`,
`triage`, and `mcp serve` (stdio MCP server, v1 tools incl. `issue_update` /
`issue_close`) are implemented and verified against the live API. `milestone`
is **specified-but-stubbed** (and `stale` / `xref` grooming verbs are in flight,
CER-1144/1145)
— they exit `2` with a `docs/spec.md` section reference, never a silent no-op. Do
**not** implement a command body until its milestone is scheduled (see the
roadmap). Keep stubs honest. (`project` + `file` landed ahead of M2 for the
dogfood loop; filing the §12 backlog into the linearctl Project via `file` is next.)

## Toolchain (bun — see docs/decisions.md ADR-0001)

- `bun run dev -- <args>` — run from source (e.g. `bun run dev -- whoami`)
- `bun run typecheck` — `tsc --noEmit` (bun strips types; tsc is the only checker)
- `bun test` — unit tests (`test/**`)
- `bun run build` — `bun build --compile` → `dist/linearctl` single binary
- **Distribution:** SLSA-attested single binaries via
  `mise use -g "github:cerebral-work/linearctl"`. bun, not Node, at runtime.

## Authentication

`LINEAR_API_KEY` is read from the environment only (1Password `Cerebral · Linear
API`, vault `cloud`). The CLI never stores, prints, or persists the key. Never
commit a key; `*.env` is git-ignored.

## Conventions

- **Conventional Commits** (release-please drives versioning): `feat:`, `fix:`,
  `feat!:` / `BREAKING CHANGE` (pre-1.0 → minor bump), `chore:`, `docs:`, `ci:`.
- **Signed commits always.** Never `--no-gpg-sign`.
- **PRs only** — no direct push to `main`. **Squash-merge** PRs (rebase-merge
  lands unsigned). release-please's own Release PRs: squash-merge too.
- **Linear is the tracker**, not GitHub Issues. Tickets live in `docs/spec.md`'s
  ticket table until the project files them itself via `linearctl file` (the dogfooding
  loop) — do **not** hand-file linearctl tickets into Linear.

## Layout

`src/index.ts` (commander dispatch) · `src/client.ts` (LinearClient factory) ·
`src/commands/*` (one file per subcommand) · `src/lib/*` (pure helpers) ·
`test/*` · `docs/` · `.github/workflows/` (`ci`, `release`, `linear-release[-dev]`).
