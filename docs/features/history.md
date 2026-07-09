# Feature: `linearctl history` — issue activity timeline

**Status:** proposed
**Command:** `linearctl history <id> [--limit 20] [--json]`
**Roadmap:** net-new (not in §7)
**Milestone:** M3

## Motivation

`show` reads an issue's **current state** — metadata + description. But the
recurring need is the **timeline**: who changed what, when, and why. The audit
trail that answers:

- "Why is this in In Review? Who moved it and when?"
- "When did this get reassigned? Who assigned it?"
- "What did the description look like before it was edited?"

Today this means opening the Linear web app and scrolling the activity feed —
not scriptable, not pipeable. The gap: `show` gives you the snapshot, `history`
gives you the **diff over time**.

This also unblocks `comment`'s CI-provenance use case: after
`xref --fix --apply` closes a ticket, a follow-up `history <id>` can verify the
close landed and surface the actor.

## Proposal

```
linearctl history CER-42
linearctl history CER-42 --limit 50 --json
```

### Output (human table)

```
CER-42 · "Migrate voicenotes off pre-seed palette"

Time                 Actor          Event
2026-07-08 14:02     chris          created
2026-07-08 14:05     chris          labeled: user-story
2026-07-08 14:10     chris          state: Backlog → Todo
2026-07-09 09:30     chris          assigned: chris
2026-07-09 11:00     chris          priority: 0 → 2
2026-07-09 16:00     chris          comment: "blocked on upstream review"
2026-07-10 10:00     chris          state: Todo → In Review
2026-07-10 10:05     chris          description: edited (23 → 45 lines)
```

### Output (JSON)

```json
{
  "identifier": "CER-42",
  "title": "Migrate voicenotes off pre-seed palette",
  "events": [
    { "type": "create",       "actor": "chris", "at": "2026-07-08T14:02:00Z" },
    { "type": "label",        "actor": "chris", "at": "2026-07-08T14:05:00Z", "label": "user-story" },
    { "type": "stateChange",  "actor": "chris", "at": "2026-07-08T14:10:00Z", "from": "Backlog", "to": "Todo" },
    { "type": "assignment",   "actor": "chris", "at": "2026-07-09T09:30:00Z", "to": "chris" },
    { "type": "priority",     "actor": "chris", "at": "2026-07-09T11:00:00Z", "from": 0, "to": 2 },
    { "type": "comment",      "actor": "chris", "at": "2026-07-09T16:00:00Z", "body": "blocked on..." },
    { "type": "stateChange",  "actor": "chris", "at": "2026-07-10T10:00:00Z", "from": "Todo", "to": "In Review" },
    { "type": "description",  "actor": "chris", "at": "2026-07-10T10:05:00Z", "fromLines": 23, "toLines": 45 }
  ]
}
```

### Behavior

- `<id>` accepts UUID or identifier (same as `show`/`update`).
- Fetches the issue's activity timeline via Linear's `issue({ id }).activities()`
  connection (paginated, `--limit` caps it).
- Normalizes Linear's raw activity types into a clean event taxonomy:
  `create`, `stateChange`, `assignment`, `priority`, `label`, `comment`,
  `description`, `projectChange`, `cycleChange`, `estimate`.
- For comments: shows the comment body (or first N chars + `…` if long). Pairs
  with the [comment](./comment.md) command — `history` reads, `comment`
  writes.
- For description edits: shows line-count delta (not a full diff — Linear's
  API doesn't expose content diffs, only that it was edited).
- `--limit` (default 20) — cap on events returned.
- Read-only — no mutations, no `--apply`.

## API surface

- `issue({ id }).activities({ ... })` — the activity timeline connection.
  Returns activity nodes with `type`, `actor`, `createdAt`, and type-specific
  payloads (`fromState`/`toState` for state changes, `body` for comments, etc.).
- Comments also available via `issue.comments()` if the activities
  connection doesn't inline comment bodies.
- Actor resolution: `activity.actor` → `user.name`.

## Non-goals

- **No content diffs.** Linear's API exposes "description was edited" but not
  the before/after content. We show the edit event + line-count delta, not a
  text diff.
- **No filtering by event type.** The timeline is chronological; filtering is
  `jq`'s job (`history CER-42 --json | jq '.events[] | select(.type ==
  "stateChange")'`).
- **No replay/undo.** History is read-only audit; changing past events is
  not a Linear capability.

## Relationship to `show`

| | `show` | `history` |
|---|---|---|
| What | current snapshot | timeline of changes |
| Answers | "what is this issue now?" | "how did it get here?" |
| Output | metadata + description | chronological events |

`show` + `history` = the full read picture. `show` is the state; `history`
is the path to it.

## Verification

- `linearctl history CER-<known> --json` → events array matching the Linear
  web app's activity feed for that issue.
- State-change events show correct `from`/`to` values.
- Comment events show the comment body (or prefix).
- `--limit 5` caps at 5 events, most-recent first (or oldest first — match
  Linear's ordering; verify and document).
