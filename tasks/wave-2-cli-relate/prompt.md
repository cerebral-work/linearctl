# Task: Wave 2 - Implement CLI Commands and Relate Integration ({{ticket}})

You work in the `linearctl` TypeScript codebase.
Confine all edits strictly to `src/commands/` (`relate.ts`, `file.ts`, `update.ts`, `search.ts`).
Do not touch core cache or test suites.

## Background

linearctl exposes developer and agent CLI commands to interact with issues and dependency graphs.
The Critical Path Method (CPM) designates Wave 2 as the interface layer consuming Wave 1 cache primitives.

## Requirements

1. **Relate Command (`src/commands/relate.ts`)**:
   - Provide CLI commands to create `--blocked-by`, `--blocking`, `--related-to`, and `--duplicate-of` links.
   - Support `--json` machine-readable output.

2. **Write-Through Mutation**:
   - Wire issue mutations in `file.ts`, `update.ts`, and `relate.ts` to write directly through to the local SQLite cache.

3. **Cache Query Integration**:
   - Use `pullCachedIssues` and `searchCachedIssues` when `--cache` or `LINEARCTL_CACHE=true` is enabled.

## Boundaries and Invariants

- Confine all file changes strictly to `src/commands/`.
- `bun run typecheck` and `bun test test/relate-cli.test.ts test/search.test.ts` must pass cleanly.
