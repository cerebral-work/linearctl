---
status: complete
created: 2026-10-13
tags: [architecture, rust, cli, rename]
priority: high
---

# 0001-lnr-strangler-architecture

## Overview

Rename `linearctl` to `lnr` (matching the estate 3-letter consonant naming convention alongside `dgr`, `sbx`, `nrn`, `wak`, and `uas`) while keeping `linearctl` as a backward-compatible binary alias and state-directory fallback. Scaffold the estate Rust monorepo harness (`crates/lnr-domain`, `crates/lnr-cli`, `xtask`, `.moon/`, `.prototools`, `Makefile` with `-j 2`) alongside the existing TypeScript/Bun CLI for a phased strangler migration.

## Design

### Naming and Compatibility Contract

| Surface | Primary Name | Compatibility Alias |
|---|---|---|
| Primary CLI binary | `lnr` (`dist/lnr`) | `linearctl` (`dist/linearctl`) |
| Repo-local config | `.lnr/` | `.linearctl/` |
| User config | `~/.config/lnr/` | `~/.config/linearctl/` |
| Release archives | `lnr_<ver>_<os>_<arch>.tar.gz` | `linearctl_<ver>_<os>_<arch>.tar.gz` |

### Rust Workspace Layout

| Path | Content |
|---|---|
| `crates/lnr-domain` | Pure domain model (`#![forbid(unsafe_code)]`, zero I/O). |
| `crates/lnr-cli` | Rust CLI binary `lnr` with git revision stamp. |
| `xtask/` | Repo automation (`spec-check` and `toolchain-check`). |
| `specs/` | LeanSpec registry validated by `cargo xtask spec-check`. |

Crates depend only downward: `lnr-cli` depends on `lnr-domain`, and `lnr-domain` has zero I/O (`std::net`, `std::fs`, `std::process`, and `tokio` are forbidden and checked by `make smoke`). All `cargo` invocations in `Makefile`, `.moon/tasks/tag-rust.yml`, and `scripts/` specify `-j 2` to prevent CPU and memory starvation on shared workstations.

## Plan

- [x] Rename package and primary binary to `lnr` while retaining `linearctl` binary alias and `.linearctl/` path fallbacks.
- [x] Add estate Rust workspace (`Cargo.toml`, `rust-toolchain.toml`, `rustfmt.toml`, `clippy.toml`, `deny.toml`, `.cargo/config.toml`, `.config/nextest.toml`).
- [x] Scaffold `crates/lnr-domain`, `crates/lnr-cli`, and `xtask`.
- [x] Wire unified `Makefile`, `.moon/`, `.prototools`, `lefthook.yml`, and CI gates with `-j 2` host throttling.

## Test

Run the full quality and smoke gates across both the TypeScript/Bun CLI and the Rust workspace:

```bash
make check && make smoke
```

## Notes

- Existing skills and scripts invoking `linearctl` continue to work without modification via the `dist/linearctl` binary and release archive aliases.
- See `~/.agents/sops/rust-repo-best-practices.md` for the estate Rust workspace and CI conventions.
