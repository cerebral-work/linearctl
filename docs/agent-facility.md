# linearctl — Agent Facility (CER-1188)

## Headless CLI contract

`linearctl examples [command]` prints runnable Bash scripts from `examples/*.sh`.
The scripts are embedded in the compiled binary and work without a source checkout.
Set the resource variables named at the top of a script (for example `TEAM`,
`ISSUE`, or `PLAN`) and `LINEAR_API_KEY` for API commands. Examples include a
version check (>= 0.7.0), quota preflight, stdin bodies and re-reading after writes.
The `examples` command itself never needs credentials or executes the scripts.

| Exit | Kind | Meaning |
|---|---|---|
| 0 | success | Completed successfully, including an empty read result |
| 2 | usage | Missing/invalid arguments, malformed plans, empty stdin |
| 3 | auth | Missing or rejected credentials |
| 4 | not_found | Referenced issue, project, team, label or other resource not found |
| 5 | rate_limit | API rate limit or quota preflight exhausted |
| 6 | refused | Dry-run write guard, duplicate check, backup verification mismatch/drift, or policy refusal |
| 1 | other | Transport, server, filesystem or unexpected failure |

An interrupted interactive prompt retains the conventional exit 130. Daemon
signal shutdown remains exit 0. The table describes CLI invocations; MCP retains
its protocol-level error reporting.

With `--json`, a failure writes exactly one JSON error line to **stderr**:

```json
{"error":{"code":2,"kind":"usage","message":"--stdin was empty.","hint":"pipe the file: cat plan.json | linearctl update --stdin; add --apply to write."}}
```

Linear user-input failures preserve the first GraphQL diagnostic and its
`userError` marker (when supplied) in both human output and the JSON message,
with kind `usage` and exit 2. SDK query/variables/request dumps are excluded;
the configured API key is redacted.

Command-specific hints also show a correct form, concrete example and
`linearctl examples <command>`. Unknown commands retain spelling suggestions and fail even with `--help`.
Place `--json` after the subcommand (for example `linearctl whoami --json`).
Unknown teams list accessible keys; unknown labels suggest the three closest
available names and `linearctl label list --team <key>`. `project list` accepts
an omitted `--team` and lists all accessible projects.

### Listing contract

An agent cannot tell a short list from a truncated one by looking at it, so a
listing must either be complete or say that it is not.

1. **Listings paginate fully by default.** A command that returns a collection
   follows the API's cursors to the end. The number of rows an agent gets must
   not depend on the server's page size. A single-page read that reports its
   first page as the whole answer is a bug, not a performance choice.
2. **A listing returns each entity once.** Cursor pagination can repeat a row
   across a page boundary when the row is modified mid-scan, so listings
   de-duplicate by id. Row counts are safe to compare; `length` is a count of
   entities, not of pages.
3. **`--limit <n>` caps the rows and marks the result partial.** The cap is
   applied to the whole sorted listing, not to whichever page the API answered
   with first — all pages are fetched, then sorted, then truncated. Under
   `--json` every row carries `"partial": true`; in text mode the note goes to
   **stderr** so stdout stays pipe-clean. Without `--limit` a listing is never
   partial. Marking partial on the rows rather than wrapping the array keeps
   `jq '.[]'` consumers working.
4. **A bad `--limit` is a usage error (exit 2), never an empty or unbounded
   listing.** `--limit` takes a positive integer; `0`, a negative and a
   non-numeric value all exit 2 rather than being silently ignored.
5. **Ordering is stable.** A listing sorts by a deterministic key before
   truncating, so the same data yields the same rows in the same order, and a
   capped listing is a prefix of the full one.
6. **Pagination terminates on any response.** `hasNextPage` with no
   `endCursor` ends the scan; a cursor that does not advance is an error, not
   a loop. A malformed page reports a usable error rather than a raw type
   failure.

An agent that must know whether it has the whole list checks for the marker:

