# `linear-workflows` (`lw`) — Specification

**Status:** v0.1 scaffold. `whoami` implemented; `digest` / `file` / `triage` /
`milestone` specified-but-stubbed (full CLI surface, bodies pending). The spec is
the contract; the code catches up to it.

**Verification posture (honest):** only `whoami` is wired to run, and it is
**unverified against the live API** until the operator runs `lw whoami` with a
real `LINEAR_API_KEY`. No command implementation here has been executed against
Linear. Per the house rule *"the agent never touches keys"*, the build does not
auto-run the production Cerebral key — verification is the operator's first step.
Nothing in this repo should be described as "working" until `lw whoami` returns a
viewer.

---

## 1. Motivation

A handful of Linear workflows get **re-improvised every session** — pulled
together ad hoc from MCP tool calls, then thrown away:

- *"What have we been up to?"* — the session-start summary of recent issue
  activity (the session-bootstrap hook asks for this verbatim).
- *Filing issues / specs in bulk* — repeatedly hit the **local MCP `save_issue`
  rate-guard** ("5th save_issue in 10 min" → blocked mid-batch), forcing
  `# bulk-file-spec: skip` overrides.
- *Triage sweeps* — finding unassigned / unestimated / in-Triage issues.
- *Milestone tracking* — "knock out the existing milestones before the
  release-please swap" needs a progress read.

These are **interactive, in-session, one-shot** today. They cannot run headless
(cron, CI, a git hook, a `| jq` pipeline), they are not reproducible, and they
share the local hypervisor's MCP rate-guard with every other agent action.

