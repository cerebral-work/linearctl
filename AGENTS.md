# AGENTS.md - lnr (linearctl)

This file is the canonical rule set for people and agents. Every rule is stated once, here.
`CLAUDE.md` points to this file.

## What this is

`lnr` (backward-compatible alias: `linearctl`) is the estate Linear API orchestrator: a headless CLI (`dist/lnr` / `dist/linearctl`), an stdio MCP server (`lnr mcp serve`), an in-cluster Kubernetes operator (`lnr operator`), and the estate Rust monorepo strangler workspace (`crates/lnr-domain`, `crates/lnr-cli`, `xtask`).

## Layout

| Path | Content |
|---|---|
| `src/` | Production TypeScript/Bun CLI (`lnr` / `linearctl`), MCP server, and operator. |
| `crates/lnr-domain` | Rust domain library. Entities and ports. Zero I/O. |
| `crates/lnr-cli` | Rust CLI binary `lnr`. Parses arguments and calls the domain. |
| `xtask/` | Repo tasks in Rust: `spec-check` and `toolchain-check`. |
| `specs/` | LeanSpec specs and the registry `specs/README.md`. |
| `docs/` | Feature references, architecture decisions (`docs/decisions.md`), and roadmap (`docs/roadmap.md`). |
| `test/` | Unit, integration, and live-API contract tests. |

Dependency direction in the Rust workspace: crates depend only downward. `lnr-cli` depends on `lnr-domain`. `lnr-domain` has zero I/O (`std::net`, `std::fs`, `std::process`, and `tokio` are forbidden; `make smoke` enforces this).

## Rules that bind

1. **LeanSpec first.** New architectural changes in the Rust workspace start as a spec in `specs/`. Run `make spec-check`.
2. **Use `-j 2` on shared workstations.** The Makefile sets `JOBS ?= 2` and passes `-j $(JOBS)` to every `cargo` call. Never run `cargo` without `-j 2`.
3. **Backward compatibility (`lnr` and `linearctl`).** `bun run build` emits both `dist/lnr` and `dist/linearctl`. Config and state lookups support both `.lnr/` and `.linearctl/` (and `~/.config/lnr/` and `~/.config/linearctl/`).
4. **Sign every commit.** Never use `--no-gpg-sign`.
5. **Use Conventional Commits.** Release automation (`release-please`) reads Conventional Commits.
6. **Merge with merge commits only.** Use `gh pr merge <N> --merge`. Never squash.
7. **Authentication.** `LINEAR_API_KEY` is read from the environment only. Never store, print, or commit credentials.

## Commands

Run `make help` for the full list.

| Target | What it does |
|---|---|
| `make build` | Build compiled Bun binaries (`dist/lnr`, `dist/linearctl`) and the Rust workspace (`-j 2`). |
| `make typecheck` | Run `tsc --noEmit` on the TypeScript codebase. |
| `make fmt` / `make fmt-check` | Format, or check formatting of Rust crates. |
| `make clippy` | Run Clippy with `-j 2` and `-D warnings` (including EST-273 restriction floors). |
| `make test` | Run both TypeScript (`bun test`) and Rust (`cargo nextest` / `cargo test -j 2`) suites. |
| `make deny` | Check Rust licenses, advisories, bans, and sources via `cargo deny check`. |
| `make spec-check` | Validate `specs/` via `cargo xtask spec-check`. |
| `make toolchain-check` | Verify active `rustc` matches `rust-toolchain.toml`. |
| `make check` | Full quality gate: `typecheck`, `fmt-check`, `clippy`, `test`, `doc-test`, `deny`. |
| `make smoke` | Run cache benchmarks, CLI contract tests, `lnr-cli` smoke test, and zero-I/O domain check. |
| `make hygiene` | Full preflight gate (`check`, `smoke`, `spec-check`, `toolchain-check`, `cpm-check`). |
