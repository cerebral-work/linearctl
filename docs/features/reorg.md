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
linearctl reorg rollback reorg-plan.jsonl.applied.jsonl --phase N   # dry-run: previews inverse ops, reverse order
linearctl reorg rollback reorg-plan.jsonl.applied.jsonl --phase N --apply   # writes
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
- **Read-after-write lag.** The post-write re-read can briefly return the
  pre-write state. A differing re-read is retried up to 4 times (0.5 s, 1 s,
  2 s, 4 s backoff, each retry reported as a `verify-retry` event) before it is
  declared a mismatch.
- **Already applied.** If the pre-read differs from `from` but equals the op's
  expected end state, the write evidently landed earlier without being
  journaled. The op is journaled `ok` with `alreadyApplied: true` (`before` is
  the planned from-state, `after` the live read) and nothing is written;
  batch members in this state are left out of the batch write. `--check`
  reports it as already applied, not drift. Rollback skips these rows unless
  `--include-already-applied` is given. Live state matching neither `from` nor
  the end state is still drift.
- **Write error, end state landed.** When a sequential write throws, the
  executor re-reads (with the same read-lag backoff). If the live state equals
  the expected end state, the op continues through verify and is journaled `ok`
  with `writeErrorButApplied: true` and `writeError: <message>`, plus a
  `write-error-applied` event naming the seq. Otherwise the original error is
  rethrown unchanged. This is never accepted for create ops (the new id comes
  from the write), for an op whose end state equals its pre-state, or for a
  delete form unless the re-read fails with not-found. Rollback still inverts
  these rows, because this tool's write landed them. Batch writes do not do
  this yet.
- **Cascaded moves.** Moving a parent issue to another team moves its
  sub-issues (in the same source team) with it, so a later `move-issue-team`
  for such a sub-issue finds it already in the destination. It is journaled
  `alreadyApplied` (with `cascade: true`) only when the live issue equals the
  op's full planned end state: destination team, `from.projectId` membership,
  `to.stateId` (an op without one is never already applied), and exactly the
  label set the apply path would have sent, computed from the recorded source
  labels (mapped `labelMap` targets, kept non-team labels, `reapplyLabelIds`).
  Anything short of that, such as a mapped label the cascade dropped, is a
  mismatch whose message says the issue was likely moved by a parent's cascade
  and lists the missing and unexpected labels. `--check` applies the same
  rule. Rollback accepts the mirror case: inverting a parent's move carries
  its sub-issues back, so a sub-issue already at its own inverse's full end
  state is counted as reverted without a write.
- **`--check`** is the dry-run with teeth: a live drift pre-read of every
  target, reporting each op OK/DRIFT without writing (exit 1 on any drift).
  It also reports plan-shape refusals apply would raise (a mixed batch group,
  see Batching) as `REFUSE`. A `name:` ref whose planned create has not run yet
  is reported as drift and says so. The plain dry run reports the same
  plan-shape refusals and exits 1 instead of suggesting `--apply`.
- **`--resume`** skips journaled-ok seqs (before `--max-ops` slices, so a
  capped resume keeps advancing).
- **Batching** is opt-in per op via `batchKey`: identical-input `relabel` /
  `set-state` ops group into `issueBatchUpdate` calls of ≤ 50, drift-checked
  per member, verified by one filtered read. Grouping rule: CONSECUTIVE ops
  (after `--resume` and `--max-ops` slicing) with the same `batchKey` and the
  same op kind, `relabel` / `set-state` only, at most 50 per group; a lone op
  is not batched. Members must carry identical `to` (compared raw, before
  `name:` resolution). A group that does not is refused: `--check` and the dry
  run mark every member `REFUSE`, and `--apply` refuses before any write. Give
  each distinct input its own `batchKey`.
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
  team-scoped label on the issue (read now) is either already swapped by a
  journaled relabel (replacements ride the move input as `addedLabelIds`) or
  carried over through `to.labelMap` (see "Carrying team labels across a move");
  the destination team in the project's membership **read live**; the issue's
  `cycleId` captured in `from` first; `projectId` unchanged after the move or
  the run stops; a state that didn't land at the mapped destination is
  corrected by a separate verified `set-state` to the destination state.

