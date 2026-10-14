---
status: complete
created: 2026-10-14
tags: [rust, intake, escapement, runbook, cli]
priority: high
depends_on: [0005-k8s-operator-crds-and-blackwall]
---

# 0006-intake-plan-submission-and-runbook

## Overview

Add the canonical operational setup and usage runbook (`docs/runbooks/linearctl.md`) and implement the `lnr → escapement` intake edge (`lnr intake` / `crates/lnr-domain::intake` / `src/core/intake.ts`) that maps Linear issues and enriched `lnr triage` items into escapement `PlanSubmission` payloads while preserving `linear_issue_id` for round-trip status reporting.

## Design

### Enriched `TriageItem`

Both `src/core/grooming.ts` and `crates/lnr-domain/src/models.rs` include `labels: Vec<String>` (`string[]`), `project: Option<String>` (`string | null`), and `estimate: Option<f64>` (`number | null`) on `TriageItem`.

### Pure Domain Intake (`crates/lnr-domain::intake` and `src/core/intake.ts`)

`crates/lnr-domain/src/intake.rs` defines zero-I/O types and functions:

- `IntakeCandidate`: normalized Linear issue / triage item snapshot (`identifier`, `title`, `description`, `url`, `team`, `project`, `priority`, `estimate`, `state`, `state_type`, `labels`, `assignee`).
- `IntakePolicy`: configurable eligibility rules (`required_labels`, `blocked_labels`, `allowed_state_types`, `default_workflow`, `tokens_per_point`, `default_max_tokens`).
- `ExecutionTier`:
  - Priority `1` (Urgent) or `2` (High) → `capable`
  - Priority `3` (Medium) → `balanced`
  - Priority `4` (Low) → `fast`
  - Priority `0` (No priority) → `review`
- Workflow selection from labels:
  - `security`, `cve`, `vulnerability` → `security-fix`
  - `bug`, `incident`, `regression`, `defect` → `bugfix`
  - `docs`, `documentation`, `runbook` → `docs`
  - `chore`, `maintenance`, `refactor`, `deps` → `chore`
  - Otherwise → `policy.default_workflow` (default `"feature"`)
- Token budget (`PlanBudget`):
  - `max_tokens = round(estimate * tokens_per_point)` when `estimate > 0`, clamped to `[min_tokens, max_tokens_cap]`, or `default_max_tokens` (`64_000`) when unestimated.
- `PlanSubmission`:
  - `schema_version`: `"escapement.plan-submission.v1"`
  - `linear_issue_id`: canonical issue identifier (e.g. `"ENG-123"`) preserved verbatim for round-trip correlation.
  - `title`, `goal`, `workflow`, `tier`, `priority`, `budget`, `labels`, `metadata` (`team`, `project`, `state`, `state_type`, `estimate`, `assignee`, `source_url`).

### CLI Surface (`lnr intake`)

- `lnr intake <ID> [--json]` evaluates a single Linear issue and outputs its `PlanSubmission` (or eligibility decision).
- `lnr intake --triage [--team <KEY>] [--require-label <LABEL>] [--all] [--json]` evaluates the team's triage queue and emits `PlanSubmission` payloads for eligible issues.

## Plan

- [x] Author spec `0006-intake-plan-submission-and-runbook.md` and register in `specs/README.md`.
- [x] Author canonical operational runbook `docs/runbooks/linearctl.md`.
- [x] Enrich `TriageItem` in `crates/lnr-domain/src/models.rs` and `src/core/grooming.ts` with `labels` and `project`.
- [x] Implement pure `lnr → escapement` intake domain logic in `crates/lnr-domain/src/intake.rs` and `src/core/intake.ts`.
- [x] Wire `lnr intake` CLI subcommand and `examples/intake.sh` in both Rust and TypeScript.
- [x] Add unit and contract tests in `test/intake.test.ts` and `crates/lnr-cli/tests/agent_contract.rs`.

## Test

```bash
cargo test --workspace --locked -j 2
make hygiene JOBS=2
```

## Notes

- Preserves zero-I/O purity in `crates/lnr-domain` and zero new external crates in `Cargo.lock`.
