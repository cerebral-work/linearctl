# Duplicate issues

`linearctl update <id> --duplicate-of <canonical>` creates a directed duplicate
relation from the source issue to the canonical issue and re-reads to verify it.
It does not explicitly change workflow state. Identifiers and UUIDs are accepted.

`linearctl close <id> --duplicate-of <canonical>` resolves the source team's
workflow state with type `duplicate`, creates/verifies the relation, then updates
only `stateId` and re-reads the issue to confirm the state. The state may have a
custom name. Plain `close <id>` continues to select a completed state.

```bash
linearctl update ENG-123 --duplicate-of ENG-100 --json
linearctl close ENG-123 --duplicate-of ENG-100 --json
```

Both return the normal issue summary plus `duplicateOf: {id, identifier}` in JSON.
A matching existing relation is reused (including later relation pages); a
conflicting target is refused with exit 6. Self-duplicates are usage errors (2).
Missing issues or duplicate workflow state fail with 4. API auth/rate-limit errors
use the shared 3/5 contract. A reported successful write whose relation or state
cannot be confirmed fails with 6 instead of returning success.

The relation and state updates are separate mutations. Failure can leave the
relation in place; no automatic rollback is attempted. Inspect the issue before
retrying. The canonical issue is never updated. Combining `update --duplicate-of`
with other single-issue flags creates the relation first, then applies those
fields; a later field failure may leave the relation. This ordering permits
`update ENG-123 --duplicate-of ENG-100 --state Duplicate`.

`--duplicate-of` is not a bulk-plan field and cannot be combined with `--stdin`.
Like other fully specified single-issue updates, these commands write immediately;
there is no implicit preview or `--apply` requirement. Use the explicit command
only after selecting the intended canonical issue.

When Linear returns "Missing duplicate relation" for a state-only update,
linearctl reports usage 2 with a hint pointing to `close --duplicate-of` or
`update --duplicate-of`.
