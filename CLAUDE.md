# lnr (linearctl) — Claude Code project guide

Canonical rules for people and agents live in [`AGENTS.md`](AGENTS.md). Read [`AGENTS.md`](AGENTS.md) first.

`lnr` (backward-compatible alias: `linearctl`) is a headless CLI and operator on **`@linear/sdk`** for recurring Linear workflows (`digest`, `file`, `triage`, `milestone`, `roadmap`, `plan`, `reorg`, `cache`, `beads`, `mcp serve`), paired with an estate Rust strangler workspace (`crates/lnr-domain`, `crates/lnr-cli`, `xtask`).
Full design: `docs/spec.md` and `specs/`. Roadmap: `docs/roadmap.md`. Tooling rationale: `docs/decisions.md`.

## Toolchain

- `bun run dev -- <args>` — run from source (e.g. `bun run dev -- whoami`)
- `make check` — full quality gate (`tsc --noEmit`, `cargo fmt --check`, `cargo clippy -j 2`, `bun test`, `cargo test -j 2`, `cargo deny check`)
- `make smoke` — cache benchmark (`bench:cache`), agent CLI contract test, `lnr-cli` smoke test, and `lnr-domain` zero-I/O check
- `bun run build` — `bun build --compile` → `dist/lnr` + `dist/linearctl` single binaries
- **Distribution:** SLSA-attested single binaries via `mise use -g "github:cerebral-work/lnr"` (or `"github:cerebral-work/linearctl"`).
