# Linear Loop recipes

Versioned prompt recipes for [Linear Loops](https://linear.app/docs/loops)
— the recurring AI-driven workflows launched 2026-07-20. Loops have no
public API yet; these recipes are the **design authority** the operator
pastes into Linear's "Create loop" UI. When Linear ships a Loops API, the
same recipes migrate to programmatic CRUD.

## File format

Each recipe is a markdown file with YAML frontmatter:

```yaml
---
name: bug-triage-dispatcher       # stable identifier
version: 1                         # bump on prompt/trigger/permission change
last_verified: "2026-07-24"           # date last checked against Linear's UI; staleness signal
trigger:
  type: issue_created_or_updated   # or "schedule" with cron
  conditions:                       # team, state, label, cycle_ends_within
    state: triage
    team: [CER, OPS]
permissions:
  team_access: [CER, OPS]           # least privilege — only the teams needed
  code_intelligence: true/false     # browse the repo? costs AI credits
  coding_sessions: true/false       # start PRs? high autonomy
  web_access: true/false             # query external sites? data egress risk
  external_sources: []              # slack/email/etc trigger sources
  allow_changes_outside_triggering_issue: true/false
tools: [github]                      # connected tools the loop may use
audience: [engineering]              # who sees the output
---

# Recipe title (human-readable)

Instructions for Linear Agent in plain English. Describe the outcome, not
the mechanism. State what the loop should NOT do (negative constraints).
```

## Catalog

| Recipe | Trigger | Scope | Purpose |
|---|---|---|---|
| `bug-triage-dispatcher` | issue → Triage | CER, OPS | investigate root cause, comment recommendation, never auto-fix |
| `triage-debt-weekly-sweep` | Mon 09:00 ET | workspace | comment on top-10 oldest unassigned/unestimated issues |
| `project-update-synthesizer` | Fri 16:00 ET | workspace | draft weekly Project Updates for started projects (draft, not publish) |
| `carry-over-warning` | issue updated, cycle ends <2d, unstarted | CER, OPS, EST, RINA | warn assignee the issue is at risk of carrying over |
| `plan-doc-drift-detector` | Mon 10:00 ET | OPS | diff roadmap-*.md ↔ Linear project overview, comment on drift |

## Authoring guidelines

- **Describe the outcome, not only the action.** "Summarize the root cause
  and recommend the next action" is better than "read the issue and comment."
- **State what the loop should NOT do.** Negative constraints are how you
  bound autonomy: "Do NOT change the issue's assignee, state, or priority."
- **Least-privilege permissions.** Enable only the permissions the loop needs.
  Web access and coding sessions are high-autonomy — enable deliberately.
- **One recipe per file.** `name` + `version` are the identity. Bump version
  when the trigger, instructions, or permissions change.
- **`last_verified` is a staleness signal, not a guarantee.** Loops have no API, so
  no conformance test can detect drift between a recipe and Linear's actual UI
  behavior. The `last_verified` date makes that drift visible instead of silent.
  Re-verify against the UI periodically and bump the date. Unlike the funnel
  contract (which has two implementations and a conformance test), a recipe
  catalog has no counterpart to diverge from — its failure mode is staleness
  against Linear's UI, not implementation drift.
- **Scope to teams, not "all".** A workspace-wide loop is powerful and
  expensive — scope it to the teams that need it.

## Relationship to `linearctl` and the orchestra

These recipes are the "manages Linear Loops" half of the
[orchestra design](../docs/features/orchestra.md) — the loop catalog the
opera maintains as design authority. The opera's own cron + sinks handle
the outward publish channels Loops can't reach (website, email, mailing
list, Attio, Grafana, audio). When Linear ships a Loops API, `linearctl
loops apply` will become a CRUD wrapper over the same recipes.

## Non-goals

- **No `dispatch` command.** The reflex POST contract is operator-owned
  (soma lane, EST-89). linearctl does not grow a reflex client.
- **No runtime dependency.** Per the soma-operator decision (2026-07-24),
  linearctl stays a dev/CI tool. The conformance test uses `linearctl pull`
  full-unbounded to compare against the Rust operator's GraphQL, but the
  operator does not shell out to linearctl per-poll.
