# Feature: `linearctl roadmap` — Milestone Timeline View & Export

**Status:** shipped — [CER-1688](https://linear.app/cerebral-work/issue/CER-1688), [OPS-888](https://linear.app/cerebral-work/issue/OPS-888)  
**Command:** `linearctl roadmap --project <ref> [--json]`  
**Roadmap:** §6.17, T22  
**Milestone:** M3  

## Motivation

Project management in Linear groups long-horizon deliverables into project milestones. While the Linear web application provides a visual roadmap view showing milestone cards on a timeline, headless scripts and terminal workflows had no direct CLI equivalent:

1. **Lack of timeline ordering:** `linearctl milestone --project <ref>` returns aggregate completion counts for milestones, but does not provide target date sequencing or per-milestone issue lists.
2. **Roadmap drift reconciliation:** When auditing planning specifications or sprint trackers against live Linear projects (such as the Blackwall roadmap reconciliation in OPS-888), operators had to manually reconcile `linearctl digest` logs or stitch together multiple GraphQL queries.
3. **Agent orchestration:** Autonomous agent teams require a machine-readable timeline projection (`--json`) to determine current horizon targets and unblocked milestone scope before picking up work.

`linearctl roadmap` fills this gap by rendering a timeline of project milestones sorted by target date, complete with visual progress bars, completion ratios, and issue rosters.

---

## Command Reference

```bash
# Render project roadmap with visual progress bars and issue lists
linearctl roadmap --project "linearctl"

# Render project roadmap using project UUID
linearctl roadmap --project "8f9b4c2e-7a1d-4e3b-9c2a-1e4d5f6a7b8c"

# Export structured roadmap timeline as JSON for scripts and jq
linearctl roadmap --project "linearctl" --json
```

### Options

- `--project <ref>`: **Required.** Linear project name or UUID.
- `--json`: Output full structured JSON payload rather than formatted human terminal text.

---

## Output Formats

### 1. Terminal Text Output (Human)

When run in a terminal without `--json`, `linearctl roadmap` outputs the project name, total milestone count, and each milestone chronologically with a 20-cell ASCII progress bar (`[██████████░░░░░░░░░░]`), completion percentage, and individual issue rows:

```text
linearctl — 3 milestone(s)

  M0 · Scaffold  (due 2026-06-30)  [████████████████████] 100%  11/11
    CER-1000  [Done]  Project scaffolding and bun setup  @ctodie
    CER-1001  [Done]  LinearClient authentication provider  @ctodie

  M1 · Read commands  (due 2026-07-15)  [████████████████████] 100%  20/20
    CER-1011  [Done]  linearctl whoami viewer introspection  @ctodie
    CER-1012  [Done]  linearctl digest activity rollup  @ctodie

  Horizon 1 · Production Cluster Deploy  (due 2026-10-20)  [████████░░░░░░░░░░░░] 40%  2/5
    CER-2647  [In Progress]  Distroless Harbor container builds  @ctodie
    CER-2648  [Todo]  Helm chart 0.3.0 deployment in linear-system
    CER-2649  [Todo]  ArgoCD application synchronization
```

If a project has no milestones defined, it provides actionable guidance:
```text
linearctl — 0 milestone(s)
(no milestones — create some via `linearctl milestone create`).
```

### 2. Structured JSON Output (`--json`)

The `--json` flag emits a machine-parseable JSON payload conforming to the `RoadmapResult` interface:

```json
{
  "project": "linearctl",
  "milestones": [
    {
      "id": "ms-uuid-1",
      "name": "M0 · Scaffold",
      "targetDate": "2026-06-30",
      "done": 11,
      "total": 11,
      "percent": 100,
      "issues": [
        {
          "id": "issue-uuid-1",
          "identifier": "CER-1000",
          "title": "Project scaffolding and bun setup",
          "state": "Done",
          "stateType": "completed",
          "assignee": "Christian Todie",
          "priority": "Urgent"
        }
      ]
    }
  ]
}
```

---

## Architecture & Implementation

The command is implemented across two layers:

1. **CLI Presentation (`src/commands/roadmap.ts`):**
   - Handles argument parsing (`--project`, `--json`).
   - Renders 20-character proportional ASCII progress bars.
   - Formats milestone due dates and issue attributions.

2. **Core Query & Aggregation Engine (`src/core/roadmap.ts`):**
   - Resolves the project reference (by UUID or name) via `resolveProject(client, projectRef)`.
   - Drains all `ProjectMilestone` connection pages via `drainConnection`.
   - Fetches issues for each milestone concurrently using a concurrency pool (`mapPool(all, 5, ...)`), throttled to avoid hitting Linear GraphQL rate limits.
   - Wraps individual milestone issue page requests in `withRetry` exponential backoff.
   - Calculates milestone progress metrics:
     $$\text{percent} = \begin{cases} 0 & \text{if } \text{total} = 0 \\ \operatorname{round}\left(\frac{\text{done}}{\text{total}} \times 100\right) & \text{otherwise} \end{cases}$$
   - Orders milestones chronologically by `targetDate` ascending, placing undated milestones first.

---

## Ecosystem Integration

`linearctl roadmap` operates in concert with related milestone and planning tooling:

- **`linearctl milestone create` (CER-1686):** Creates the project milestones visualized in the roadmap timeline.
- **`linearctl milestone gap` (CER-2820):** Detects ghost milestones (milestones with zero issues) and unscheduled issues lacking milestone assignment.
- **`linearctl plan` (CER-2821):** Generates Saga Spec 0040 Critical Path Method (CPM) execution waves filtered by `--milestone <ref>`.

---

## Test Verification

Test coverage is verified in [`test/roadmap.test.ts`](file:///home/ctodie/projects/platform/tooling/linearctl/test/roadmap.test.ts):
- Empty milestone array handling and empty issue rosters.
- Project name and UUID resolution.
- Ascending target date sorting invariants.
- State type categorization and completion percentage arithmetic.
- Paginated issue and milestone connection drainage.
