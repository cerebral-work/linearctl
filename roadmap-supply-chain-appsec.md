# Roadmap: Supply Chain, AppSec & Data

**Linear Project:** [Supply Chain, AppSec & Data](https://linear.app/cerebral-work/project/supply-chain-appsec-and-data-60b73d86b191)
**Project ID:** `56254f92-decf-4936-aca2-d9b1dcd962cc`
**Scope:** Image/dep supply chain (Trivy, Harbor, cosign signing), web/worker app vulns, data-leak-at-load, retention/disposal, PII, audit logging & detection.

## Live Linear State (auto-rendered 2026-07-29 14:33 UTC)

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
| Application Security & Code Scanning | `45745b0e-ca4d-447f-b600-d8da2376b877` | 2026-10-15 | 3 | 0% (0/3) |
| Image & Artifact Supply Chain Hardening | `ff3f6c2c-4b01-4644-add8-f42339c113b7` | 2026-09-15 | 4 | 0% (0/4) |
| Dependency & Supply Chain Scanning | `4e61ad4b-1b4b-4e86-a458-0d90b656b7b1` | 2026-08-15 | 2 | 0% (0/2) |
| Data Protection, PII & Audit Logging | `da07e802-e171-4a9e-ab06-a35e34b0ff15` | 2026-11-15 | 4 | 0% (0/4) |

```
Supply Chain, AppSec & Data — 4 milestone(s)

  Dependency & Supply Chain Scanning  (due 2026-08-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/2
    SEC-24  [Backlog]  Enforce dependency review action on PRs touching lockfiles
    SEC-23  [Backlog]  Generate SBOM (CycloneDX) across all flagship repos

  Image & Artifact Supply Chain Hardening  (due 2026-09-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/4
    SEC-28  [Backlog]  Establish SBOM attestation and verification at deploy-time
    SEC-27  [Backlog]  Implement cosign image signing for all production images
    SEC-26  [Backlog]  Configure Harbor vulnerability scanning policy (block critical on push)
    SEC-25  [Backlog]  Integrate Trivy image scanning into all build pipelines (CI)

  Application Security & Code Scanning  (due 2026-10-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/3
    SEC-31  [Backlog]  Add security review gate to release-please workflow (block on critical SAST findings)
    SEC-30  [Backlog]  Enable GitHub secret scanning + push protection across estate
    SEC-29  [Backlog]  Expand CodeQL query suites and add custom security queries

  Data Protection, PII & Audit Logging  (due 2026-11-15)  [░░░░░░░░░░░░░░░░░░░░] 0%  0/4
    SEC-35  [Backlog]  Deploy centralized audit logging with anomaly detection alerts
    SEC-34  [Backlog]  PII classification and handling: tag, mask, and route sensitive fields
    SEC-33  [Backlog]  Define and enforce data retention & disposal policy (TTL, automated purge)
    SEC-32  [Backlog]  Implement data-leak-at-load protection (secrets/PII scrubbing on model/context load)
```

*Last 7 days: 0 issue(s) touched, 0 completed.*
*Rendered by `.github/scripts/render-roadmap.sh` (corpus auto-render, schedule + dispatch).*

## Milestones

### Milestone 1: Dependency & Supply Chain Scanning
**Target: 2026-08-15**

Establish estate-wide dependency vulnerability scanning and triage. Dependabot is now enabled; the focus shifts to alert triage workflows, SBOM generation, and dependency policy enforcement.

| Issue | State | Priority |
|-------|-------|----------|
| SEC-11 — Enable Dependabot across the estate | Done | High |
| SEC-16 — Triage 13 critical Dependabot alerts surfaced by estate-wide enablement | Backlog | High |
| (new) — Generate SBOM (CycloneDX) across all flagship repos | — | Medium |
| (new) — Enforce dependency review action on PRs touching lockfiles | — | Medium |

### Milestone 2: Image & Artifact Supply Chain Hardening
**Target: 2026-09-15**

Secure the container image supply chain: Trivy scanning in CI, Harbor integration for image storage with vulnerability policies, cosign signing for provenance and integrity verification.

| Issue | State | Priority |
|-------|-------|----------|
| (new) — Integrate Trivy image scanning into all build pipelines (CI) | — | High |
| (new) — Configure Harbor vulnerability scanning policy (block critical on push) | — | High |
| (new) — Implement cosign image signing for all production images | — | High |
| (new) — Establish SBOM attestation and verification at deploy-time | — | Medium |

### Milestone 3: Application Security & Code Scanning
**Target: 2026-10-15**

Deepen application security beyond dependency scanning: CodeQL SAST is live but needs expanded coverage, secret scanning, and security review gates in the release process.

| Issue | State | Priority |
|-------|-------|----------|
| SEC-12 — Stand up code scanning (CodeQL) | Done | Medium |
| (new) — Expand CodeQL query suites and add custom security queries | — | Medium |
| (new) — Enable GitHub secret scanning + push protection across estate | — | High |
| (new) — Add security review gate to release-please workflow (block on critical SAST findings) | — | High |

### Milestone 4: Data Protection, PII & Audit Logging
**Target: 2026-11-15**

Address data security end-to-end: prevent data leakage at load time, enforce data retention/disposal policies, protect PII, and establish comprehensive audit logging and detection.

| Issue | State | Priority |
|-------|-------|----------|
| (new) — Implement data-leak-at-load protection (secrets/PII scrubbing on model/context load) | — | High |
| (new) — Define and enforce data retention & disposal policy (TTL, automated purge) | — | Medium |
| (new) — PII classification and handling: tag, mask, and route sensitive fields | — | High |
| (new) — Deploy centralized audit logging with anomaly detection alerts | — | Medium |
