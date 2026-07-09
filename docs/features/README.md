# Feature proposals

Individual feature proposals for `linearctl` — each one a self-contained `.md`
file exploring a command or capability that extends the current surface (§6 of
`docs/spec.md`) beyond the roadmap already captured in §7.

**Status legend:** `proposed` (idea, not yet ticketed) · `ticketed` (filed in
Linear via the dogfood loop) · `in-progress` · `shipped`.

## Index

| Feature | Command | Status | One-liner |
|---------|---------|--------|-----------|
| [Park user stories](./park.md) | `linearctl park` | proposed | File issues directly into Backlog with a user-story scaffold + label. |
| [Comment](./comment.md) | `linearctl comment` | proposed | Add comments to issues headless — the missing write mutation. |
| [Label management](./label.md) | `linearctl label` | proposed | Create / list / rename labels headless. |
| [Cycle review](./cycle.md) | `linearctl cycle` | proposed | Current-cycle scope, carry-over, and assignment. Expands roadmap T8. |
| [Duplicate check](./dupcheck.md) | `linearctl dupcheck` | proposed | Fuzzy-match titles before filing to prevent duplicates. |
| [Search](./search.md) | `linearctl search` | proposed | Arbitrary-criteria issue search — the `grep` for Linear. |
| [History](./history.md) | `linearctl history` | proposed | Issue activity timeline — the audit trail `show` doesn't surface. |
| [Templates](./template.md) | `linearctl template` | proposed | File issues from reusable markdown templates. |
| [TUI dashboard](./tui.md) | `linearctl tui` | proposed | Full-screen keyboard-driven dashboard — 5 panes over the same `core/*`. |
| [Interactive mode](./interactive.md) | `linearctl <cmd> --interactive` | proposed | Prompts, spinners, styled output when TTY + no `--json` + missing args. |

## Reference

- The full cross-language TUI/CLI library catalog: [`tui-cli-landscape/`](./tui-cli-landscape/README.md) — split by language (Rust, Go, Python, TS/JS, C/C++, Haskell/OCaml/Ruby/Zig/Nim/Elixir/Crystal). 14 categories, stars, downloads, maintenance status, and adopters for every library.

## Relationship to `docs/spec.md` §7

§7 captures the original backlog one-liners. These proposals **expand** the
ones worth building (e.g. `cycle`) and add **net-new** capabilities that
surfaced from real workflow patterns (parking user stories, commenting,
duplicate detection). When a proposal is ratified, it gets a Conventional-
Commit ticket title and enters the dogfood filing loop (ADR-0005).

## Design principles (carried from spec §2)

- **Headless + `--json`** everywhere — every command composes with `jq`.
- **Safe-by-default** — reads never mutate; writes are dry-run unless
  `--apply`; no delete/archive operations.
- **Gap-filler** — each command complements an interactive skill or fills a
  batch/CI hole the MCP server doesn't cover.
- **Honest** — no stubs; ship a verified body or don't ship.
