# soma funnel contract — linearctl ↔ WorkSource operator

**Status:** contract (this doc is the spec the Rust soma-operator implements
against). Lives at `docs/funnel-contract.md` in `cerebral-work/linearctl`;
the operator repo (`unsigned-gg/soma`) consumes it.
**Linear:** last verified against `@linear/sdk` v86 on 2026-07-24.

The **soma-operator** runs a WorkSource reconcile loop in-cluster that pulls
actionable Linear tickets and controls them (transition + comment) as an
ingestion funnel into the soma dispatch chain. The operator may implement the
Linear reads/writes **either** by shelling out to `linearctl` (simplest;
binary already shipped) **or** by issuing Linear GraphQL directly against the
same queries + mutations documented below (lowest latency, no child
process). Either path satisfies the contract; this doc is the source of truth
for both.

---

## 1. HEADLESS PULL — `linearctl pull`

Emit JSON: one object per issue. Machine-consumable, no ANSI, stable field
names. Filtered by `--team`, `--state`, `--label` (plus the secondary
`--assignee` / `--project` / `--priority` / `--text` / `--updated-since` /
`--created-since` filters inherited from `search`).

### Invocation

```bash
# The soma-operator's exact funnel query, reproducible from the CLI:
linearctl pull \
  --team EST \
  --state-set Todo \
  --state-set Backlog \
  --label soma-ingest
```

| Filter | Format | Default | Notes |
|---|---|---|---|
| `--team <key...>` | team key (repeatable); `all` = every team | every accessible team | server-side |
| `--state <ref>` | type alias (`triage\|backlog\|todo\|started\|done\|canceled\|all`) or a state **name** (e.g. `In Progress`) | **active only** (`completed` + `canceled` excluded) | `all` lifts the default |
| `--state-set <ref>` | state name or type (repeatable; OR logic) | inherits `--state` default | e.g. `--state-set Todo --state-set Backlog`; takes precedence over `--state` |
| `--label <name...>` | label name (repeatable) | none | all must match (AND) |
| `--assignee <who>` | `me` / `none` / email / display name / user id | none | `none` = unassigned |
| `--project <ref>` | project UUID or name | none | server-side |
| `--priority <0-4\|none>` | exact priority | none | 1=Urgent 2=High 3=Medium 4=Low 0/none=unset |
| `--text <query>` | substring over title + description | none | server-side containsIgnoreCase |
| `--updated-since <window>` | lookback (`7d`, `24h`, `2w`) | none | server-side `updatedAt: { gte }` |
| `--created-since <window>` | lookback | none | server-side `createdAt: { gte }` |
| `--limit <n>` | integer | exhaustive | stop after collecting this many issues (bounded smoke loops) |
| `--json` | flag | n/a | always JSON; accepted for consistency |

Output is **JSON to stdout only** (no human-table path — use `search` for
that). Logs/errors go to stderr. Exit `0` on success (including zero-result),
`1` on error, `2` if the API rate limit is exhausted (see §4).

### JSON schema — `PullIssue`

```json
[
  {
    "id": "7b638a93-cc26-48e0-b6cf-98e890165809",
    "identifier": "EST-83",
    "title": "soma smoke-test payload",
    "state": "Todo",
    "stateType": "unstarted",
    "priority": 3,
    "labels": ["soma-ingest"],
    "description": "Full markdown body of the issue…",
    "url": "https://linear.app/cerebral-work/issue/EST-83/soma-smoke-test-payload",
    "updatedAt": "2026-07-24T16:52:01.638Z"
  }
]
```

| Field | Type | Notes |
|---|---|---|
| `id` | string | Linear issue UUID — pass to `issueUpdate`/`commentCreate` mutations |
| `identifier` | string | human ref (`TEAM-N`); stable; use as the `<id>` for CONTROL commands |
| `title` | string | |
| `state` | string | workflow-state **name** (e.g. `In Progress`); pass back to `update --state` |
| `stateType` | string | enum: `triage\|backlog\|unstarted\|started\|completed\|canceled\|duplicate`; the category of `state` |
| `priority` | number | 0=unset 1=Urgent 2=High 3=Medium 4=Low |
| `labels` | string[] | sorted label names; empty array `[]` (never `null`) |
| `description` | string | full markdown body; empty string `""` if absent (never `null`) |
| `url` | string | canonical Linear URL |
| `updatedAt` | string | ISO-8601 UTC timestamp — **load-bearing**: consumers key idempotency on this field. See invariant below. |

