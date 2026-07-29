# soma — Project Roadmap

> Generated 2026-07-22 via `linearctl roadmap --project soma`
> Source: [Linear — soma](https://linear.app/cerebral-work/project/soma-c6b4537264a7)

soma is the agentic OS (reflex gate plane, trust-ledger, per-user hermes
function-agent runtime, deck, CLI, spec). As of 2026-07-18 it is scaffold;
verbs route through reflex once Phase 1 lands.

---

## Live Linear State (auto-rendered 2026-07-29 14:30 UTC)

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
| Extensions & Observability | `3c576bbc-d0c2-462f-acb0-5ebefb1a4bb9` | 2026-11-15 | 2 | 0% (0/2) |
| Standards & Governance | `55b4da6a-7d74-4b21-aafc-30da0c268b6a` | 2026-10-15 | 2 | 0% (0/2) |
| Agent Runtime & Memory | `1a729e6d-3386-43d2-b1cb-2c91cea20937` | 2026-09-15 | 3 | 33% (1/3) |
| Reflex Gate Plane | `cbb820fe-3e6c-41f5-a100-a645807a86ca` | 2026-08-15 | 4 | 0% (0/4) |

```
soma — 4 milestone(s)

  Reflex Gate Plane  (due 2026-08-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/4
    CER-1706  [Backlog]  Reflex trust-ledger: classification engine + decision persistence
    CER-1639  [Backlog]  Spec drift gate: pin harness hook record shapes to spec/
    CER-1634  [Backlog]  Reflex client contract: reflex-classify.sh PreToolUse hook (Phase 1 gate)
    CER-1633  [In Progress]  Reflex client #0 interim: sign-off JSONL annex in the guard hooks  @ctodie

  Agent Runtime & Memory  (due 2026-09-15)  [███████░░░░░░░░░░░░░] 33%  1/3
    CER-1707  [Backlog]  soma CLI: verb dispatch through reflex gate plane
    CER-1637  [Done]  hermes function-agent preset + per-agent LiteLLM virtual keys  @ctodie
    CER-1635  [Backlog]  Memory tiers on reverie: engram schemas + per-principal scoping

  Standards & Governance  (due 2026-10-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    CER-1638  [Backlog]  Naming decision: cortex (reverie mesh CLI) vs Cortex (soma §9 layer)
    CER-1636  [Backlog]  os repo standards adoption: stage via create wizard, operator installs

  Extensions & Observability  (due 2026-11-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    CER-1708  [Backlog]  soma deck: composition plane for agent output and reflex state
    CER-1640  [Backlog]  Extensions backlog: Linear ratification trail, PostHog workforce observability, voice approvals
```

*Last 7 days: 13 issue(s) touched, 2 completed.*
*Rendered by `.github/scripts/render-roadmap.sh` (corpus auto-render, schedule + dispatch).*

## Milestone Overview

| # | Milestone | Target | Progress | Issues |
|---|---|---|---|---|
| 1 | Reflex Gate Plane | 2026-08-15 | 0% (0/4) | 4 |
| 2 | Agent Runtime & Memory | 2026-09-15 | 33% (1/3) | 3 |
| 3 | Standards & Governance | 2026-10-15 | 0% (0/2) | 2 |
| 4 | Extensions & Observability | 2026-11-15 | 0% (0/2) | 2 |

---

## M1: Reflex Gate Plane  `(due 2026-08-15)`  `[░░░░░░░░░░░░░░░░░░░░] 0%  0/4`

Phase 1 foundation: reflex classification hook, sign-off JSONL annex, the
classification engine itself, and the spec-drift gate that pins all record
shapes. Establishes the gate plane that soma verbs route through.

This is the critical path — nothing downstream can ship until the gate plane
classifies tool calls and persists decisions to the trust-ledger.

| Issue | State | Assignee | Description |
|---|---|---|---|
| CER-1633 | In Progress | @ctodie | Reflex client #0 interim: sign-off JSONL annex in the guard hooks |
| CER-1634 | Backlog | — | Reflex client contract: reflex-classify.sh PreToolUse hook (Phase 1 gate) |
| CER-1706 | Backlog | — | Reflex trust-ledger: classification engine + decision persistence |
| CER-1639 | Backlog | — | Spec drift gate: pin harness hook record shapes to spec/ |

**Dependencies:** CER-1634 (hook contract) → CER-1706 (engine that the hook
calls). CER-1633 (sign-off annex) is the interim path, consumed by CER-1706.
CER-1639 validates all three against spec schemas.

---

## M2: Agent Runtime & Memory  `(due 2026-09-15)`  `[███████░░░░░░░░░░░░░] 33%  1/3`

hermes function-agent runtime with per-agent LiteLLM virtual keys, memory tier
integration on reverie (engram schemas + per-principal scoping), and the soma
CLI that routes verbs through the reflex gate plane.

The runtime foundation is done (CER-1637 shipped). Memory tiers and the CLI
verb dispatch layer are the remaining work.

| Issue | State | Assignee | Description |
|---|---|---|---|
| CER-1637 | Done | @ctodie | hermes function-agent preset + per-agent LiteLLM virtual keys |
| CER-1635 | Backlog | — | Memory tiers on reverie: engram schemas + per-principal scoping |
| CER-1707 | Backlog | — | soma CLI: verb dispatch through reflex gate plane |

**Dependencies:** CER-1707 depends on M1 (reflex gate must classify before
verbs route through it) and CER-1637 (runtime preset). CER-1635 feeds
CER-1707 (per-principal context retrieval).

---

## M3: Standards & Governance  `(due 2026-10-15)`  `[░░░░░░░░░░░░░░░░░░░░] 0%  0/2`

Resolve the cortex naming collision (reverie mesh CLI vs soma §9 layer) and
adopt os-repo standards via the create wizard with operator-installed defaults.
These are governance/decision tickets that unblock naming and scaffold
consistency across the estate.

| Issue | State | Assignee | Description |
|---|---|---|---|
| CER-1638 | Backlog | — | Naming decision: cortex (reverie mesh CLI) vs Cortex (soma §9 layer) |
| CER-1636 | Backlog | — | os repo standards adoption: stage via create wizard, operator installs |

**Dependencies:** CER-1638 (naming) should land before any soma layer naming
is locked. CER-1636 (standards adoption) is independent but prerequisites clean
naming.

---

## M4: Extensions & Observability  `(due 2026-11-15)`  `[░░░░░░░░░░░░░░░░░░░░] 0%  0/2`

Extensions backlog: Linear ratification trail for reflex decisions, PostHog
workforce observability, voice-based approval flows, and the soma deck — the
composition plane that renders reflex state and agent output for the operator.

| Issue | State | Assignee | Description |
|---|---|---|---|
| CER-1640 | Backlog | — | Extensions backlog: Linear ratification trail, PostHog workforce observability, voice approvals |
| CER-1708 | Backlog | — | soma deck: composition plane for agent output and reflex state |

**Dependencies:** CER-1708 (deck) consumes the trust-ledger stream from
CER-1706 (M1) and surfaces voice approvals from CER-1640. Can begin
stubbing once M1 ships; full feature depends on M1 + CER-1640.

---

## Rendered Output

```
soma — 4 milestone(s)

  Reflex Gate Plane  (due 2026-08-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/4
    CER-1706  [Backlog]  Reflex trust-ledger: classification engine + decision persistence
    CER-1639  [Backlog]  Spec drift gate: pin harness hook record shapes to spec/
    CER-1634  [Backlog]  Reflex client contract: reflex-classify.sh PreToolUse hook (Phase 1 gate)
    CER-1633  [In Progress]  Reflex client #0 interim: sign-off JSONL annex in the guard hooks  @ctodie

  Agent Runtime & Memory  (due 2026-09-15)  [███████░░░░░░░░░░░░░] 33%  1/3
    CER-1707  [Backlog]  soma CLI: verb dispatch through reflex gate plane
    CER-1637  [Done]  hermes function-agent preset + per-agent LiteLLM virtual keys  @ctodie
    CER-1635  [Backlog]  Memory tiers on reverie: engram schemas + per-principal scoping

  Standards & Governance  (due 2026-10-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    CER-1638  [Backlog]  Naming decision: cortex (reverie mesh CLI) vs Cortex (soma §9 layer)
    CER-1636  [Backlog]  os repo standards adoption: stage via create wizard, operator installs

  Extensions & Observability  (due 2026-11-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    CER-1708  [Backlog]  soma deck: composition plane for agent output and reflex state
    CER-1640  [Backlog]  Extensions backlog: Linear ratification trail, PostHog workforce observability, voice approvals
```
