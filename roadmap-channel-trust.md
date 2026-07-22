# Channel-Trust Injection Hardening — Project Roadmap

> Linear project: [Channel-Trust Injection Hardening](https://linear.app/cerebral-work/project/channel-trust-injection-hardening-0b0954e7c49b)

The mission: close the structural gap between agent channels (mesh wakeup,
send-keys, tool-use) and the trust-trust boundary they must never cross.
Every workstream hardens one channel so that secrets, blast-radius actions,
and peer-to-peer capability injection become structurally unreachable —
gated by authentication, attribution, and tiered governance rather than
policy alone.

---

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
