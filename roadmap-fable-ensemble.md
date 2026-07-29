# Fable Ensemble — Project Roadmap

> Generated 2026-07-22 from live Linear issues (project: Fable Ensemble, team OPS).
> 5 issues, all in Backlog, all assigned to `ctodie`, all priority Medium.
> 5 milestones created in Linear via `linearctl milestone create`; all issues
> assigned via `linearctl update --milestone`. Live render:
> `linearctl roadmap --project 'Fable Ensemble'`

## Live Linear State (auto-rendered 2026-07-29 14:32 UTC)

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
| M4 — Cutover + Re-measure | `7407aefc-390c-45ad-b288-df995e20e8e0` | 2026-10-28 | 2 | 0% (0/2) |
| M3 — Owned-Weights Distill | `ce3481e1-2bca-4b6b-bf7b-3599cf3991f3` | 2026-10-14 | 2 | 0% (0/2) |
| M2 — Prompted Ensemble Bridge | `489f5dab-b65e-460d-b6ae-d3c80a1dda18` | 2026-09-02 | 3 | 0% (0/3) |
| M1 — Verification Spine | `0f1f03ed-0cef-4f85-b671-412bb495c785` | 2026-08-19 | 1 | 0% (0/1) |
| M0 — Externalize the Substrate | `c1d4235b-cd29-45a6-bdb0-72553dec19d3` | 2026-08-05 | 1 | 0% (0/1) |

```
Fable Ensemble — 5 milestone(s)

  M0 — Externalize the Substrate  (due 2026-08-05)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-231  [Backlog]  F0 — Externalize the substrate (reflex coverage audit + bookend skill)  @ctodie

  M1 — Verification Spine  (due 2026-08-19)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-232  [Backlog]  F1 — Stand up the spine (two-engine eval harness + persona + frozen golden set)  @ctodie

  M2 — Prompted Ensemble Bridge  (due 2026-09-02)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/3
    OPS-902  [Triage]  feat(fable): bookend orchestrator — ship-feature skill as prompted pipeline
    OPS-901  [Triage]  feat(fable): exemplar bank — freeze the golden set transcripts as retrieval corpus
    OPS-900  [Triage]  feat(fable): rules-based router — prompt-family dispatch (engine 1 predicates)

  M3 — Owned-Weights Distill  (due 2026-10-14)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    OPS-904  [Triage]  feat(fable): fine-tune distilled model on platform GPU substrate
    OPS-903  [Triage]  feat(fable): distillation dataset — collect transfer pairs from M2 bridge runs

  M4 — Cutover + Re-measure  (due 2026-10-28)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    OPS-906  [Triage]  feat(fable): acceptance — full golden-set re-measure + voice stability report
    OPS-905  [Triage]  feat(fable): cutover — serve distilled weights behind the router
```

*Last 7 days: 7 issue(s) touched, 0 completed.*
*Rendered by `.github/scripts/render-roadmap.sh` (corpus auto-render, schedule + dispatch).*

## What Fable Ensemble Is

Fable Ensemble is the plan to preserve the operator's AI-assistant "voice"
(personality, judgment reflexes, steering behavior) against model
deprecation and vendor lock-in — without betting the estate on a single
frontier model or a costly training run before its value is proven.

The design is deliberately layered so each phase delivers value even if the
ones after it never run:

- **Layer A — Owned weights** (F3/F4): the durable insurance. Distilled model
  weights served on the platform's own GPU substrate. Most expensive, most
  irreversible; only justified after the cheaper layers prove the gap.
- **Layer B — Prompted ensemble** (F0/F2): zero training, fully portable. A
  rules-based router + exemplar bank + bookend orchestrator that reproduces
  the voice using prompted frontier models behind a thin gateway.
- **Layer C — Verification spine** (F1): the two-engine eval harness that makes
  every other layer's claims load-bearing. Engine 1 = deterministic reflex
  assertions (CI-able pass/fail). Engine 2 = a heterogeneous judge panel for
  the irreducibly subjective dimensions (voice-match, synthesis,
  steerability), calibrated against operator rank before its numbers count.

The dependency logic is structural, not temporal: F0 and F1 land first
because everything downstream measures against them. F2 (the bridge) either
meets the bar on prompted models alone — in which case F3 distillation may
not be worth the spend — or quantifies the exact gap that justifies it. F4
is the one-way door: cutover to owned weights behind the router, re-measured
end-to-end.

---

## Milestones

### M0 — Externalize the Substrate (OPS-231)

Make the agent's judgment reflexes — the §1B fingerprint (operator-gates
irreversible actions, backward-verifies writes, asks at forks, emits
file:line + ticket-ID, never skip-verifies, audits reality before executing)
— explicit and portable. Every reflex must map to a backing file, and the
bookend ship-feature skill must exist as a reusable artifact.

This is "layer B + C, zero training, fully portable" — the load-bearing first
third that delivers deprecation resilience even if F3/F4 never run.

