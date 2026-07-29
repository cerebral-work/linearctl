# Secrets & Credential Management — Roadmap

> **Source:** Linear team `SEC` (18 issues across all states).
> **Generated:** 2026-07-22 via `linearctl` (`search --team SEC --state all --json`).
> **Project scope note:** The Linear project "Secrets & Credential Management" contains 2 issues directly; the SEC team as a whole (which owns all secrets/credential/security work) contains 18. This roadmap covers the full SEC team issue set.

---

## Live Linear State (auto-rendered 2026-07-29 14:34 UTC)

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
| Agent Secret Exfiltration Prevention | `38469279-db3c-4cb0-bdd0-c4e85811aa5c` | 2026-10-31 | 6 | 33% (2/6) |
| TLS & Transport Hardening | `6eb4e12f-02b1-471f-a0fd-1119449e41a1` | 2026-09-12 | 3 | 67% (2/3) |
| Access Control & Auth Hardening | `7424d2f4-b7f5-477a-9e13-1a62cfca5668` | 2026-09-26 | 4 | 75% (3/4) |
| Secret Detection & Prevention | `a0e42514-ff3e-40f2-984a-914b8b9403b4` | 2026-08-15 | 2 | 50% (1/2) |
| Dependency & Code Scanning | `9bc6f9d0-8d8f-4b85-b0c9-5b6ee2a7c434` | 2026-08-29 | 3 | 67% (2/3) |

```
Secrets & Credential Management — 5 milestone(s)

  Secret Detection & Prevention  (due 2026-08-15)  [██████████░░░░░░░░░░] 50%  1/2
    SEC-15  [Backlog]  GHAS spend decision — secret/code scanning for 57 private repos (incl. flagships)
    SEC-7  [Done]  Enable GitHub secret scanning + push protection org-wide (disabled 67/67 repos)

  Dependency & Code Scanning  (due 2026-08-29)  [█████████████░░░░░░░] 67%  2/3
    SEC-16  [Backlog]  Triage 13 critical Dependabot alerts surfaced by estate-wide enablement (litellm ×9, rina ×3, terrarium ×1)
    SEC-12  [Done]  Stand up code scanning (CodeQL) — zero repos have ever run an analysis
    SEC-11  [Done]  Enable Dependabot across the estate (disabled 55/67 repos, incl. flagships)

  TLS & Transport Hardening  (due 2026-09-12)  [█████████████░░░░░░░] 67%  2/3
    SEC-18  [Backlog]  godseat HSTS+CSP commit parked unpublished — blocked on Forgejo reachability (SEC-13)
    SEC-10  [Done]  dreamcode: NODE_TLS_REJECT_UNAUTHORIZED=0 on spawned Copilot LSP subprocess (copilot.rs:511)
    SEC-9  [Done]  paas: unjustified TLS InsecureSkipVerify on outbound StartTLS (provision/email.go:65)

  Access Control & Auth Hardening  (due 2026-09-26)  [███████████████░░░░░] 75%  3/4
    SEC-17  [Done]  cerebral realm: `google-public` OIDC broker has no hosted-domain restriction — any Google account self-provisions a realm user  @ctodie
    SEC-14  [Done]  SEC: kagent agent endpoints exposed unauthenticated on dev.unsigned.gg — harden + make durable  @ctodie
    SEC-13  [In Progress]  Core-services: Cloudflare Access breaks Forgejo auth — Forgejo-primary migration + credential/monitoring hardening  @ctodie
    SEC-8  [Done]  rina: unauthenticated debug-auth endpoint leaks partial session cookie + email/role — delete  @ctodie

  Agent Secret Exfiltration Prevention  (due 2026-10-31)  [███████░░░░░░░░░░░░░] 33%  2/6
    SEC-6  [In Progress]  Open decisions — interview before build  @ctodie
    SEC-5  [Backlog]  WS5 — governance: encode trust tiers (Phase 3)
    SEC-4  [Backlog]  WS2 — authenticated peer wakeups (Phase 2)
    SEC-3  [Backlog]  WS3 — make secret→exfil structurally unreachable (Phase 1)
    SEC-2  [Done]  WS1 — enforced PreToolUse gate on blast-radius actions (Phase 0)  @ctodie
    SEC-1  [Done]  WS4 — send-keys attribution logging (Phase 0)  @ctodie
```

*Last 7 days: 14 issue(s) touched, 7 completed.*
*Rendered by `.github/scripts/render-roadmap.sh` (corpus auto-render, schedule + dispatch).*

## Milestones

### M1 — Secret Detection & Prevention (Guardrails)
*Enable and budget automated secret/credential leak prevention across the GitHub estate.*

