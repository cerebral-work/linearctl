---
name: release-notes-attach
version: 1
last_verified: "2026-07-24"  # against Linear Loops UI; bump when re-verified
trigger:
  type: issue_updated
  conditions:
    milestone_state: completed
    team: [CER, OPS, EST, RINA, USE, RD, BIZ, SEC, BRAND, TOD]
permissions:
  team_access: [CER, OPS, EST, RINA, USE, RD, BIZ, SEC, BRAND, TOD]
  code_intelligence: false
  coding_sessions: false
  web_access: false
  external_sources: []
  allow_changes_outside_triggering_issue: true
tools:
  - github
audience: [engineering, operations]
---

# Release notes attach

When a project milestone transitions to `completed`, gather all issues that
were in that milestone and assemble them into release notes grouped by
label. Then:

1. Query all issues in the completed milestone (any state — completed,
   canceled, duplicate).
2. Group by label: `feat`, `fix`, `chore`, `docs`, `ci`, `refactor`, or
   `other` for unlabeled.
3. Render Markdown release notes:
   ```
   ## What's new (feat)
   - CER-123: title
   - OPS-456: title

   ## Fixes (fix)
   - EST-78: title

   ## Other
   - CER-90: title
   ```
4. Post the notes as a comment on the first issue in the milestone.
5. If the project has a GitHub release, attach the notes to the release body
   via the GitHub tool (append, do not replace existing content).

## What this loop does

- Reads milestone issues + their labels.
- Groups + renders Markdown release notes.
- Comments on an issue + optionally appends to a GitHub release.

## What this loop does NOT do

- Never changes issue state, assignee, or priority.
- Never creates or deletes issues.
- Never replaces existing GitHub release notes — appends only.
- Never starts a coding session.