| Issue | Priority | Title |
|-------|----------|-------|
| [OPS-231](https://linear.app/cerebral-work/issue/OPS-231) | Medium | F0 — Externalize the substrate (reflex coverage audit + bookend skill) |

**Exit criteria:** coverage audit 100% (every §1B reflex → backing file);
bookend dry-run on OPS-146 produces a PR whose evidence bundle is at least as
strong as a Fable-run baseline.

**Feeds:** M1 (the reflex assertions become Engine 1 predicates), M2 (the
bookend skill becomes the orchestrator).

---

### M1 — Stand Up the Spine (OPS-232)

The verification spine — the single highest-value change in the design run.
Without it, every claim about voice preservation is anecdote; with it, every
downstream layer is measured against a frozen, calibrated yardstick.

Two engines: Engine 1 (deterministic reflex assertions, CI-able, each §1B
reflex a checkable predicate against recorded transcripts) and Engine 2
(judge panel for subjective dims — voice-match as similarity-to-reference,
synthesis + steerability as absolute quality; heterogeneous panel with at
least one non-Claude judge to debias the family prior). Plus a frozen
stratified golden set (N=30 for the bridge baseline) and the persona prompt.

| Issue | Priority | Title |
|-------|----------|-------|
| [OPS-232](https://linear.app/cerebral-work/issue/OPS-232) | Medium | F1 — Stand up the spine (two-engine eval harness + persona + frozen golden set) |

**Exit criteria:** judges calibrated (judge-vs-operator rank correlation,
Krippendorff alpha ≥ 0.6); floor and ceiling anchored; baseline numbers
reported with CI lower bounds, not means.

**Open decisions:** D-2 (per-dimension bar values), D-3 (judge panel
composition + calibration bar).

**Feeds:** M2 (golden set provides the Bridge baseline), M3 (DPO pairs come
from the golden-set machinery), M4 (harness re-runs against the owned-weights
provider).

---

### M2 — Prompted Ensemble: the Bridge (OPS-233)

The bridge — a prompted ensemble delivering deprecation resilience with zero
training and full portability. If this clears the bar, F3 distillation may
not be worth the spend; if it doesn't, it quantifies the exact voice-gap
that justifies it.

Rules-based router (declarative role-to-model table in YAML, resolved by a
thin Go gateway reusing the platform's existing API gateway pattern + Kong —
not new infra). Exemplar bank for the voice surface. Bookend orchestrator
(persistent steerable session) + builder/fixer/auditor subagents + voice
surface.

| Issue | Priority | Title |
|-------|----------|-------|
| [OPS-233](https://linear.app/cerebral-work/issue/OPS-233) | Medium | F2 — Prompted ensemble: the bridge (rules router + exemplar bank) |

**Exit criteria:** per-dimension bar met by the prompted ensemble, OR a
quantified voice-gap (vs the Fable-vs-Fable ceiling) that justifies F3
distillation spend.

**Open decisions:** D-8 (routing substrate — confirm rules-router-first;
defer Morph Router / Rig to measured need), D-4 (bookend seat model).

**Feeds:** M4 (Triton-Fable registers as just one more provider behind the
same router).

---

### M3 — Owned-Weights Distill: ENDGAME (OPS-234)

The durable insurance: owned Fable weights served on the platform's own GPU
substrate. **BLOCKED on OPS-188** (GPU substrate activation) — the dev MIG
slice (~4–5 GB) cannot train a 7–14B QLoRA; the inference leg
(gpu-operator / kueue / keda → Triton) has no ArgoCD generator and gpu-pool
is pinned to 0 nodes. Do not start until that resolves.

Corpus harvested from engram + session transcripts (deduped, PII/secret
scrubbed). LoRA/QLoRA first, not full SFT. License-first base model
(Qwen-2.5 or Llama-3.x 7–14B, Apache-2.0 / MIT) — distill the voice; keep
the judgment bookend on the strongest frontier model. Pipeline: Kueue Job on
gpu-pool → OCI artifact (ORAS) in Harbor → Dynamo-Triton serving.

| Issue | Priority | Title |
|-------|----------|-------|
| [OPS-234](https://linear.app/cerebral-work/issue/OPS-234) | Medium | F3 — Owned-weights distill (ENDGAME): corpus to QLoRA to Triton |

**Exit criteria:** distilled-model voice-dim win-rate vs base at or above
target, blind-judged; Engine 1 reflex assertions not regressed.

**Precondition:** OPS-188 (finish inference leg + acquire real training GPU).
**Open decisions:** D-5 (base model + size), D-6 (training GPU acquisition).
All GPU spend is operator-gated.

**Feeds:** M4 (the owned-weights endpoint registers behind the router).

---

### M4 — Cutover + Re-measure (OPS-235)

Final cutover: the owned-weights voice provider goes live behind the router
and the full two-engine harness re-runs to prove preservation. This is the
one-way door — once Triton-Fable is the router's voice provider, the
prompted bridge surface is swapped out.

Technique #8 (a style classifier as a generation-time gate) is added here,
not earlier — it only earns its complexity once the endpoint it gates is the
owned-weights one.

| Issue | Priority | Title |
|-------|----------|-------|
| [OPS-235](https://linear.app/cerebral-work/issue/OPS-235) | Medium | F4 — Cutover + re-measure (Triton-Fable behind the router + style classifier gate) |

**Exit criteria:** composite per-dimension bar met with the owned-weights
voice provider (Engine 1 reflex coverage + Engine 2 per-dimension scores
with CIs and anchor deltas + calibration status, one-page report);
classifier AUC + rejection-rate sane.

**KEDA scale-to-zero** keeps idle serving cost near zero; cold-start latency
to weigh.

---

## Dependency Graph

```
M0: Substrate            M1: Spine              M2: Bridge
─────────────           ───────────            ──────────
OPS-231 reflex audit ──→ OPS-232 eval harness ──→ OPS-233 prompted ensemble
      │                   │     │ golden set          │ per-dim bar OR
      │                   │     │ DPO pairs            │ quantified voice-gap
      │                   │     └──────────┐           │
      │ bookend skill     │                ↓           │
      │                   │           ┌─────────────────┘
      ↓                   │           │
  reflexes → predicates   │           │      M3: Distill (ENDGAME)
      └─ Engine 1 ────────┘           │      ──────────────────
                                        └──→ OPS-234 corpus→QLoRA→Triton
                                               │  BLOCKED on OPS-188
                                               │  (GPU substrate)
                                               ↓
                                             M4: Cutover + Re-measure
                                             ────────────────────────
                                             OPS-235 Triton behind router
                                               + style classifier gate
```

**Critical path:** M0 (substrate) → M1 (spine) → M2 (bridge) → M3 (distill,
blocked on OPS-188) → M4 (cutover).

**Parallelism:** M0 and M1 have some independent work (the bookend skill vs
the eval harness) but M1's Engine 1 predicates depend on M0's reflex audit
completing. M2 cannot start meaningfully until M1's golden set is frozen.
M3 is fully blocked until OPS-188 resolves (GPU substrate). M4 depends on
both M2 (router) and M3 (owned-weights endpoint).

**Decision gate after M2:** if the prompted ensemble meets the per-dimension
bar, F3 distillation may be deferred. The plan explicitly does not assume M3
is mandatory — it is justified only by a measured voice-gap from M2.

---

## Issue Summary

| ID | Title | Priority | State | Milestone |
|----|-------|----------|-------|-----------|
| OPS-231 | F0 — Externalize the substrate (reflex audit + bookend skill) | Medium | Backlog | M0 — Externalize the Substrate |
| OPS-232 | F1 — Stand up the spine (two-engine eval harness + persona + golden set) | Medium | Backlog | M1 — Stand Up the Spine |
| OPS-233 | F2 — Prompted ensemble: the bridge (rules router + exemplar bank) | Medium | Backlog | M2 — Prompted Ensemble: the Bridge |
| OPS-234 | F3 — Owned-weights distill (ENDGAME): corpus to QLoRA to Triton | Medium | Backlog | M3 — Owned-Weights Distill: ENDGAME |
| OPS-235 | F4 — Cutover + re-measure (Triton-Fable behind the router + style classifier gate) | Medium | Backlog | M4 — Cutover + Re-measure |


---

## Created Milestones (Linear)

| Milestone | ID | Target Date | Issue |
|-----------|-----|-------------|-------|
| M0 — Externalize the Substrate | `c1d4235b-cd29-45a6-bdb0-72553dec19d3` | 2026-08-05 | OPS-231 |
| M1 — Verification Spine | `0f1f03ed-0cef-4f85-b671-412bb495c785` | 2026-08-19 | OPS-232 |
| M2 — Prompted Ensemble Bridge | `489f5dab-b65e-460d-b6ae-d3c80a1dda18` | 2026-09-02 | OPS-233 |
| M3 — Owned-Weights Distill | `ce3481e1-2bca-4b6b-bf7b-3599cf3991f3` | 2026-10-14 | OPS-234 |
| M4 — Cutover + Re-measure | `7407aefc-390c-45ad-b288-df995e20e8e0` | 2026-10-28 | OPS-235 |

---

## Live Roadmap Render

```
Fable Ensemble — 5 milestone(s)

  M0 — Externalize the Substrate  (due 2026-08-05)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-231  [Backlog]  F0 — Externalize the substrate (reflex coverage audit + bookend skill)  @ctodie

  M1 — Verification Spine  (due 2026-08-19)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-232  [Backlog]  F1 — Stand up the spine (two-engine eval harness + persona + frozen golden set)  @ctodie

  M2 — Prompted Ensemble Bridge  (due 2026-09-02)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-233  [Backlog]  F2 — Prompted ensemble: the bridge (rules router + exemplar bank)  @ctodie

  M3 — Owned-Weights Distill  (due 2026-10-14)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-234  [Backlog]  F3 — Owned-weights distill (ENDGAME): corpus to QLoRA to Triton  @ctodie

  M4 — Cutover + Re-measure  (due 2026-10-28)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-235  [Backlog]  F4 — Cutover + re-measure (Triton-Fable behind the router + style classifier gate)  @ctodie
```

*Rendered by `linearctl roadmap --project 'Fable Ensemble'` on 2026-07-22.*
