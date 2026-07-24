---
name: plan-doc-drift-detector
version: 1
last_verified: "2026-07-24"  # against Linear Loops UI; bump when re-verified
trigger:
  type: schedule
  cron: "0 10 * * 1"
  timezone: America/New_York
permissions:
  team_access: [OPS]
  code_intelligence: false
  coding_sessions: false
  web_access: false
  external_sources: []
  allow_changes_outside_triggering_issue: true
tools:
  - github
audience: [operations]
---

# Plan-doc drift detector

Per the unsigned-paas house rule, plan docs (roadmap-*.md) mirror to the
Linear project overview (`Project.content`). Every Monday at 10:00 ET,
compare the two for each OPS project that has both a roadmap-*.md file and
a Linear project overview:

1. Fetch the project's Linear overview document (markdown).
2. Fetch the matching roadmap-*.md from the GitHub repo.
3. Diff the two (structural — headings, key milestones, scope statements).
4. If they diverge, post a comment on the project's first issue noting the
   drift and which side appears more current.

Do NOT update either document — the human decides which is the source of
truth and syncs manually. Do NOT change issue states or assignments.

## What this loop does

- Reads Linear project overview docs (via the doc API).
- Reads GitHub repo files (via the GitHub tool).
- Diffs them structurally (not byte-for-byte — ignores whitespace, ordering
  of bullet points, and timestamp headers).
- Comments on drift with a summary of what changed.

## What this loop does NOT do

- Never writes to either document.
- Never changes issue state, assignee, or priority.
- Never starts a coding session.
