# linearctl — Agent Facility (CER-1188)

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