| Issue | Title | State | Priority | Assignee |
|-------|-------|-------|----------|----------|
| [SEC-7](https://linear.app/cerebral-work/issue/SEC-7/enable-github-secret-scanning-push-protection-org-wide-disabled-6767) | Enable GitHub secret scanning + push protection org-wide (disabled 67/67 repos) | ✅ Done | Urgent | — |
| [SEC-15](https://linear.app/cerebral-work/issue/SEC-15/ghas-spend-decision-secretcode-scanning-for-57-private-repos-incl) | GHAS spend decision — secret/code scanning for 57 private repos (incl. flagships) | ⏳ Backlog | Medium | — |

**Status:** Push protection baseline shipped org-wide (SEC-7). The remaining decision gap is the GHAS spend/cost-triage for private repos (SEC-15) — a budget gate, not an engineering one.

---

### M2 — Dependency & Code Scanning (Supply Chain)
*Stand up and maintain automated vulnerability detection across all repos.*

| Issue | Title | State | Priority | Assignee |
|-------|-------|-------|----------|----------|
| [SEC-11](https://linear.app/cerebral-work/issue/SEC-11/enable-dependabot-across-the-estate-disabled-5567-repos-incl-flagships) | Enable Dependabot across the estate (disabled 55/67 repos, incl. flagships) | ✅ Done | High | — |
| [SEC-12](https://linear.app/cerebral-work/issue/SEC-12/stand-up-code-scanning-codeql-zero-repos-have-ever-run-an-analysis) | Stand up code scanning (CodeQL) — zero repos have ever run an analysis | ✅ Done | Medium | — |
| [SEC-16](https://linear.app/cerebral-work/issue/SEC-16/triage-13-critical-dependabot-alerts-surfaced-by-estate-wide) | Triage 13 critical Dependabot alerts surfaced by estate-wide enablement (litellm ×9, rina ×3, terrarium ×1) | ⏳ Backlog | High | — |

**Status:** Scanning is now estate-wide (SEC-11, SEC-12). The follow-up — triaging the 13 critical alerts that surfaced from the enablement (SEC-16) — is the immediate operational debt.

---

### M3 — TLS & Transport Hardening
*Eliminate insecure transport configurations and enforce HSTS/CSP on public surfaces.*

| Issue | Title | State | Priority | Assignee |
|-------|-------|-------|----------|----------|
| [SEC-9](https://linear.app/cerebral-work/issue/SEC-9/paas-unjustified-tls-insecureskipverify-on-outbound-starttls) | paas: unjustified TLS InsecureSkipVerify on outbound StartTLS (provision/email.go:65) | ✅ Done | Medium | — |
| [SEC-10](https://linear.app/cerebral-work/issue/SEC-10/dreamcode-node-tls-reject-unauthorized0-on-spawned-copilot-lsp) | dreamcode: NODE_TLS_REJECT_UNAUTHORIZED=0 on spawned Copilot LSP subprocess (copilot.rs:511) | ✅ Done | Medium | — |
| [SEC-18](https://linear.app/cerebral-work/issue/SEC-18/godseat-hstscsp-commit-parked-unpublished-blocked-on-forgejo) | godseat HSTS+CSP commit parked unpublished — blocked on Forgejo reachability (SEC-13) | ⏳ Backlog | Medium | — |

**Status:** Two TLS verification bypasses fixed (SEC-9, SEC-10). The remaining godseat HSTS+CSP deployment (SEC-18) is blocked on the Forgejo migration (SEC-13 in M4).

---

### M4 — Access Control & Auth Hardening
*Close authentication gaps on exposed services and enforce domain-restricted identity flows.*

| Issue | Title | State | Priority | Assignee |
|-------|-------|-------|----------|----------|
| [SEC-8](https://linear.app/cerebral-work/issue/SEC-8/rina-unauthenticated-debug-auth-endpoint-leaks-partial-session-cookie) | rina: unauthenticated debug-auth endpoint leaks partial session cookie + email/role — delete | ✅ Done | Urgent | ctodie |
| [SEC-13](https://linear.app/cerebral-work/issue/SEC-13/core-services-cloudflare-access-breaks-forgejo-auth-forgejo-primary) | Core-services: Cloudflare Access breaks Forgejo auth — Forgejo-primary migration + credential/monitoring hardening | ⏳ Backlog | High | — |
| [SEC-17](https://linear.app/cerebral-work/issue/SEC-17/cerebral-realm-google-public-oidc-broker-has-no-hosted-domain) | cerebral realm: \`google-public\` OIDC broker has no hosted-domain restriction — any Google account self-provisions a realm user | ⏳ Backlog | Urgent | ctodie |
| [SEC-14](https://linear.app/cerebral-work/issue/SEC-14/sec-kagent-agent-endpoints-exposed-unauthenticated-on-devunsignedgg) | SEC: kagent agent endpoints exposed unauthenticated on dev.unsigned.gg — harden + make durable | ⏳ Backlog | High | — |

**Status:** One auth-leak endpoint fixed (SEC-8). Three open gaps remain — the Forgejo/Cloudflare Access migration (SEC-13) is the structural blocker; the google-public OIDC broker (SEC-17) and kagent unauthenticated endpoints (SEC-14) are independently actionable.

---

### M5 — Agent Secret Exfiltration Prevention (Workstreams WS1–WS5)
*Multi-phase workstream to make secret-to-exfiltration structurally unreachable in agent harnesses.*

| Issue | Title | State | Priority | Assignee |
|-------|-------|-------|----------|----------|
| [SEC-1](https://linear.app/cerebral-work/issue/SEC-1/ws4-send-keys-attribution-logging-phase-0) | WS4 — send-keys attribution logging (Phase 0) | ✅ Done | High | ctodie |
| [SEC-6](https://linear.app/cerebral-work/issue/SEC-6/open-decisions-interview-before-build) | Open decisions — interview before build | ⏳ Backlog | High | — |
| [SEC-2](https://linear.app/cerebral-work/issue/SEC-2/ws1-enforced-pretooluse-gate-on-blast-radius-actions-phase-0) | WS1 — enforced PreToolUse gate on blast-radius actions (Phase 0) | ⏳ Backlog | High | — |
| [SEC-3](https://linear.app/cerebral-work/issue/SEC-3/ws3-make-secretexfil-structurally-unreachable-phase-1) | WS3 — make secret→exfil structurally unreachable (Phase 1) | ⏳ Backlog | Medium | — |
| [SEC-4](https://linear.app/cerebral-work/issue/SEC-4/ws2-authenticated-peer-wakeups-phase-2) | WS2 — authenticated peer wakeups (Phase 2) | ⏳ Backlog | Medium | — |
| [SEC-5](https://linear.app/cerebral-work/issue/SEC-5/ws5-governance-encode-trust-tiers-phase-3) | WS5 — governance: encode trust tiers (Phase 3) | ⏳ Backlog | Low | — |

**Status:** Only the attribution logging foundation shipped (SEC-1 / WS4 Phase 0). The bulk of the workstream is pending: SEC-6 ("interview before build") gates the design; WS1→WS5 form a phased implementation path (Phase 0 gates → Phase 1 structural unreachability → Phase 2 authenticated peering → Phase 3 trust-tier governance).

---

## Roadmap Visualization

```
SEC Team — Secrets & Credential Management Roadmap
===================================================

         COMPLETED                          BACKLOG / IN-PROGRESS
         ─────────                          ──────────────────────

M1 Guardrails      [████████████] SEC-7 ✓          [░░░░] SEC-15  (budget gate)

M2 Supply Chain    [██████████████████] ✓          [░░░░░░] SEC-16  (triage 13 alerts)
   SEC-11, SEC-12

M3 TLS Hardening   [████████████████████] ✓        [░░░░] SEC-18  (blocked → M4)

M4 Access Control  [████] SEC-8 ✓                  [░░░░░░░░░░░░░░] 3 open:
                                                      SEC-13, SEC-17, SEC-14

M5 Agent Exfil     [████] SEC-1 ✓                  [░░░░░░░░░░░░░░░░░░] 5 open:
   Prevention                                            SEC-6, WS1-2, WS3-3,
   (WS1–WS5)                                             WS4-2, WS5-5

Legend: █ = done   ░ = open/backlog

Cross-milestone dependencies:
  M4/SEC-13 ──blocks──→ M3/SEC-18  (Forgejo reachability gates HSTS+CSP deploy)
```

---

## Summary Statistics

| Milestone | Done | Backlog | Total |
|-----------|------|---------|-------|
| M1 — Secret Detection & Prevention | 1 | 1 | 2 |
| M2 — Dependency & Code Scanning | 2 | 1 | 3 |
| M3 — TLS & Transport Hardening | 2 | 1 | 3 |
| M4 — Access Control & Auth Hardening | 1 | 3 | 4 |
| M5 — Agent Secret Exfiltration Prevention | 1 | 5 | 6 |
| **Total** | **7** | **11** | **18** |

**Completion:** 7/18 (39%) — the foundational scanning/transport fixes are shipped; the heavy lifting is in M4 (auth hardening) and M5 (agent exfiltration prevention workstreams).

---

## Recommended Sequencing

1. **M2 / SEC-16** — Triage the 13 critical Dependabot alerts now. Scanning just lit up; unaddressed criticals are the highest near-term risk.
2. **M4 / SEC-17** — OIDC broker hosted-domain restriction (Urgent, assigned to ctodie). Any Google account self-provisioning is an authn bypass.
3. **M4 / SEC-14** — kagent unauthenticated endpoints on dev.unsigned.gg. Exposed agent surface is a credential exfil vector.
4. **M4 / SEC-13** — Forgejo migration + Cloudflare Access reconciliation. Unblocks M3/SEC-18 (HSTS+CSP deploy).
5. **M5 / SEC-6** — "Interview before build": resolve the open design decisions so the WS1–WS5 phased implementation can start.
6. **M5 / SEC-2 → SEC-3 → SEC-4 → SEC-5** — Sequential workstream execution (Phase 0 gates → Phase 1 structural → Phase 2 peering → Phase 3 governance).
7. **M1 / SEC-15** — GHAS spend decision for private repos. Budget/triage gate; can proceed in parallel.
