# Roadmap — design: lab.cerebral.work

> Generated 2026-07-22 via `linearctl roadmap --project 'design: lab.cerebral.work'`
> Project UUID: `c54700c9-fcf9-4451-9a10-80fa83f8a885`
> Team: BRAND · State: started · Progress: ~6%

---

## Milestone Overview

| # | Milestone | Target Date | Theme |
|---|-----------|-------------|-------|
| M0 | Foundation & Governance | 2026-08-15 | Legal, licensing, canon ratification, realm-contract wave 0 |
| M1 | Design System Core — Components v0.8.0–v0.12.0 | 2026-09-30 | Component library waves 2→6 |
| M2 | Realm Contract Migration & Auth Unification | 2026-10-31 | Site/bbs onto realm contract, gate dedup, spoke wiring |
| M3 | Identity Polish & Tenant Surfaces | 2026-11-30 | Latte light scale, storyboards, glass parity, terminal idiom |

---

## M0 — Foundation & Governance (target 2026-08-15)

The blocking-est work lives here: trademark clearance, font licensing, canon
ratification, and the realm-contract wave-0 wiring that everything downstream
depends on. No component wave ships until the legal + governance gates close.

**Issues:**
- `BRAND-14` — canon: ratify the v0.5.x implementation + decide the remaining surfaces
- `BRAND-18` — Marc ratification pass: PROVISIONAL roles, structure, RFC 0001 amendment
- `BRAND-15` — fonts: PP Fraktion Mono + Cerebral Glyph — what licenses do you hold?
- `BRAND-17` — Buy PP Fraktion Mono web license; embed as canon slot 1
- `BRAND-16` — trademark: "Cerebral" knockout = CROWDED — counsel clearance needed
- `BRAND-25` — wave 0: bbs onto @cerebral/design (reimplements 5 existing recipes)
- `BRAND-26` — wave 0: site onto the realm contract (reverie brand realm wiring)
- `BRAND-13` — hub phase 1 (guardrails): realm-lint + recipe gallery before spoke #1 ✓ Done

**Missing tickets to file:**
- RFC 0001 ratification checklist + sign-off ceremony (operator gate)

---

## M1 — Design System Core: Components v0.8.0–v0.12.0 (target 2026-09-30)

The sequential component-wave pipeline — forms → structure/data → overlays →
terminal idiom → power components. Each wave ships a versioned release; the
wave-4 fork decision gates whether we stay on v0.10.x or fork the component
surface.

**Issues:**
- `BRAND-20` — components wave 2 — forms complete (v0.8.0)
- `BRAND-21` — components wave 3 — structure & data (v0.9.0)
- `BRAND-22` — components wave 4 — overlays & feedback (v0.10.0) + Phase-3 fork decision
- `BRAND-23` — components wave 5 — terminal idiom (v0.11.0)
- `BRAND-24` — components wave 6 — power components (v0.12.0)

---

## M2 — Realm Contract Migration & Auth Unification (target 2026-10-31)

Consolidating all properties (lab, design, dreams) onto the realm contract and
deduplicating auth screens via cb-gate. The voicenotes living-terminal migration
is canceled (BRAND-11) — the spoke-1 work is superseded by the broader realm
contract.

**Issues:**
- `BRAND-27` — gate dedup: migrate lab/design/dreams hand-rolled auth screens to cb-gate
- `BRAND-11` — voicenotes: migrate to living-terminal (spoke #1) — Canceled

**Missing tickets to file:**
- Realm contract conformance audit across all properties (lab/design/dreams/voicenotes)
- cb-gate integration: design system authentication component spec

---

## M3 — Identity Polish & Tenant Surfaces (target 2026-11-30)

The final-polish milestone: the Latte light scale (every derived overlay step
currently fails AA), tenant storyboards, the glass effect Firefox parity, and
the terminal idiom surfacing for tenant content types.

**Issues:**
- `BRAND-12` — cerebral identity: design the Latte light scale (every derived overlay step fails AA)
- `BRAND-19` — design.cerebral.work: storyboards for voicenotes / files / dreams tenants
- `BRAND-1` — glass: Firefox behavior check (Chrome + Safari verified empirically 2026-07-08)

**Missing tickets to file:**
- Latte light scale: AA-conformant overlay pass + contrast audit
- Tenant storyboard review: operator sign-off on voicenotes/files/dreams direction
