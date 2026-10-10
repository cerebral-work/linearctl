# Sprint Queue — linearctl-waves

**Saved:** 2026-10-10T05:35:00Z · **critical path makespan:** 145 minutes · **status:** ready

12 tasks across 4 sequential sprint waves (Wave 0 to Wave 3).

## Wave 0: Preflight & Baselines (3 tasks, 15 min)
- **W0.1** — Blackwall & Host Preflight: Verify host RAM floor >= 4000MB, no git lock, and blackwall doctor.
- **W0.2** — Baseline Typecheck & Test Gate: Run `bun run typecheck` and `bun test test/agent-help.test.ts`.
- **W0.3** — Herdr Pane Audit: Verify Herdr socket is active and `estate/w1B:p6` lane is authenticated.

## Wave 1: Core Cache & Funnel Invariants (3 tasks, 40 min)
- **W1.1** — Drizzle Schema & FTS5 Triggers (`src/core/cache/schema.ts`, `db.ts`): Table schemas and virtual tables.
- **W1.2** — Funnel Ingestion & Delta Sync Engine (`src/core/cache/sync.ts`): Sub-second incremental syncing.
- **W1.3** — Funnel Contract Parity Validation (`docs/funnel-contract.md`): Schema parity for downstream agents.

## Wave 2: CLI Commands & Relate Integration (3 tasks, 50 min)
- **W2.1** — Relate Commands & Blocking Links (`src/commands/relate.ts`): Graph relations and duplicate tracking.
- **W2.2** — Cache Query Engine & FTS5 Search (`src/core/cache/query.ts`): Sub-5ms queries and FTS5 ranking.
- **W2.3** — Write-Through Cache Invalidation (`src/commands/file.ts`, `update.ts`): Instant local cache write-through.

## Wave 3: Verification, Benchmarking & Land-on-Green (3 tasks, 40 min)
- **W3.1** — Cache Guardrail Benchmarking (`scripts/benchmark-cache.ts`): p99 <= 2ms point lookup and <= 5ms funnel query.
- **W3.2** — E2E Suite & Agent-Help Contract (`test/agent-help.test.ts`): Full 1,200+ test suite pass.
- **W3.3** — Single-Binary Compilation & Landing (`bun run build`): Standalone binary packaging and signed land-on-green.

---
Reproduce with: `./scripts/cpm-wave-runner.sh --wave all`
