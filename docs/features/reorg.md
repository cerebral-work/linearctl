# Feature: `linearctl reorg` — plan-file-driven workspace reorganization

**Status:** in review (feat/reorg)
**Command:** `linearctl reorg census|plan|apply|verify|rollback`
**Roadmap:** net-new

## Motivation

A Linear workspace that grew without an owner drifts: duplicate per-team
labels, inconsistent state sets, dormant projects, teams that need folding.
Fixing that is hundreds of writes — too many for hand-driving, too dangerous
for a script without guardrails. `reorg` is the middle path: a **reviewed plan
file** drives a journaled executor that verifies every write and stops at the
first mismatch.

The engine is generic. Workspace-specific rules (which teams fold, which
labels merge, which projects archive) live **outside** this repo — the repo
ships the schema, the op registry, and a toy rules example
(`examples/reorg-rules.example.json`).

## Pipeline

```
linearctl reorg census [--team K] [--limit N] [--out census.json]   # read-only snapshot
linearctl reorg plan --rules rules.json --census census.json        # → reorg-plan.jsonl
$EDITOR reorg-plan.jsonl                                            # human review IS the authorization
linearctl reorg apply reorg-plan.jsonl --phase N                    # dry-run: per-op diff + request budget
linearctl reorg apply reorg-plan.jsonl --phase N --check            # dry-run + LIVE drift pre-read (exit 1 on drift)
linearctl reorg apply reorg-plan.jsonl --phase N --apply \
  --backup-record backup.verified.json [--resume] [--max-ops N]
linearctl reorg verify --plan reorg-plan.jsonl --phase N            # journal + live re-check → report
linearctl reorg rollback reorg-plan.jsonl.applied.jsonl --phase N   # inverse ops, reverse order
```

## Safety contract

- **Dry-run by default.** `--apply` writes; it refuses without
  `--backup-record <file>` pointing at a `{ "verifiedAt": "<ISO>" }` record
  fresher than 24 h (a verified backup precedes any bulk write).
