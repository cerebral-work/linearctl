# Feature: `linearctl cycle` — current-cycle review

**Status:** proposed (expands roadmap T8)
**Command:** `linearctl cycle [--team CER] [--cycle active|<id>] [--json]`
**Roadmap:** §7 item 1 (T8)
**Milestone:** M3

## Motivation

The roadmap (§7.1) already calls this out: *"current-cycle review: scope,
completed, carry-over, scope-change."* The need is concrete and recurring —
before a cycle ends you want:

- **What's in scope** — the issues assigned to the current cycle.
- **What's done** — completed issues in the cycle (burn-down).
- **What's at risk** — started-but-unfinished, and unstarted issues with <2
  days left.
- **Carry-over** — issues from the *previous* cycle that didn't finish (the
  rot detector's cycle-flavored cousin).
- **Scope-change** — issues added to or removed from the cycle mid-flight
  (via `cycleHistory` / activity events).

`milestone` covers milestone burn-down; `cycle` covers the **time-boxed
iteration** — a different Linear entity. Cycles are where teams actually plan;
milestones are longer-horizon groupings.

## Proposal

```
linearctl cycle                       # current cycle, all teams
linearctl cycle --team CER            # CER's current cycle
linearctl cycle --team CER --cycle active   # explicit (default)
linearctl cycle --team CER --cycle <uuid>   # a specific cycle
linearctl cycle --team CER --previous      # last cycle (carry-over view)
```

### Output (human table)

```
CER · Cycle 12 (Jul 7 – Jul 14) · 3 days remaining

Scope   12 issues · 34 pts
Done     5 issues · 14 pts   ████████░░░░  41%
In prog  3 issues ·  9 pts   ████░░░░░░░░  
At risk  2 issues (unstarted, <2d left)
Carry- 4 issues from Cycle 11 (2 done this cycle, 2 still open)
over

Unstarted (4): CER-101, CER-103, CER-110, CER-115
At-risk  (2): CER-110, CER-115
```

### Output (JSON)

```json
{
  "team": "CER",
  "cycle": { "id": "...", "number": 12, "startsAt": "...", "endsAt": "..." },
  "daysRemaining": 3,
  "scope":   { "issues": 12, "points": 34 },
  "done":    { "issues": 5,  "points": 14 },
  "inProgress": { "issues": 3, "points": 9 },
  "atRisk":  [{ "identifier": "CER-110", "reason": "unstarted, 1d left" }],
  "carryOver": {
    "fromCycle": 11,
    "issues": 4,
    "doneThisCycle": 2,
    "stillOpen": ["CER-95", "CER-98"]
  }
}
```

### Behavior

- `--cycle active` (default) resolves the team's current cycle (the one whose
  `startsAt ≤ now < endsAt`). `--cycle <id>` takes a UUID. `--previous`
  resolves the most recently ended cycle.
- Scope = issues with `cycleId == cycle.id`. Done = subset with
  `state.type == completed`. At-risk = unstarted issues with
  `cycle.endsAt - now < 2d` (configurable via `--risk-window`).
- Carry-over = issues in the current cycle that were also in the *previous*
  cycle (detected via `cycleHistory` or the issue's
  `previousCycle`/`cycleHistory` relation). Falls back to "issues in the
  current cycle that were in Triage/Backlog at the previous cycle's end" if
  `cycleHistory` isn't available.
- Points use the team's estimate system if enabled; counts only if
  `notUsed`.

## API surface

- `team({ filter: { key } }).cycles({ filter: { ... } })` — resolve cycles by
  date range.
- `cycle.issues()` — scoped issues (paginated).
- `issue.estimate` — the estimate value (for points).
- `cycleHistory` / issue cycle history relation — for carry-over. Need to
  verify this relation exists in the SDK; if not, infer from issue
  `updatedAt` timestamps within the previous cycle's window.

## Non-goals

- **No cycle creation.** Cycles are managed in the web app (team settings);
  `cycle` is a read/review command. This keeps the safe-by-default posture
  simple.
- **No scope changes.** Moving issues in/out of cycles is `update`'s job
  (once `update` gains a `--cycle` flag — a separate, small proposal).

## Relationship to `milestone`

| | `milestone` | `cycle` |
|---|---|---|
| Entity | Project milestone | Team cycle |
| Horizon | longer (release/delivery) | time-boxed iteration |
| Burn-down | done vs total | done vs total + at-risk + carry-over |
| Time pressure | deadline (if set) | days remaining in the box |

They're complementary, not overlapping. A release milestone spans multiple
cycles; `cycle` is the within-iteration view.

## Verification

- `linearctl cycle --team CER --json` → valid JSON with the shape above,
  numbers matching the Linear web app's cycle view.
- `linearctl cycle --team CER` → human table with correct burn-down bar.
- `linearctl cycle --previous --team CER` → resolves the last ended cycle,
  shows carry-over into the current one.
- Days-remaining calculation correct across cycle boundaries (verified at a
  known point in a cycle).
