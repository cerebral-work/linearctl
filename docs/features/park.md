# Feature: `linearctl park` — file user stories into Backlog

**Status:** ticketed — [CER-1557](https://linear.app/cerebral-work/issue/CER-1557)
**Command:** `linearctl park <title> --team CER [--project ID] [--persona <name>] [--accept <md|->] [--json]`
**Roadmap:** net-new (not in §7)
**Milestone:** M3

## Motivation

The recurring pattern: an idea or user story surfaces mid-session and needs a
home **now** — written down, parked somewhere it won't get lost, but not
committed to a cycle or triaged. Today this means:

1. Open Linear, click "New issue", type the title, set status to Backlog manually.
2. Or use `linearctl file` — but `file` creates in the team's default state
   (usually Triage or Todo), so you have to follow up with `linearctl update
   <id> --state Backlog`.

`file` is optimized for "create an issue to work on now". Parking is a
different intent: **collect, don't commit**. The friction gap is small but it's
the kind of thing that gets skipped ("I'll file it later") and then lost.

## Proposal

`linearctl park` creates an issue **directly in Backlog**, with an optional
user-story scaffold and a `user-story` label.

```
linearctl park "Guided tour for new users" \
  --team CER \
  --project "design: cerebral" \
  --persona "new visitor" \
  --accept "Given a first-time visit, when the user lands, then a 3-step tour appears"
```

### Behavior

- Creates the issue with `state: Backlog` (the team's `backlog`-type workflow
  state — resolved the same way `triage` resolves the Triage state).
- `--persona` + `--accept` build the description in the user-story format:

  ```markdown
  As a new visitor,
  I want a guided tour,
  so that I understand what Cerebral offers.

  ## Acceptance criteria
  - Given a first-time visit, when the user lands, then a 3-step tour appears
  ```

  If neither `--persona` nor `--accept` is passed, the title is the full
  description (plain `file` behavior, just parked).
- `--accept -` reads criteria from stdin (one bullet per line).
- Attaches a `user-story` label (auto-created on the team if missing — same
  resolution logic as `file`'s `--label`, but with create-on-miss).
- `--json` emits `{ identifier, url, state, label }`.

### Relationship to `file`

`park` is `file` + a pre-set Backlog state + an optional scaffold. It is **not**
a new filing engine — it calls the same `core/issues` create path with a
resolved `stateId` and the scaffolded description. The differences:

| | `file` | `park` |
|---|---|---|
| Default state | team default (Triage/Todo) | **Backlog** |
| Description | `--desc` or title | scaffold from `--persona`/`--accept` or title |
| Label | `--label` (must exist) | `user-story` (auto-create) |

## API surface

Linear's `issueCreate` accepts a `stateId` — already used by `update --state`.
No new mutation needed; this is a command-layer convenience over the existing
`createIssue` path.

The only new capability is **label auto-create**: `file`'s `pickLabelIds`
errors on unmatched labels (by design — fail loud). `park` adds an
`--auto-label` resolution that creates the `user-story` label if missing
(`createLabel` mutation) and optionally turns it on for any `--label` it's
given. This is a `lib/labels` change, not a new module.

## Non-goals

- Not a full story-mapping tool — no epic/theme hierarchy beyond what Linear
  Projects already provide.
- No estimation — parked stories are unestimated by definition.
- No prioritization — parking is unordered; priority is set when a story is
  pulled into a cycle.

## Alternatives considered

- **Just use `file` + `update --state Backlog`.** Works, but it's two commands
  for one intent, and the user-story scaffold is manual. `park` makes the
  intent explicit and the scaffold automatic.
- **Add `--backlog` to `file`.** Rejected — `file`'s default state is a
  feature (issues are actionable immediately); making it overridable muddies
  the contract. A separate verb keeps each intent clean.

## Verification

- `linearctl park "test story" --team CER --json` → issue in Backlog state with
  `user-story` label, returns `{ identifier, url, state: "Backlog" }`.
- `linearctl park "with scaffold" --team CER --persona "x" --accept - <<<'criterion'`
  → description contains the "As a x, I want..., so that..." scaffold + the
  criterion under `## Acceptance criteria`.
- `linearctl whoami` still works (no regression in shared client path).
