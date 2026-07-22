# Infra & Network Hardening — Roadmap

> **Source:** Linear project "Infra & Network Hardening" (`c2a4f91c-dcfb-411d-a6f4-b37bff0a64e5`).
> **Generated:** 2026-07-22 via `linearctl` — milestones created, issues assigned, and dependency wired live in Linear. Rendered via `linearctl roadmap --project`.
> **Project state:** backlog · 3 milestones · 5 issues (2 done, 3 backlog).
> **Companion roadmap:** The broader SEC team surface — secret scanning, supply chain, auth hardening, agent exfiltration prevention — is covered in [`roadmap-secrets-credential-mgmt.md`](roadmap-secrets-credential-mgmt.md). This roadmap covers only the issues directly scoped to the Infra & Network Hardening project.

---

## Linear Milestones (created)

| ID | Milestone | Target Date |
|----|----------|-------------|
| `529d179b-f952-453b-b6d4-8bd89ef2e59d` | TLS Verification & Transport Hardening | 2026-07-25 |
| `8dd3dfe7-651c-4c53-a949-399c96cb0bb9` | Forgejo-Primary Migration & Access Reconciliation | 2026-08-29 |
| `c87ba8e3-c594-4c1f-8349-4f2ed9102965` | Public-Surface Header Enforcement (HSTS + CSP) | 2026-09-12 |

---

## Milestones

### M1 — TLS Verification & Transport Hardening
*Eliminate insecure TLS configurations on outbound and spawned-subprocess transports.*

| Issue | Title | State | Priority | Assignee |
|-------|-------|-------|----------|----------|
| [SEC-9](https://linear.app/cerebral-work/issue/SEC-9/paas-unjustified-tls-insecureskipverify-on-outbound-starttls) | paas: unjustified TLS InsecureSkipVerify on outbound StartTLS (provision/email.go:65) | ✅ Done | Medium | — |
| [SEC-10](https://linear.app/cerebral-work/issue/SEC-10/dreamcode-node-tls-reject-unauthorized0-on-spawned-copilot-lsp) | dreamcode: NODE_TLS_REJECT_UNAUTHORIZED=0 on spawned Copilot LSP subprocess (copilot.rs:511) | ✅ Done | Medium | — |

**Status:** Both transport-verification bypasses are closed. SEC-9 removed an unjustified `InsecureSkipVerify` on outbound StartTLS in the paas email provisioner; SEC-10 removed a `NODE_TLS_REJECT_UNAUTHORIZED=0` override on a spawned Copilot LSP subprocess. These were latent MITM-enabling defects on internal code paths — the transport surface is now verification-enforcing by default.

---

### M2 — Forgejo-Primary Migration & Access Reconciliation
*Restore Forgejo reachability under Cloudflare Access by migrating to the tailnet-only self-hosted primary, then hardening its credential and monitoring posture.*

| Issue | Title | State | Priority | Assignee |
|-------|-------|-------|----------|----------|
| [SEC-13](https://linear.app/cerebral-work/issue/SEC-13/core-services-cloudflare-access-breaks-forgejo-auth-forgejo-primary) | Core-services: Cloudflare Access breaks Forgejo auth — Forgejo-primary migration + credential/monitoring hardening | ⏳ Backlog | High | — |

**Status:** Cloudflare Access enforcement broke Forgejo's auth flow, leaving the self-hosted primary unreachable through the public path. SEC-13 is the structural unblock: migrate to the tailnet-only Forgejo-primary (its dedicated Linear project is `Forgejo-primary · tailnet-only · self-hosted CI`), reconcile Cloudflare Access policies, and stand up credentials + monitoring hardening on the new surface. This is the single critical-path item — it gates M3 (wired as a formal `blockedBy` relation: SEC-18 ← SEC-13).

---

### M3 — Public-Surface Header Enforcement (HSTS + CSP)
*Publish the parked godseat HSTS/CSP commit once Forgejo reachability is restored, then verify the headers are live.*

| Issue | Title | State | Priority | Assignee |
|-------|-------|-------|----------|----------|
| [SEC-18](https://linear.app/cerebral-work/issue/SEC-18/godseat-hstscsp-commit-parked-unpublished-blocked-on-forgejo) | godseat HSTS+CSP commit parked unpublished — blocked on Forgejo reachability (SEC-13) | ⏳ Backlog | Medium | — |
| [SEC-19](https://linear.app/cerebral-work/issue/SEC-19/verify-hsts-csp-headers-live-on-public-godseat-surface-post-publish) | Verify HSTS + CSP headers live on public godseat surface post-publish | ⏳ Backlog | Medium | — |

**Status:** The HSTS + Content-Security-Policy hardening commit for godseat is written but unpublished — deployment is blocked on the Forgejo-primary migration (SEC-13 / M2) because the publish path routes through Forgejo, which is currently unreachable. The `blockedBy` link is now formally set in Linear. SEC-19 (filed as part of this roadmap) is the acceptance gate — after SEC-18 publishes the commit, SEC-19 verifies the headers are actually served on the public surface (HSTS max-age + includeSubDomains, CSP policy match, no upstream proxy override, `curl -I` confirmation). Publication without verification is not done.

---

## Rendered Roadmap (live from Linear)

```
Infra & Network Hardening — 3 milestone(s)

  TLS Verification & Transport Hardening  (due 2026-07-25)  [████████████████████] 100%  2/2
    SEC-10  [Done]  dreamcode: NODE_TLS_REJECT_UNAUTHORIZED=0 on spawned Copilot LSP subprocess (copilot.rs:511)
    SEC-9  [Done]  paas: unjustified TLS InsecureSkipVerify on outbound StartTLS (provision/email.go:65)

  Forgejo-Primary Migration & Access Reconciliation  (due 2026-08-29)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/1
    SEC-13  [Backlog]  Core-services: Cloudflare Access breaks Forgejo auth — Forgejo-primary migration + credential/monitoring hardening

  Public-Surface Header Enforcement (HSTS + CSP)  (due 2026-09-12)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    SEC-19  [Backlog]  Verify HSTS + CSP headers live on public godseat surface post-publish
    SEC-18  [Backlog]  godseat HSTS+CSP commit parked unpublished — blocked on Forgejo reachability (SEC-13)
```

---

## Summary Statistics

| Milestone | Done | Backlog | Total |
|-----------|------|---------|-------|
| M1 — TLS Verification & Transport Hardening | 2 | 0 | 2 |
| M2 — Forgejo-Primary Migration & Access Reconciliation | 0 | 1 | 1 |
| M3 — Public-Surface Header Enforcement (HSTS + CSP) | 0 | 2 | 2 |
| **Total** | **2** | **3** | **5** |

**Completion:** 2/5 (40%) — all transport-layer verification fixes are shipped; the remaining work is a two-step dependency chain resting on the Forgejo-primary migration (SEC-13 → SEC-18 → SEC-19).

---

## Recommended Sequencing

1. **M2 / SEC-13** — Forgejo-primary migration + Cloudflare Access reconciliation. High priority, the critical-path unblocker. Land this first; everything in M3 is downstream of it. Formally blocks SEC-18.
2. **M3 / SEC-18** — Publish the parked godseat HSTS+CSP commit. Pure deployment once SEC-13 restores Forgejo reachability — no new code required.
3. **M3 / SEC-19** — Verify headers are live on the public surface. Acceptance gate for M3; cannot close M3 until this passes.
4. **M1 (sustaining)** — Both items closed. No follow-up unless new insecure-transport paths surface; treat as a settled foundation.
