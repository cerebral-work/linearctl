# linearctl — Claude Code project guide

`linearctl` — a headless TypeScript CLI on **`@linear/sdk`** for recurring
Linear workflows (digest, file, triage, milestone). Built + shipped with **bun**.
Full design: `docs/spec.md`. Tooling rationale: `docs/decisions.md`.

## Status: command surface complete + plugin/MCP shipped

`whoami`, `project` (create / list), `file`, `update` / `close`, `digest`,
`triage`, `stale`, `xref`, `milestone`, `show`, `ratelimit`, `doc`
(get-overview / set-overview), and `mcp serve` (stdio MCP server — 12 tools:
reads `whoami`/`project_list`/`digest`/`triage`/`milestone`/`stale`/`project_overview_get`,
writes `file_issue`/`project_create`/`issue_update`/`issue_close`/`project_overview_set`)
are implemented and
verified against the live API — **every command in §6 is implemented; no stubs
remain.** The
linearctl Project + backlog are dogfood-filed in Linear (team CER). If you add a
*new* command, keep it honest: ship a verified body, not a silent no-op.

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
- **PRs only** — no direct push to `main`. **Merge-commit** PRs (`gh pr merge
  --merge`) per the estate merge-style SOP (2026-08-06: never squash; API
  rebase-merge lands unsigned — rebase locally + fast-forward if linear history
  is wanted). release-please's own Release PRs: merge-commit too.
- **Linear is the tracker**, not GitHub Issues. Tickets live in `docs/spec.md`'s
  ticket table until the project files them itself via `linearctl file` (the dogfooding
  loop) — do **not** hand-file linearctl tickets into Linear.

## Layout

`src/index.ts` (commander dispatch) · `src/client.ts` (LinearClient factory) ·
`src/commands/*` (one file per subcommand) · `src/lib/*` (pure helpers) ·
`test/*` · `docs/` · `.github/workflows/` (`ci`, `release`, `linear-release[-dev]`).
