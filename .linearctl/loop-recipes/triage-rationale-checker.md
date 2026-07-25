---
name: triage-rationale-checker
version: 1
last_verified: "2026-07-24"  # against Linear Loops UI; bump when re-verified
trigger:
  type: issue_updated
  conditions:
    state_changed_from: triage
    team: [CER, OPS, TOD, EST, RINA, USE, RD, BIZ, SEC, BRAND]
permissions:
  team_access: [CER, OPS, TOD, EST, RINA, USE, RD, BIZ, SEC, BRAND]
  code_intelligence: false
  coding_sessions: false
  web_access: false
  external_sources: []
  allow_changes_outside_triggering_issue: false
tools: []
audience: [engineering]
---

# Triage rationale checker

When an issue is moved OUT of the Triage state, check whether it has:

1. An assignee (not unassigned).
2. An estimate (not zero / not unset).
3. A priority (not 0 / not unset).
4. At least one label.

If ANY of these are missing, post a comment:

  ℹ️ This issue left Triage without:
  - [ ] Assignee
  - [ ] Estimate
  - [ ] Priority
  - [ ] Label

  Consider filling these in for better tracking and road-mapping.

If ALL four are present, do nothing — the triage was thorough.

## What this loop does

- Detects state transitions OUT of Triage.
- Checks for the four triage-quality fields (assignee, estimate, priority,
  labels).
- Comments a checklist only when fields are missing.

## What this loop does NOT do

- Never blocks or reverts the state transition.
- Never changes assignee, estimate, priority, or labels.
- Never comments on fully-triaged issues.
- Never starts a coding session.
- Does NOT run on issues created from external sources (Slack, email).
