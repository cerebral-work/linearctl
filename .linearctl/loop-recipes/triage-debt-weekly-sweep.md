---
name: triage-debt-weekly-sweep
version: 1
trigger:
  type: schedule
  cron: "0 9 * * 1"
  timezone: America/New_York
permissions:
  team_access: [CER, OPS, TOD, EST, RINA, USE, RD, BIZ, SEC, BRAND]
  code_intelligence: false
  coding_sessions: false
  web_access: false
  external_sources: []
  allow_changes_outside_triggering_issue: true
tools: []
audience: [engineering]
---

# Triage debt weekly sweep

Every Monday at 09:00 ET, scan the workspace for issues needing triage
(Triage state, or unassigned / unestimated / no-priority in active states).
For each of the top 10 oldest, post a comment with:

- Age (days since creation)
- Why it surfaced (missing assignee, estimate, priority, or in Triage)
- Recommendation (assign, estimate, close as stale, or escalate)

Do NOT change the issue's fields. Comment-only — the human decides what to
do with the recommendation.

## Scope

Workspace-wide (all teams). The loop may write comments on any team's
issues, which is why `allow_changes_outside_triggering_issue: true` is set.

## What this loop does NOT do

- Never changes state, assignee, priority, or labels.
- Never starts a coding session.
- Never posts to external services.
- Does NOT process issues created from external sources (Slack, email).
