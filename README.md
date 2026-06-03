# linear-workflows (`lw`)

A small, headless CLI for the Linear workflows we keep re-improvising by hand —
**digest** ("what have we been up to"), **file** (headless issue creation),
**triage**, and **milestone** burn-down — built on the official
[`@linear/sdk`](https://www.npmjs.com/package/@linear/sdk).

> **Status:** v0.1 scaffold. `whoami` is implemented; the rest are
> **specified-but-stubbed** (the CLI surface is real — `--help` works — the bodies
> are pending). See [`SPEC.md`](./SPEC.md) for the full design, the proposed
> additional workflows, and the agent/SDK insights driving the roadmap.
>
> **Auth is wired but unverified** — run `lw whoami` with a real key to confirm it
> before trusting anything. Nothing here has been run against the live API yet.

## Why a CLI when there's an MCP server + skills?

The in-session skills (`file-bug`, `issue-triage`, `linear-file-spec`, …) are
**interactive**. `lw` is the **headless / batch / CI** complement — same jobs, but
runnable from cron, a git hook, or a `| jq` pipeline, and it **sidesteps the local
MCP `save_issue` rate-guard** for batch filing (while still respecting Linear's own
limits). Full positioning table in [`SPEC.md` §3](./SPEC.md).

## Install / develop

```bash
npm install              # deps (Node ≥ 24)
npm run dev -- --help    # run from source via tsx (no build step)
npm run build            # emit dist/ + the `lw` bin
npm link                 # optional: put `lw` on PATH
```

## Authentication

`lw` reads a Linear personal API key from `LINEAR_API_KEY`. It renders from
1Password (`Cerebral · Linear API`, vault `cloud`) into `~/.config/zsh/secrets.env`
at `chezmoi apply`, or inject it for one run:

```bash
# resolves the "Cerebral · Linear API" item (vault `cloud`) by its stable ID —
# the UUID is copy-paste-safe; the title contains a space + `·` that is not.
LINEAR_API_KEY="op://cloud/wk3h5dwd2rnaurejrovhac4gm4/<field>" op run -- lw whoami
```

The key is **never** stored, cached, logged, or printed by this tool, and `*.env`
is git-ignored.

## Commands

| Command | Status | Summary |
|---|---|---|
| `lw whoami [--json]` | ✅ implemented | Resolve the authenticated viewer — proves auth. |
| `lw digest [--since 7d] [--team CER]` | 📝 specified | Recent issue activity grouped by status. |
| `lw file <title> --team CER` | 📝 specified | Create an issue headless (batch-friendly). |
| `lw triage --team CER` | 📝 specified | List issues needing triage. |
| `lw milestone [--project ID]` | 📝 specified | Milestone burn-down. |

Stubbed commands exit `2` with a pointer to their SPEC section — never a silent
no-op.

## First run

```bash
npm run build && lw whoami      # or: npm run whoami
```

If you see your name + org, auth works and the M1 read commands can be
implemented + verified. See [`SPEC.md` §10](./SPEC.md) for the roadmap.
