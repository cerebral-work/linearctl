---
status: complete
created: 2026-10-14
tags: [architecture, rust, domain, cli, mcp]
priority: high
depends_on: [0001-lnr-strangler-architecture]
---

# 0002-lnr-rust-port

## Overview

Port the `lnr` (`linearctl`) domain logic, CLI command surface, Linear GraphQL client, local state stores (`handoff`, `template`, `loops`, `beads`, `plan`), and stdio MCP server into the Rust workspace (`crates/lnr-domain` and `crates/lnr-cli`) while preserving the agent CLI contract (`0 ok · 2 usage · 3 auth · 4 not found · 5 rate limited · 6 refused · 1 other`) and `-j 2` host throttling.

## Design

### `crates/lnr-domain` (Zero-I/O Domain Library)

`crates/lnr-domain` enforces `#![forbid(unsafe_code)]`, `#![deny(missing_docs)]`, and zero I/O (`std::net`, `std::fs`, `std::process`, and `tokio` are forbidden). It houses:

| Module | Responsibility |
|---|---|
| `error` | `ErrorKind`, `CliError`, `ErrorEnvelope`, exit code mapping (`0..=6`), GraphQL/HTTP error classification, and batch assertion. |
| `closest` | Levenshtein edit distance, `closest_names`, and `closest_command` typo suggestion. |
| `labels` | Case-insensitive `pick_label_ids` with 3-closest-name error hints. |
| `time` | Civil-date/ISO-8601 UTC formatting and relative window parsing (`7d`, `24h`, `2w`, `30m`, `45s`). |
| `priority` | `--priority` parser (`0..=4` and `none`) and priority label formatting. |
| `similarity` | Stopword-stripped token-set Jaccard similarity and `score_candidates` for `dupcheck`. |
| `story` | User-story markdown builder (`build_story_description`) for `park`. |
| `template` | Frontmatter template parser, variable extractor, and `{{ var \| "default" }}` renderer. |
| `handoff` | Handoff id slugifier, YAML frontmatter parser/serializer, section skeleton, and section validator. |
| `loops` | Linear Loop recipe parser and 9-rule static linter (`lint_recipe`). |
| `beads` | Beads issue/dependency models, Linear priority/state mappings, readiness evaluator, blocker/dependent queries, atomic claim/close transitions, and cycle detector. |
| `plan` | Saga Spec 0040 CPM engine (`compute_cpm`, `compute_waves`), step role classifier, Beads-to-Saga plan generator (`generate_saga_plan`), and TOML serializer/parser. |
| `crypto` | Pure FIPS 180-4 SHA-256 and RFC 2104 HMAC-SHA256 for backup verification and operator webhook envelopes. |
| `models` | Linear domain entities (`WhoamiResult`, `RateLimitInfo`, `TeamSummary`, `LabelInfo`, `ProjectSummary`, `MilestoneSummary`, `IssueSummary`, `BatchFileItem`, `BulkSpecItem`) and rate-limit header parser. |
| `examples` | Embedded runnable shell examples (`include_str!`) for all 44 root commands. |

### `crates/lnr-cli` (Rust CLI Binary & Adapters)

`crates/lnr-cli` compiles the `lnr` binary (with `linearctl` alias support) and implements:

1. **Contract-Compliant CLI Dispatcher (`cli.rs`, `main.rs`):** Full command tree covering all 44 root commands and subcommands, unknown-command Levenshtein suggestions, `--help` validation on unknown commands, root `--json` placement hints, dry-run exit code `6` guards, and structured JSON error envelopes on `stderr`.
2. **Linear GraphQL Client (`graphql.rs`):** Executes GraphQL queries and mutations against `https://api.linear.app/graphql` (reading `LINEAR_API_KEY` from the environment without exposing credentials in process arguments) and supports deterministic offline fixture scenarios (`LINEARCTL_TEST_SCENARIO`).
3. **Filesystem Adapters (`store.rs`):** Handoff store (`~/.local/state/{lnr,linearctl}/handoffs/`), template discovery (`.{lnr,linearctl}/templates` + `~/.config/{lnr,linearctl}/templates`), loop recipe loader, and Beads workspace store (`.beads/issues.jsonl` + `metadata.json`).
4. **Stdio MCP Server (`mcp.rs`):** JSON-RPC 2.0 server over `stdin`/`stdout` (`lnr mcp serve`) exposing the 12 Linear tools with `readOnlyHint` annotations.

## Plan

- [x] Author LeanSpec `0002-lnr-rust-port.md` and register in `specs/README.md`.
- [x] Implement pure domain modules and unit tests in `crates/lnr-domain`.
- [x] Implement GraphQL client, local stores, MCP server, and full CLI surface in `crates/lnr-cli`.
- [x] Validate `crates/lnr-cli` against the agent CLI contract and full `make hygiene JOBS=2` gate.

## Test

```bash
make check JOBS=2 && make smoke JOBS=2 && make spec-check toolchain-check JOBS=2
```

## Notes

- All `cargo` invocations use `-j 2` to respect shared host throttling on `ceres`.
- Zero additional third-party crates are required beyond the existing 54-package `Cargo.lock`, preserving `cargo deny check` compliance and fast incremental builds.