- **Every write is sequential**: live pre-read (abort when live state drifted from
  the plan's census-time `from`) → write inside `withRetry` → re-read by a
  **different** query → compare the op's **computed expected end state**
  (`expectedPost` — the full post-label-set for relabel, the full teamIds for
  add-project-team; never a vacuous key check) → append to `applied.jsonl` with
  fsync. First mismatch stops the run with exit 3; batch members are journaled
  individually (the mismatching one `ok:false`) before the stop, so resume and
  rollback never lose track of a write.
- **`--check`** is the dry-run with teeth: a live drift pre-read of every
  target, reporting each op OK/DRIFT without writing (exit 1 on any drift).
- **`--resume`** skips journaled-ok seqs (before `--max-ops` slices, so a
  capped resume keeps advancing).
- **Batching** is opt-in per op via `batchKey`: identical-input `relabel` /
  `set-state` ops group into `issueBatchUpdate` calls of ≤ 50, drift-checked
  per member, verified by one filtered read.
- **Pacing**: token bucket at 2000 req/h (Linear's key budget is 2500/h) plus
  `X-RateLimit-*-Remaining` header reads; under 10 % remaining the run sleeps
  to the window reset.
- **Irreversible ops** (`delete-team`, label delete, `archive-state`) exist
  only in phase-6 plan files, each carrying an `approval` deck id, and apply
  only with `--allow-irreversible`.
- **`delete-team` and `archive-state` re-prove emptiness live** immediately
  before the write (0 issues incl. archived, 0 projects, 0 non-retired labels;
  0 issues in the state) — the census is never trusted for irreversible work.
- **`move-issue-team` preconditions** (enforced by the executor, all LIVE
  reads): phase-1 and phase-2 verify markers green in the journal; every
  team-scoped label on the issue (read now) already swapped by a journaled
  relabel whose workspace replacements ride the move input as `addedLabelIds`;
  the destination team in the project's membership **read live**; the issue's
  `cycleId` captured in `from` first; `projectId` unchanged after the move or
  the run stops; a state that didn't land at the mapped destination is
  corrected by a separate verified `set-state` to the destination state.

`reorg census` snapshots teams (+states), **all issues** (id, team, state,
labels, project, cycle, archived — the planner needs them for issue ops),
labels with per-label issue counts, projects, initiatives. Everything
paginates; `--team` scopes teams/issues/projects, `--limit` caps the smoke
path. Note: under `--limit`, per-label issue counts and the `--team` project
filter are computed over the CAPPED issue/project sets (counts are lower
bounds) — fine for smoke, never for a plan's census.

## Plan file

`reorg-plan.jsonl`: header line `{"_meta": {generated, censusHash,
workspaceId, rulesHash, warnings[]}}`, then one op per line:

```json
{"seq":12,"phase":1,"op":"relabel","target":{"type":"issue","id":"…","identifier":"EX-12"},"from":{"labelIds":["l-team"]},"to":{"add":["l-ws"],"remove":["l-team"]},"evidence":"rule ws-bug-label","reversible":true,"batchKey":"ws-bug"}
```

`from` is captured at census time and is the executor's drift anchor.
The 20 ops: `create-workspace-label`, `relabel`, `rename-label`,
`retire-or-delete-label`, `set-state`, `enable-triage`, `archive-state`,
`set-project-status`, `set-project-lead`, `set-project-target`,
`add-project-team`, `remove-project-team`, `move-project-initiative`,
`set-initiative-owner`, `archive-issue`, `archive-project`,
`archive-initiative`, `move-issue-team`, `create-project-status`,
`delete-team`.

Notes per kind:
- **`rename-label` exists because Linear enforces label-name uniqueness ACROSS
  workspace and team scope** — a workspace `create-workspace-label` fails
  while any team copy carries the name. The planner therefore orders phase 1
  by kind regardless of rule order: renames → creates → relabels → retires.
  `--check` preflights every create against ALL scopes (accounting for planned
  renames) and reports a conflict as drift, instead of letting Linear reject
  it mid-apply.
- `archive-state` is **never** reversible (Linear has no unarchive): the
  planner coerces it to `reversible:false` and requires an approval id;
  `reversible:false` is allowed in phase 2 (states) or 6 (deletes) only.
- `remove-project-team` computes the post-membership from a LIVE read at apply
  time — a team added after the census is never dropped by a stale plan.
- `create-project-status` rides `projectStatusCreate`; the inverse is archive
  in the UI (no inverse op).

## Rules and selectors

`reorg plan --rules <file>` takes declarative rules. `match.entity` is one of
`team`, `issue`, `workspace-label`, `team-label`, `team-state`, `project`,
`initiative`, `none` (creation ops). Selectors:

- **issues**: `identifier`, `teamKey`, `stateId`, `projectId`, `archived`,
  plus `label` (name — any census label sharing it counts) or `labelId`, in
  combination. A rule's `batchKey` propagates to every op it expands into.
- **projects / initiatives**: select by `id` preferred; a `name` match hitting
  more than one entity is REFUSED (duplicate names exist), never fanned out.
- **label refs across ops**: `"name:<label-name>"` inside `to.add`,
  `to.remove`, or `to.reapplyLabelIds` resolves at apply time — the journal's
  earlier `create-workspace-label` first, then a live workspace-scoped lookup.
  Zero hits or several = refuse.
- **warnings**: the planner warns (stderr + `_meta.warnings`) when a rule
  references a team the same plan deletes, or a census project still lists a
  to-be-deleted team.
- **`--since-census <minutes>`** refuses to plan against a stale census.

## Rollback

`rollback <applied.jsonl> --phase N` applies each op's inverse in reverse
journal order with the same per-write verify. Reversible inverses: relabel,
set-state, project/initiative fields, unarchive, label restore, move-back
(identifier changes again — the identifier map is the record). No inverse
(skipped, named in the output): `archive-state` (recreate by hand),
label delete, `delete-team` after the grace window.

## Exit codes

0 ok · 1 error / verify failures · 3 verify mismatch (drift or post-write).

## Tests

`test/reorg-core.test.ts` (schema, journal fsync, backup gate, dry-run, drift
abort, first-mismatch stop, resume, batch cap, gated refusal, move
preconditions, verify, rollback, pacing) and `test/reorg-cli.test.ts`
(plan generation from rules + census, boundary validation) run against a
fake-backend `rawRequest` stub — no live writes, ever.
