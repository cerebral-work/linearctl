# Feature: `linearctl comment` — add comments headless

**Status:** in-progress — [CER-1345](https://linear.app/cerebral-work/issue/CER-1345), PR #33
**Command:** `linearctl comment <id> [--body <md|->] [--json]`
**Roadmap:** net-new (not in §7)
**Milestone:** M3

## Motivation

`file` creates issues, `update`/`close` mutates their state, `show` reads them
— but there is **no way to add a comment** headless. The gap shows up in two
recurring patterns:

1. **Batch annotation** — a triage sweep surfaces issues that need a nudge
   ("this has been In Review for 5 days — merge or close"). Today you read the
   `triage` output, then manually comment in the web app, one by one.
2. **CI provenance** — when `xref --fix --apply` closes a ticket from a merged
   PR, it should leave a breadcrumb comment ("Closed via PR #42 — body said
   'Closes CER-7'"). Right now the close is silent; the audit trail lives only
   in the PR body and the Linear activity log.

`createComment` is a first-class Linear mutation (`createComment({ issueId,
body })`); it's just not wired to a command.

## Proposal

```
linearctl comment CER-42 --body "Closing per PR #42 — Closes CER-42"
linearctl comment CER-42 --body - <<<'status: blocked on upstream review'
linearctl triage --team CER --json | jq -r '.[] | select(.reasons[] | contains("in-review")) | .identifier' | \
  while read id; do linearctl comment "$id" --body "nudge: in review > 5d"; done
```

### Behavior

- `<id>` accepts a UUID **or** an identifier (`CER-123`), same as `update`/`show`.
- `--body` is required; `--body -` reads markdown from stdin (same pattern as
  `file --desc -`).
- `--json` emits `{ identifier, commentId, url }`.
- No `--apply` gate needed — a comment is non-destructive (additive), so the
  safe-by-default posture is satisfied without a dry-run flag. Contrast with
  `stale --label` (mutates) and `xref --fix` (mutates state), which require it.

### MCP tool

Add a `comment_issue` MCP tool (write, non-destructive) to `mcp serve` — the
natural complement to `issue_update`/`issue_close`. Annotation: not
`readOnlyHint`, not `destructiveHint` (matches plugin-spec D6 — no
delete/archive).

## API surface

Single mutation: `createComment({ issueId, body })`. The issue ID is resolved
from the identifier in `core/issues` (already used by `update`/`close`/`show`).

## Non-goals

- No comment editing or deletion (D6 — no destructive ops).
- No @-mention resolution — the body is raw markdown; Linear renders mentions
  if the username is already in the text.
- No threading — Linear comments are flat at the API level.

## Alternatives considered

- **Fold into `update`.** Rejected — `update` mutates issue *fields* (state,
  labels, assignee). Comments are a separate entity; conflating them muddies
  the contract and the `--json` shape.
- **Only via `xref --fix`.** Too narrow — the CI-provenance use case is one
  application; a general `comment` command serves the nudge/annotate pattern
  and any future automation that wants to leave a breadcrumb.

## Verification

- `linearctl comment CER-<existing> --body "test" --json` → `{ commentId, url }`,
  comment visible in the Linear web UI.
- `linearctl comment CER-<existing> --body -` reading from stdin → same.
- `linearctl show CER-<that-issue>` (once it surfaces comments — see
  [history](./history.md)) shows the new comment.
- MCP: `comment_issue` tool returns the same shape via `mcp serve`.