```bash
linearctl label list --limit 5 --json | jq -e 'any(.[]; .partial == true)' > /dev/null \
  && echo 'truncated; raise or drop --limit' >&2
```

`label list` implements this contract. Other listings predate it and are being
brought into line; `reorg census --limit` deliberately caps what is *fetched*
(a smoke-test path, documented in its `--help`) and so does not follow rule 3.

Use `set -euo pipefail` in Bash so pipelines propagate failures. Send comment
bodies through `--body -`, issue descriptions through `--desc -`, and plans
through `cat plan.json | linearctl update --stdin`. Empty stdin fails before a
mutation; some sandboxed shells do not deliver file redirects reliably.
`update --stdin` requires `--apply` to write. A preview still goes to stdout,
then exits **6**; explicitly handle that code when previewing. Single-issue
`update <id> --state ...` continues to write immediately.

Batch commands preserve outcome reports on stdout even if some writes fail.
They exit with the common failure kind when all failures share one, otherwise
1; unresolved issue references exit 4. Re-read successful writes and retry only
failed rows. A failed batch is not automatically safe to replay in full.

`backup --verify --json` preserves the detailed report on stdout and emits a
`refused` error on stderr when integrity checks or live comparisons fail (exit 6).
A clean report exits 0. In backup's original 0.8.0 contract, integrity mismatch
was 1, drift/sample mismatch was 2, and usage was 3; these become 6, 6, and 2
respectively. Authentication failures use 3, API resource lookup failures 4,
exhausted rate limits 5, and other runtime failures 1. A missing manifest is usage 2.

**Migration:** older binaries used 2 for exhausted quota and often 1 for usage,
auth or lookup failures. Consumers must now use 5 for rate limits and 6 for
write previews. Check `linearctl --version` and `linearctl --help` on the actual
binary selected by PATH before relying on this contract. Version 0.7.0 is the
minimum example baseline; the exit-code contract ships with this feature.


