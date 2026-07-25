---
name: cross-platform-handoff-design
version: 1
last_verified: "2026-07-24"  # against Linear Loops UI; bump when re-verified
trigger:
  type: issue_created
  conditions:
    label: design-system
    team: [RD, USE]
permissions:
  team_access: [RD, USE, CER]
  code_intelligence: false
  coding_sessions: false
  web_access: false
  external_sources: []
  allow_changes_outside_triggering_issue: true
tools: []
audience: [engineering, design]
---

# Cross-platform handoff (design system)

When a new issue is created with the `design-system` label in team RD or
USE, determine whether the request requires parallel work on multiple
platforms (web, iOS, Android, desktop). If it does:

1. Analyze the issue's title, description, and labels for platform hints.
2. Identify which platforms are affected (at least web is always included
   for cerebral/unsigned-gg surfaces).
3. Create sub-issues in the appropriate teams:
   - Web → RD (if frontend) or CER (if backend/API)
   - Design → USE
4. Label each sub-issue with the platform + `design-system` label.
5. Link all sub-issues as children of the original issue.
6. Comment on the original issue with a summary of the created sub-issues.

## What this loop does

- Reads the incoming design-system issue for platform signals.
- Creates 1-N sub-issues scoped to the right teams.
- Wires parent-child relationships.
- Comments with a summary.

## What this loop does NOT do

- Never changes the original issue's state, assignee, or priority.
- Never starts a coding session.
- If only one platform is needed, does NOT create sub-issues — comments
  "no cross-platform handoff needed" and stops.
- Does NOT delete or archive any issue.
