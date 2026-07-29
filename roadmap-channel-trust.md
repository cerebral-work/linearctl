# Channel-Trust Injection Hardening — Project Roadmap

> Linear project: [Channel-Trust Injection Hardening](https://linear.app/cerebral-work/project/channel-trust-injection-hardening-0b0954e7c49b)

The mission: close the structural gap between agent channels (mesh wakeup,
send-keys, tool-use) and the trust-trust boundary they must never cross.
Every workstream hardens one channel so that secrets, blast-radius actions,
and peer-to-peer capability injection become structurally unreachable —
gated by authentication, attribution, and tiered governance rather than
policy alone.

---

## Live Linear State (auto-rendered 2026-07-29 14:33 UTC)

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
| Phase 2: Authenticated Peer Wakeups | `06c4ff58-7fe2-4ba7-8958-41a134aa3fe2` | 2026-01-15 | 1 | 0% (0/1) |
| Phase 0: Foundation Gates | `0c148ca7-889b-4d0e-b2be-6e613d5760f4` | 2025-09-15 | 1 | 0% (0/1) |
| Phase 1: Secret-Exfil Structural Unreachability | `a6feec55-69d1-4456-820f-f4734644e0f1` | 2025-11-15 | 2 | 0% (0/2) |
| Phase 3: Trust-Tier Governance | `dd11bab4-395b-4380-9b56-fd2cf9604fd4` | 2026-03-15 | 1 | 0% (0/1) |

```
Channel-Trust Injection Hardening — 4 milestone(s)

  Phase 0: Foundation Gates  (due 2025-09-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    SEC-20  [Backlog]  Harden Foundation Gates integration test — verify PreToolUse + send-keys gates together

  Phase 1: Secret-Exfil Structural Unreachability  (due 2025-11-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    SEC-53  [Backlog]  feat(channel-trust): capability graph audit — enumerate all secret→sink paths
    SEC-52  [Backlog]  feat(channel-trust): type-system enforcement — make secret→exfil path unrepresentable

  Phase 2: Authenticated Peer Wakeups  (due 2026-01-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    SEC-21  [Backlog]  Capability-token protocol spike — PoC signed scoped wakeup token

  Phase 3: Trust-Tier Governance  (due 2026-03-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    SEC-22  [Backlog]  Audit implicit trust-tier assumptions across agent + mesh codebase
```

*Last 7 days: 2 issue(s) touched, 0 completed.*
*Rendered by `.github/scripts/render-roadmap.sh` (corpus auto-render, schedule + dispatch).*

## Milestone 1 — Phase 0: Foundation Gates (target 2025-09-15)

The hardening floor: enforce attribution and blast-radius gates on the two
channels an agent already commands — send-keys (output side) and PreToolUse
(input side). Every later phase assumes these gates exist and are enforced.
Also absorbs the incident-response hardening of the kagent endpoints exposed
on dev.unsigned.gg, and the open-decisions interview that must resolve
design ambiguities before Phase 1 build.

**Issues**
- SEC-1 — WS4 — send-keys attribution logging (Phase 0) ✅ Done
- SEC-2 — WS1 — enforced PreToolUse gate on blast-radius actions (Phase 0)
- SEC-14 — SEC: kagent agent endpoints exposed unauthenticated on dev.unsigned.gg — harden + make durable
- SEC-6 — Open decisions — interview before build

---

## Milestone 2 — Phase 1: Secret-Exfil Structural Unreachability (target 2025-11-15)

Make the path from a secret to an exfiltration sink structurally
unreachable — not just policy-gated but impossible to express in the type
system or capability graph. This is the workstream that turns "agents
shouldn't leak secrets" into "agents can't leak secrets."

**Issues**
- SEC-3 — WS3 — make secret→exfil structurally unreachable (Phase 1)

---

## Milestone 3 — Phase 2: Authenticated Peer Wakeups (target 2026-01-15)

Replace unauthenticated mesh wakeup with a capability-token protocol:
peer agents may only wake and inject work into each other when they can
present a signed, scoped capability. Closes the injection vector the mesh
currently exposes between trust tiers.

**Issues**
- SEC-4 — WS2 — authenticated peer wakeups (Phase 2)

---

## Milestone 4 — Phase 3: Trust-Tier Governance (target 2026-03-15)

Encode the trust tiers — the lattice, not just the labels — into the
governance layer so that capability injection, tool access, and peer
wakeup are all resolved against a single authoritative tier function.
This is the governance capstone that makes the per-channel hardening of
Phases 0–2 composable and enforceable as policy.

**Issues**
- SEC-5 — WS5 — governance: encode trust tiers (Phase 3)
