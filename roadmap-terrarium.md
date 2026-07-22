# Terrarium — Project Roadmap

> Rendered `2026-07-22` via `linearctl roadmap --project Terrarium`.
> [Linear project](https://linear.app/cerebral-work/project/terrarium-2ea589a69f7a) · 5 milestones · 119 issues

---

## Milestone Timeline

| # | Milestone | Target | Progress | Done/Total |
|---|-----------|--------|----------|------------|
| 1 | Terrarium Core & Standards Adoption | 2026-08-15 | █████████░░░░░░░░░░░ 43% | 15/35 |
| 2 | Repo Adoption Wave | 2026-09-30 | ░░░░░░░░░░░░░░░░░░░░ 0% | 0/38 |
| 3 | Soma Reflex & Trust Ledger | 2026-10-31 | ███████░░░░░░░░░░░░░ 36% | 4/11 |
| 4 | Lab Platform Evolution | 2026-11-30 | ██░░░░░░░░░░░░░░░░░░ 9% | 2/23 |
| 5 | Estate Security & Auth Hardening | 2026-12-15 | ░░░░░░░░░░░░░░░░░░░░ 0% | 0/12 |

---

## 1. Terrarium Core & Standards Adoption

**Due 2026-08-15 · 43% complete (15/35)**

Foundation milestone: moon monorepo scaffold, CI workflows, lifecycle orchestration, terrarium standards
adoption across estates (reverie, unsigned-paas, revenant), guardrail enforcement, and governance workflows.

| ID | State | Title | Assignee |
|----|-------|-------|----------|
| RD-7 | Done | Scaffold the machine: moon + CI + githooks + .claude (settings/hooks/permissions incl. grep) + node templates | @ctodie |
| RD-8 | Backlog | Author spin-lead + eject workflows into .claude/workflows | @ctodie |
| RD-9 | Done | Port/adopt critpath + the lineage convention (coherence machine) | @ctodie |
| RD-10 | Backlog | Wire lifecycle orchestration (ideation/execution/validation modular drivers) | @ctodie |
| RD-11 | Done | Enforced-guardrail pass: merge-gate + ci-gate + secret-guard + locks + permissions | @ctodie |
| RD-13 | Done | RD-7 follow-up: moon 2.x task-model port (moon ci not yet green) + CI-gate enforcement on main | @ctodie |
| RD-14 | Backlog | Wire lefthook install path — proto can't manage it; git hooks currently skipped on fresh bootstrap | @ctodie |
| RD-15 | Done | Python node-kind CI provisioning: install ruff + pytest, add wsref pyproject + tests, re-gate wsref | @ctodie |
| RD-16 | Done | Release workflow red on main — wire release-please to a GitHub App token | @ctodie |
| RD-17 | In Progress | Adopt terrarium standards — reverie | @ctodie |
| RD-18 | Backlog | Adopt terrarium standards — unsigned-paas | @ctodie |
| RD-19 | Backlog | Adopt terrarium standards — revenant | @ctodie |
| RD-20 | Backlog | Adopt terrarium standards — reverie-slack-app | @ctodie |
| RD-21 | Backlog | tanzaku node seed — ambient protocol canon: Marc ratification + naming | |
| RD-22 | Backlog | dreams — platform naming verdict + re-founding rollout (M2/M3) | |
| RD-23 | Backlog | tag-webapp CI flake: 4 concurrent pnpm install runs race native postinstalls | |
| RD-37 | Backlog | Git-hooks install mechanism — salvage from closed terrarium-ctl PR #12 | |
| RD-38 | Backlog | Fixture-based policy self-test for critpath — salvage from closed terrarium-ctl PR #12 | |
| RD-57 | Backlog | Activate throughline on dreams (stretch, n=3 proof) | |
| RD-63 | Done | Somnium — persistent project agents + live preview per node | @ctodie |
| RD-65 | Done | Add moon dependsOn/inputs edges where node CI correctness spans nodes | @ctodie |
| RD-66 | Done | scripts/antagonist-prep.sh — deterministic review-surface materialization | @ctodie |
| RD-67 | Done | Audit alchemy nodes for the dead alchemy deploy script form | @ctodie |
| RD-68 | Done | dreams: /throughline walkthrough — surface the THROUGHLINE/OPEN PANEL corpus | @ctodie |
| RD-69 | Done | dealbook: dealbook.cerebral.work — entity pitch/reference/data ingestion pipeline | @ctodie |
| RD-126 | Backlog | alchemy CI credential — automate brands/bbs deploys + fold in Linear release tracking | |
| RD-137 | Backlog | terrarium: reconcile antagonist review-gate lens count (spec 6 vs code 5) | |
| RD-138 | Backlog | terrarium: land infra-eng + research-fanout into .claude/workflows/ | |
| RD-139 | Done | terrarium: make the ['template'] CI-exclusion explicit | @ctodie |
| RD-140 | Done | terrarium: templates ship no NODE.md / lineage stub (relates RD-8) | @ctodie |
| RD-151 | Backlog | terrarium: wire the rust CI path (cargo-nextest + confirm clippy in .prototools) | |
| RD-194 | Done | os: land scaffold PRs #1–#3 (standards adoption, CI workflows, reflex daemon v0) | |
| RD-198 | Backlog | Retire PIPELINE.md §10.1 company-description stage workaround | |
| RD-202 | Backlog | Terrarium: node registry auto-validation + CANON.md freshness gate | |
| RD-204 | Backlog | Terrarium: linearctl distribution via bun install + homebrew tap | |

---

## 2. Repo Adoption Wave

**Due 2026-09-30 · 0% complete (0/38)**

Bulk adoption of 38+ repos into terrarium governance across unsigned-gg and cerebral-work orgs.
Includes external-node onboarding, lineage stubs, CI exclusion patterns, and adoption tracking.

### unsigned-gg org (14 repos)

| ID | State | Title |
|----|-------|-------|
| RD-89 | Backlog | adopt: unsigned-gg/unsigned-gg |
| RD-90 | Backlog | adopt: unsigned-gg/dc |
| RD-91 | Backlog | adopt: unsigned-gg/escapement |
| RD-92 | Backlog | adopt: unsigned-gg/overflow |
| RD-93 | Backlog | adopt: unsigned-gg/blackwall |
| RD-94 | Backlog | adopt: unsigned-gg/pgt |
| RD-95 | Backlog | adopt: unsigned-gg/juarez |
| RD-96 | Backlog | adopt: unsigned-gg/agent-jury |
| RD-97 | Backlog | adopt: unsigned-gg/mission-control |
| RD-98 | Backlog | adopt: unsigned-gg/bench |
| RD-99 | Backlog | adopt: unsigned-gg/reach |
| RD-100 | Backlog | adopt: unsigned-gg/nahbro.dev |
| RD-101 | Backlog | adopt: unsigned-gg/uri-snapshot |
| RD-102 | Backlog | adopt: unsigned-gg/ghost-blog |
| RD-103 | Backlog | adopt: unsigned-gg/kokoro-tts |

### cerebral-work org (20 repos)

| ID | State | Title |
|----|-------|-------|
| RD-104 | Backlog | adopt: cerebral-work/site |
| RD-105 | Backlog | adopt: cerebral-work/gaze-works |
| RD-106 | Backlog | adopt: cerebral-work/pact |
| RD-107 | Backlog | adopt: cerebral-work/flashed-web |
| RD-108 | Backlog | adopt: cerebral-work/cerebral-design |
| RD-109 | Backlog | adopt: cerebral-work/linearctl |
| RD-110 | Backlog | adopt: cerebral-work/blanklabel |
| RD-111 | Backlog | adopt: cerebral-work/cf-pwa-template |
| RD-112 | Backlog | adopt: cerebral-work/dealroom |
| RD-113 | Backlog | adopt: cerebral-work/mcp-honeypot |
| RD-114 | Backlog | adopt: cerebral-work/honeypot.vip |
| RD-115 | Backlog | adopt: cerebral-work/somnium |
| RD-116 | Backlog | adopt: cerebral-work/cerebral-voicenotes |
| RD-117 | Backlog | adopt: cerebral-work/files-portal |
| RD-118 | Backlog | adopt: cerebral-work/aiml-history |
| RD-119 | Backlog | adopt: cerebral-work/cortex |
| RD-120 | Backlog | adopt: cerebral-work/cicatrix |
| RD-121 | Backlog | adopt: cerebral-work/calc |
| RD-122 | Backlog | adopt: cerebral-work/very-good-document-imposer |
| RD-123 | Backlog | adopt: cerebral-work/linear-github-sync |
| RD-124 | Backlog | adopt: cerebral-work/enterprise-genie |
| RD-125 | Backlog | adopt: cerebral-work/pgt |

### Onboarding infrastructure

| ID | State | Title | Assignee |
|----|-------|-------|----------|
| RD-12 | Backlog | Onboarding node + external-node adoption rollout (reverie/revenant/unsigned-paas) | @ctodie |

---

## 3. Soma Reflex & Trust Ledger

**Due 2026-10-31 · 36% complete (4/11)**

The agentic OS reflex layer: reflex daemon, enforcement threat model, sign-off authentication,
WebAuthn proof verification, trust ledger + promotion mechanic, policy as signed append-only store,
memory tiers, comms pilot, naming ratification, and RFC positioning vs OAP/MCP.

| ID | State | Title | Assignee |
|----|-------|-------|----------|
| RD-128 | Backlog | soma: Marc/Laura naming ratification consult | |
| RD-129 | Done | soma: reflex enforcement threat model | @ctodie |
| RD-130 | Done | soma: reflex daemon v0 (Phase 1) | @ctodie |
| RD-131 | Done | soma: sign-off authentication design | @ctodie |
| RD-132 | Done | soma: incident definition for auto-demotion | @ctodie |
| RD-133 | Backlog | soma/comms pilot — draft-only (Phase 2) | |
| RD-134 | Backlog | soma: the promotion mechanic + trust ledger (Phase 4) | |
| RD-135 | Backlog | soma: memory tiers on engram (Phase 3) | |
| RD-136 | Backlog | soma: reflex RFC — position vs OAP / MCP authz (Phase 8) | |
| RD-196 | Backlog | soma: WebAuthn sign-off proof verification in reflex (RD-131 implementation) | |
| RD-197 | Backlog | soma: policy as a signed append-only store (the T5 half of the separate-signer line) | |

---

## 4. Lab Platform Evolution

**Due 2026-11-30 · 9% complete (2/23)**

lab.cerebral.work progression from v1 through v3: write API, grill authoring, full-text search,
revision diffs, docket unification, Linear snapshot cron, deal tier, R2 attachments, Slack grill
answering, offline shell, scheduled D1 export, nightly backup, a11y/perf ratchets, and realm brand-lint.

### v1.x (Shipped)

| ID | State | Title |
|----|-------|-------|
| RD-24 | Done | lab v1.1 — nightly plans-dir ingestion |
| RD-25 | Done | lab v1.2 — write API (bearer/session) + shared grill parser |

### v2 (In Progress)

| ID | State | Title |
|----|-------|-------|
| RD-26 | Backlog | lab v2 — grill authoring v0: parse-as-grill toggle on /new |
| RD-27 | Backlog | lab v2 — Linear snapshot refresh cron |
| RD-28 | Backlog | lab v2 — full-text search |
| RD-29 | Backlog | lab v2 — revision diffs |
| RD-30 | Backlog | lab v2 — design pass |
| RD-31 | Backlog | lab v2 — docket unification |

### v3 (Planned)

| ID | State | Title |
|----|-------|-------|
| RD-32 | Backlog | lab v3 — offline read-only shell |
| RD-33 | Backlog | lab v3 — attachments via R2 |
| RD-34 | Backlog | lab v3 — scheduled D1 -> R2 export |
| RD-35 | Backlog | lab v3 — grill answering from Slack |
| RD-36 | Backlog | lab v3 — deal tier |

### Cross-cutting

| ID | State | Title |
|----|-------|-------|
| RD-41 | Backlog | lab-ingest deploy-copy parity check |
| RD-42 | Backlog | Grill authoring-habit switch to lab write API |
| RD-46 | Backlog | lab bearer-API hardening |
| RD-49 | Backlog | lab D1 nightly backup to R2 |
| RD-50 | Backlog | BOARD_KV snapshot history |
| RD-51 | Backlog | D1 migration discipline |
| RD-52 | Backlog | Extract @cerebral/realms |
| RD-53 | Backlog | lab realm + estate brand-lint |
| RD-54 | Backlog | Playwright runtime tier-invariant test |
| RD-56 | Backlog | lab a11y/perf ratchets (stretch) |

---

## 5. Estate Security & Auth Hardening

**Due 2026-12-15 · 0% complete (0/12)**

Multi-door auth hardening: OIDC revocation-lag fix, OTP cross-connection throttle, dual-door revocation
regression tests, gate-failure alerting, estate secrets migration to Cloudflare Secrets Store, vendored-token
stale-check CI, deploy-workflow unification, dealbook JWT hardening, coherence swarm auditor, and
blast-radius assessment tooling.

| ID | State | Title | Assignee |
|----|-------|-------|----------|
| RD-39 | Backlog | Post-merge landing verification (phantom-merge guard) | |
| RD-40 | Backlog | Gate-failure alerting across all three auth doors | |
| RD-43 | Backlog | Estate secrets -> Cloudflare Secrets Store (KMS-backed, answer 3c) | |
| RD-44 | Backlog | OIDC revocation-lag fix | |
| RD-45 | Backlog | OTP cross-connection throttle | |
| RD-47 | Backlog | CF Access /ops retire | |
| RD-48 | Backlog | Dual-door revocation regression tests | |
| RD-55 | Backlog | Deploy-workflow unification (composite Action, answer 2b) | |
| RD-64 | Backlog | Vendored-token stale-check CI gate (DESIGN-SURFACES section 3.2) | |
| RD-70 | Backlog | dealbook hardening: in-worker JWT verify, service-token custody, Workspace-group gate | @ctodie |
| RD-127 | Backlog | Coherence swarm — cross-repo spec/code/Linear auditor | @ctodie |
| RD-203 | Backlog | Terrarium: blast-radius assessment tooling for node changes | |

---

## Milestone Details

### 1. Terrarium Core & Standards Adoption
- **ID:** `7b44a78f-c33f-4dcf-ba1e-1e38d228770c`
- **Target:** 2026-08-15
- **Scope:** Moon monorepo scaffold, CI workflows (cargo-nextest, ruff, pytest, clippy), lifecycle
  orchestration, standards adoption across reverie/unsigned-paas/revenant, guardrail enforcement
  (merge-gate, ci-gate, secret-guard), governance workflows, antagonist review-gate, alchemy CI,
  Somnium persistent agents, dealbook ingestion, throughline activation.
- **New tickets filed:** RD-202 (node registry auto-validation), RD-204 (linearctl distribution)

### 2. Repo Adoption Wave
- **ID:** `8c80089d-e97c-4978-941a-3a64fc475065`
- **Target:** 2026-09-30
- **Scope:** 38 repo adoptions across two GitHub orgs (unsigned-gg: 14, cerebral-work: 20),
  plus the onboarding node and external-node adoption rollout. Each adoption ticket tracks
  bringing a repo under terrarium's moon monorepo governance with CI, standards, and NODE.md
  lineage conventions.

### 3. Soma Reflex & Trust Ledger
- **ID:** `664a7af2-f985-4a1f-8448-6856ae41f881`
- **Target:** 2026-10-31
- **Scope:** The agentic OS reflex layer spanning 8 phases:
  - Phase 1: reflex daemon v0 (done)
  - Phase 2: comms pilot (draft-only)
  - Phase 3: memory tiers on engram
  - Phase 4: promotion mechanic + trust ledger
  - Phase 5: policy as signed append-only store
  - Phase 8: reflex RFC positioning vs OAP/MCP authz
  - Plus: WebAuthn proof verification, incident auto-demotion, naming ratification.

### 4. Lab Platform Evolution
- **ID:** `82e73f20-114e-4594-ac40-80a7377e7d67`
- **Target:** 2026-11-30
- **Scope:** lab.cerebral.work platform maturation:
  - v1.x (shipped): nightly plans-dir ingestion, write API + grill parser
  - v2: grill authoring, Linear snapshot cron, full-text search, revision diffs,
    design pass, docket unification
  - v3: offline shell, R2 attachments, scheduled D1 export, Slack grill
    answering, deal tier
  - Cross-cutting: deploy-copy parity, API hardening, D1 nightly backup,
    BOARD_KV history, D1 migration discipline, @cerebral/realms extraction,
    realm brand-lint, Playwright tests, a11y/perf ratchets.

### 5. Estate Security & Auth Hardening
- **ID:** `da93e50c-f888-407d-9592-df3f8decf2b8`
- **Target:** 2026-12-15
- **Scope:** Multi-door auth hardening across the estate:
  - OIDC revocation-lag fix + dual-door revocation regression tests
  - OTP cross-connection throttle
  - Gate-failure alerting across all three auth doors
  - Estate secrets migration to Cloudflare Secrets Store (KMS-backed)
  - Vendored-token stale-check CI gate
  - Deploy-workflow unification (composite Action)
  - Dealbook JWT hardening
  - Coherence swarm cross-repo auditor
  - Blast-radius assessment tooling for node changes (new: RD-203)
  - CF Access /ops retirement.

---

*Generated by `linearctl roadmap --project Terrarium` on 2026-07-22.
Milestones created, issues assigned, and missing tickets filed (RD-202, RD-203, RD-204) in this session.*
