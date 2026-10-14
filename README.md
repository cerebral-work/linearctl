<h1 align="center">lnr <sub>(linearctl)</sub></h1>

<p align="center">
  <em>Linear API orchestration — from headless CLI to in-cluster reconciliation loop.</em>
</p>

<p align="center">
  <img alt="built with bun" src="https://img.shields.io/badge/built%20with-bun-000000?logo=bun&logoColor=white">
  <img alt="Rust 1.94.1" src="https://img.shields.io/badge/Rust-1.94.1-000000?logo=rust&logoColor=white">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white">
  <img alt="@linear/sdk v86" src="https://img.shields.io/badge/%40linear%2Fsdk-v86-5e6ad2?logo=linear&logoColor=white">
  <img alt="tests" src="https://img.shields.io/badge/tests-100%2B%20passing-brightgreen">
  <img alt="Helm chart" src="https://img.shields.io/badge/Helm-chart-0f1689?logo=helm&logoColor=white">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

<p align="center">
  <a href="https://github.com/cerebral-work/lnr/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/cerebral-work/lnr/ci.yml?label=CI"></a>
  <a href="https://github.com/cerebral-work/lnr/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/cerebral-work/lnr?display_name=tag"></a>
  <a href="https://linear.app/docs/loops"><img alt="Loops" src="https://img.shields.io/badge/Loops-9%20recipes-5e6ad2"></a>
</p>

---

## What is this?

`lnr` (backward-compatible CLI alias: `linearctl`) is a **Linear API orchestrator** — a single-binary CLI and service that runs three ways:

1. **CLI** — headless commands (`lnr <command>` or `linearctl <command>`) for the Linear workflows you keep
   re-improvising by hand: `pull`, `cache`, `digest`, `triage`, `stale`, `file`,
   `update`, `comment`, `milestone`, `cycle`, `roadmap`, `plan`, `release-notes`,
   `standup`, `xref`, `search`, `show`, `history`, `loops lint`, and more.
2. **MCP server** — `lnr mcp serve` exposes 12 tools to Claude Desktop /
   Claude Code over stdio.
3. **In-cluster Deployment** — a Helm chart deploying a leader-elected
   always-on `Deployment` that owns the schedule + webhook ingress, publishes
   digests to Linear Pulse / Slack / web / email, and serves the funnel
   contract for downstream Kubernetes operators.

