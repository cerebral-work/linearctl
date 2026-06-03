# Decisions (ADR log)

Short architecture decision records. Each: context → decision → consequences. The
evaluation behind the build/dist choice was settled **empirically**, not by vibes.

---

## ADR-0001 — Build & distribute with bun single-binary (not npm)

**Status:** Accepted (2026-06-03).

**Context.** `linearctl` is a TypeScript CLI (Node-flavoured, ESM) on `@linear/sdk`
(which pulls a `graphql` subtree). The deciding question for build tooling is
**distribution**: the operator ships their other CLIs (`ant`, `linear-release`) as
single binaries consumed via mise's `github:` backend, which verifies SLSA
provenance + GitHub artifact attestations on install.

**Decision.** Build with **bun** and ship **`bun build --compile` single binaries**,
cross-compiled for `linux/macos × x64/arm64`, attested with
`actions/attest-build-provenance`, and consumed via
`mise use -g "github:cerebral-work/linearctl"`. Test runner: **`bun test`**.
Type-checker: **`tsc --noEmit`** (bun strips types; it does not type-check).

**Why (empirically verified).** The one real risk — does `bun build --compile`
survive `@linear/sdk`'s graphql tree — was tested by actually compiling the exact
dep set on bun 1.3.14: it produced a standalone binary that ran graphql code paths
cleanly and failed only on *authentication* (fake key), never on the graphql
"from another module or realm" duplication error ([bun#11785](https://github.com/oven-sh/bun/issues/11785)).
That bug affects graphql **servers** (schema realm checks); `@linear/sdk` is a
**client** and doesn't trip it. No native addons in the tree. Attestation is
producer-agnostic (it Sigstore-signs the artifact *digest*), so a bun binary wraps
identically to the operator's Go-built `ant`.

**Consequences.**
- ✅ Same install UX / supply-chain gate as the operator's existing mise tools; no
  Node runtime required at the user's machine.
- ⚠️ **Binary size ~60–92 MB per platform per release** (embeds the bun runtime) vs
  a ~7 MB Go binary. Accepted for a pinned-version internal CLI. `--bytecode` is
  **off** (it trades size up for startup; not worth it for a CLI).
- ⚠️ bun#11785 is **open**, but the SDK *client* cannot trip it (no schema realm
  checks) — the residual risk is an unrelated bun bundler regression, not this bug.
  Mitigation: CI compiles + module-load-smokes the binary every PR (the
  `@linear/sdk` import runs at startup, so a bundling break fails the smoke).
  Workaround if a bundler issue ever fires: `overrides` pinning a single graphql
  (treat as a maybe — it did not reliably fix the issue for others).
- ⚠️ macOS Mach-O binaries are Gatekeeper-quarantined unsigned → notarization /
  `xattr` is tracked (T15).

**Rejected — npm (`npm i -g` / `npx`).** ~200 KB install, trivial CI, zero #11785
exposure — but it needs Node ≥24 at runtime, is **not** a mise `github:` tool, and
gets **no SLSA/attestation gate on install**. It breaks the single-binary pattern
the operator's toolchain is built around. The honest tie-breaker (binary size) lost
to install-UX + supply-chain consistency.

> Correction surfaced during research: `ant` is **GoReleaser**-built, not bun. So
> "match ant's tooling" was a non-choice — `ant` only sets the *asset shape* mise
> expects (GoReleaser-style `name_version_os_arch.tar.gz`), which bun assets mimic.

---

## ADR-0002 — Decline K8s / monorepo build tooling (skaffold, kaniko, moon)

**Status:** Accepted (2026-06-03).

**Decision.** Do **not** adopt **skaffold**, **kaniko**, or **moon**.

**Rationale.** skaffold + kaniko are Kubernetes image-build tooling — nothing in a
single-package CLI touches a cluster or an OCI image (until/unless the M4 daemon,
see ADR-0004). **moon** is a monorepo task runner; one package does not earn the
overhead. Evaluating ≠ adopting — "thorough" means a documented decline, not
ceremony. Revisit only if `linearctl` ever joins a monorepo.

---

## ADR-0003 — proto for a toolchain pin only (not a task runner)

**Status:** Accepted (2026-06-03).

**Decision.** Ship a **`.prototools`** pinning `bun` (+ `node` for editor/LSP
parity) so contributors match CI, and stop there. proto is otherwise redundant with
the maintainer's mise pins; no proto tasks, no moon.

---

## ADR-0004 — Docker is deferred to the M4 agent daemon

**Status:** Accepted (2026-06-03).

**Decision.** No Dockerfile / image pipeline now. The CLI ships as a binary, not a
container. A container becomes relevant only for **`lw watch`** (the long-running
webhook agent, M4), where it'll be scoped with its own runtime requirements
(glibc base, etc.). Captured in the roadmap (spec §10), not scaffolded.

---

## ADR-0005 — Linear is the tracker; the project dogfoods its own backlog

**Status:** Accepted (2026-06-03).

**Decision.** Issues are tracked in **Linear**, not GitHub Issues. The first-pass
backlog lives in **`docs/spec.md` §12** until M2 lands; then the project **files its
own tickets via `lw file`** — the dogfooding loop. The agent does **not** hand-file
linearctl tickets into Linear (outward-facing + would hit the local MCP rate-guard,
and the point is to exercise `lw file` itself).

---

## ADR-0006 — release-please (node) + squash-merge + signed commits

**Status:** Accepted (2026-06-03).

**Decision.** Versioning via **release-please** (`release-type: node`,
`bump-minor-pre-major: true` — pre-1.0, breaking → minor). PRs are **squash-merged**
(GitHub's rebase-merge replays commits *unsigned*; squash preserves a signed result).
Conventional Commits required.

**Note on signatures.** release-please's own Release PR commits are authored by the
bot and **GitHub web-flow-signed** (marked *Verified*), not GPG-signed by the
maintainer's key. Branch protection that requires signatures must accept GitHub's
web-flow signature — confirm before enabling "require signed commits".
