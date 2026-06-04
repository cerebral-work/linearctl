<h1 align="center">linearctl</h1>

<p align="center">
  <em>The Linear workflows you keep re-improvising by hand — as one fast, headless CLI.</em>
</p>

<p align="center">
  <img alt="built with bun" src="https://img.shields.io/badge/built%20with-bun-000000?logo=bun&logoColor=white">
  <img alt="bun 1.3.14" src="https://img.shields.io/badge/bun-1.3.14-fbf0df?logo=bun&logoColor=black">
  <img alt="TypeScript strict" src="https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white">
  <img alt="@linear/sdk ^86" src="https://img.shields.io/badge/%40linear%2Fsdk-%5E86-5e6ad2?logo=linear&logoColor=white">
  <img alt="status commands complete" src="https://img.shields.io/badge/status-commands%20complete-brightgreen">
  <img alt="license MIT" src="https://img.shields.io/badge/license-MIT-blue">
</p>

---

`digest` what you've been up to · `file` issues headless · `triage` the backlog ·
track `milestone` burn-down — built on the official
[`@linear/sdk`](https://www.npmjs.com/package/@linear/sdk), shipped as a single
attested binary.

> [!NOTE]
> **Every command in the spec is implemented and verified against the live API** —
> `whoami`, `project`, `file`, `update` / `close`, `digest`, `triage`, `stale`,
> `xref`, `milestone`, plus `mcp serve` (a Model Context Protocol server that
> exposes the same capabilities to Claude Desktop / Claude Code). The full design,
> roadmap, mermaid diagrams, and ticket backlog live in
> [`docs/spec.md`](./docs/spec.md); the tooling rationale in
> [`docs/decisions.md`](./docs/decisions.md).

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

All commands are implemented and honor `--json`; mutating verbs are
safe-by-default.

| Command | Summary |
|---|---|
| `linearctl whoami` | Resolve the authenticated viewer — proves auth. |
| `linearctl digest [--since 7d] [--team CER...]` | Recent activity grouped by workflow state. |
| `linearctl file <title> --team CER [--project ID] [--label ...]` | Create an issue headless (batch-friendly). |
| `linearctl update <id> [--state] [--assignee] [--label] [--priority]` | Mutate an issue's fields. |
| `linearctl close <id>` | Move an issue to its team's completed state. |
| `linearctl triage [--team CER...]` | Surface issues needing triage, with *why*-reasons. |
| `linearctl stale [--older-than 30d] [--label N [--apply]]` | Sweep stale issues; report-only unless `--apply`. |
| `linearctl xref [--repo owner/repo]` | Reconcile GitHub PRs ↔ Linear tickets (read-only). |
| `linearctl milestone [--project ID]` | Per-milestone burn-down (done vs total + bar). |
| `linearctl project create\|list` | Create / list Linear projects. |
| `linearctl mcp serve` | Stdio MCP server (10 tools) for Claude — see below. |

Safe-by-default: `stale --label` is a dry-run unless `--apply`; `xref` is
read-only; there are no delete/archive operations. Full reference:
[`docs/spec.md` §6](./docs/spec.md). Roadmap (`cycle`, `release-notes`, `standup`,
native `linearctl watch` agent): [`docs/spec.md` §7, §10](./docs/spec.md).

## Use it in Claude (plugin + Desktop extension)

`linearctl mcp serve` exposes the same capabilities as MCP tools — 6 read
(`whoami`, `project_list`, `digest`, `triage`, `milestone`, `stale`) + 4 write
(`file_issue`, `project_create`, `issue_update`, `issue_close`). Both surfaces
launch the installed `linearctl` binary, so install the CLI first (Quickstart).

**Claude Code** — add the marketplace, then install the plugin (it reads
`LINEAR_API_KEY` from your environment):

```bash
claude plugin marketplace add cerebral-work/linearctl
claude plugin install linearctl@cerebral-work
```

**Claude Desktop** — pack the `.mcpb` extension and open it in the app:

```bash
npx @anthropic-ai/mcpb pack mcpb/ dist/linearctl.mcpb
# Claude Desktop → Settings → Extensions → install dist/linearctl.mcpb
```

Desktop prompts once for your Linear API key (a masked field) and stores it in
the OS keychain — never in a file. Details: [`mcpb/README.md`](./mcpb/README.md)
and [`docs/plugin-spec.md`](./docs/plugin-spec.md).

## How it ships

Conventional Commits → **release-please** Release PR → tag → **bun cross-compiles**
4 targets → **SLSA-attested** tarballs → `mise` install verifies the attestation.
Diagram + caveats (binary size, the bun#11785 mitigation): [`docs/spec.md`
§8](./docs/spec.md).

## Dogfooding

`linearctl` is a Linear CLI, so it files its own backlog: the tickets in
[`docs/spec.md` §12](./docs/spec.md) were created in Linear via `linearctl file`
itself (team CER), and are groomed with `triage` / `stale` / `xref`. The project
is its own first user.

---

<p align="center"><sub>Built for the Cerebral workspace · MIT · <code>chris@todie.io</code></sub></p>