`reorg census` snapshots teams (+states), **all issues** (id, team, state,
labels, project, cycle, archived — the planner needs them for issue ops),
labels with per-label issue counts, projects, initiatives. Everything
paginates; `--team` scopes teams/issues/projects, `--limit` caps the smoke
path. `--limit` bounds **teams, issues and projects only** — labels and
initiatives are always fetched in full — so a capped census is cheaper but
not cheap. The cap is applied while paging, not after a full scan, which is
what keeps the smoke path quick. Note: under `--limit`, per-label issue
counts and the `--team` project filter are computed over the CAPPED
issue/project sets (counts are lower bounds) — fine for smoke, never for a
plan's census. A capped census sets `partial: true` and says so on stderr,
and `reorg plan` preserves that flag; a `0`, negative or non-numeric
`--limit` exits 2. A scan whose cursor stops advancing ends early and also
sets `partial: true`. `partialReasons` lists each cause (the `--limit` cap,
and one entry per stalled connection). `reorg plan` over a partial census
adds a warning to `_meta.warnings` and prints it; it does not refuse.

## Plan file

`reorg-plan.jsonl`: header line `{"_meta": {generated, censusHash,
workspaceId, rulesHash, warnings[]}}`, then one op per line:

```json
{"seq":12,"phase":1,"op":"relabel","target":{"type":"issue","id":"…","identifier":"EX-12"},"from":{"labelIds":["l-team"]},"to":{"add":["l-ws"],"remove":["l-team"]},"evidence":"rule ws-bug-label","reversible":true,"batchKey":"ws-bug"}
```

`from` is captured at census time and is the executor's drift anchor.
The 21 ops: `create-workspace-label`, `create-team-label`, `relabel`, `rename-label`,
`retire-or-delete-label`, `set-state`, `enable-triage`, `archive-state`,
`set-project-status`, `set-project-lead`, `set-project-target`,
`add-project-team`, `remove-project-team`, `move-project-initiative`,
`set-initiative-owner`, `archive-issue`, `archive-project`,
`archive-initiative`, `move-issue-team`, `create-project-status`,
`delete-team`.

Notes per kind:
- **`archive-project` archives; it never trashes.** Linear keeps archived
  projects restorable indefinitely, while trashed ("recently deleted") projects
  are permanently removed after 30 days (linear.app/docs/projects,
  linear.app/docs/default-team-pages). The op calls `projectArchive(id,
  trash: false)` explicitly (deprecated in the schema in favour of
  `projectDelete`, which trashes, but still the only plain-archive mutation),
  expects `{ archived: true, trashed: false }` afterwards, and is rolled back
  with `projectUnarchive`. Plan input is `to: { archived: true }`; a plan or
  rule whose `to` carries `trashed: true` is refused at parse time, because
  trashing is a delayed permanent delete and belongs in a gated phase-6 op.
  If the live project comes back trashed after the call, the apply fails.
- **`rename-label` exists because Linear enforces label-name uniqueness ACROSS
  workspace and team scope** — a workspace `create-workspace-label` fails
  while any team copy carries the name. The planner therefore orders phase 1
  by kind regardless of rule order: renames → creates → relabels → retires.
  `--check` preflights every create against ALL scopes (accounting for planned
  renames) and reports a conflict as drift, instead of letting Linear reject
  it mid-apply.
- **`create-team-label`** creates a label owned by the destination team
  (`target` is the team; `to` is `{name, color?, description?}`; `from` is
  `{labelId: null}`). Linear label names are unique, case-insensitively,
  across the workspace and across a parent team and its sub-teams, while
  unrelated teams may share a name. The executor and `--check` therefore
  refuse a name already held in the destination team, its parent, any
  sub-team, or the workspace, unless a **lower-seq** `rename-label` moves the
  holder off the name (a rename to the same name frees nothing; renaming an
  owner frees its inherited views). When the source team is a sub-team of the
  destination, rename its own labels first (e.g. `name·old-<src>`). The
  created id is journaled so `created:<seq>` refs can resolve to it. Inverse:
  retire the created label. The conflict set above (destination, parent,
  sub-teams, workspace; case-insensitive) is this engine's model of Linear's
  rule; Linear's own refusal at create time remains the backstop.
