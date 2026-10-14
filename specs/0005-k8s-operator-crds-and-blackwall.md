---
status: complete
created: 2026-10-14
tags: [rust, operator, kubernetes, blackwall, mcp]
priority: high
depends_on: [0004-complete-rust-cutover]
---

# 0005-k8s-operator-crds-and-blackwall

## Overview

Complete the Horizon 2 Kubernetes operator controller/CRD surface (`LinearProject`, `LinearDigestSchedule`, `LinearTicketBinding`), the Horizon 3 Blackwall task-batch digest output (`digest --format blackwall` and `schema_version: 1`), and the opt-in Helm chart MCP supergateway bridge across both the pure-Rust workspace (`crates/lnr-domain`, `crates/lnr-cli`) and the TypeScript runtime (`src/`).

## Design

### 1. Operator Runtime & CRDs (`linear.cerebral.work/v1alpha1`)
- **`operator` command flags**:
  - `--namespace <ns>`: Scopes watched resources (default `linear-system`).
  - `--emit-crds`: Emits the three CustomResourceDefinition manifests (`linearprojects.linear.cerebral.work`, `lineardigestschedules.linear.cerebral.work`, `linearticketbindings.linear.cerebral.work`) as multi-document YAML (or JSON array when `--json` is passed) and exits 0 without starting the daemon.
  - `--reconcile <file>`: Reconciles a single Custom Resource manifest from disk (`-` for stdin) and prints the reconciled status/plan (JSON when `--json` is passed).
- **`LinearProject` (`Scope: Cluster`)**:
  - `spec`: `{ projectRef, team, syncInterval? }`.
  - `status`: `{ milestones[], triageCount, staleCount, lastSync, conditions[] }`.
  - Condition `Stale` is `"True"` (`reason: "StaleIssuesPresent"`) when `staleCount > 0`, and `"False"` (`reason: "NoStaleIssues"`) otherwise.
- **`LinearDigestSchedule` (`Scope: Namespaced`)**:
  - `spec`: `{ schedule, team, since, output: { configMap, namespace? }, json? }`.
  - `status`: `{ lastRun, lastConfigMapVersion, issueCount }` plus rendered Kubernetes `ConfigMap` (`data["digest.json"]` or `data["digest.txt"]`, annotated with `linear.cerebral.work/version`).
- **`LinearTicketBinding` (`Scope: Namespaced`)**:
  - `spec`: `{ ticket, apply?, resource: { apiVersion, kind, name, namespace }, rules: [{ when, then, state?, comment? }] }`.
  - `status`: `{ lastEvent, ticketState, plannedAction?, applied, shippingComment?, lastSync }`.
  - Dry-run by default (`spec.apply !== true` records `plannedAction` with `applied: false`).
- **Static Chart CRDs & MCP Supergateway**:
  - Commit static CRDs under `deploy/chart/crds/`.
  - Add opt-in `mcp:` block in `deploy/chart/values.yaml` and `deploy/chart/templates/mcp-service.yaml` to bridge `linearctl mcp serve` stdio over supergateway SSE/HTTP in-cluster.

### 2. Blackwall Digest Contract (`schema_version: 1` & `--format blackwall`)
- `DigestResult` in both `lnr-domain` and `src/core/grooming.ts` includes `schema_version: 1`.
- `lnr digest --format blackwall` emits valid TOML with `schema_version = 1`, `since = "..."`, and `[[task]]` tables containing `id`, `title`, `state`, `state_type`, `url`, and `prompt`.

## Plan

- [x] Author spec `0005-k8s-operator-crds-and-blackwall.md` and register in `specs/README.md`.
- [x] Implement `schema_version: 1`, `render_blackwall_toml`, and pure K8s CRD/reconciliation models in `crates/lnr-domain` and `crates/lnr-cli`.
- [x] Implement `schema_version: 1`, `renderBlackwallToml`, `src/core/k8s-operator.ts`, and operator CLI flags in `src/`.
- [x] Add `deploy/chart/crds/*.yaml` and `deploy/chart/templates/mcp-service.yaml`.
- [x] Add unit and contract tests in `test/` and `crates/lnr-cli/tests/agent_contract.rs`.

## Test

```bash
cargo test --workspace --locked -j 2
make check JOBS=2 && make smoke JOBS=2 && make spec-check toolchain-check JOBS=2
```

## Notes

- Preserves zero-I/O purity in `crates/lnr-domain` and zero new external crates in `Cargo.lock`.
