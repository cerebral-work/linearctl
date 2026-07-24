---
name: project-update-synthesizer
version: 1
trigger:
  type: schedule
  cron: "0 16 * * 5"
  timezone: America/New_York
permissions:
  team_access: [CER, OPS, TOD, EST, RINA, USE, RD, BIZ, SEC, BRAND]
  code_intelligence: false
  coding_sessions: false
  web_access: false
  external_sources: []
  allow_changes_outside_triggering_issue: true
tools:
  - github
audience: [engineering, operations]
---

# Project update synthesizer

Every Friday at 16:00 ET, review all started projects. For each project
that had activity this week (issues moved, comments posted, PRs merged):

1. Summarize what was accomplished (2-3 bullet points from completed issues).
2. List what's in progress (started issues, blocked issues).
3. Flag risks (issues at-risk, milestones slipping, stale started issues).
4. Post this summary as a draft Project Update.

Do NOT publish the update — leave it as a draft for the project lead to
review and publish on Monday. Do NOT change issue states or assignments.

## What this loop does

1. Queries started projects (status = started).
2. For each, queries issues completed/started/blocked this week.
3. Synthesizes a 4-section update using the issue data.
4. Creates a Project Update (draft) with the summary.

## What this loop does NOT do

- Never publishes updates (draft only).
- Never changes issue state, assignee, or priority.
- Never starts a coding session.
- Does NOT consume AI credits for code analysis (code_intelligence: false).