**Stability guarantees:** field names are stable and will not rename without a
major-version bump. New fields may be added (the operator MUST ignore unknown
fields). `labels` and `description` are always present and non-null.

> **INVARIANT — `updatedAt` is load-bearing for idempotency.**
>
> Consumers (including soma's `Payload::Ticket`, EST-80) hash `title` +
> `description` and key idempotency on `updatedAt`. If the semantics of
> `updatedAt` ever change, consumers' dedup breaks silently. This field is
> selected in every `pull` query, emitted on every issue, and will not be
> removed or renamed without a major-version bump. If `updatedAt` semantics
> change in the Linear API, that is a breaking contract change and consumers
> MUST be notified before upgrade.

### Equivalent Linear GraphQL (for the direct-implementation path)

```graphql
query PullIssues($filter: IssueFilter, $orderBy: PaginationOrderBy, $first: Int!, $after: String) {
  issues(filter: $filter, orderBy: $orderBy, first: $first, after: $after) {
    nodes {
      id identifier title url priority description updatedAt
      state { name type }
      labels { nodes { name } }
    }
    pageInfo { hasNextPage endCursor }
  }
}
```

Paginate until `pageInfo.hasNextPage == false`. Dedupe by `id` (under
`orderBy: updatedAt`, a row whose `updatedAt` changes mid-scan can reappear
across page boundaries). Variables: `orderBy: updatedAt`, `first: 100`.

The filter is built from the flags above (see
`src/core/search.ts#buildSearchFilter` for the exact `IssueFilter` composition):
team keys → `team.key.in`; state alias → `state.type.eq`; state name →
`state.name.eqIgnoreCase`; labels → `labels.some.name.eqIgnoreCase` (AND);
default (no `--state`) → `state.type.nin [completed, canceled]`; `--state all`
→ no state filter.

---

## 2. HEADLESS CONTROL — transition + comment

Both commands are **non-interactive** when given flags: no prompts, no TTY
dependency, safe to call from the operator's Rust reconcile loop. Both accept a
UUID or a human identifier (`CER-123`) as `<id>`. Both exit `0` on success and
non-zero (`1`) on failure.

### 2.1 Transition — `linearctl update <id> --state <name>`

```bash
linearctl update CER-123 --state "In Progress" --json
```

Transitions the issue to the named workflow state, resolved against the
issue's **own team** (case-insensitive name match). The state name comes from
`PullIssue.state` (or the team's workflow states).

**Output (JSON):**

```json
{
  "id": "7b638a93-cc26-48e0-b6cf-98e890165809",
  "identifier": "CER-123",
  "title": "Fix the flux capacitor",
  "url": "https://linear.app/cerebral.work/issue/CER-123",
  "state": "In Progress",
  "assignee": "ctodie"
}
```

**Error → exit code:**
- `1` — issue not found, state name not found on the team, or Linear reports
  the mutation did not succeed. The error message lists the team's available
  state names when the state isn't found.
- `2` — (only from `ratelimit`; `update` does not gate, but the operator
  SHOULD check §4 before a batch).

The operator may also set other fields in the same call (`--assignee`,
`--priority`, `--label`, `--project`, `--milestone`, `--cycle`, `--parent`,
`--title`, `--desc`, `--blocked-by`, `--related-to`); only `--state` is in the
funnel contract. See `linearctl update --help` for the full surface.

**Equivalent Linear GraphQL:**

```graphql
mutation UpdateIssue($input: IssueUpdateInput!) {
  issueUpdate(id: "<issue-uuid>", input: $input) {
    success
    issue { identifier title url state { name } assignee { displayName } }
  }
}
```

Resolve the **state name → `stateId`** first via the team's workflow states:
`workflowStates(filter: { team: { id: { eq: "<team-uuid>" } } })` → match by
name (case-insensitive). Pass `stateId` in `IssueUpdateInput`.

> **INVARIANT — description never round-trips on a state-only transition.**
>
> A known Linear bug (documented in `~/todo.md` against SEC tickets; reproduced
> 2026-07-24 with EST-83) wipes ticket descriptions to `# bulk-file-spec: skip`
> when certain automations append on a state change. The funnel contract
> **REQUIRES** that `linearctl update <id> --state <name>` sends **only**
> `{ stateId }` in the `issueUpdate` input — never `description`, `title`, or
> any other field. The implementation builds the mutation input from only the
> fields explicitly passed (`params.description` is `undefined` when `--state`
> is given alone, so `description` is absent from the input object). This is
> tested in `test/funnel-parity.test.ts` — "state-only update sends ONLY
> stateId, no other field leaks" — and verified live against EST-83 (22-char
> description preserved before and after a no-op `--state Done`).
>
> The Rust operator's direct-GraphQL path MUST replicate this: send
> `issueUpdate(input: { stateId: "..." })` with no other keys. Do NOT
> read-then-write the description back — that is exactly the pattern that
> triggers the clobber.

### 2.2 Comment — `linearctl comment <id> --body <markdown>`

```bash
linearctl comment CER-123 --body "soma operator: dispatched to worker X" --json
```

Adds a comment to the issue. `--body -` reads markdown from stdin (needed when
the body is long or contains shell-unsafe characters). The comment is
non-destructive (additive), so there is no `--apply` dry-run gate.

**Output (JSON):**

```json
{
  "identifier": "CER-123",
  "commentId": "comment_abc123",
  "url": "https://linear.app/cerebral-work/issue/CER-123"
}
```

**Error → exit code:**
- `1` — issue not found, empty body, or Linear rejects the mutation.

**Equivalent Linear GraphQL:**

```graphql
mutation CreateComment($input: CommentCreateInput!) {
  commentCreate(input: $input) { success comment { id url } }
}
```

`CommentCreateInput.issueId` takes the **issue UUID** (resolve the identifier
`CER-123` → UUID via a `issue(id: …)` lookup or by including `id` in the
`pull` query above). `body` is the markdown string.

> **Note:** the `url` field in the CLI output is the **issue URL** (where the
> comment lives), not a comment-specific URL. A comment-specific deep link is
> not exposed by the `createComment` mutation; the issue URL anchors the
> comment in context.

---

## 3. Auth, invocation shape, and rate limits

### Authentication

Both `pull` and the CONTROL commands read a Linear **personal API key** from
`LINEAR_API_KEY` (env only; never stored, logged, or printed). The operator
injects it per-process invocation — render from OpenBao into the env, or wrap
the binary with `op run` for CLI use.

### Rate-limit posture

| Limiter | Whose | What linearctl does |
|---|---|---|
| Linear API complexity / `RATELIMITED` | Linear's | Still applies. The operator SHOULD probe headroom before a batch via `linearctl ratelimit` (exit `2` when exhausted) and back off on `RATELIMITED`. |

```bash
# before a reconcile batch:
linearctl ratelimit --json  # exit 2 if exhausted → defer the run
```

### Non-goals (operator does these, not linearctl)

- The operator owns the reconcile loop cadence, dedup of already-dispatched
  issues, and the dispatch chain downstream of `comment`. `linearctl` is the
  Linear read/write surface only.
- `linearctl` never auto-runs; the operator invokes it (or hits GraphQL
  directly). No daemon, no cron inside the funnel contract.

---

## 4. Verification (operator acceptance)

| Check | Command | Pass |
|---|---|---|
| PULL emits all 9 fields, stable names | `linearctl pull --team CER --state all --json` | `jq 'keys'` shows exactly the schema fields |
| PULL filters by team + label | `linearctl pull --team CER --label bug --json` | every result has `"Bug"` in `labels` |
| PULL filters by state type | `linearctl pull --team CER --state started --json` | every result has `"stateType": "started"` |
| TRANSITION succeeds + exits 0 | `linearctl update <id> --state "<current state>" --json` | exits 0, returns `{identifier, state}` |
| TRANSITION fails + exits non-zero | `linearctl update INVALID-999 --state "X"` | exit `1`, stderr message |
| COMMENT fails + exits non-zero | `linearctl comment INVALID-999 --body "x"` | exit `1`, stderr message |
| No ANSI in piped JSON | `linearctl pull --team CER --json \| cat -v` | no `^[` sequences |
| Rate-limit probe | `linearctl ratelimit --json` | returns remaining/reset; exit `2` when exhausted |
