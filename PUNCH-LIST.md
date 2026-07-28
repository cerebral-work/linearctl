# linearctl — Backlog Punch-List

> Updated 2026-07-28. CER-1148 (OAuth `actor=app` scaffolding) shipped
> (PR #112). CER-1149 loop driver + `linearctl watch` CLI shipped (full-loop
> fallback path; daemon follow-up). Remaining: T14/CER-1149 daemon, TUI,
> notarization — operator-gated / large scope. See `roadmap-linearctl.md`
> for the full milestone view and `docs/spec.md` §12 for the complete ticket
> table (T1-T26). 286 tests pass, 0 fail.
## Shipped (2026-07-28 — CER-1149 loop driver slice)

| ID | Pri | Title |
|---|---|---|
| 🔵 [CER-1149](https://linear.app/cerebral-work/issue/CER-1149) | P4 | `feat(watch)`: `linearctl watch` — full-loop fallback path — loop driver library (`emitThought` → `driveAgentLoop` → `moveToStartedIfDelegated`) + `watch --once --payload` CLI verb; 10s-SLA thought-first ordering; daemon delegate-to-operator branch is follow-up |

## Shipped (2026-07-28 — PR #112 / commit eaa1043)

| ID | Pri | Title |
|---|---|---|
| ✅ [CER-1148](https://linear.app/cerebral-work/issue/CER-1148) | P4 | `feat(auth)`: OAuth `actor=app` scaffolding — `linearctl auth` subcommand (client-credentials / exchange-code / refresh / whoami); 1Password `linear-unsigned-oauth` item by field ID; live `whoami` verified |

## Shipped (2026-07-24 — PR #89 / commit 1955a99)

| ID | Pri | Title |
|---|---|---|
| ✅ [CER-1604](https://linear.app/cerebral-work/issue/CER-1604) | P3 | `file --stdin` dry-run / `--apply` project-name mismatch (Bug) — fixed: dry-run now validates project refs |
| ✅ [CER-1686](https://linear.app/cerebral-work/issue/CER-1686) | P3 | `milestone create` — create project milestones |
| ✅ [CER-1687](https://linear.app/cerebral-work/issue/CER-1687) | P3 | `project update` — update project state, name, description |
| ✅ [CER-1688](https://linear.app/cerebral-work/issue/CER-1688) | P4 | `roadmap` — view or export a project roadmap (milestone timeline) |

## Deferred (operator-gated / large scope)

| ID | Pri | Title | Assignee | Milestone | Age |
|---|---|---|---|---|---|
| [CER-1550](https://linear.app/cerebral-work/issue/CER-1550) | P0 | `feat(tui)`: full-screen keyboard-driven dashboard over `core/*` | unassigned | M4 | 13d |
| [CER-1149](https://linear.app/cerebral-work/issue/CER-1149) | P4 | `feat(agent)`: `linearctl watch` — AgentSessionEvent daemon | ctodie | M4 | 49d |
| [CER-1150](https://linear.app/cerebral-work/issue/CER-1150) | P4 | `chore(release)`: macOS notarization / codesign | ctodie | M2 | 49d |


---

## Bugs

### CER-1604 — `file --stdin` dry-run / `--apply` project-name mismatch (P3, Bug, unassigned, 2d old)

**Repro:** `linearctl file --stdin` without `--apply` (dry-run) does NOT
validate project resolution. It resolves the team from the payload and prints
`[dry-run] would create N issue(s)` even when `project` is a human-readable
name that `--apply` will reject:

```bash
linearctl file --stdin <<'EOF'
[{"title":"smoketest","team":"BIZ","project":"bigram / gami — Advisory","priority":3,"desc":"x"}]
EOF
# → [dry-run] would create 1 issue(s); re-run with --apply to write.   (looks fine)

linearctl file --stdin --apply <<'EOF'  # same payload
[...]
EOF
# → failed 2: Argument Validation Error - projectId must be a UUID.
```

**Expected:** the dry-run should validate project resolution the same way
`--apply` does, so a dry-run "would create" is a reliable predictor of an apply
that succeeds. Either resolve project names → UUIDs in the `--stdin` path the
same way the single-issue `file` path does, or have the dry-run emit the same
`Argument Validation Error` when `project` isn't a UUID.

**Fix direction:** the `--stdin` batch path skips the project-name resolution
step that the single-issue `file` path runs. Lift the resolver out of the
single-issue path and run it in both. ~30-line change, no API churn.

---

## Actionable Features (headless CLI — implementing now)

### CER-1686 — `milestone create` — create project milestones (P3, Feature, unassigned, 0d old)

**What:** `linearctl milestone create <name> --project <ref> [--target-date <YYYY-MM-DD>] [--description <md|->]`.
`--project` accepts name or UUID (same as `file --project`). `--target-date` optional.
`--description` optional markdown (same `--desc` / `-` stdin convention as `file`). Emits milestone UUID.

### CER-1687 — `project update` — update project state, name, description (P3, Feature, unassigned, 0d old)

**What:** `linearctl project update <ref> [--state <state>] [--name <name>] [--description <md|->]`.
`<ref>` accepts project name or UUID. `--state` sets project state (backlog, started, paused, completed, canceled).

### CER-1688 — `roadmap` — view or export a project roadmap (P4, Feature, unassigned, 0d old)

**What:** `linearctl roadmap --project <ref> [--json]`. Renders a milestone timeline: each milestone with target date,
progress (done/open), and issue list. Sorted by target date. `--json` for piping.

---
## Features

### CER-1550 — `feat(tui)`: full-screen keyboard-driven dashboard over `core/*` (P0, Feature, unassigned, M4, 9d old)

**What:** a terminal dashboard that renders the same `core/*` data the CLI
already fetches — triage queue, milestone burndown, recent digest, xref
drift — in one full-screen view, navigable with `j`/`k` and `Enter`.

**Why:** the **third mode** in the multi-modal architecture: headless
(current) → interactive prompts ([`interactive.md`](docs/features/interactive.md))
→ full-screen TUI. All three share the same `core/*` data layer; only the
rendering surface differs.

**Command:** `linearctl tui [--team CER] [--project ID] [--focus digest|triage|milestone|xref]`

**Status:** proposed → ticketed (CER-1550). Spec lives at
[`docs/features/tui.md`](docs/features/tui.md). Priority is currently unset
(P0 in Linear terms) — needs an estimate + a decision on whether it lands
before or after the agent-facility work.

**Landscape survey done:** [`docs/features/tui-cli-landscape/`](docs/features/tui-cli-landscape/)
covers the TS/JS, Rust, Go, and C/C++ TUI ecosystem options.

### CER-1188 — `feat(agent)`: `linearctl` maintainer-agent facility, phased (P4, ctodie, M4, 43d old)

**What:** turn the linearctl working session into a standing maintainer/PM
agent — handles improvements, receives tickets, plans sprints, runs grooming
passes, and the full role catalog. **Persistent role, not a persistent
process:** durable state in engram (handoff chain), ephemeral compute in
scheduled routines; any fresh agent rehydrates the role on wake.

**Decisions (operator, 2026-06-05):**
- **D1 Runtime:** hybrid — scheduled routines (cadence) + coord-mesh standby (dispatch).
- **D2 Autonomy:** autonomous-within-guardrails — auto-merge own green linearctl PRs + auto-file/groom; NEVER release, touch other repos/teams, or send externally without operator.
- **D3 Intake:** poll the linearctl Linear project (CER) + accept coord dispatch.
- **D4 Cadence:** groom daily · featuredev weekly · sprint biweekly.

**Roles:** maintainer/featuredev · reviewer · test-CI/docs stewards ·
intake-triage · sprint planner · grooming · roadmap · release-manager
(gated) · dependency/security · observability/error-insight · dogfood ·
knowledge.

**WIP plan:** `docs/agent-facility.md` (first pass, approved direction).
**Status:** phased — the OAuth scaffolding (CER-1148) and `watch` daemon
(CER-1149) are the M4 prerequisites.

### CER-1149 — `feat(agent)`: `linearctl watch` — AgentSessionEvent daemon (P4, ctodie, M4, 45d old)

**Scope:** created/prompted loop, 10s thought, activities.
**Source:** `docs/spec.md` §12 (T14). One of the three M4 agent-facility
prerequisites (alongside CER-1148 OAuth and CER-1188 itself).

### CER-1148 — `feat(agent)`: OAuth `actor=app` scaffolding (P4, ctodie, M4, 45d old)

**Scope:** app registration, scopes, token storage.
**Source:** `docs/spec.md` §12 (T13). The first M4 agent-facility prerequisite
— the maintainer-agent (CER-1188) needs an app actor to act as the
linearctl project bot rather than as `ctodie`'s user token.

---

## Release / Distribution

### CER-1150 — `chore(release)`: macOS notarization / codesign (P4, ctodie, M2, 45d old)

**Scope:** Gatekeeper quarantine fix for darwin assets.
**Source:** `docs/spec.md` §12 (T15).

**Why it's still open:** `linearctl` ships via `mise` today (the
`github-cerebral-work-linearctl` registry), and the macOS binary gets
quarantined by Gatekeeper because it's unsigned. The fix is a release
pipeline step that notarizes + codesigns the darwin asset. Low priority
because `mise install` + `xattr -d com.apple.quarantine` is a working
workaround, but every new macOS user hits it once.

---

## Cross-references

- **M4 (agent facility) dependency chain:** CER-1148 (OAuth) → CER-1149
  (`watch`) → CER-1188 (maintainer-agent). The TUI (CER-1550) is independent
  of this chain but competes for the same M4 slot.
- **M2 is "done" except for** CER-1150 — the only M2 ticket still in Backlog.
  It's a release-pipeline chore, not a feature gap.
- **Feature-proposal docs** all carry a status line (`shipped` / `ticketed` /
  `proposed`); none are bare `proposed` waiting for a ticket. The
  `tui.md` proposal was promoted to CER-1550.
- **Actionable now (4 tickets):** CER-1604 (bug), CER-1686 (`milestone create`),
  CER-1687 (`project update`), CER-1688 (`roadmap`). All unassigned headless CLI
  work with clear specs — implementing in priority order.
- **New tickets (CER-1686/87/88)** were filed 2026-07-22 while building the
  Blackwall project roadmap — the gaps surfaced from real use.
