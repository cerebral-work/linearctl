# linearctl — Claude Code project guide

`linearctl` — a headless TypeScript CLI on **`@linear/sdk`** for recurring
Linear workflows (digest, file, triage, milestone). Built + shipped with **bun**.
Full design: `docs/spec.md`. Tooling rationale: `docs/decisions.md`.

## Status: pre-code (M0)

`whoami` is implemented and verified against the live API. `digest` / `file` /
`triage` / `milestone` are **specified-but-stubbed** — they exit `2` with a
`docs/spec.md` section reference, never a silent no-op. Do **not** implement a
command body until its milestone is scheduled (see the roadmap). Keep stubs honest.

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
