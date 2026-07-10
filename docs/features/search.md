# Feature: `linearctl search` — arbitrary-criteria issue search

**Status:** ticketed — [CER-1560](https://linear.app/cerebral-work/issue/CER-1560)
**Command:** `linearctl search [--team CER] [--state <type|name>] [--label <name>] [--assignee <email|me|none>] [--project <ref>] [--priority <0-4>] [--text <query>] [--json]`
**Roadmap:** net-new (not in §7)
**Milestone:** M3

## Motivation

Every existing command is **purpose-built** — `triage` finds triage-able
issues, `stale` finds old issues, `digest` finds recent activity. But the
recurring ad-hoc pattern is: *"give me all issues in team X with label Y,
assigned to Z, in state W"* — a general query that doesn't fit any single
command's fixed filter.

Today you either:

1. Open the Linear web app and use the filter UI (not scriptable).
2. Chain `triage --json | jq '.[] | select(...)'` — works, but `triage`'s
   filter is fixed (triage-state / unassigned / unestimated); you can't ask
   it for "all *Done* issues with label `bug` assigned to me" because
   `triage` excludes completed issues by design.

The gap: a **general search/filter command** — the `grep` for Linear issues.
Not a purpose-built sweep, a composable query.

## Proposal

```
linearctl search --team CER --state done --label bug --json
linearctl search --team CER --assignee me --priority 1 --json
linearctl search --team CER --assignee none --state started --json
linearctl search --team CER --project "Reverie" --state started --json
linearctl search --team CER --text "rate limit" --state all --json
```

### Filters

All filters are optional and composable (AND logic):

| Flag | Values | Maps to |
|------|--------|---------|
| `--team` | key(s), repeatable | `team.key.in` (omit = all) |
| `--state` | `triage\|backlog\|todo\|started\|in-progress\|review\|done\|canceled\|all` (by type or name) | `state.type.in` or `state.name.eq` |
| `--label` | name(s), repeatable | `labels.name.in` (resolved to IDs) |
| `--assignee` | `me` / `email` / `name` / `id` / `none` | `assignee.id.eq` or `assignee.isNull` |
| `--project` | UUID / slug-id / name | `project.id.eq` |
| `--priority` | `0-4` / `none` | `priority.eq` or `priority.isNull` |
| `--text` | free-text query | Linear's `search` term (full-text) |
| `--updated-since` | window (`7d`, `24h`) | `updatedAt.gte` |
| `--created-since` | window | `createdAt.gte` |

`--state all` overrides the default (which is active states only — excludes
`done`/`canceled`, matching `triage`).

### Behavior

- Default scope: **active states** (all except completed/canceled) across all
  accessible teams — same safe default as `triage`. Use `--state all` or
  `--state done` to include completed.
- `--assignee none` finds **unassigned** issues (a common triage query).
- `--text` uses Linear's full-text search via the `search` field on the issue
  query (or the dedicated `searchIssues` query if available). Combined with
  structured filters for "search within a filtered set."
- Output: table by default (identifier / state / assignee / title), `--json`
  for structured.
- Paginated (same `fetchNext()` pattern as `digest`/`triage`).

## Why not just extend `triage`?

`triage` has an opinionated contract: it surfaces issues **needing triage**
with computed *why*-reasons. Its filters are fixed to that intent. General
search is a different intent — **answer a query**, not **surface a grooming
backlog**. Conflating them means either `triage` grows unbounded flags
(muddying its contract) or `search` is a thin alias (confusing). A separate
verb keeps each clean.

## API surface

Single paginated `issues` query with composed filters — the same query
pattern `triage` and `digest` use, just with a flexible filter builder. The
`--text` flag may use Linear's `search` parameter on the issue query or a
separate `searchIssues` root — needs SDK verification.

`--assignee me` resolves via `client.viewer` (same as `whoami`); `--assignee
<email|name>` resolves via `users` query.

## Non-goals

- **No saved searches / filters.** Linear's web app has saved views; the CLI
  is stateless. A named-filter feature is possible later but adds
  persistence (a config file), which the current design avoids.
- **No full-text search ranking.** `--text` passes through to Linear's
  search; we don't re-rank.
- **No search across comments/descriptions specifically.** `--text` searches
  the issue's indexed text (title + description); deep comment search is
  Linear's job.

## Alternatives considered

- **`jq` on `triage --json`.** Limited to `triage`'s fixed filter (active +
  triage-able). Can't query completed issues, can't filter by assignee/priority
  arbitrarily. `search` is a superset.
- **Linear's web filter URL deep-link.** Not scriptable; can't feed a CI gate
  or a cron job.

## Verification

- `linearctl search --team CER --state done --json | jq 'length'` matches the
  count in the Linear web app's Done view for CER.
- `linearctl search --team CER --assignee none --state started` returns only
  unassigned, in-progress issues.
- `linearctl search --team CER --label bug --priority 1 --json` returns only
  priority-1 issues carrying the `bug` label.
- `linearctl search --text "rate limit" --state all` returns issues whose
  title/description mention "rate limit", including done ones.
