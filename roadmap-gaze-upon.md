# gaze-upon — Project Roadmap

> Generated 2026-07-22 from live Linear issues (project: gaze-upon, team OPS).
> 8 issues, all in Triage, all unassigned, all priority 4 (Urgent).
> Source: `linearctl search --project gaze-upon --state all --json`.
> Milestones created and issues assigned via `linearctl milestone create` + `update --stdin --apply`.

## Live Linear State (auto-rendered 2026-07-26 10:39 UTC)

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
| Dogfood & Validation | `3f74fd73-0b1d-4573-b410-d47f3b61e05e` | 2026-09-09 | 1 | 0% (0/1) |
| Harness Safety & State Integrity | `9aa072c1-a18f-4c1c-987e-af3dcd9683a6` | 2026-08-12 | 3 | 0% (0/3) |
| Observability & Trace Export | `baf06cda-7024-44c0-a7e9-8b0b507617e4` | 2026-08-26 | 2 | 0% (0/2) |
| Context & Planning Surface | `5dee250f-608b-49a1-94b5-c085f8ff08f9` | 2026-08-12 | 2 | 0% (0/2) |

```
gaze-upon — 4 milestone(s)

  Harness Safety & State Integrity  (due 2026-08-12)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/3
    OPS-885  [Triage]  Feature Doc: Checkpoint on Timeout (partial work capture)
    OPS-884  [Triage]  Feature Doc: Provider Factory (resolve_provider, config-driven OMP args)
    OPS-883  [Triage]  Feature Doc: Stale-Root Guards (extract/reconcile/pr --force)

  Context & Planning Surface  (due 2026-08-12)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    OPS-888  [Triage]  Feature Doc: Linear Roadmap View + Milestone Structure
    OPS-881  [Triage]  Feature Doc: Linear Digest (blackwall linear digest)

  Observability & Trace Export  (due 2026-08-26)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    OPS-887  [Triage]  Feature Doc: Context Observability + OTel + Phoenix + Langfuse
    OPS-886  [Triage]  Feature Doc: ST1 RunEvent Bus (dogfood-generated)

  Dogfood & Validation  (due 2026-09-09)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-882  [Triage]  Feature Doc: Dogfood Harness (OMP + glm-5.2-fast max thinking)
```

*Last 7 days: 0 opened, 0 closed.*
*Rendered by `.github/workflows/gaze-upon-velocity.yml` on schedule + dispatch.*

## What gaze-upon Is

gaze-upon is the **visibility, context, and planning surface** for the operator's
agent harness. Where Blackwall is the execution spine (dispatch, plan, settle,
RunEvent bus), gaze-upon is the layer that lets the operator (and the agents
themselves) *see* what the harness is doing, *capture* what it produced, and
*plan* what comes next. Three concerns:

1. **Context intake** — feed live project state (Linear digests, roadmaps) into
   agent context so dispatches are grounded in what's actually open.
2. **Operational observability** — structured traces, OTel export, and event
   buses that make tool-call sequences inspectable and replayable.
3. **Harness safety & dogfooding** — guards against silent state corruption
   (stale roots, time-out discard), provider abstraction for multi-model
   runs, and the dogfood loop that proves the harness on itself.

Every issue in this project is a **Feature Doc** — a design specification that
precedes implementation. None are in progress; the project is at 0% progress
because the design phase has not yet closed into execution.

---

## Milestones

### M1 — Context & Planning Surface

Give the harness (and the operator) a live read on project state: what's open,
what the roadmap says, and what got merged. These are the **read-side**
integrations — no writes, no dispatch side-effects.