- **Inherited labels** (sub-team copies mirroring an owner team's label) are
  read-only — Linear refuses writes on them. The census captures
  `inheritedFrom` (+ `team.parent`); the planner groups by owner
  (`inheritedFrom ?? id`, usage summed over children), selects owners only,
  and refuses at plan time any rule naming an inherited label id. `apply` and
  `--check` refuse an inherited target live. In a relabel, an owner id in
  `to.remove` maps to the child id each issue actually carries, and a
  `labelId` selector matches issues carrying any child of the owner.
- `archive-state` is **never** reversible (Linear has no unarchive): the
  planner coerces it to `reversible:false` and requires an approval id;
  `reversible:false` is allowed in phase 2 (states) or 6 (deletes) only.
- `remove-project-team` computes the post-membership from a LIVE read at apply
  time — a team added after the census is never dropped by a stale plan.
- `create-project-status` rides `projectStatusCreate`; the inverse is archive
  in the UI (no inverse op). `ProjectStatusCreateInput.position` is required:
  when `to.position` is absent the executor reads the live statuses and places
  the new one between its lifecycle neighbours (backlog, planned, started,
  paused, completed, canceled) at the midpoint of their positions, or last+1
  when none follows, and journals the position used.

## Carrying team labels across a move

A team move drops team-scoped labels, and a label of another team cannot be
added to an issue before it moves. `move-issue-team` therefore takes
`to.labelMap`: `{ "<source label id>": "<destination ref>" }`, where a
destination ref is a label id or `created:<seq>` (resolved at apply time from
the journal record of that `create-team-label` / `create-workspace-label`).

- Precondition (a): each team-scoped label live on the issue must be swapped
  by a journaled relabel or be a `labelMap` key (an inherited view on the issue
  is looked up by its own id, then its owner id) whose destination belongs to
  the destination team's scope: workspace, owned by that team, or owned by its
  parent. Anything else refuses, naming the label. Entries for labels the issue
  does not carry add nothing.
- The move input sends `labelIds` = the exact final set: live labels still
  valid in the destination, plus each mapped replacement, plus
  `to.reapplyLabelIds`. The set is journaled as `to.labelIdsComputed`. The
  post-move check, `verify`, and rollback all require the issue to carry
  exactly that set (and the destination team); a mismatch stops the run.
- A `created:<seq>` that names a `create-team-label` must target the move's
  destination team or its parent (workspace creates are fine anywhere); the
  planner, `--check` and the apply preflight (before any write, including the
  create itself) refuse otherwise, naming both teams.
- Rollback moves the issue back to the source team with the source label set
  recorded in the journal's `before` read (not the plan's census copy). If a
  source label has been retired since, rollback (dry run and apply) refuses
  naming it; `--restore-retired` restores it (`issueLabelRestore`, verified)
  before moving back.
- `--check` also verifies that every `created:<seq>` ref resolves to a
  journaled or lower-seq planned create, and that plain destination ids are
  usable in the destination team.
- Planner rules: a `create-team-label` rule uses `match: {entity: "team",
  where: {key}}`, `to: {name, ...}` and an optional `ref`. A move rule's
  `labelMap` may use `created:<ref>`; the planner rewrites it to
  `created:<seq>`, prunes each issue's map to the labels it carries, and
  refuses an unknown ref. Within phase 5 the planner orders `rename-label`,
  `create-team-label`, `add-project-team`, `move-issue-team` (only these kinds
  are reordered; other ops keep their place).

## Team visibility

A team move adopts the destination team's visibility. Moving issues out of a
private team into a non-private one makes every moved issue visible to all
workspace members, and to guests who are members of the destination. The same
holds for a project: adding a non-private team to a project that sits only on
private teams exposes its page, description and updates. `reorg` refuses such
ops unless the rule opts in.

An op is refused when it WIDENS visibility:

- `move-issue-team` from a private team to a non-private team;
- `move-issue-team` from a private team to a private team that has members the
  source lacks (they gain access, guests included). Members are read live;
- `add-project-team` of a non-private team to a project whose current teams are
  all private.

Not refused: public to anything, and private to private with equal member sets.
A private destination that lacks some source members only removes readers; it is
reported, not refused: `plan` prints `info: A -> B: N source member(s) lose
access (M move(s))` and `apply --check` prints `info seq ...`. A rollback that
moves an issue back into a private team is therefore never refused for
visibility.

Where it is enforced:

- **census** records `private` for every team, and the member ids of private
  teams. A team with no boolean `private`, or a members read that fails or
  cannot finish paging, is an error; `plan` refuses a census without `private`.
- **plan** throws, before writing a plan file, when a rule would widen
  visibility without opting in. The one-line error names each team pair with its
  op count and then each refused op (seq, identifier, source -> destination,
  reason). On success `plan` prints one `visibility change (allowed): ...` line
  per team pair.
- **`apply --check`** reports `REFUSE seq N ... (SRC -> DST): reason` from LIVE
  reads of team privacy and members, never from the census. An opted-in op is
  listed as `visibility change (allowed)`.
- **`apply`** runs the same live check immediately before the first write and
  refuses with zero mutations. An opted-in change is reported as a
  `visibility change (allowed) seq ...` line before the write.

Fail-closed: if a team is not found, `private` is not a boolean, or the members
read errors or is partial, the op is refused. Unknown visibility is never read as
public.

To opt in, set `"allowVisibilityChange": true` on the rule. The planner copies it
to every op the rule produces and never infers it. Opt in only after deciding
that the moved issues, or the project, may be seen by the destination's audience.

