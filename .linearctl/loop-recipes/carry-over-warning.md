---
name: carry-over-warning
version: 1
trigger:
  type: issue_updated
  conditions:
    cycle_ends_within: "2d"
    state_type: unstarted
    team: [CER, OPS, EST, RINA]
permissions:
  team_access: [CER, OPS, EST, RINA]
  code_intelligence: false
  coding_sessions: false
  web_access: false
  external_sources: []
  allow_changes_outside_triggering_issue: false
tools: []
audience: [engineering]
---

# Carry-over warning

When an issue in a cycle that ends within 2 days is still unstarted, post a
comment warning the assignee (or the team if unassigned) that the issue is
at risk of carrying over.

The comment should include:
- The cycle end date.
- The issue's current state (unstarted).
- A recommendation: start now, move to next cycle, or remove from scope.

Do NOT change the issue's state, cycle, assignee, or priority. The human
decides — this loop only surfaces the risk.

## Scope

Teams with cycles enabled (CER, OPS, EST, RINA). Only triggers on issues
that are in a cycle AND in an unstarted state AND the cycle ends within 2
days. One comment per issue per trigger — does not spam if already
commented.

## What this loop does NOT do

- Never changes fields or state.
- Never starts a coding session.
- Never re-comments if a carry-over warning already exists on the issue.