`lw` makes them **first-class, scriptable, composable commands** on top of the
official [`@linear/sdk`](https://www.npmjs.com/package/@linear/sdk).

## 2. Goals / Non-goals

**Goals**
- One small, fast CLI for the recurring workflows above.
- Headless + scriptable: every command has a `--json` mode for `jq`/automation.
- Honest auth: read `LINEAR_API_KEY` from the environment; never store or print it.
- Composable with the rest of the toolbelt (cron, CI, git hooks, `coord`).

**Non-goals**
- Not a replacement for the Linear MCP server or the web app — it covers the
  *recurring* flows, not the full API surface.
- Not a general issue browser (that's the app / MCP).
- No write operations beyond the explicitly-modelled ones (`file`, and later
  `triage --assign`); destructive ops stay out.

## 3. Positioning vs existing skills (gap-filler, not duplication)

The in-session skills are **interactive**: a human (or agent) drives them inside a
Claude session, one issue at a time, through the MCP server. `lw` is the
**headless / batch / CI** complement to the same jobs — same outcomes, different
execution context, and a *different rate-limit domain* (see §9).

| `lw` command | Complements skill | Why a CLI is the gap-filler |
|---|---|---|
| `lw digest` | *(none — net-new)* | The session-start "what have we been up to" summary, made reproducible and pipeable. No skill owns this today. |
| `lw file` | `file-bug`, `linear-file-spec` | Those are interactive + MCP-bound; `lw file` runs in scripts/CI/loops and **sidesteps the local MCP `save_issue` rate-guard** (it talks straight to Linear, not through the local hypervisor). |
| `lw triage` | `issue-triage` | `issue-triage` reasons about one issue interactively; `lw triage` is a fast headless *listing* to feed it, a standup, or a CI gate. |
| `lw milestone` | *(none — net-new)* | Milestone burn-down for the release-readiness check; no skill covers it. |
| `lw whoami` | *(none)* | Auth smoke-test / the thin slice. |

The rule of thumb: **skills decide, `lw` enumerates and executes in bulk.** Where
a skill is the right tool (nuanced single-issue triage), `lw` feeds it a list;
where automation is the right tool (file 12 specs from a loop), `lw` runs without
a session at all.

## 4. Architecture

- **Runtime:** Node ≥ 24 (mise-pinned `24.16.0`), ESM (`"type": "module"`).
- **Language:** TypeScript, strict. Dev runs via `tsx` (no build step); `npm run
  build` (`tsc`) emits `dist/` and the `lw` bin.
- **Deps:** `@linear/sdk` (the official SDK), `commander` (subcommands + help).
  Dev: `typescript`, `tsx`, `@types/node`. Intentionally minimal.
- **Layout:**
  ```
  src/
    index.ts          commander wiring + dispatch (the only entry)
    client.ts         makeClient(): LinearClient from $LINEAR_API_KEY
    commands/         one file per subcommand
    lib/
      output.ts       printJson / printTable
      time.ts         sinceToDate("7d") → Date   (pure, unit-testable)
  ```
- **Output contract:** human table by default; `--json` emits structured JSON to
  stdout (errors/log to stderr) so every command composes with `jq` and friends.
- **Exit codes:** `0` ok · `1` runtime/auth error · `2` not-yet-implemented (so a
  stub is never mistaken for a silent success).

## 5. Authentication & secrets

`lw` reads a **Linear personal API key** from `process.env.LINEAR_API_KEY`. The
key is operator-provisioned, in 1Password as **`Cerebral · Linear API`** (vault
`cloud`), and rendered into `~/.config/zsh/secrets.env` at `chezmoi apply`. For a
one-off run without the rendered file:

```bash
# stable item ID (copy-paste-safe; the title's space + `·` is not)
LINEAR_API_KEY="op://cloud/wk3h5dwd2rnaurejrovhac4gm4/<field>" op run -- lw whoami
```

`lw` **never** stores, caches, logs, or prints the key — `client.ts` reads it at
call time and nothing else touches it. `.gitignore` excludes `*.env` so a
rendered secret can never ride along in a commit. A native OAuth path (`actor=app`)
is future work (§8).

## 6. Command reference

### 6.1 `lw whoami` — *implemented*
`lw whoami [--json]`. Resolves `client.viewer` + `client.organization`. The thin
vertical slice proving auth end-to-end. Run it first on any new machine.

### 6.2 `lw digest` — *specified*
`lw digest [--since 7d] [--team CER] [--json]`. "What have we been up to":
issues updated within the window, grouped by workflow-state type
(completed / started / triage / backlog).
- Filter: `{ updatedAt: { gte: sinceToDate(since) }, team?: { key: { eq } } }`,
  `orderBy: updatedAt`, paginate via `fetchNext()` until `!hasNextPage`.
- Human mode: counts + a section per group (identifier · title · assignee · url).
- JSON mode: `{ window, team, groups: { completed: [...], started: [...], ... } }`.

### 6.3 `lw file` — *specified*
`lw file <title> --team CER [--project ID] [--desc <md|->] [--label name...] [--json]`.
Create an issue headless. `--desc -` reads markdown from stdin (heredocs, pipes).
- Resolve team by key (`teams({ filter: { key: { eq } } })`), then
  `createIssue({ teamId, title, description, projectId })`; print `identifier` +
  `url`.
- Batch-friendly: designed to be called in a loop with backoff (§9).

### 6.4 `lw triage` — *specified*
`lw triage --team CER [--json]`. List issues needing attention: in the **Triage**
state, **or** unassigned, **or** unestimated. A fast headless listing to feed the
`issue-triage` skill, a standup, or a CI gate. Output flags *why* each issue
surfaced.

### 6.5 `lw milestone` — *specified*
`lw milestone [--project ID] [--json]`. Per-milestone burn-down (done vs open,
percent + bar) for a project. Backs the release-readiness check ("milestones
cleared before the release-please swap").

## 7. Proposed additional workflows (backlog)

Surfaced from the recurring patterns this codebase already exercises — candidates
once the MVP lands:

1. **`lw cycle`** — current-cycle review: scope, completed, carry-over,
   scope-change. The sprint-health read.
2. **`lw stale [--older 30d]`** — stale-issue sweep: in-progress issues untouched
   for *N* days (rot detector); pairs with a weekly cron → digest.
3. **`lw xref [--pr N]`** — PR ↔ issue cross-reference audit: open PRs with no
   linked issue, and issues marked done whose PR never merged. (Complements the
   `pr-triage` skill; directly relevant to the linear-release linkage work.)
4. **`lw release-notes <from>..<to>`** — assemble release notes from issues
   *completed* in a range, grouped by label. Feeds the `linear-release` /
   `cut-release` flow with human-readable notes the commit-scan can't produce.
5. **`lw standup [--slack #chan]`** — render `digest` as a standup post; optional
   push to Slack (operator-gated send — never auto-post; see house rules).
6. **`lw watch` (daemon)** — long-running: subscribe to Linear webhooks and react
   (auto-label, auto-link PRs, ping `coord`). The bridge to §8.

## 8. Insights from the Agent guidelines + SDK (what to build toward)

From [linear.app/developers](https://linear.app/developers) — the Agent
Interaction Guidelines (AIG) and SDK — three insights that should shape the
roadmap:

- **Go from polling CLI → native Linear agent.** The biggest leverage is an OAuth
  app with `actor=app` (scopes `app:assignable` + `app:mentionable`). Then `lw`
  isn't a thing *you* run — it's an **agent assigned to issues** that reacts to
  `AgentSessionEvent` webhooks. Mentions/assignments become triggers; the
  workflows in §7 become *automatic* instead of ad-hocced. This is the structural
  upgrade the user's "surface insights from agents" ask points at.
- **Agent UX has protocol obligations.** The AIG require emitting a `thought`
  activity within ~10s of a session starting, and respecting `promptContext`.
  A native `lw watch` must implement these to be a well-behaved agent (responsive,
  visible, non-silent) rather than a black box.
- **Rate limits are complexity-based, and the CLI changes the domain — not the
  ceiling.** `lw` sidesteps the *local hypervisor MCP* `save_issue` rate-guard
  (that guard is ours, not Linear's), but it then faces **Linear's own**
  complexity-weighted limits, surfaced as a `RATELIMITED` extension code. So the
  honest framing: the CLI removes a *self-imposed* bottleneck for batch work, and
  in exchange must itself be **rate-limit-aware** — read the cost headers, back
  off on `RATELIMITED`, prefer a single filtered query over N round-trips
  (`assignee: { null: true }` in one call beats fetch-all-then-filter). OAuth
  `actor=app` raises the ceiling vs a personal key, another reason §8 bullet 1
  matters.

**Cross-cutting SDK practices** the implementations should adopt: request only the
fields rendered (the SDK lazy-fetches relations → N+1 traps on `.state` /
`.assignee`; resolve in the query, not in a loop); always paginate (`fetchNext()`)
rather than trusting the first page; treat connections as cursors, not arrays.

## 9. Rate-limit posture (honest)

Two distinct limiters, often conflated:

| Limiter | Whose | What `lw` does |
|---|---|---|
| Local MCP `save_issue` guard ("5 in 10 min") | **Ours** (hypervisor-preflight) | **Sidestepped** — `lw` calls Linear directly, not through the local MCP. This is the batch-filing win. |
| Linear API complexity / `RATELIMITED` | **Linear's** | **Still applies.** `lw` must back off, batch, and prefer single filtered queries. Not magic — a different, higher ceiling. |

Claiming `lw` "fixes rate limits" would be false. It moves batch work out from
under a *self-imposed* guard; Linear's real limits remain and are respected.

## 10. Roadmap / milestones

- **M0 — scaffold (this PR):** repo, CLI surface, `whoami`, spec. ✅
- **M1 — read commands:** implement `digest`, `triage`, `milestone` against the
  live API; verify each end-to-end before claiming it works.
- **M2 — write + batch:** implement `file` with stdin + backoff; batch helper.
- **M3 — additional workflows:** `cycle`, `stale`, `xref`, `release-notes` (§7).
- **M4 — native agent:** OAuth `actor=app`, `lw watch` webhook daemon, AIG
  compliance (`thought`/`promptContext`) (§8).

## 11. Verification checklist (before any command is called "working")

- [ ] `npm run build` clean; `lw --help` and every `lw <cmd> --help` render.
- [ ] `lw whoami` returns the expected viewer + org (operator, real key).
- [ ] Each read command verified against live data before M1 is declared done.
- [ ] No secret in git history; `*.env` ignored (verified pre-first-commit).
