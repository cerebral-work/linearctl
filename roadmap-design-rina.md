# Roadmap — design: rina

> Design-side tracking for RINA. Canon flow: Marc authors in the claude.ai design project "Kanae - Negai" (9be550ef) → `ds-pullback` skill syncs to R2 bucket `ds-rina` (CF account 07ae, wrangler OAuth). App consumption: `cerebral-work/rina` tokens.css / shadcn config. Marc Goudet co-owns; structure and artifacts are PROVISIONAL until he ratifies.
>
> **Linear project:** [`design: rina`](https://linear.app/cerebral-work/project/design-rina-16cacb5f60c3) · `cd9a8adb-7aa4-4309-a71d-702ebba442f3`

---

## Milestones

### M1 — Design-to-App Pipeline · target 2026-08-08

Lock down the design artifact transport from claude.ai → R2 → app consumption. The pipeline that carries design tokens from Marc's authoring surface into the production app, with automated drift detection so broken sync never goes unnoticed again.

**Scope:**
- ds-pullback → R2 → app ingestion loop verified end-to-end
- Automated weekly drift detection (BRAND-8, standing chore)
- Pipeline health dashboard or runbook
- Wrangler OAuth for R2 write path documented

**Issues:** BRAND-8

---

### M2 — Design Token Foundation · target 2026-08-22

Establish the rina token system in `tokens.css` and shadcn theme config. Verify the token surface that all composite component styles build on, with app-side `globals.css` as the single source of truth (per CLAUDE.md rule 4).

**Scope:**
- `tokens.css` — full rina color/spacing/typography token set
- shadcn theme config aligned to rina tokens
- Token consumption audit — every component using registered tokens
- Migration of stray shadcn-native tokens (`border-input`, `bg-background`, `text-muted-foreground`, `ring-ring`) to stone palette

---

### M3 — Composite Component Styling · target 2026-09-05

Restore and fill all `.rina-*` composite CSS classes. The five composite components (BuyButton, SellButton, PriceBlock, DepositBlock, ConditionPill) and StatusBadge currently render as bare unstyled text because class definitions were dropped during the lib unification refactor.

**Scope:**
- Define `.rina-btn-buy`, `.rina-btn-sell`, `.rina-price*`, `.rina-condition-pill*`, `.rina-deposit-bar*`
- Define `.rina-status-*` / `.rina-dot-*` mapping for StatusBadge
- Visual verification on `wishxrina.com` behind access wall
- `textarea.tsx` token migration (off shadcn tokens → stone tokens matching `input.tsx`)

---

### M4 — Design QA & Ratification · target 2026-09-19

Cross-component design audit, production visual verification, and Marc's ratification of the design system. The structure and artifacts remain PROVISIONAL until Marc signs off (house rule).

**Scope:**
- Full visual audit across all rina composite components
- Marc ratification gate — artifacts marked ratified or revised
- Design system documentation — usage guide for rina tokens + composite classes
- Production sign-off — every component renders styled on prod

---

*Rendered by linearctl `roadmap --project 'design: rina'` — see append below.*
