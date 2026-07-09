# Feature: `linearctl tui` — full-screen dashboard

**Status:** proposed
**Command:** `linearctl tui [--team CER] [--project ID] [--focus digest|triage|milestone|xref]`
**Roadmap:** net-new (not in §7)
**Milestone:** M4 (after the core command surface is complete)

## Motivation

`linearctl` is headless-first by design — every command pipes with `jq`,
runs in cron, and composes in CI. But the same operator who scripts
`linearctl triage | jq` in a hook also sits down at a terminal and wants
to **see the landscape** — triage queue, milestone burndown, recent digest,
xref drift — without running four commands and scrolling four outputs.

Today that means: open the Linear web app. Which is fine for one issue, but
the web app doesn't show triage + milestone + xref in one screen, and it
isn't keyboard-driven. A terminal dashboard that renders the same `core/*`
data the CLI already fetches — in one full-screen view, navigable with `j`/`k`
and `Enter` — fills the gap between "pipe to jq" and "open the browser."

This is the **third mode** in the multi-modal architecture: headless (current)
→ interactive prompts (see [`interactive.md`](./interactive.md)) → full-screen
TUI. All three share one `core/*`, one binary, one auth path.

## Proposal

`linearctl tui` opens a full-screen terminal dashboard over the existing
`core/*` functions. It is a **viewer** — it calls the same read paths
(`core/grooming`, `core/milestones`, `core/issues`, `core/xref`) that the
CLI commands already use. No new API surface, no new mutations, no new
logic. The TUI is pure presentation.

```
linearctl tui                      # full dashboard, all teams
linearctl tui --team CER           # scoped to one team
linearctl tui --focus triage       # open on the triage panel
```

### Layout

```
┌─ linearctl ─────────────────────────────────────────────────────┐
│ [1] Digest  [2] Triage  [3] Milestone  [4] Xref  [5] Stale       │
│────────────────────────────────────────────────────────────────-│
│                                                                 │
│  Triage queue — CER (7 issues)                                  │
│                                                                 │
│  ▸ CER-142  Fix webhook retry logic        unassigned  P2  3d   │
│    CER-138  Refactor batch backoff          unestimated  P1  7d │
│    CER-135  Add cycle review command        triage       P3  1d  │
│    CER-131  MCP handshake smoke test        no priority  —  12d │
│    ...                                                          │
│                                                                 │
│────────────────────────────────────────────────────────────────-│
│ j/k move · Enter show · e edit · r triage · q quit             │
└─────────────────────────────────────────────────────────────────┘
```

### Panes (tabs `1`–`5`)

| Pane | Source | What it shows |
|------|--------|---------------|
| **Digest** | `core/grooming` (digest query) | Recent activity grouped by state type — same grouping as `linearctl digest` |
| **Triage** | `core/grooming` (triage query) | Triage queue with reason flags — same as `linearctl triage` rows |
| **Milestone** | `core/milestones` | Burn-down bars per milestone — same as `linearctl milestone` |
| **Xref** | `core/xref` | PR↔ticket drift summary — same categories as `linearctl xref` |
| **Stale** | `core/grooming` (stale query) | Stale issues bucketed warn/critical — same as `linearctl stale` |

### Behavior

- **Read-only by default.** The TUI never mutates without explicit action.
  `Enter` on an issue opens a detail view (calls `core/issues.show`); `e`
  offers to open `$EDITOR` on the description; `r` proposes a triage action
  that must be confirmed — same dry-run-then-confirm contract as the CLI.
- **Keyboard-first.** `j`/`k` or arrow keys to move, `1`–`5` to switch
  panes, `/` to filter, `Enter` to drill into an issue, `q` to quit. Mouse
  support is optional (nice for scroll), not required.
- **TTY-gated.** If stdout is not a TTY (piped, redirected, `--json` passed),
  `linearctl tui` errors with "tui requires a terminal" — it never
  degrades to a broken half-render. The headless commands are the pipe
  path; the TUI is the human path.
- **Scope filters.** `--team` and `--project` pre-filter all panes. `/`
  opens an inline filter for the current pane (title substring, assignee,
  label).
- **Detail view.** `Enter` on an issue opens a full-screen render of
  `linearctl show <id>` — metadata + description + activity, scrollable.

### Relationship to `core/*`

The TUI imports and calls the same functions the CLI commands use:

```
src/tui/
  app.ts        # entry, pane router, keyboard loop
  panes/
    digest.ts   # calls core/grooming.getDigest()
    triage.ts   # calls core/grooming.getTriageQueue()
    milestone.ts # calls core/milestones.getMilestones()
    xref.ts     # calls core/xref.reconcile()
    stale.ts    # calls core/grooming.getStale()
  components/
    table.ts    # reusable issue-table renderer
    bar.ts      # burn-down bar
    detail.ts   # issue detail view
```

