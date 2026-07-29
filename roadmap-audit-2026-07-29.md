# Roadmap corpus audit — Vesperan estate assets

> Audit date: **2026-07-29**. Read-only pass — no Linear writes performed.
> Corpus: the 30 `roadmap-*.md` files at the root of `cerebral-work/linearctl`.
> Live evidence: `linearctl digest --since 7d --json` (707 issues touched,
> **242 completed** since the snapshots), `linearctl project list`,
> `linearctl search`, `~/vesperan-estate/` repo sweeps (2026-07-19), reverie
> memory (`vesperan-holdco-structure`, `vesperan-estate-staleness`).

## 1 · Executive summary

- **The corpus is 7 days stale against a week that closed 242 issues.** All
  30 files except `roadmap-gaze-upon.md` are static snapshots generated
  2026-07-22 (linearctl's own on 07-25). Only gaze-upon has an auto-refresh
  mechanism (`.github/workflows/gaze-upon-velocity.yml`); it re-rendered
  itself 2026-07-28.
- **Worst drift:** `engineer-vm ssh-wake autoscaler` is now **100% complete**
  in Linear while its roadmap shows every milestone at 0%. Meridian is at
  **78.6%** vs an all-backlog roadmap. linearctl's own roadmap still lists
  CER-1148/1149/1188 as open M4 prerequisites — all three are now **Done**
  (CER-1149 closed today, 2026-07-29).
- **Coverage gaps against the Vesperan estate:** no roadmap exists for the
  **Vesperan Formation project itself** (VES team, 7 issues, 3 In Progress),
  for **reverie** (the flagship asset), for **Blackwall** (project at 97.3%),
  or for **dreamcode / herdr / site / voicenotes** (no Linear projects at
  all). The `escapement` roadmap covers 3 issues while the EST team logged
  117 touches this week — it no longer represents the surface it names.
- **VES-7 already tracks the downstream consequence:** the
  `~/vesperan-estate/` valuation docs are stale on soma/blackwall/escapement
  and volume coefficients must be re-run before any re-valuation. A refreshed
  roadmap corpus is an input to that re-valuation, not a substitute for it.
- **Tool finding:** `linearctl project list` returns exactly 50 rows — no
  pagination. Reverie, linearctl, Terrarium, Fable Ensemble and others exist
  but are silently absent from the listing. Candidate bug ticket.

## 2 · Corpus inventory

30 files, one mechanism split:

| Class | Files | Refresh |
|---|---|---|
| Auto-rendered | `roadmap-gaze-upon.md` | CI workflow, schedule + dispatch (last: 2026-07-28) |
| Static snapshots | the other 29 | manual `linearctl roadmap` / session-authored, 2026-07-22 (linearctl: 07-25) |

Three docs have unfilled render placeholders (`open-panel`,
`reverie-cloud-prereqs`, `crm` — "roadmap will be rendered here" /
empty append sections). `design: rina` ends mid-sentence at its render stub.

## 3 · Staleness — doc claim vs live Linear (2026-07-29)

Live figures from `project list` progress + the 7-day digest. Projects marked
"paginated out" exist but were dropped by the 50-row cap; their drift is
inferred from the digest.

| Roadmap file | Doc claim (07-22) | Live (07-29) | Verdict |
|---|---|---|---|
| engineer-vm | 0% everywhere, OPS-670 In Progress | **project 100%** | **Fully stale — project completed** |
| meridian | 6 issues all Backlog | **78.6%**; OPS-1058–1061 filed *and* closed 07-27 (never in doc) | **Fully stale** |
| linearctl | M4 open (CER-1148/1149/1188) | all three **Done**; CER-1759 (milestone update cmd) shipped; 0.7.0 + unreleased watch/operator/handoff work | **Stale — M4 substantially landed** |
| escapement | 3 issues (EST-1..3), 0% | project **28.5%**; EST team +117 touches (soma funnel EST-80/83, estate work EST-41..74) | **Under-scoped + stale** |
| soma | M2 33% | project 10.7% (metric shift); reflex/trust-ledger surge post-07-18 not reflected | Stale |
| cicatrix | M1 100 / M2 0 / M3 "Ready" | project **53.3%** | Stale |
| secrets-credential-mgmt | 7/18 done (39%) | project **58.3%** | Stale |
| identity-realms | 77.8% | **88.9%** | Mild drift |
| identity-access | 56% | project 70% | Mild drift |
| cloudflare-zero-trust | 86% | 85.7% | Current |
| open-panel | 100% (6 done, 1 canceled) | project 66.7% (metric difference; BIZ team +91 touches this week — new bigram/gami work is *outside* this project) | Check scope |
| overflow | ~6% | 5.2% | Current |
| cortex | 25% | 18.6% | Mild drift |
| gaze-upon | auto-rendered 07-28 | 0% | **Current (only self-maintaining doc)** |
| crm / pgt / channel-trust / supply-chain / design:rina / design:unsigned | 0% | 0% | Current (no motion) |
| infra-network-hardening | 40% (2/5) | list shows 0% (metric anomaly — SEC-9/10 are Done) | Verify on regen |
| ml-image | 0%, started | 6.8% | Mild drift |
| fable-ensemble / terrarium / rina-private-cloud / reverie-cloud-prereqs / dotfiles / agentic-infra-ops / design:* (rest) | — | paginated out or minor motion | Regen to confirm |

Team-level 7-day churn (completed / total touched): OPS 135/298 · CER 30/91 ·
BIZ 28/91 · EST 25/117 · RD 15/66 · SEC 7/24 · TOD 2/15 · VES 0/1.

## 4 · Coverage — estate asset → Linear project → roadmap doc

Asset list drawn from `~/vesperan-estate/vesperan-estate-repos-*.md` (the
valuation basis) plus the estate brief.

### Covered (roadmap exists)
linearctl · soma/os · escapement (under-scoped) · terrarium · cicatrix ·
cortex · openpanel (tooling + design) · overflow · meridian · gaze-upon ·
pgt · CRM · ML Image · Fable Ensemble · engineer-vm/waker · RINA
(private-cloud + design only) · security cluster (6 docs) · identity (2) ·
reverie-cloud prereqs (infra only) · dotfiles · brand/design (6).

### Gaps, ranked

| # | Asset / project | Evidence | Why it matters | Writes needed |
|---|---|---|---|---|
| 1 | **Vesperan — Formation & Estate Valuation** (team VES, 7 issues, 12.5%, VES-1/2/3 In Progress) | project exists, zero roadmap doc | The holdco program itself — the reason this corpus exists. WBS (audit → valuation → ledger → prospectus → trademark → entity map) maps 1:1 to milestones. Counsel-first gate must be stated in the doc. | Milestones + assignments |
| 2 | **reverie** (Reverie project live, ≥17 started issues; paginated out of list) | 1,385 commits, flagship valuation anchor (72.8% operator basis) | Largest first-party asset with no roadmap doc at all — only its cloud-infra prereqs are covered. | Likely milestones exist partially; audit then fill |
| 3 | **Blackwall** (project 97.3%; 2 canceled dup projects) | 82–97 commit count discrepancy already flagged in VES-7 | Near-done ≠ no roadmap: the estate valuation needs the retrospective + the residual 3%. gaze-upon's OPS-888 says a Blackwall roadmap artifact was produced — it was never landed in this corpus. | Minimal |
| 4 | **escapement (EST estate surface)** | roadmap covers EST-1..3; EST-41..83 (soma funnel, estate ops) invisible | v1.0.0 / 190 tests per staleness memo vs "4 commits" in the valuation sweep — the doc and the estate valuation disagree with reality in opposite directions. | Re-scope + milestones |
| 5 | **er-terminal** (TOD project, 23.1%, 3 In Progress incl. TOD-1019/1020/1022) | active this week | Uncovered active project. | Milestones |
| 6 | **Lizard** (54.1%, started), **Stratum**, **bigram/gami Advisory** (17.9%), **gamiapp.io**, **Attio CRM Ops**, **Agentic Enterprise GTM**, **Platform Audit 2026-07** (62.5%), **VKE Decommission**, **Forgejo-primary**, **Big Board — Platform Stability** (87.5%) | projects with no docs | Second tier — decide per-project whether a roadmap doc earns its keep or the Linear project page suffices. | Varies |
| 7 | **dreamcode** (37,530 commits, product base) · **herdr** (installed tool, no checkout) · **site** · **voicenotes** · **revenant** · **pact/reach/omp** | no Linear project at all | Estate assets outside the tracker entirely. dreamcode and herdr are the material ones. | Project creation first |

## 5 · Structural findings

1. **One doc self-maintains; 29 rot.** The gaze-upon velocity workflow
   (schedule + dispatch → re-render → commit) is the proven pattern. A single
   scheduled workflow could re-render every `roadmap-*.md` nightly/weekly —
   the staleness class in §3 disappears permanently. This also matches the
   existing Loops recipe `plan-doc-drift-detector` (Mon 10:00 — diff
   `roadmap-*.md` ↔ Linear), which currently has nothing fresh to diff against.
2. **The corpus lives in the linearctl repo root** — 30 files about other
   projects in a CLI tool's repo. Defensible as dogfood output, but the
   Vesperan formation work (VES-4 prospectus, VES-6 entity map) will want a
   canonical estate-docs home. Decision for the operator, not blocking.
3. **`linearctl project list` truncates at 50 with no pagination and no
   truncation warning** — silently hides Reverie, linearctl, Terrarium,
   Fable Ensemble, etc. Candidate bug ticket (contradicts the "no silent
   truncation" house rule).
4. **`house metric drift:** three docs claim progress numbers that disagree
   with Linear's project progress in *both* directions (open-panel 100→66.7,
   infra-network 40→0). Milestone-progress vs project-progress are different
   metrics; regenerated docs should state which they report.
5. **VES-7 is the downstream consumer**: re-run volume coefficients over
   blackwall/escapement/soma before any re-valuation. The refreshed corpus +
   repo sweeps feed VES-2 (valuation pass). Sequence: regen corpus → re-run
   coefficients → VES-2.

## 6 · Recommended execution plan (writes authorized, not yet performed)

Phase 1 — refresh (no new Linear entities):
re-run `linearctl roadmap --project <X>` for every project-backed doc,
ratelimit-gated (`linearctl ratelimit` before each batch); fill the four
empty render stubs; update the linearctl roadmap by hand (M4 landed).

Phase 2 — author the gaps (Linear writes via linearctl, dogfood pattern):
1. `roadmap-vesperan-formation.md` — milestones from the VES WBS; counsel
   gate stated in-doc.
2. `roadmap-reverie.md` — audit existing Reverie project structure first.
3. `roadmap-blackwall.md` — land the artifact OPS-888 already produced, or
   regenerate.
4. Re-scope `roadmap-escapement.md` to the real EST surface.
5. `roadmap-er-terminal.md`.
6. Tier-2 projects (§4 gap #6): one-line triage each — roadmap doc or
   "Linear page suffices", recorded, not silently skipped.

Phase 3 — stop the rot:
generalize the gaze-upon velocity workflow to the whole corpus (one workflow,
matrix over projects); file the `project list` pagination bug; wire the
`plan-doc-drift-detector` loop recipe against the refreshed corpus.

Tickets to file when execution starts: pagination bug (CER), corpus
auto-render workflow (CER), per-gap roadmap tickets (respective teams).