> **Status:** WIP plan — phased. The M4 prerequisites have shipped: OAuth
> `actor=app` scaffolding (CER-1148) and the `linearctl watch` + `linearctl
> operator` daemon loop driver (CER-1149). This document is the plan the
> `PUNCH-LIST.md` references but did not yet contain (PUNCH-LIST:136); authoring
> it is Track 1 Phase 0.
>
> **Ticket:** [CER-1188](https://linear.app/cerebral-work/issue/CER-1188)
> (P4, ctodie, M4). **Source:** `PUNCH-LIST.md:117-138`, `roadmap-linearctl.md:49`,
> `docs/spec.md` §10.

## 1. Goal

Turn the linearctl working session into a standing maintainer/PM agent. It
handles improvements, receives tickets, plans sprints, and runs grooming passes
across the full role catalog.

**Persistent role, not a persistent process:** durable state lives in engram
(the handoff chain, Track 6) and in Linear (issues/comments/states); ephemeral
compute lives in scheduled routines. Any fresh agent rehydrates the role on
wake — there is no single always-on brain that, if lost, loses the role.

## 2. Operator decisions (the contract)

Decisions recorded by the operator on 2026-06-05 (PUNCH-LIST:125-129):

- **D1 — Runtime:** hybrid. Scheduled routines fire on cadence (a `setInterval`
  inside the `linearctl operator` daemon); coord-mesh standby accepts dispatch
  (a future control-socket route `/dispatch <role>`). Both paths boot inside
  `startOperator`, not as a separate process.
- **D2 — Autonomy:** autonomous-within-guardrails. The agent auto-merges its own
  *green* linearctl PRs, and auto-files / auto-grooms issues. It NEVER releases,
  touches other repos/teams, or sends anything externally without the operator.
  Enforcement is a single checkpoint (`src/core/guardrails.ts`),
  `assertWithinGuardrails(action)` — roles do not implement their own gates.
- **D3 — Intake:** poll the linearctl Linear project (CER) via
  `core/grooming.ts`; accept coord dispatch (D1). Output sink is comments on
  issues (non-destructive) + handoff artifacts (Track 6) for cross-session
  memory.
- **D4 — Cadence:** groom daily · featuredev weekly · sprint biweekly. Each
  role declares its cadence in `RoleDescriptor`; the scheduler translates it to
  `intervalMs`.

## 3. Role catalog (all 12 roles)

The catalog is the typed registry in `src/core/role-catalog.ts`. Each role is a
`RoleDescriptor = { name, cadence, intake, guardrails }`. The first slice
ships two roles (intake-triage, grooming); the rest land behind the LLM (Track 3).

| # | Role | Cadence | Intake | Autonomy | Phase |
|---|---|---|---|---|---|
| 1 | **maintainer / featuredev** | weekly | poll-project | autonomous (own green PRs) | later (needs LLM) |
| 2 | **reviewer** | weekly | poll-project | read + comment | later (needs LLM) |
| 3 | **test-CI / docs stewards** | weekly | poll-project | read + comment | later |
| 4 | **intake-triage** | daily | poll-project | read + comment | **Phase 2 ✓** |
| 5 | **sprint planner** | biweekly | poll-project | read + propose | later (needs LLM) |
| 6 | **grooming** | daily | poll-project | autonomous (label stale) | **Phase 3 ✓** |
| 7 | **roadmap** | weekly | poll-project | read + comment | later (needs LLM) |
| 8 | **release-manager** (gated) | on-demand | coord-dispatch | **manual-only** — never autonomous | later |
| 9 | **dependency / security** | weekly | poll-project | read + comment | later |
| 10 | **observability / error-insight** | weekly | poll-project | read + comment | later |
| 11 | **dogfood** | weekly | poll-project | autonomous (own repo) | later |
| 12 | **knowledge** | biweekly | poll-project | read + comment | later |

`release-manager` is the one role that is **never** autonomous under D2 — even
auto-merge of its own PRs is gated. Cross-repo, release, and external-send
actions are blocked for *every* role at the guardrail checkpoint.

## 4. Per-role loop shape on the operator daemon

Every role runs the same loop, wired by `scheduleRole(role, intervalMs, runner)`
in `src/core/scheduler.ts`:

```
┌─ startOperator ─────────────────────────────────────────┐
│  mint app-actor token (token cache, in-memory)            │
│  start control socket (/healthz, /delegate, future /dispatch) │
│  start queue poller (CF Queue linear-agent-events)       │
│  for each role in opts.roles:                             │  ← new
│    scheduleRole(role, cadence→ms, runner(role, token))    │  ← new
└───────────────────────────────────────────────────────────┘

scheduleRole loop (one per role):
  on interval (D4 cadence):
    runner = the role's handler (intake-triage / grooming / …)
    result = runner(tokenCache.getToken())
    if result.mutation: assertWithinGuardrails(proposed)   ← single gate
    post result (comment on issue / handoff artifact)
  on SIGINT/SIGTERM:
    stop the interval, drain in-flight runs (shared shutdown)
```

Roles share the daemon's cached token — so role actions attribute as the Linear
app actor (`unsigned-gg`), never as `ctodie`'s user token. This is the D2
autonomy boundary made physical: the token is the boundary; the guardrail is
the policy.

## 5. Guardrail enforcement points (D2)

**Single checkpoint.** `src/core/guardrails.ts` exports
`assertWithinGuardrails(action: ProposedAction)`. It is called before *every*
role mutation. Roles never implement their own gates — they propose actions
(`comment`, `label`, `file-issue`, `update-issue`, `move-state`) and the
checkpoint decides.

**Autonomous set (allowed):**

- comment on an issue (additive, non-destructive)
- apply/remove a label on an issue (the `stale` dry-run-then-confirm contract)
- file an issue in the linearctl project (CER)
- update an issue's state/priority/assignee/estimate within the linearctl team
- merge the agent's own green linearctl PR (squash, signed)

**Gated set (throws → requires operator):**

- merge to main (any repo except the agent's own green linearctl PR)
- touch another repo or another team's issues
- publish / send externally (comments on external issues, webhook fanout)
- cut a release / create a tag / push to a registry
- rotate / delete a secret

Throwing is the contract: a role that proposes a gated action aborts that run,
logs the blocked proposal, and surfaces it to the operator. It does not crash
the daemon — the guardrail throws inside a try, the run is skipped, the next
cadence tick retries with whatever the operator decided.

## 6. Linear project-intake mechanism (D3)

**Poll-project (the default intake for phases 0–3).** Every role with
`intake: "poll-project"` queries the linearctl Linear project (CER) via the
existing `core/*` functions:

- `intake-triage` → `core/grooming.triage(teamKeys?, project?)` (the Triage queue:
  unassigned / unestimated / no-priority / triage-state) + `core/grooming.stale(…)`
  (the stale sweep).
- `grooming` → `core/grooming.stale(…)` + `applyStaleLabel(…)` (the dry-run-then-
  confirm label contract from `src/commands/stale.ts`).

**Coord-dispatch (the future intake).** D1's "coord-mesh standby (dispatch)"
path adds a control-socket route `POST /dispatch <role>` that the coord mesh
hits to wake a role out of cadence. The route shape is an open operator decision
(see §9.2) — not implemented in phase 0–3.

**Both.** Roles may declare `intake: "both"` and run the poll-project cadence
while also accepting dispatch. The scheduler fires the cadence; the dispatch
route fires an immediate run (bounded by an in-flight guard).

## 7. Cadence (D1 hybrid + D4 daily/weekly/biweekly)

| Cadence | `intervalMs` | Roles |
|---|---|---|
| daily | 1 × `DAY_MS` (86_400_000) | intake-triage, grooming |
| weekly | 7 × `DAY_MS` | maintainer/featuredev, reviewer, test-CI/docs, roadmap, dependency/security, observability/error-insight, dogfood |
| biweekly | 14 × `DAY_MS` | sprint planner, knowledge |
| on-demand | — (coord dispatch only) | release-manager |

The scheduler fires the first run immediately (so a backlog drains on boot),
then re-fires on the interval — the same pattern the queue poller uses
(`src/core/operator.ts` schedulePoll). The interval is the *upper bound* on
latency, not a real-time guarantee: a slow run delays the next tick (sequential,
not overlapping), which is correct for a single-token actor.

## 8. Phasing

- **Phase 0 (this doc):** the WIP plan. No code. Authoring = Track 1 Phase 0.
- **Phase 1 (catalog + scheduler + operator wiring):** `src/core/role-catalog.ts`,
  `src/core/scheduler.ts`, `roles?: RoleDescriptor[]` on `OperatorOptions`. Two
  roles registered (intake-triage, grooming), no handlers yet. Proves roles
  compose onto the daemon without LLM.
- **Phase 2 (intake-triage):** `src/roles/intake-triage.ts` — the first role
  handler. Read-heavy, low-autonomy, exercises the full D1/D3 contracts without
  the LLM. Daily cadence.
- **Phase 3 (grooming + guardrails):** `src/roles/grooming.ts`,
  `src/core/guardrails.ts`. The first role that *mutates* (labels stale), so
  the D2 checkpoint is exercised on every run. Daily cadence.
- **Later phases:** `maintainer/featuredev` (weekly, needs LLM Track 3),
  `reviewer`, `sprint planner` (biweekly), `roadmap`, `release-manager` (gated
  — manual-only even under D2), `dependency/security`, `observability/error-
  insight`, `dogfood`, `knowledge`. Gated on LLM (Track 3) + live-integration
  (Track 4).

## 9. Open operator decisions

1. **Where does role output land?** D3 specifies the *intake* (poll CER) but not
   the *output sink* for self-initiated grooming. Recommendation: comments on
   issues (non-destructive, `CLAUDE.md` honesty rule) + handoff artifacts (Track
   6) for cross-session memory. Implemented as such in Phase 2–3.
2. **Coord-mesh standby trigger contract.** D1 says "coord-mesh standby
   (dispatch)" but the dispatch *into* the daemon isn't defined. The control
   socket currently has `/healthz` + `/delegate`; a third route `/dispatch
   <role>` is the intake point. Needs operator sign-off on the route shape
   before implementation.
3. **Does `release-manager` ever get the D2 autonomous merge?** D2 says
   "auto-merge own green linearctl PRs" but release-manager touching releases is
   explicitly gated. Resolution proposed here: release-manager is
   **manual-approval-only** — the guardrail throws for any release/tag/registry
   action by any role including itself, and the release-manager role exists
   only to *prepare* a release (notes, branch check), never to ship it.

## 10. Non-goals (this phase)

- No LLM reasoning (Track 3). intake-triage and grooming are deterministic.
- No coord-dispatch route (§9.2). Poll-project intake only.
- No cross-repo or external actions (D2 gated — throws at the checkpoint).
- No persistent process state beyond the token cache + in-flight guards.
  Durable state is in Linear (comments/labels/states) and engram (Track 6).
- No TUI surface (Track 2). The role catalog is not a UI surface.

## 11. Listing compliance audit (read-only)

Measured against the §"Listing contract" rules on 2026-10-04 (workspace: 269
labels, 93 projects incl. archived, 15 teams). Read-only: nothing in this
audit changes behaviour, and the non-compliant entries are recorded rather
than fixed here.

| Listing | Paginates fully | De-dupes | `--limit` partial | Verdict |
|---|---|---|---|---|
| `label list` (`core/labels.ts`) | yes, cursor loop | yes, by id | yes, rows + stderr, exit 2 on bad input | **complies** |
| `doc list` (`core/documents.ts`) | yes, cursor loop | n/a (none observed) | no `--limit` | **complies** (rules 1–2, 6 partial) |
| `resolveLabelIds` (`core/issues.ts`) | yes, `fetchNext` drain | n/a (resolver) | n/a | **complies** |
| `resolveLabelIdMap` (`core/bulk.ts`) | yes, `fetchNext` drain | n/a (resolver) | n/a | **complies** |
| `listTeamKeys` (`core/teams.ts`) | yes, `fetchNext` drain | yes, `new Set` | n/a | **complies** |
| `reorg census` `paged()` (`core/reorg.ts`) | yes when unlimited | no | **no marker**; `--limit` stops fetching | **deviates, by design** — see below |
| `project list` (`core/projects.ts`) | yes, `fetchNext` drain | **no** | no `--limit` | **does not comply** — returns duplicates |
| `listMilestones` (`core/milestones.ts`) | yes, `fetchNext` drain | **no** | n/a | **latent** — same shape, single page today |
| `roadmap` (`core/roadmap.ts`) | yes, `fetchNext` drain | **no** | n/a | **latent** — same shape, single page today |

**`project list` returns each project twice up to the page size.** The SDK's
`fetchNext()` *appends* to `connection.nodes` (`_appendNodes`), but the caller
also pushes `connection.nodes` into a separate array on every iteration, so
page one is counted again for each later page. Live: `project list --json`
returns **141 rows for 91 distinct projects** — 50 duplicates, exactly the
first page re-added. The same accumulate-into-an-array shape appears in
`listMilestones` and `roadmap`; both read a single page in this workspace, so
they are latent rather than failing. `listTeamKeys` has the shape too but
de-duplicates through a `Set`, which masks it. The correct form is to drain
the connection and then read `connection.nodes` once.

**`reorg census --limit` is a deliberate deviation.** Its `--help` describes a
smoke-test cap on what is *fetched*, and downstream counts are explicitly
lower bounds. It therefore does not mark partial. Two gaps are still worth
noting against rule 4: `--limit 0` and `--limit -5` are silently ignored
(the guard is `limit &&`, so `0` is falsy) and exit 0 having fetched
everything, and a non-numeric `--limit abc` becomes `NaN` and does the same.
Under the contract those are usage errors.
