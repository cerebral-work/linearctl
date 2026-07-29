# Roadmap — design: rina

> Design-side tracking for RINA. Canon flow: Marc authors in the claude.ai design project "Kanae - Negai" (9be550ef) → `ds-pullback` skill syncs to R2 bucket `ds-rina` (CF account 07ae, wrangler OAuth). App consumption: `cerebral-work/rina` tokens.css / shadcn config. Marc Goudet co-owns; structure and artifacts are PROVISIONAL until he ratifies.
>
> **Linear project:** [`design: rina`](https://linear.app/cerebral-work/project/design-rina-16cacb5f60c3) · `cd9a8adb-7aa4-4309-a71d-702ebba442f3`

---

## Live Linear State (auto-rendered 2026-07-29 14:35 UTC)

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
| Design QA & Ratification | `b78b4be2-6baf-4300-89e5-edf5731e7b8d` | 2026-09-19 | 3 | 0% (0/3) |
| Composite Component Styling | `4d4f5775-bef3-423b-9f1a-8f0c09847945` | 2026-09-05 | 2 | 0% (0/2) |
| Design Token Foundation | `67a0a382-6e51-4948-8306-2b76ee98c838` | 2026-08-22 | 3 | 0% (0/3) |
| Design-to-App Pipeline | `cfba9240-c675-4ffc-9667-7cbf1af1a2b0` | 2026-08-08 | 2 | 0% (0/2) |

```
design: rina — 4 milestone(s)

  Design-to-App Pipeline  (due 2026-08-08)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    BRAND-35  [Backlog]  Verify ds-pullback → R2 → app ingestion loop end-to-end
    BRAND-8  [Backlog]  [chore] weekly ds-pullback drift check — rina

  Design Token Foundation  (due 2026-08-22)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/3
    BRAND-38  [Backlog]  Token consumption audit — every component using registered rina tokens
    BRAND-37  [Backlog]  Align shadcn theme config to rina tokens
    BRAND-36  [Backlog]  Define full rina token set in tokens.css

  Composite Component Styling  (due 2026-09-05)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    BRAND-40  [Backlog]  Migrate textarea.tsx off shadcn tokens to stone palette
    BRAND-39  [Backlog]  Restore missing .rina-* composite CSS classes — Buy/Sell/Price/Condition/Deposit

  Design QA & Ratification  (due 2026-09-19)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/3
    BRAND-43  [Backlog]  Design system documentation — rina token + composite class usage guide
    BRAND-42  [Backlog]  Marc ratification gate — design system sign-off
    BRAND-41  [Backlog]  Full visual audit across all rina composite components on prod
```

*Last 7 days: 1 issue(s) touched, 0 completed.*
*Rendered by `.github/scripts/render-roadmap.sh` (corpus auto-render, schedule + dispatch).*

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