Built on the official [`@linear/sdk`](https://www.npmjs.com/package/@linear/sdk)
v86 + live Linear GraphQL API, paired with an estate Rust strangler workspace (`crates/lnr-domain`, `crates/lnr-cli`, `xtask`). No scraping, no undocumented endpoints.

```mermaid
flowchart TD
  subgraph cli["CLI (headless)"]
    DEV["operator · script · CI<br/>lnr / linearctl · --json"]
  end
  subgraph mcp["MCP server"]
    CLAUDE["Claude Desktop / Code<br/>12 tools over stdio"]
  end
  subgraph cluster["In-cluster Deployment (Helm)"]
    LEADER["leader pod<br/>schedule + webhook + publish"]
    STBY["standby pod<br/>waits on lease"]
    LEADER --> SINK["sinks: Pulse · Slack · web · email"]
  end
  CRON["internal scheduler<br/>5min tick + named jobs"] --> LEADER
  WEBHOOK["Linear webhook<br/>ProjectUpdate · AgentSession"] -->|HTTPS| LEADER
  FUNNEL["funnel contract<br/>lnr pull --json"] --> OPERATOR["soma-operator<br/>(separate deployment)"]
  DEV --> cli
  CLAUDE --> mcp
```

## Quickstart

### As a CLI

```bash
# install via mise (no Node runtime — bun embeds it)
mise use -g "github:cerebral-work/lnr"
lnr whoami
lnr digest --since 7d --team CER --json | jq
# `linearctl` remains supported as a backward-compatible binary alias
```

### As an in-cluster Deployment

```bash
# add the chart (from the repo — no remote registry yet)
helm install linearctl ./deploy/chart \
  --set secrets.linearApiKey.secretName=linearctl-linear-api-key \
  --set deployment.publish.dryRun=true

# verify
kubectl get pods -l app.kubernetes.io/name=linearctl
kubectl logs deploy/linearctl-orchestra -f
```

<details>
<summary><strong>Develop from source</strong></summary>

```bash
bun install                 # bun ≥ 1.3 (see .prototools)
bun run dev -- whoami       # run from source
make check                  # tsc + rustfmt + clippy (-j 2) + bun test + cargo test (-j 2) + cargo deny
make smoke                  # latency benchmark + CLI contract + zero-I/O Rust domain check
bun run build               # bun build --compile → dist/lnr + dist/linearctl
helm template ./deploy/chart # render the chart locally
```
</details>

## Local SQLite ORM Cache (`linearctl cache` / `--cache`)

Embedded in-process cache powered by `bun:sqlite` and Drizzle ORM. Eliminates remote GraphQL latency (300–800ms) down to **<0.5ms p99**, preventing rate-limit exhaustion during high-frequency agent reconciliation loops (`soma-operator`, `godseat`).

```bash
# Delta sync from Linear GraphQL (fetches only updatedAt >= last_sync_at)
linearctl cache sync

# Inspect local database path, size, and entity counts
linearctl cache status

# Fast-path pull (<0.5ms p99, zero network calls, exact funnel contract parity)
linearctl pull --cache --team EST --state-set Todo --state-set Backlog --label soma-ingest

# Sub-millisecond FTS5 full-text search
linearctl search --cache "reconcile loop" --team CER --json
```

- **Write-Through Mutation:** `file`, `update`, and `close` automatically update local SQLite rows upon successful API response for instant read-after-write consistency.
- **Single-Binary:** Fully self-contained in `dist/linearctl` with zero external database processes or runtime C dependencies.
- **Full Architecture & Reference:** See [`docs/features/local-cache.md`](./docs/features/local-cache.md).

## Optional Beads Graph Integration (`linearctl beads` / `pull --beads`)

Discovery-based integration with [gastownhall/beads](https://github.com/gastownhall/beads) (`bd`). Enables AI coding agents and autonomous loops to track Linear issue dependencies locally and find unblocked work (`ready` tasks) without network overhead.

```bash
# Initialize local Beads workspace in the current repository
linearctl beads init --team CER

# Inspect graph status and unblocked ready count
linearctl beads status

# Synchronize issues and blocking relations between Linear and local Beads graph
linearctl beads sync

# Discover unblocked ready tasks
linearctl beads ready --json

# Stream only unblocked tasks through the ingestion funnel
linearctl pull --beads --json

# Atomically claim an unblocked task locally
linearctl beads claim CER-101 --push

# Close a task and immediately unblock downstream dependencies
linearctl beads close CER-101 --reason "Fixed in commit abc123" --push
```

- **Non-Invasive:** Projects without Beads continue to function identically with zero overhead.
- **Dual Execution Engine:** Fully interoperable with the system `bd` CLI if installed; embeds an autonomous standalone graph engine when `bd` is not present.
- **Full Architecture & Reference:** See [`docs/features/beads.md`](./docs/features/beads.md).

## The funnel contract — machine-to-machine Linear control

The core in-cluster primitive. `linearctl pull` + `linearctl update --state` +
`linearctl comment` form a **headless funnel contract** — the exact PULL +
TRANSITION + COMMENT surface a Kubernetes operator needs to control Linear
issues without a human at a terminal.

```bash
# The soma-operator's exact funnel query (deployed on Cygnus, proven with EST-83):
linearctl pull --team EST --state-set Todo --state-set Backlog --label soma-ingest --json

# Fast-path cached read:
linearctl pull --cache --team EST --state-set Todo --state-set Backlog --label soma-ingest --json

# Transition (sends ONLY { stateId } — description-clobber invariant, tested):
linearctl update EST-83 --state "In Progress" --json

# Comment:
linearctl comment EST-83 --body "dispatched to worker X" --json
```

**10 stable JSON fields per issue:** `id` (UUID), `identifier`, `title`, `state`,
`stateType`, `priority`, `labels`, `description`, `url`, `updatedAt`.

**Hard invariant:** a state-only update never round-trips the description —
verified live against the API, tested in `test/funnel-parity.test.ts`. The
soma-operator's CI conformance test runs `linearctl pull` full-unbounded and
asserts its own GraphQL returns the same set — no runtime coupling, just
contract parity. Full spec: [`docs/funnel-contract.md`](./docs/funnel-contract.md).

## In-cluster Deployment (`deploy/chart/`)

| Manifest | What it does |
|---|---|
| `deployment.yaml` | 2-replica `Deployment`, leader-elected via `coordination.k8s.io/Lease`. Non-root, read-only rootfs, all capabilities dropped. Runs `linearctl loops lint` on startup (fails readiness if recipes are invalid). |
| `rbac.yaml` | `ServiceAccount` + minimal `Role` (lease create/get/update only — no cluster-wide perms). |
| `service.yaml` | `ClusterIP` + `ServiceMonitor` (Prometheus) + `PodDisruptionBudget` (minAvailable: 1). |
| `loop-recipes-cm.yaml` | Mounts `.linearctl/loop-recipes/*.md` as a ConfigMap. Pod restarts on recipe changes (checksum annotation). |
| `ingress.yaml` | Linear webhook ingress (`/webhook`) with signature verification at the edge. |

**Safe-by-default:** `dryRun: true` out of the box — the opera logs "would
publish" + dedup hash, no mutations. Operator sign-off gates the first publish
per (surface × audience) pair. Secrets resolved from
[OpenBao](https://openbao.org) via `ExternalSecret` — never in Helm values.

See [the Helm chart values](./deploy/chart/values.yaml) for the full
configuration surface.

## Linear Loops recipe catalog

9 versioned, lint-validated recipes for
[Linear Loops](https://linear.app/docs/loops) — the recurring AI-driven
workflows launched July 2026. Loops have no public API yet (the
`WorkflowDefinition` schema type exists but has no query or mutation surface —
verified via live `__schema` introspection), so these recipes are the **design
authority** the operator pastes into Linear's "Create loop" UI:

| Recipe | Trigger | What it does |
|---|---|---|
| `bug-triage-dispatcher` | issue → Triage | investigate root cause via Code Intelligence, comment recommendation |
| `triage-debt-weekly-sweep` | Mon 09:00 | comment on top-10 oldest unassigned/unestimated issues |
| `project-update-synthesizer` | Fri 16:00 | draft weekly Project Updates (draft, never publish) |
| `carry-over-warning` | cycle ends <2d, unstarted | warn assignee of carry-over risk |
| `plan-doc-drift-detector` | Mon 10:00 | diff `roadmap-*.md` ↔ Linear project overview |
| `cross-platform-handoff-design` | issue created, label=design-system | create platform-specific sub-issues |
| `release-notes-attach` | milestone → completed | assemble release notes grouped by label |
| `pulse-curator` | weekdays 09:00 | score Project Updates on clarity/signal/staleness |
| `triage-rationale-checker` | issue leaves Triage | check assignee+estimate+priority+labels |

```bash
linearctl loops lint
# → 9 recipe(s), 0 error(s), 0 warning(s) ✓ all recipes valid
```

Each recipe carries a `last_verified` date — staleness is visible, not silent.
When Linear ships a Loops API, the YAML maps 1:1 to `WorkflowDefinition`
fields — `loops apply` and `loops diff` become CRUD wrappers with zero design
churn. See [`.linearctl/loop-recipes/README.md`](./.linearctl/loop-recipes/README.md).

## Commands

All commands honor `--json`; mutating verbs are safe-by-default. Exit codes:
`0` ok · `2` usage · `3` auth · `4` not found · `5` rate limited · `6` refused · `1` other.
See [the agent contract](docs/agent-facility.md#headless-cli-contract) for JSON
errors, dry-run semantics and migration. Run `linearctl examples [command]`
for embedded shell examples.

### Read (15 commands)

`whoami` · `digest` · `pull` · `triage` · `stale` · `milestone` · `roadmap` ·
`cycle` · `xref` · `search` · `show` · `history` · `comments` ·
`release-notes` · `standup` · `ratelimit`

### Write (12 commands)

`file` · `update` · `close` · `comment` · `relate` · `project` · `milestone create` ·
`doc` · `link` · `label` · `park` · `template`

`backup` writes a verifiable read-only dump of the workspace to a local directory; `backup --verify <dir>` checks one (see [`docs/features/backup.md`](./docs/features/backup.md)).

### Loops + MCP

`loops lint` · `mcp serve`

### Reorg

`reorg census` · `reorg plan` · `reorg apply` · `reorg verify` · `reorg rollback`
— plan-file-driven workspace reorganization, dry-run by default with a
journaled, per-write-verified executor. See [`docs/features/reorg.md`](./docs/features/reorg.md).

Full reference: [`docs/spec.md` §6](./docs/spec.md). Product and architecture roadmap:
[`docs/roadmap.md`](./docs/roadmap.md). Tooling rationale:
[`docs/decisions.md`](./docs/decisions.md).

## Authentication

`LINEAR_API_KEY` from the environment — env only, never stored/printed/logged.
In-cluster: resolved from [OpenBao](https://openbao.org) via `ExternalSecret`,
injected as a `secretKeyRef`. A native OAuth `actor=app` path is future work.

## Build

```bash
cargo xtask ci        # the CI gate: tools, toolchain-check, fmt-check, clippy, test,
                      # doc-test, deny, typos, machete, then bun (stops at the first failure)
cargo xtask install   # cargo xtask ci, then a --locked release build of every Rust binary
```

`cargo xtask tools` installs the pinned gate tools (cargo-deny, typos-cli,
cargo-machete, cargo-nextest) with `cargo install --locked` when they are missing
or at another version; their versions live in `xtask/src/gate.rs`. The Rust
toolchain is pinned in `rust-toolchain.toml`.

The TypeScript CLI is not a cargo project, so `cargo xtask ci` calls bun
directly in its last step (`cargo xtask bun`): `bun install --frozen-lockfile`,
`bun run typecheck`, `bun test` and `bun run build`, the commands ci.yml's
`check` job runs. CI runs the same `cargo xtask ci` in the `xtask-ci` job.

## How it ships

Conventional Commits → **release-please** → tag → **bun cross-compiles** 4
targets (linux/macos × x64/arm64) → **SLSA-attested** tarballs → `mise`
verifies attestation on install. CI on every PR: `tsc --noEmit` · `bun test`
(100+ tests) · `bun build --compile` + `--version` smoke.

```mermaid
flowchart LR
  C["Conventional Commits"] --> RP["release-please"]
  RP --> TAG["tag vX.Y.Z"]
  TAG --> BUILD["bun build<br/>4 targets"]
  BUILD --> ATT["SLSA attestation<br/>(Sigstore)"]
  ATT --> MISE["mise install<br/>(verifies)"]
```

## Project stats

| | |
|---|---|
| **Commands** | 26 (read, write, loops, mcp) |
| **MCP tools** | 12 (7 read + 5 write) |
| **Tests** | 100+ (unit + live-contract + MCP handshake + funnel-parity + loop-recipes) |
| **Loop recipes** | 9 (linted, versioned, `last_verified` staleness-tracked) |
| **Helm chart** | `deploy/chart/` — Deployment + RBAC + Service + Ingress + ConfigMap + PDB |
| **Binary** | Single bun-compiled binary, 4 platforms, SLSA-attested |
| **Runtime** | No Node required — bun embeds the runtime |
| **Install (CLI)** | `mise use -g "github:cerebral-work/linearctl"` |
| **Install (cluster)** | `helm install linearctl ./deploy/chart` |

## Dogfooding

`linearctl` files its own backlog in Linear (team CER) via `linearctl file`,
grooms it with `triage` / `stale` / `xref`, and tracks milestones via
`milestone` / `roadmap`. The project is its own first user — and its own first
in-cluster reconciliation target.

---

<p align="center"><sub>Built for the Cerebral workspace · MIT · <code>chris@todie.io</code> · <a href="https://github.com/cerebral-work/linearctl">GitHub</a> · <a href="https://linear.app/cerebral-work">Linear</a></sub></p>
