# Roadmap: Supply Chain, AppSec & Data

**Linear Project:** [Supply Chain, AppSec & Data](https://linear.app/cerebral-work/project/supply-chain-appsec-and-data-60b73d86b191)
**Project ID:** `56254f92-decf-4936-aca2-d9b1dcd962cc`
**Scope:** Image/dep supply chain (Trivy, Harbor, cosign signing), web/worker app vulns, data-leak-at-load, retention/disposal, PII, audit logging & detection.

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