| Issue | Title |
|-------|-------|
| [OPS-881](https://linear.app/cerebral-work/issue/OPS-881) | Linear Digest (blackwall linear digest) |
| [OPS-888](https://linear.app/cerebral-work/issue/OPS-888) | Linear Roadmap View + Milestone Structure |

**Why these group:** Both are Linear-introspection features that surface
project state (a digest of recent activity, a structured roadmap view) as
context for dispatch. They share a data source (Linear via `linearctl`) and a
consumer (the agent context window). Building them together means one
`linearctl` subprocess contract and one caching/staleness strategy serves both.

**Key risks:**
- Linear API rate limits: both features hit `linearctl` subprocess calls. A
  digest that pulls a large project's 14-day window plus a roadmap that pulls
  every issue can easily exceed burst limits. Caching strategy (TTL, per-query
  memoization) must be settled before either feature ships.
- The roadmap feature (OPS-888) already produced an artifact for the Blackwall
  project — it's partially validated but not generalized. Generalization to
  arbitrary projects is the remaining work.

**Exit criteria:** `blackwall linear digest` produces a grounded markdown
digest for any project; roadmap view renders milestones + issue assignments
from any project's issues. Both degrade gracefully on API failure (stale cache
with timestamp, not a blank context block).

---

### M2 — Observability & Trace Export

Make the harness's tool-call sequences inspectable and exportable. Three
layers stack: local operation traces (landed), OTel export to Phoenix (in
progress), and LLM-call observability via Langfuse. The RunEvent bus is the
transport that feeds all of them.

| Issue | Title |
|-------|-------|
| [OPS-886](https://linear.app/cerebral-work/issue/OPS-886) | ST1 RunEvent Bus (dogfood-generated) |
| [OPS-887](https://linear.app/cerebral-work/issue/OPS-887) | Context Observability + OTel + Phoenix + Langfuse |

**Why these group:** The RunEvent bus (OPS-886) is the substrate that the
observability layer (OPS-887) consumes. Per-tool-call `OpDelta` records are
already captured locally (`.blackwall/objects/traces/`); the RunEvent bus
makes them a queryable event stream, and OTel export ships them to Phoenix for
cross-run analysis. Langfuse covers the LLM-call dimension the tool-level
traces miss. Building the bus first, then the export pipeline on top, is the
natural dependency order.

**Key risks:**
- The buses described are "dogfood-generated" — the harness emitting events
  about its own operation. A feedback loop risk: if the observability layer
  is itself buggy, every subsequent diagnosis relies on data the layer
  corrupted. The bus must be write-only-append, never mutating past events.
- Phoenix + Langfuse are two separate backends covering two dimensions
  (tool calls vs. LLM calls). Correlating a tool-call trace to the LLM call
  that produced it requires a shared trace/span ID — the contract must be
  defined in this milestone, not deferred.

**Exit criteria:** RunEvent bus emits structured events for every tool call;
OTel export lands in Phoenix with runnable traces; Langfuse captures LLM
call latency/cost. All three correlate by a shared run ID.

---

### M3 — Harness Safety & State Integrity

Prevent the harness from silently destroying or discarding work. Three guards
address the three failure modes that bite hardest: stale root state that
causes a dispatch to target the wrong tree, partial work discarded on timeout,
and forced operations that bypass review.

| Issue | Title |
|-------|-------|
| [OPS-883](https://linear.app/cerebral-work/issue/OPS-883) | Stale-Root Guards (extract/reconcile/pr --force) |
| [OPS-885](https://linear.app/cerebral-work/issue/OPS-885) | Checkpoint on Timeout (partial work capture) |
| [OPS-884](https://linear.app/cerebral-work/issue/OPS-884) | Provider Factory (resolve_provider, config-driven OMP args) |

**Why these group:** All three are about the harness not trusting its own
state and not trusting its inputs. Stale-root guards prevent dispatch into a
tree that has drifted. Checkpoint-on-timeout prevents the progress made before
a timeout from vanishing. The provider factory prevents the wrong model (or a
misconfigured model) from running — a safety guard dressed as a config
abstraction. They share a concern: **the harness's internal state must be
verifiable and recoverable, never assumed**.

**Key risks:**
- Stale-root guards (OPS-883) cover `extract`, `reconcile`, and `pr --force` —
  three of the most operator-driven commands. A guard that's too aggressive
  blocks legitimate operator action; one too permissive is no guard at all.
  The threshold (what counts as "stale"?) must be operator-tunable, not
  hardcoded.
- Checkpoint-on-timeout (OPS-885) requires a checkpoint format that's
  resumable — a half-written file or a half-applied patch cannot be blindly
  resumed. The checkpoint must capture enough to either continue cleanly or
  roll back, with no middle ground.
- Provider factory (OPS-884) centralizes provider resolution. A bug here
  affects every dispatch, not just one. It must fail closed (refuse to run if
  the provider config is ambiguous) rather than fail open with a default
  guess.

**Exit criteria:** stale-root detection runs before every `extract`/`reconcile`
/`pr --force`; timed-out runs persist a checkpoint that can be resumed or
rolled back; provider resolution is config-driven with a single source of truth
and fails closed on ambiguity.

---

### M4 — Dogfood & Validation

Prove the harness on itself. The dogfood harness runs the harness's own agents
against the harness's own codebase at a known configuration, closing the loop
between "we built it" and "we trust it."

| Issue | Title |
|-------|-------|
| [OPS-882](https://linear.app/cerebral-work/issue/OPS-882) | Dogfood Harness (OMP + glm-5.2-fast max thinking) |

**Why this is separate:** Dogfooding depends on every prior milestone being
functional. It requires context intake (M1) to know what to work on,
observability (M2) to verify the dogfood run's traces, and safety guards (M3)
to prevent a dogfood run from corrupting state. It is the validation gate that
says the harness is ready to be trusted on real work — putting it in the same
milestone as the features it validates would be circular.

**Key risks:**
- `glm-5.2-fast` at max thinking is a known-flaky configuration. The dogfood
  harness must treat model output as adversarial input — validate structure,
  don't assume the model followed instructions. A dogfood run that blindly
  trusts a malformed tool call will reproduce production bugs in the dogfood
  loop.
- The dogfood loop must be hermetic: no writes to repos outside its worktree,
  no commits to main, no dispatches that escape the sandbox. A dogfood harness
  that can affect production state defeats the purpose.

**Exit criteria:** the harness runs a full dispatch cycle (context intake →
plan → tool calls → settle) against its own codebase at the target model
configuration, producing a complete, inspectable trace with no manual
intervention and no state leakage.

---

## Dependency Graph

```
M1: Context & Planning      M2: Observability           M3: Safety & Integrity
─────────────────────        ────────────────────        ───────────────────────
OPS-881 Linear Digest ─┐     OPS-886 RunEvent Bus ─┐     OPS-883 Stale-root guards
                       │                            ├─→  OPS-885 Checkpoint on timeout
OPS-888 Roadmap View ──┘     OPS-887 OTel+Phoenix ─┘     OPS-884 Provider factory
        │                           │                          │
        └───────────┬───────────────┴──────────────────────────┘
                    ▼
              M4: Dogfood & Validation
              ─────────────────────────
              OPS-882 Dogfood Harness (OMP + glm-5.2-fast)
```

**Critical path:** M2 (RunEvent bus → OTel export) is the long pole — it has
the most integration surface (Phoenix, Langfuse, OTel SDK). M1 and M3 can run
in parallel; neither depends on the other. M4 (dogfood) blocks on all three:
it needs context (M1), traces (M2), and guards (M3) to be meaningful.

Within M2, OPS-886 (RunEvent bus) precedes OPS-887 (OTel export) — the bus is
the event source the export consumes.

---

## Issue Summary

| ID | Title | Priority | State | Milestone |
|----|-------|----------|-------|-----------|
| OPS-881 | Linear Digest (blackwall linear digest) | Urgent | Triage | M1 — Context & Planning Surface |
| OPS-888 | Linear Roadmap View + Milestone Structure | Urgent | Triage | M1 — Context & Planning Surface |
| OPS-886 | ST1 RunEvent Bus (dogfood-generated) | Urgent | Triage | M2 — Observability & Trace Export |
| OPS-887 | Context Observability + OTel + Phoenix + Langfuse | Urgent | Triage | M2 — Observability & Trace Export |
| OPS-883 | Stale-Root Guards (extract/reconcile/pr --force) | Urgent | Triage | M3 — Harness Safety & State Integrity |
| OPS-885 | Checkpoint on Timeout (partial work capture) | Urgent | Triage | M3 — Harness Safety & State Integrity |
| OPS-884 | Provider Factory (resolve_provider, config-driven OMP args) | Urgent | Triage | M3 — Harness Safety & State Integrity |
| OPS-882 | Dogfood Harness (OMP + glm-5.2-fast max thinking) | Urgent | Triage | M4 — Dogfood & Validation |
