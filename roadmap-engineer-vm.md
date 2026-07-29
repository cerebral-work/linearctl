# engineer-vm ssh-wake autoscaler — Project Roadmap

> Generated 2026-07-22 from live Linear issues (project: engineer-vm ssh-wake
> autoscaler, team OPS). 6 issues: 1 In Progress, 4 in Triage, 1 Canceled.
> Project progress: 25%.
>
> **Executed in Linear:** 5 milestones created, 6 issues assigned. Rendered
> via `linearctl roadmap --project 'engineer-vm ssh-wake autoscaler'`.

## Live Linear State (auto-rendered 2026-07-29 14:33 UTC)

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
| M4 — fcsm Snapshot/Resume Backend | `5dfd5b38-9515-43ae-a7b4-d608416b58f6` | 2026-09-16 | 1 | 0% (0/1) |
| M5 — Generalization & OSS Extraction | `04864a6a-8f2d-4644-ad8b-9e3a9ce3b979` | 2026-09-30 | 2 | 0% (0/2) |
| M3 — Hardening & Observability | `8411a6ac-1117-4c5f-aacb-0e0aa72b413d` | 2026-09-02 | 1 | 0% (0/1) |
| M2 — Fleet Rollout & Onboarding | `4808fcbf-693b-4948-a574-48b612dfe393` | 2026-08-19 | 1 | 0% (0/1) |
| M1 — MVP & Accept-and-Hold Proxy | `fdb16872-8d2c-4663-b618-e5f54ee41dd0` | 2026-08-05 | 1 | 100% (1/1) |

```
engineer-vm ssh-wake autoscaler — 5 milestone(s)

  M1 — MVP & Accept-and-Hold Proxy  (due 2026-08-05)  [████████████████████] 100%  1/1
    OPS-670  [Done]  engineer-vm-waker P1: accept-and-hold SSH proxy + scale controller MVP  @ctodie

  M2 — Fleet Rollout & Onboarding  (due 2026-08-19)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-671  [Triage]  engineer-vm-waker P2: fleet rollout + opt-in defaults + onboarding docs

  M3 — Hardening & Observability  (due 2026-09-02)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-672  [Triage]  engineer-vm-waker P3: activity probe, HA decision, metrics

  M4 — fcsm Snapshot/Resume Backend  (due 2026-09-16)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-673  [Triage]  engineer-vm-waker P4: fcsm snapshot/resume wake backend

  M5 — Generalization & OSS Extraction  (due 2026-09-30)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    OPS-821  [Canceled]  waker: seed unsigned-gg/waker — generalize accept-and-hold waker to STS+Deployment scale-to-zero
    OPS-819  [Triage]  waker: seed unsigned-gg/waker — generalize accept-and-hold waker to STS+Deployment scale-to-zero
```

*Last 7 days: 2 issue(s) touched, 1 completed.*
*Rendered by `.github/scripts/render-roadmap.sh` (corpus auto-render, schedule + dispatch).*

## What This Is

An accept-and-hold TCP wake proxy + idle reaper that scales engineer VMs to
zero when idle and wakes them on SSH connect. The waker runs as a
per-VM listener (Go, ko-built): on TCP `accept` it scales the target
StatefulSet 0→1 via the `scale` subresource, polls pod `Ready` + dials guest
sshd (cap 120s), then splices the connection. An idle reaper scales back to 0
after `idleTimeout` (default 45m) with zero active connections.

Per-VM opt-in via STS annotations `unsigned.gg/wake-enabled` +
`unsigned.gg/idle-timeout`. Helm chart `helm/compute/engineer-vm-waker`
(production path `applications/engineer-vm-waker` in unsigned-paas), scoped
RBAC: `statefulsets/scale` get/patch + pods get/list/watch in the six
`*-vm` namespaces only.

The wake backend is an **interface from day one** — the P1 STS-scale
implementation is the first concrete backend; fcsm snapshot/resume (P4) and the
generalized unsigned-gg/waker repo are later backends on the same contract.

Authoritative spec: `docs/specs/engineer-vm-ssh-wake-autoscaler.md`.

---
## Milestones

### M1 — MVP & Accept-and-Hold Proxy (OPS-670)
> Linear milestone: `fdb16872-8d2c-4663-b618-e5f54ee41dd0` · target 2026-08-05

