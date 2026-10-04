# Feature: `linearctl backup` — verifiable workspace dump

**Status:** implemented
**Command:** `linearctl backup --out <dir> [--include-history] [--since <window>] [--team KEY...] [--limit <n>] [--entities <csv>] [--resume] [--no-markdown] [--json]` · `linearctl backup --verify <dir> [--tolerance <fraction>] [--offline] [--json]`
**Roadmap:** net-new (not in §7)

## Motivation

Linear keeps no export that is complete, scriptable and checkable. Before any
bulk change (a reorganisation, a migration, a plugin that writes at scale) you
want a copy of the workspace you can prove is intact, and a way to re-prove it
later. `pull` exports issues only, for the soma funnel. `backup` covers every
entity type and ships a verifier.

## Proposal

`backup --out <dir>` is read-only. It creates `<dir>/linear-<UTC>/` containing:

- `manifest.json` — workspace id/urlKey, linearctl version, started/finished,
  scope, `partial`, per-entity `{count, file, sha256, bytes}`, minimum
  `x-ratelimit-requests-remaining` seen, `warnings[]`.
- one `<entity>.jsonl` per entity, rows sorted by id, relations stored as
  `*Id` fields only.
- `issues-md/<TEAM>/<identifier>.md` — one readable file per issue. The header
  block is `renderIssueDetail` (the same text `show` prints); comments follow.
  `--no-markdown` skips it.

Entities: organization, users, teams, workflowStates, issueLabels, issues,
comments, attachments (metadata and URLs only, never fetched), issueRelations,
projects, projectMilestones, projectUpdates, initiatives, initiativeToProjects,
documents, cycles, customViews, projectStatuses, projectLabels,
initiativeLabels, templates, customers, customerNeeds. `issueHistory` is added
by `--include-history`.

A one-shot schema introspection checks that every root connection exists; any
that does not is skipped and named in `warnings[]` (and the dump is `partial`).
Nothing is dropped silently.

Fields that are sensitive or bulky are not requested: organization auth/SAML/
SCIM settings, user calendar hashes, editor-state blobs, reaction blobs and
progress-history arrays.

### Scope flags

| flag | effect |
|---|---|
| `--team KEY...` | issues, workflow states, labels, cycles and teams filtered server-side; comments, attachments and relations kept only for the dumped issues. Other entities are dumped in full and named in `warnings[]`. Marks the dump `partial`. |
| `--since <window>` | `7d`, `24h`, `2w` or an ISO date. Server-side `updatedAt` filter on issues, comments, projects, documents and initiatives. Marks `partial`. |
| `--limit <n>` | cap rows per entity (smoke tests). Marks `partial`. |
| `--entities <csv>` | only these entities. Marks `partial`. |
| `--include-history` | second pass, one request per issue, resumable, sleeps for a minute whenever fewer than 100 requests remain in the hour. Off by default. |
| `--resume` | continue the latest interrupted run under `--out`. Flags must match the original run. Finished entities are re-read from disk; the history pass skips issues already fetched. |

### `backup --verify <dir>`

1. Recompute sha256, byte size and line count of every file against the manifest.
2. Check referential integrity inside the dump (state, team, project, assignee,
   parent, issue references). On a full dump a dangling id fails; on a partial
   dump it is reported as a note.
3. Compare live per-entity counts to the manifest (full dumps only).
4. Spot-check five random issues against the live API. Identifier, creation
   time and team must match. Title, description, priority and state may differ
   only if the issue was edited after the dump (live `updatedAt` is newer);
   that is noted, not failed. A difference with no newer `updatedAt` fails.

`--offline` runs steps 1 and 2 only. `--tolerance` is the allowed live count
drift per entity as a fraction (default `0.02`).

Live-drift semantics: step 3 is the only place `--tolerance` applies. Edits made
after the dump are expected on a live workspace and never fail the sample.

Exit codes: `0` ok · `1` hash, count or reference mismatch (or runtime error) ·
`2` live drift beyond tolerance, or a sampled issue differs · `3` usage.

### Teams the key cannot list

Private or archived teams can own rows (workflow states, for example) without
appearing in the `teams` query. Such ids are recorded in
`manifest.unresolved.teams` and in `warnings[]`; verify accepts exactly those
ids as dangling and no others.

## Behavior

- Read-only: no mutation is ever sent.
- `manifest.requests` is the total GraphQL request count for the run (resumed
  segments included), so the rate-limit budget used is visible.
- History is stored as raw history nodes (ids, as returned), not rendered
  through the timeline normaliser. This is deliberate: a backup keeps the
  source records; rendering is a read-time concern. Checkpoints are written
  every 50 issues, and a finished history pass is reused by `--resume`.
- The unlisted-team check (below) is skipped under `--limit` and `--since`,
  where a truncated `teams` page would make it report false entries.
- Auth is `LINEAR_API_KEY` from the environment, as for every command. The key
  is never written to any output file.
- Transient errors (rate limit, 5xx, transport) retry with the shared backoff.
- Pages are `first:100` with `includeArchived:true`; rows repeated across pages
  are de-duplicated by id.
- A full base dump of a workspace with about 5,000 issues takes roughly 270
  requests and a couple of minutes. History adds one request per issue.

## API surface

- Introspection: `__type(name: "Query") { fields { name } }`, once per run.
- Reads: one paginated query per entity (`first: 100`, `includeArchived: true`),
  and `organization` and `templates` as single reads. `--since` and `--team`
  add a `filter:` argument where the connection supports it.
- History: `issue(id) { history(first: 100, includeArchived: true) }`, one
  request per issue plus pages.
- Verify: `first: 250` id-only pages for live counts, and one `issue(id)` read
  per sampled issue.
- No mutations.

## Alternatives considered

- **Reuse `pull`.** Rejected: it is issues-only, active states by default, and
  its output shape is a contract for another consumer.
- **One JSON file per run.** Rejected: JSON Lines streams, diffs line by line,
  and lets verify hash and count each entity independently.
- **SDK model objects instead of raw GraphQL.** Rejected: the SDK resolves
  relations lazily, one request per relation; flat selections cost a few hundred
  requests for the whole workspace.
- **Render history with the timeline normaliser.** Rejected for the backup
  itself, see Behavior.
- **Fail verify on any live difference.** Rejected: a live workspace changes
  while you verify.

## Non-goals

- No upload, encryption or retention: the command writes a directory. Moving it
  elsewhere is the caller's job.
- No restore. The dump is a record; re-creation is a separate, deliberate step.
- No attachment binaries.

## Verification

- `linearctl backup --out ./b --team CER --limit 50` then
  `linearctl backup --verify ./b/linear-*` → exit 0.
- Edit one line of any `.jsonl` → `--verify` exits 1 and names the file.
- `bun test test/backup.test.ts`.
