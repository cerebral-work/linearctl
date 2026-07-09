# Feature: `linearctl label` — label management

**Status:** proposed
**Command:** `linearctl label list|create|rename [--team CER] [--json]`
**Roadmap:** net-new (not in §7)
**Milestone:** M3

## Motivation

Labels are the organizing primitive across all of linearctl's teams, but
management is web-app-only. The recurring pattern: a new label is needed
mid-batch ("file these 12 issues with `scope:payments`" — but that label
doesn't exist yet), so you:

1. Stop the batch.
2. Open Linear, create the label.
3. Resume filing with `linearctl file --label scope:payments`.

There's also a **drift** pattern: the BRAND team has 40+ labels, many
duplicated across teams (`Bug`/`Feature`/`Improvement` exist on every team
with different IDs). There's no headless way to audit that — `triage` and
`stale` use labels but don't surface label health.

## Proposal

Three subcommands:

### `linearctl label list [--team CER] [--json]`

List labels for a team (or all teams), with usage counts (how many issues
carry each label). Exposes the drift: duplicate names across teams, unused
labels (0 issues), orphan labels (team deleted).

```
linearctl label list --team BRAND --json | jq '.[] | select(.issues == 0)'
```

### `linearctl label create <name> --team CER [--color <hex>] [--json]`

Create a label. `--color` defaults to Linear's auto-assigned color. Pairs with
`file --label` and `park` — the batch flow becomes:

```
linearctl label create scope:payments --team CER
linearctl file "..." --team CER --label scope:payments   # now resolves
```

### `linearctl label rename <old> <new> --team CER [--json]`

Rename a label (updates the label entity; all issues carrying it are
re-tagged automatically by Linear). Useful for consolidation: rename
`scope:taskqueue` → `scope:tasks` across a team.

### Behavior

- `--team` is required for `create`/`rename` (labels are team-scoped);
  optional for `list` (omit for all teams — cross-team drift view).
- All three honor `--json`.
- `create` is a write mutation but non-destructive (additive). `rename` is a
  write mutation but reversible (rename back). Neither needs `--apply` — they
  don't touch issues directly. No `delete` subcommand (D6).

## API surface

- `createLabel({ teamId, name, color })` — `labelCreate` mutation.
- `updateLabel({ id, name })` — `labelUpdate` mutation (for rename).
- Labels query: `team({ id }).labels({})` — already used by `file`'s
  `pickLabelIds`, extended to include per-label issue counts (`issues` count
  resolver).

## Non-goals

- **No label deletion.** D6 — no destructive ops. Orphan labels are reported
  by `list`, cleaned up manually in the web app.
- **No cross-team label sync.** Linear doesn't have org-level labels; labels
  are team-scoped by design. Consolidation is manual.
- **No label grouping / parent labels.** Linear labels are flat.

## Alternatives considered

- **Auto-create in `file --label`.** Rejected — `file`'s `pickLabelIds` errors
  on unmatched labels *by design* (fail loud, prevent typos). `park` gets
  auto-create for `user-story` because the intent is explicit; `file` should
  stay strict. `label create` is the escape hatch.
- **A `labels` report in `triage`.** Too coupled — label health is a separate
  concern from issue triage. A dedicated `label` command keeps them clean.

## Verification

- `linearctl label create test-label --team CER --json` → label exists, returns
  `{ id, name, color }`.
- `linearctl file "x" --team CER --label test-label --json` → resolves without
  error (proves the label is visible to `pickLabelIds`).
- `linearctl label list --team CER --json | jq '.[] | select(.name=="test-label") | .issues'`
  → `0` (just created, no issues).
- `linearctl label rename test-label renamed-test --team CER` → label name
  changes; `file --label renamed-test` resolves.