No `src/tui/api.ts` — the TUI never talks to Linear directly. It calls
`core/*`, which calls `client.ts`, which calls `@linear/sdk`. One auth
path, one rate-limit domain, one set of data contracts.

## Library candidates

From the [`tui-cli-landscape/typescript-javascript.md`](./tui-cli-landscape/typescript-javascript.md)
research:

| Library | GH ★ | Weekly DL | Adopters | Fit |
|---------|------|-----------|---------|-----|
| **ink** | 38.1k | 4.2M | Claude Code, Gemini CLI, Copilot CLI | Proven at scale. React renderer → familiar component model. But `@inkjs/ui` is stale (2yr, v2.0.0) — build components from `Box`/`Text` primitives. |
| **OpenTUI** | 11.9k | 119k | OpenCode, terminal.shop | Native Zig core → high perf, cell-diffing. Newer, smaller ecosystem. TS bindings. |
| **Glyph** | 40 | low | Aion, Epist | Richest component library (20+ components, focus system, modal, JumpNav). But 40★, early-stage, full-screen only. |

**Lean: Ink.** The adoption signals are decisive — Claude Code, Gemini CLI,
and Copilot CLI all ship Ink-based TUIs in production. The stale `@inkjs/ui`
is a known quantity: the component primitives (`Box`, `Text`, `Static`,
`useInput`, `useApp`) are stable and sufficient. Building a 5-pane dashboard
from those primitives is well-trodden ground.

OpenTUI is the performance play if the dashboard grows heavy (hundreds of
issues rendered with live updates), but the initial surface is 5 read-only
panes — Ink's React reconciliation is fast enough. Glyph has the best
components but the adoption risk (40★, early) is too high for a tool that
needs to be reliable.

**Decision deferred to implementation time** — this proposal argues for the
*TUI mode* and its architecture, not a specific library. The library choice
is an ADR.

## API surface

No new Linear API calls. The TUI uses:

| Core function | Already used by | TUI pane |
|---------------|----------------|----------|
| `core/grooming.getDigest()` | `linearctl digest` | Digest |
| `core/grooming.getTriageQueue()` | `linearctl triage` | Triage |
| `core/milestones.getMilestones()` | `linearctl milestone` | Milestone |
| `core/xref.reconcile()` | `linearctl xref` | Xref |
| `core/grooming.getStale()` | `linearctl stale` | Stale |
| `core/issues.show()` | `linearctl show` | Detail view |

The only new code is the presentation layer in `src/tui/`.

## Non-goals

- **Not an issue editor.** The TUI shows and navigates; it doesn't replace
  the Linear web app for writing descriptions. `e` opens `$EDITOR` on a
  temp file and calls `core/issues.update` on save — same path as a future
  `linearctl edit` command, not a TUI-internal editor.
- **Not a real-time watcher.** The dashboard refreshes on demand (`r` key)
  or on a configurable interval (`--refresh 30s`). True real-time (webhook
  subscription) is T14 (the `watch` daemon), a separate concern.
- **Not the MCP server.** The TUI is for the human at the terminal; the
  MCP server is for the agent in Claude Desktop/Code. Both are surfaces
  over `core/*` — they don't share code beyond that.
- **No `--json` mode.** The TUI is human-only by definition. If you need
  structured output, use the headless commands.

## Alternatives considered

- **Open the Linear web app.** Works, but: not keyboard-driven, no
  multi-pane view, requires leaving the terminal, can't compose with
  local context (git branch, editor state).
- **Build the dashboard in the interactive mode (prompts).** Rejected —
  prompts are for one-off interactions (select a team, confirm a write),
  not for navigating a data landscape. A full-screen TUI is the right
  tool for "show me everything and let me look around."
- **Use `fzf` over `linearctl triage --json`.** Power-user workaround, not
  a feature. Works for one pane (triage), doesn't compose across panes,
  no detail view, no milestone bars. The TUI is the opinionated, integrated
  version.
- **Wait for a terminal Linear client (gum/bubbletea equivalent).** No such
  client exists for Linear; building it is the value. And it would be in
  Go/Rust, not the TS/JS ecosystem linearctl lives in.

## Verification

- `linearctl tui` in a real terminal renders all 5 panes with live data
  from the operator's workspace.
- `linearctl tui --team CER` scopes all panes to CER.
- `j`/`k` moves the cursor, `1`–`5` switches panes, `Enter` opens issue
  detail, `q` quits.
- `linearctl tui | cat` errors with "tui requires a terminal" (no broken
  half-render to a pipe).
- `linearctl tui --json` errors the same way (the TUI has no JSON mode).
- No new API calls — `core/*` coverage is identical to the headless commands.
- `bun run typecheck` clean, `bun test` green, `bun build --compile` still
  produces a single binary (Ink adds ~2MB to the bundle).
