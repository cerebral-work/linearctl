<h1 align="center">linearctl</h1>

<p align="center">
  <em>The Linear workflows you keep re-improvising by hand — as one fast, headless CLI.</em>
</p>

<p align="center">
  <img alt="built with bun" src="https://img.shields.io/badge/built%20with-bun-000000?logo=bun&logoColor=white">
  <img alt="bun 1.3.14" src="https://img.shields.io/badge/bun-1.3.14-fbf0df?logo=bun&logoColor=black">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white">
  <img alt="@linear/sdk ^86" src="https://img.shields.io/badge/%40linear%2Fsdk-%5E86-5e6ad2?logo=linear&logoColor=white">
  <img alt="status pre-code M0" src="https://img.shields.io/badge/status-pre--code%20(M0)-orange">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

---

`digest` what you've been up to · `file` issues headless · `triage` the backlog ·
track `milestone` burn-down — built on the official
[`@linear/sdk`](https://www.npmjs.com/package/@linear/sdk), shipped as a single
attested binary.

> [!NOTE]
> **Status: pre-code (M0).** `whoami` is implemented and verified against the live
> API. `digest` / `file` / `triage` / `milestone` are **specified-but-stubbed** —
> the CLI surface is real (`--help`, `--json`, required-options all work); the
> bodies land milestone by milestone. The full design, roadmap, mermaid diagrams,
> and ticket backlog live in [`docs/spec.md`](./docs/spec.md); the tooling
> rationale in [`docs/decisions.md`](./docs/decisions.md).

## Why a CLI when there's an MCP server + skills?

The in-session skills (`file-bug`, `issue-triage`, `linear-file-spec`, `pr-triage`)
are **interactive**. `linearctl` is the **headless / batch / CI** complement — same
jobs, runnable from cron, a git hook, or a `| jq` pipeline — and it **sidesteps the
local MCP `save_issue` rate-guard** for batch filing (while still respecting
Linear's own limits). Positioning table: [`docs/spec.md` §3](./docs/spec.md).

## Quickstart

```bash
# install the released binary via mise (no Node runtime needed)
mise use -g "github:cerebral-work/linearctl"

# prove auth, then go
linearctl whoami
linearctl digest --since 7d --team CER --json | jq
```

<details>
<summary><strong>Develop from source</strong></summary>

```bash
bun install                 # bun ≥ 1.3 (see .prototools)
bun run dev -- whoami       # run from source
bun run typecheck           # tsc --noEmit
bun test                    # unit tests
bun run build               # bun build --compile → dist/linearctl
```
</details>

## Authentication

`linearctl` reads a Linear personal API key from `LINEAR_API_KEY`. Provision it
however you like — render it from a secret manager into your shell env, or inject
it for a single run:

```bash
# inject the key from your secret manager for one run (1Password shown)
LINEAR_API_KEY="op://<vault>/<item>/<field>" op run -- linearctl whoami
```

The key is **never** stored, cached, logged, or printed, and `*.env` is git-ignored.

## Commands

| Command | Status | Summary |
|---|---|---|
| `linearctl whoami [--json]` | ✅ implemented | Resolve the authenticated viewer — proves auth. |
| `linearctl digest [--since 7d] [--team CER]` | 📝 specified | Recent issue activity grouped by status. |
| `linearctl file <title> --team CER` | 📝 specified | Create an issue headless (batch-friendly). |
| `linearctl triage --team CER` | 📝 specified | List issues needing triage. |
| `linearctl milestone [--project ID]` | 📝 specified | Milestone burn-down. |

Stubbed commands exit `2` with a pointer to their spec section — never a silent
no-op. More on the roadmap (`cycle`, `stale`, `xref`, `release-notes`, `standup`,
and a native `linearctl watch` agent): [`docs/spec.md` §7, §10](./docs/spec.md).

## How it ships

Conventional Commits → **release-please** Release PR → tag → **bun cross-compiles**
4 targets → **SLSA-attested** tarballs → `mise` install verifies the attestation.
Diagram + caveats (binary size, the bun#11785 mitigation): [`docs/spec.md`
§8](./docs/spec.md).

## Dogfooding

`linearctl` is a Linear CLI, so it files its own backlog: the tickets in
[`docs/spec.md` §12](./docs/spec.md) get created via `linearctl file` once that command
lands (M2). The project is its own first user.

---

<p align="center"><sub>Built for the Cerebral workspace · MIT · <code>chris@todie.io</code></sub></p>
