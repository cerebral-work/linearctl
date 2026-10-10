# Task: Wave 1 - Implement Core Cache and Funnel Invariants ({{ticket}})

You work in the `linearctl` TypeScript codebase.
Confine all edits strictly to `src/core/cache/`.
Do not touch any CLI commands or top-level project files.

## Background

linearctl requires an in-process local SQLite cache using `bun:sqlite` and Drizzle ORM.
It stores issues, teams, states, labels, projects, cycles, milestones, and issue relations.
The Critical Path Method (CPM) designates Wave 1 as the foundation for local lookups and funnel queries.

## Requirements

1. **Drizzle ORM Schema (`src/core/cache/schema.ts`)**:
   - Maintain strict SQLite table definitions for all Linear entities.
   - Maintain FTS5 virtual table `issues_fts` and database triggers for automatic index maintenance.

2. **Delta Sync Engine (`src/core/cache/sync.ts`)**:
   - Fetch updated records using `updatedAt >= last_sync_at`.
   - Batch insert into SQLite using transactional Drizzle queries.
   - Enforce write-through mutations via `patchIssueInCache` and `deleteIssueFromCache`.

3. **Funnel Contract Parity**:
   - Conform strictly to `docs/funnel-contract.md`.

## Boundaries and Invariants

- Confine all file changes strictly to `src/core/cache/`.
- `bun run typecheck` and `bun test test/cache-*.test.ts` must pass with zero errors.
