# Task: Wave 3 - Verification, Benchmarking, and Land-on-Green ({{ticket}})

You work in the `linearctl` TypeScript codebase.
Confine all edits strictly to `test/` and `scripts/benchmark-cache.ts`.
Do not touch core logic or command implementations.

## Background

linearctl requires strict performance and CLI contract enforcement before landing.
The Critical Path Method (CPM) designates Wave 3 as the terminal verification phase.

## Requirements

1. **Performance Guardrails (`scripts/benchmark-cache.ts`)**:
   - Assert point lookup p99 <= 2ms.
   - Assert funnel query p99 <= 5ms.
   - Assert FTS5 text search p99 <= 10ms.

2. **Test Suite Verification**:
   - Verify all unit and integration tests pass with zero failures.
   - Assert agent help contracts in `test/agent-help.test.ts`.

3. **Packaging & Landing**:
   - Single-binary compilation via `bun run build`.

## Boundaries and Invariants

- Confine all file changes strictly to `test/` and `scripts/benchmark-cache.ts`.
- Full gate passes (`bun run typecheck && bun test && bun run bench:cache`).
