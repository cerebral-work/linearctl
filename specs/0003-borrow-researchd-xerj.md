---
status: complete
created: 2026-10-14
tags: [architecture, rust, domain, cli, mcp, xtask, researchd, xerj]
priority: high
depends_on: [0002-lnr-rust-port]
---

# 0003-borrow-researchd-xerj

## Overview

Borrow and port core Rust domain models, search/budgeting primitives, and workspace verification automation from the `researchd` (`autoresearcher`) platform and `xerj` search engine into `lnr` (`crates/lnr-domain`, `crates/lnr-cli`, `xtask`, `Cargo.toml`, and `projectfile.yaml`). All borrowed code preserves `lnr-domain` zero-I/O purity, EST-273 Clippy restriction floors, `-j 2` host throttling, and zero new external dependency crates in `Cargo.lock`.

## Design

### 1. `xerj` Subsystems Ported to `lnr`

| Source in `xerj` | Target in `lnr` | Responsibility |
|---|---|---|
| `crates/xerj-fts/src/bm25.rs` & `analyzer.rs` | `crates/lnr-domain/src/bm25.rs` | Lucene-compatible BM25 relevance scorer (`Bm25Scorer`, `ScoreBreakdown`, `QueryExplanation`, `FieldStats`, `CollectionStats`), identifier-aware `WordDelimiterFilter` (camelCase/acronym/digit splitter), `AsciiFoldingFilter` (`fold_to_ascii`), and multi-field `Bm25IssueIndex` for ranking Linear issues with `_explain` breakdowns. |
| `crates/xerj-mcp/src/token_budget.rs` | `crates/lnr-domain/src/token_budget.rs` | Deterministic word-boundary token counter (`count_tokens`), hard budget floor (`MIN_MAX_TOKENS = 32`, `opt_max_tokens`, `truncate_to_budget`), and MCP/CLI JSON response budgeter (`budget_json_response`) with span deduplication, rank-ordered greedy admission, locator-stub demotion, and `_token_budget` accounting (`count_tokens(&out) <= max_tokens`). |
| `engine/Cargo.toml` | `Cargo.toml` | `[profile.ci-test]` (`panic = "unwind"`, `lto = false`, `codegen-units = 16`), `[profile.quick]` (`opt-level = 2`, `lto = false`, `incremental = true`), `[profile.profiling]`, and `[profile.profiling-final]`. |

### 2. `researchd` (`autoresearcher`) Subsystems Ported to `lnr`

| Source in `autoresearcher` | Target in `lnr` | Responsibility |
|---|---|---|
| `crates/science/src/saga.rs` | `crates/lnr-domain/src/saga.rs` | Validated DAG `FlowGraph`, `SagaStep`, `ActivityKind`, `EvidenceTier`, `GateKind`, `CompensationReceipt`, forward/backward `CpmSchedule` (`ES`, `EF`, `LS`, `LF`, `total_slack`, `free_slack`, `critical_path`), and $U_3$-bounded `WavePlan`. |
| `crates/science/src/workstream.rs` | `crates/lnr-domain/src/workstream.rs` | Steiner (1972) `ProcessLossModel` ($U_3 = 3$ wave cap), Hackman (2002) `HackmanTeamAudit`, Steward/Eppinger `WorkstreamDsm` coupling & Wave-0 tearing analysis, and Little/Kingman/Goldratt `WorkstreamQueueMetrics` (`DbrAdmissionDecision`). |
| `crates/science/src/versionset.rs` | `crates/lnr-domain/src/versionset.rs` | Amazon Brazil-style `VersionSet` & `VersionSetResolver` with Kahn topological build ordering and `[patch.crates-io]` TOML generation. |
| `crates/science/src/security.rs` | `crates/lnr-domain/src/security.rs` | Monotonically attenuating `CapabilityEnvelope` (`Minted -> Attenuated -> Sealed`), prohibited sensitive path checks, MCP JSON-RPC `inspect_protocol_payload` & `sanitize_telemetry_method`, `ReversibilityClass` (`R0..R3`) governance, and `WatchdogState` silent-failure folding. |
| `crates/researchd/src/autumn/reviews.rs` & `crates/science/src/mesh.rs` | `crates/lnr-domain/src/reviews.rs` | `linear-code-review` Saga flow contracts (`LinearCodeReviewRequest`, `LinearCodeReviewReceipt`, `LinearReviewStatusResponse`, `default_linear_code_review_flow`), `MeshGateCard`, and content-addressed handoff verification (`fnv1a_64_hex`, `build_cas_r2_key`, `verify_handoff_bytes`). |
| `rust/xtask/src/*` & `projectfile.yaml` | `xtask/src/*` & `projectfile.yaml` | Full repo automation suite: `branch-hygiene`, `graph-audit` (with `--break-check` 3 negative controls), `projectfile-check`, `versionset-check`, `xerj-check`, and checkpointed `cargo xtask check` verification pipeline (with DBR admission and CAS tamper `--break-check`). |

### 3. CLI & MCP Surface Additions (`crates/lnr-cli`)

- **MCP Server (`crates/lnr-cli/src/mcp.rs`):** Enforces `security::inspect_protocol_payload` and `sanitize_telemetry_method` on inbound JSON-RPC calls, applies `token_budget::budget_json_response` when `max_tokens` is supplied, and exposes `bm25_search`, `queue_admission`, and `review_flow` MCP tools.
- **CLI Dispatcher (`crates/lnr-cli/src/cli.rs`):** Adds `search-bm25`, `dbr`, and `review-flow` commands alongside existing 44 root commands.

## Plan

- [x] Author LeanSpec `0003-borrow-researchd-xerj.md` and register in `specs/README.md`.
- [x] Port `bm25`, `token_budget`, `saga`, `workstream`, `versionset`, `security`, and `reviews` into `crates/lnr-domain`.
- [x] Port `branch_hygiene`, `graph_audit`, `projectfile`, `versionset`, `xerj`, and `pipeline` into `xtask`, and create root `projectfile.yaml`.
- [x] Wire `bm25`, `token_budget`, `security`, `workstream`, and `reviews` into `crates/lnr-cli` (`cli.rs` and `mcp.rs`).
- [x] Verify all unit tests, integration tests, `--break-check` mutation controls, and `make hygiene JOBS=2`.

## Test

```bash
make check JOBS=2 && make smoke JOBS=2 && make spec-check toolchain-check JOBS=2
cargo run -q -p xtask --locked -j 2 -- check --break-check
```

## Notes

- Zero new crates added to `Cargo.lock`; `xtask` depends directly on `lnr-domain`.
- `crates/lnr-domain/src` remains 100% free of forbidden I/O tokens (`std::net`, `std::fs`, `std::process`, `tokio`).