Caveats:

- Privacy and members are cached for 30 seconds within a run. A team made public
  or private mid-run may read with its old value until the entry expires.
- `rollback` does not run this guard: it restores recorded state, so it must be
  able to put things back. Rolling back a move out of a private team and into a
  non-private one (the inverse of a public -> private move) widens visibility;
  check the teams before rolling back.

## Inherited workflow states

Workflow states inherit like labels: a sub-team's states carry `inheritedFrom`
pointing at the parent's state, and archiving the parent's state archives every
inherited view at once. `archive-state` on an inherited view refuses ("act on
the owner state"; `REFUSE` under `--check`). For an owner state, the dry run
and `--check` list the inherited views that will archive with it, and the
executor refuses while any of those views still holds issues. The census records
`inheritedFrom` per state. In `plan`, inherited views never match a broad `team-state`
rule (as inherited labels), so the owner alone is planned and its views cascade. A rule
that names a view by `where.id` is refused at plan time, naming the owner.

## Superseded ops in verify

`verify` compares each journaled op's expected end state with the live target.
When a later op (seq order) that is journaled ok changes the same key of the
same target, only that last op is checked against live; an earlier one is
reported as `superseded by seq N`, counts as ok, and is listed separately
(`SUPERSEDED ...` lines, `superseded` in the JSON and the report file), never
dropped. An op that is only partly superseded is still checked on its other
keys. A later op that is not journaled ok supersedes nothing.

Rules:

- Later ops come from every ok journal row (deduped by seq), not only the
  plan file being verified, so a later op journaled from another plan counts.
  A plan op with no ok row is still reported as failed.
- Superseding is per key. An archive supersedes only what it sets (`archived`,
  and `trashed` for projects): an earlier move or project-team change is still
  checked against the archived target. An archive, unarchive, re-archive chain
  checks only the last archive. Only a delete (target gone) supersedes every
  key of earlier ops on that target.
- A create's identity is the label it created (journaled label id, else the
  case-insensitive name), not its team. Creates of different labels in one
  team never supersede each other; only a later rename, retire or delete of
  that label supersedes its create.
- A later op in a different phase supersedes only when that phase's latest
  verify marker is green (current journal, then prior journals, by the gate
  rule below). Otherwise the earlier op is checked normally. Later ops in the
  same phase are checked in the same run, so they may supersede.

## Prior journals

`apply`, `--check` and `verify` accept `--prior-journal <file>` (repeatable).
Only the `verify` markers of those journals are read, and they count for the
phase gates, with no clock involved: if the current journal has any verify
marker for the phase, its latest marker (file order) decides alone; prior
journals are consulted only when the current one has none, and then every prior
journal that has a marker must end green (any red fails). Prior journals are never written, resumed or rolled back, and
a missing file is an error. `verify` additionally prints the gate state across
journals after its own marker is appended.

## Rules and selectors

`reorg plan --rules <file>` takes declarative rules. `match.entity` is one of
`team`, `issue`, `workspace-label`, `team-label`, `team-state`, `project`,
`initiative`, `none` (creation ops). Selectors:

- **issues**: `identifier`, `teamKey`, `stateId`, `projectId`, `archived`,
  plus `label` (name — any census label sharing it counts) or `labelId`, in
  combination. A rule's `batchKey` propagates to every op it expands into.
  The planner rejects two `relabel` / `set-state` ops that share a `batchKey`
  but have different `to` (the key means identical input). Other op kinds are
  not checked: `add-project-team` computes a per-target `to`.
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

`rollback <applied.jsonl> --phase N` is a dry-run by default: it prints each
inverse op it would apply and makes no mutation calls. `--check` adds a live
pre-read of every target and reports drift (exit 1 when any); `--apply` writes.
With `--apply`, each inverse op first pre-reads its target and refuses
(exit 3, `ROLLBACK MISMATCH` naming field, expected and actual) when the live
state is not what the journal recorded the forward op leaving. It then applies
each op's inverse in reverse journal order with the same per-write verify.
Rows journaled `alreadyApplied` record a change the tool never wrote (it may be
a manual edit), so rollback skips them and lists them as "skipped: already
applied before this run (not written by the tool)"; `--include-already-applied`
inverts them too. The
inverse is built from the plan's `from`, filling any compared field the plan
omitted (for example a label's old name) from the journaled pre-write read.
If neither the plan nor the journal recorded a field the inverse needs, rollback
refuses (exit 3, `ROLLBACK REFUSED`) before any write. A target that cannot be
read counts as drift under `--check` and is refused under `--apply`. Reversible inverses: relabel,
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
