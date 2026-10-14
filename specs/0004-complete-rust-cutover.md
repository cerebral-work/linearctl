---
status: complete
created: 2026-10-14
tags: [architecture, rust, cli, graphql, cache, operator, cutover]
priority: high
depends_on: [0002-lnr-rust-port, 0003-borrow-researchd-xerj]
---

# 0004-complete-rust-cutover

## Overview

Complete the strangler cutover of `lnr` (`linearctl`) from the 98 MB Bun-bundled TypeScript CLI to the native ~5 MB Rust binary (`crates/lnr-cli`). Port all remaining CLI subcommands (`search`, `pull`, `relate`, `link`, `comments`, `digest`, `triage`, `stale`, `standup`, `mine`, `cycle`, `doc`, `milestone`, `reorg`, `cache`, `operator`, `watch`, `auth`, `backup`, `history`, `initiative`, `park`, `release-notes`, `roadmap`, `tui`) into `crates/lnr-domain` and `crates/lnr-cli`, eliminate the generic fallback stub in `crates/lnr-cli/src/cli.rs`, and update `Makefile` so `make build` installs the compiled Rust binary to `dist/lnr` and `dist/linearctl`.

## Design

### 1. Domain Filter & Grooming Pure Functions (`crates/lnr-domain/src/models.rs`)

- **`SearchFilterInput` & `build_issue_filter(&SearchFilterInput)`:** Pure zero-I/O GraphQL `IssueFilter` composer supporting `team_keys`, `state` (with aliases `todo` -> `unstarted`, `done` -> `completed`, `in-progress` -> `started`, `all`), `state_set` (OR across states), `labels`, `assignee`, `project`, `milestone`, `priority`, `text` (`title`/`description` `containsIgnoreCase`), `updated_since`, and `created_since`.
- **Grooming & Triage Classifiers (`triage_reasons`, `group_by_state_type`, `render_standup_markdown`, `render_mine_text`):** Pure domain classifiers for `triage`, `digest`, `standup`, `mine`, and `release-notes`.

### 2. GraphQL & Local State Adapters (`crates/lnr-cli/src/graphql.rs` & `store.rs`)

- **`LinearClient` Read & Write Methods:**
  - `search_issues` and `pull_issues` (funnel contract: `id`, `identifier`, `title`, `state`, `stateType`, `priority`, `labels`, `description`, `url`, `updatedAt`)
  - `relate_issue` (`issueRelationCreate` for `blocks`, `related`, `duplicate`) and `attach_link` (`attachmentLinkURL`)
  - `comments_by_author`, `issue_history`, `cycle_review`, `list_initiatives`, `roadmap_projects`
  - `doc_get_overview`, `doc_set_overview`, `doc_list`, `doc_create`, `doc_update`
  - `milestone_list`, `milestone_create`, `milestone_update`, `milestone_delete`, `milestone_gap`
  - `reorg_census`
- **Local Cache & Operator Probes (`crates/lnr-cli/src/store.rs`):**
  - Dual-path `.lnr` / `.linearctl` local issue cache (`cache sync`, `cache status`, `cache clear`, `cache query`)
  - Operator Unix-socket readiness/liveness probe (`operator --check`, `operator --health`) and status reporting

### 3. Binary Cutover (`Makefile`)

- `make build-rust` compiles `lnr-cli` (`-j 2`) and copies the native Rust binary to `dist/lnr` and `dist/linearctl` so the production CLI artifacts are native Rust binaries while keeping `bun run build` and `bun test` green for CI parity.

## Plan

- [x] Author LeanSpec `0004-complete-rust-cutover.md` and register in `specs/README.md`.
- [x] Add pure `IssueFilter` and grooming/digest/triage/standup/mine domain functions in `crates/lnr-domain/src/models.rs`.
- [x] Implement remaining GraphQL queries/mutations in `crates/lnr-cli/src/graphql.rs` and local cache/operator state helpers in `crates/lnr-cli/src/store.rs`.
- [x] Replace the fallback command arm in `crates/lnr-cli/src/cli.rs` with explicit handlers for all remaining commands.
- [x] Update `Makefile` so `make build` installs the native Rust binary into `dist/lnr` and `dist/linearctl`, and add integration tests in `crates/lnr-cli/tests/agent_contract.rs`.

## Test

```bash
cargo test --workspace --locked -j 2
make check JOBS=2 && make smoke JOBS=2 && make spec-check toolchain-check JOBS=2
```

## Notes

- Preserves zero-I/O purity in `crates/lnr-domain` and zero new external crates in `Cargo.lock`.
