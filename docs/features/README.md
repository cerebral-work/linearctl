# Feature proposals

Individual feature proposals for `linearctl` — each one a self-contained `.md`
file exploring a command or capability that extends the current surface (§6 of
`docs/spec.md`) beyond the roadmap already captured in §7.

**Status legend:** `proposed` (idea, not yet ticketed) · `ticketed` (filed in
Linear via the dogfood loop) · `in-progress` · `shipped`.

## Index

| Feature | Command | Status | One-liner |
|---------|---------|--------|-----------|
| [Park user stories](./park.md) | `linearctl park` | shipped CER-1557 | File issues directly into Backlog with a user-story scaffold + label. |
| [Comment](./comment.md) | `linearctl comment` | shipped CER-1345 | Add comments to issues headless — the missing write mutation. |
| [Label management](./label.md) | `linearctl label` | ticketed CER-1558 | Create / list / rename labels headless. |
| [Cycle review](./cycle.md) | `linearctl cycle` | ticketed CER-1143 | Current-cycle scope, carry-over, and assignment. Expands roadmap T8. |
| [Duplicate check](./dupcheck.md) | `linearctl dupcheck` | shipped CER-1559 | Fuzzy-match titles before filing to prevent duplicates. |
| [Search](./search.md) | `linearctl search` | shipped CER-1560 | Arbitrary-criteria issue search — the `grep` for Linear. |
| [History](./history.md) | `linearctl history` | ticketed CER-1561 | Issue activity timeline — the audit trail `show` doesn't surface. |
| [Templates](./template.md) | `linearctl template` | ticketed CER-1562 | File issues from reusable markdown templates. |
| [TUI dashboard](./tui.md) | `linearctl tui` | ticketed CER-1550 | Full-screen keyboard-driven dashboard — 5 panes over the same `core/*`. |
| [Interactive mode](./interactive.md) | `linearctl <cmd> --interactive` | shipped (core) CER-1551 | Prompts, spinners, styled output when TTY + no `--json` + missing args. |
| [Beads Integration](./beads.md) | `linearctl beads` · `pull --beads` | shipped CER-2660 | Optional, discovery-based Beads graph issue tracking & dependency resolution for Linear state. |
| [Roadmap timeline](./roadmap.md) | `linearctl roadmap` | shipped CER-1688 | Milestone timeline view with target dates, progress bars, and issue lists. |
| [CPM Plan generation](./plan.md) | `linearctl plan` | shipped CER-2821 | Saga Spec 0040 Critical Path Method (CPM) plans and wave scheduling. |
| [Local ORM cache](./local-cache.md) | `linearctl cache` | shipped CER-2650 | Sub-millisecond SQLite replica with delta sync and write-through. |
| [Workspace reorg](./reorg.md) | `linearctl reorg` | shipped CER-2810 | Workspace audit, plan, and mutation simulation with atomic rollback. |
| [Backup](./backup.md) | `linearctl backup` | shipped CER-1555 | Read-only JSONL workspace backup and entity manifest verification. |

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