The foundational P1: a working accept-and-hold waker for one volunteer VM.
This is the only In Progress issue and the prerequisite for every subsequent
milestone — fleet rollout, hardening, and generalization all build on the P1
contract.

| Issue | Priority | State | Title |
|-------|----------|-------|-------|
| [OPS-670](https://linear.app/cerebral-work/issue/OPS-670) | Medium | In Progress | accept-and-hold SSH proxy + scale controller MVP |

**Scope:** Go service (ko-built), one listener per VM. On TCP accept → scale
target STS 0→1 → poll Ready + dial guest sshd (cap 120s) → splice. Idle reaper
scales to 0 after `idleTimeout` (45m default) with zero active connections.
Helm chart per CLAUDE.md standards with namespace-scoped RBAC.

**Key risks:**
- Splice latency budget is tight: ≤60s p95 from `ssh` invocation to shell.
  Boot time + ssdh dial must fit inside the 120s hard cap; a slow-pulling image
  or a stuck init container blows the budget silently.
- "Active sessions never severed" is the hardest invariant. The idle reaper
  must count in-flight TCP connections accurately — a race between connection
  accept and reap-zero leaves the user hung mid-keystroke.
- RBAC is scoped to six `*-vm` namespaces only; a mis-scoped chart is a
  privilege-escalation surface, not a convenience.

**Exit criteria:** one volunteer VM opted in; sleeping-VM ssh lands a shell
≤60s p95; active sessions never severed; idle reaper scales to 0 after
timeout with zero active connections.

---

### M2 — Fleet Rollout & Onboarding (OPS-671)
> Linear milestone: `4808fcbf-693b-4948-a574-48b612dfe393` · target 2026-08-19

After P1 observation week: repoint the remaining engineer VM Services at the
waker and document the opt-in contract for the fleet.

| Issue | Priority | State | Title |
|-------|----------|-------|-------|
| [OPS-671](https://linear.app/cerebral-work/issue/OPS-671) | Medium | Triage | fleet rollout + opt-in defaults + onboarding docs |

**Scope:** Repoint remaining engineer VM Services at the waker; flip opt-in
defaults for the volunteers' cohort; document per-VM overrides + first-connect
latency expectation in `awesome-unsigned` onboarding.

**Key risks:**
- `darius-vm` stays opted **OUT** until the guest activity probe (M3) exists —
  it's a headless `herdr` server where long-running non-SSH work would be
  incorrectly reaped. Fleet rollout must respect this exclusion or that
  service silently dies.
- "Opt-in defaults for volunteers' cohort" is a behavioral change for existing
  users. First-connect latency (up to 60s) is a new UX expectation that
  onboarding docs must set — a user who doesn't know the VM was sleeping
  assumes the network is broken.

**Exit criteria:** all volunteer engineer VMs repointed to the waker;
`darius-vm` explicitly excluded; onboarding docs published with first-connect
latency expectation and per-VM override instructions.

---

### M3 — Hardening & Observability (OPS-672)
> Linear milestone: `8411a6ac-1117-4c5f-aacb-0e0aa72b413d` · target 2026-09-02
The P3 hardening pass: in-guest activity probe, waker HA decision, and
Prometheus metrics. This unblocks safe opt-in for headless workloads like
`darius-vm`.

| Issue | Priority | State | Title |
|-------|----------|-------|-------|
| [OPS-672](https://linear.app/cerebral-work/issue/OPS-672) | Low | Triage | activity probe, HA decision, metrics |

**Scope:** In-guest activity probe (load/sessions via guest agent) so
long-running non-SSH work blocks reaping; waker HA decision (the waker is a
data-path component — a restart drops spliced connections); Prometheus metrics
(wake latency, reap count, saved core-hours) + Grafana panel.

**Key risks:**
- The activity probe is the correctness fix for `darius-vm`'s exclusion. If
  the probe can't distinguish "idle" from "running a background job," either
  headless workloads get reaped (data loss) or nothing gets reaped (no
  savings). The probe contract is load-bearing.
- HA decision is architecturally unresolved: the waker holds spliced TCP
  connections in memory. A pod restart drops every active session. Leader
  election vs. per-VM ownership vs. accepting the blast radius — each has a
  different failure mode that must be chosen deliberately, not defaulted.
- Metrics without saved-core-hours quantification makes the project
  un-defendable: "we built a scale-to-zero waker" needs a number attached.

**Exit criteria:** guest activity probe blocks reaping during non-SSH
workloads; waker HA decision implemented and documented; Prometheus +
Grafana surface wake latency, reap count, and saved core-hours.

---

### M4 — fcsm Snapshot/Resume Backend (OPS-673)
> Linear milestone: `5dfd5b38-9515-43ae-a7b4-d608416b58f6` · target 2026-09-16
When engineer VMs converge onto fcsm (OPS-589): swap the waker's backend from
`statefulsets/scale` to Firecracker snapshot/resume via the fcsm session API.
Sub-second wake, guest memory state preserved.

| Issue | Priority | State | Title |
|-------|----------|-------|-------|
| [OPS-673](https://linear.app/cerebral-work/issue/OPS-673) | Low | Triage | fcsm snapshot/resume wake backend |

**Scope:** Implement the fcsm backend behind the existing wake interface.
Sub-second wake, guest memory state preserved, removes boot latency and
lost-state concerns. The accept-and-hold contract is unchanged — only the
backend implementation swaps.

**Key risks:**
- **Hard dependency on OPS-589 (fcsm convergence).** This milestone cannot
  land until engineer VMs run on fcsm. It's blocked on platform work outside
  this project's scope; track OPS-589, not OPS-673, for the unblock.
- "The backend be an interface from day one" (spec mandate) means M1's STS
  implementation must not leak backend-specific assumptions into the
  accept-and-hold contract. If it does, the fcsm swap becomes a rewrite, not
  a backend swap.
- Snapshot/resume preserves guest memory state — this is a semantic change
  from the STS backend (fresh boot). Long-lived state (stale DNS, expired
  tokens, half-open connections) now persists across wake cycles. This may be
  a feature or a bug depending on the workload.

**Exit criteria:** fcsm backend implements the wake interface; sub-second wake
verified; guest memory state preserved across wake cycles; STS backend remains
as a fallback or is removed by explicit decision.

---

### M5 — Generalization & OSS Extraction (OPS-819, OPS-821)
> Linear milestone: `04864a6a-8f2d-4644-ad8b-9e3a9ce3b979` · target 2026-09-30

Extract the P1 Go code into `unsigned-gg/waker` as a generalized
scale-to-zero activator for StatefulSets **and** Deployments.

| Issue | Priority | State | Title |
|-------|----------|-------|-------|
| [OPS-819](https://linear.app/cerebral-work/issue/OPS-819) | Medium | Triage | seed unsigned-gg/waker — generalize to STS+Deployment scale-to-zero |
| [OPS-821](https://linear.app/cerebral-work/issue/OPS-821) | Medium | Canceled | waker: seed unsigned-gg/waker (duplicate of OPS-819) |

**Scope:** Port the P1 Go code into the new repo (`unsigned-gg/waker`,
created 2026-07-18, currently empty) with terrarium-standard scaffold
(moon/proto, lefthook, release-please, signed commits). Generalize the target
from STS-only to STS+Deployment via the `scale` subresource. Keep the wake
backend an interface from day one.

> **OPS-821 is a Canceled duplicate of OPS-819** (same title, same description,
> created 7 seconds apart). It carries no independent scope — included here
> for completeness so the roadmap reflects the full issue set.

**Key risks:**
- Generalization from STS-only to STS+Deployment changes the RBAC surface:
  `deployments/scale` is a different permission than `statefulsets/scale`.
  The chart's RBAC must be widened deliberately, and namespace-scoping becomes
  more critical (a Deployment scale permission cluster-wide is a broad
  surface).
- Extraction is a fork point: once the code lives in `unsigned-gg/waker`, the
  engineer-vm chart consumes it as a dependency. The interface contract
  (accept-and-hold, idle reaper, backend pluggability) must be stable before
  extraction or the chart and the repo will drift.
- An empty repo with a description is not a project. This milestone is
  unblocked but unprioritized — it depends on M1 being Done and the operator
  choosing to invest in generalization over the P2-P4 hardening path.

**Exit criteria:** `unsigned-gg/waker` repo seeded with terrarium-standard
scaffold; P1 Go code ported; STS+Deployment scale-to-zero generalized; wake
backend interface preserved; first release cut.

---

## Dependency Graph

```
M1: MVP & Proxy              M2: Fleet Rollout        M3: Hardening
─────────────────           ─────────────────         ──────────────
OPS-670 P1 MVP ───── is a ─→ OPS-671 P2 rollout       OPS-672 P3 probe/HA/metrics
  (In Progress)       prereq   (after observation wk)   (unblocks darius-vm)
      │
      │ accept-and-hold contract stable
      ▼
M4: fcsm Backend             M5: OSS Extraction
──────────────────           ──────────────────
OPS-673 P4 snapshot/resume   OPS-819 seed unsigned-gg/waker
  (blocked on OPS-589         (generalize STS→STS+Deployment;
   fcsm convergence)           OPS-821 = canceled dup)
```

**Critical path:** M1 (MVP) → M2 (fleet rollout). M2 cannot start until the
P1 observation week completes — it's the validation gate for fleet-wide
opt-in.

**Parallelizable:** M3 (hardening) and M5 (extraction) are both unblocked once
M1 lands. M3 corrects the `darius-vm` exclusion; M5 generalizes the contract.
They can run concurrently but M5's interface stability affects M3's HA
decision — coordinate the backend-interface contract, not the schedule.

**Blocked:** M4 (fcsm backend) is blocked on OPS-589 (fcsm convergence), a
platform dependency outside this project. Track OPS-589 for the unblock; do
not estimate M4 until fcsm lands.

---

## Issue Summary

| ID | Title | Priority | State | Milestone |
|----|-------|----------|-------|-----------|
| [OPS-670](https://linear.app/cerebral-work/issue/OPS-670) | accept-and-hold SSH proxy + scale controller MVP | Medium | In Progress | M1 — MVP & Accept-and-Hold Proxy |
| [OPS-671](https://linear.app/cerebral-work/issue/OPS-671) | fleet rollout + opt-in defaults + onboarding docs | Medium | Triage | M2 — Fleet Rollout & Onboarding |
| [OPS-672](https://linear.app/cerebral-work/issue/OPS-672) | activity probe, HA decision, metrics | Low | Triage | M3 — Hardening & Observability |
| [OPS-673](https://linear.app/cerebral-work/issue/OPS-673) | fcsm snapshot/resume wake backend | Low | Triage | M4 — fcsm Snapshot/Resume Backend |
| [OPS-819](https://linear.app/cerebral-work/issue/OPS-819) | seed unsigned-gg/waker — generalize to STS+Deployment | Medium | Triage | M5 — Generalization & OSS Extraction |
| [OPS-821](https://linear.app/cerebral-work/issue/OPS-821) | seed unsigned-gg/waker (canceled duplicate of OPS-819) | Medium | Canceled | M5 — Generalization & OSS Extraction |

**Note on OPS-821:** Canceled duplicate of OPS-819, created 7 seconds apart.
No independent scope. Included for completeness — the roadmap accounts for all
6 issues in the project.

---

## Rendered Roadmap (live from Linear)

```
$ linearctl roadmap --project 'engineer-vm ssh-wake autoscaler'

engineer-vm ssh-wake autoscaler — 5 milestone(s)

  M1 — MVP & Accept-and-Hold Proxy  (due 2026-08-05)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-670  [In Progress]  engineer-vm-waker P1: accept-and-hold SSH proxy + scale controller MVP  @ctodie

  M2 — Fleet Rollout & Onboarding  (due 2026-08-19)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-671  [Triage]  engineer-vm-waker P2: fleet rollout + opt-in defaults + onboarding docs

  M3 — Hardening & Observability  (due 2026-09-02)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-672  [Triage]  engineer-vm-waker P3: activity probe, HA decision, metrics

  M4 — fcsm Snapshot/Resume Backend  (due 2026-09-16)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    OPS-673  [Triage]  engineer-vm-waker P4: fcsm snapshot/resume wake backend

  M5 — Generalization & OSS Extraction  (due 2026-09-30)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    OPS-821  [Canceled]  waker: seed unsigned-gg/waker — generalize accept-and-hold waker to STS+Deployment scale-to-zero
    OPS-819  [Triage]  waker: seed unsigned-gg/waker — generalize accept-and-hold waker to STS+Deployment scale-to-zero
```
