# Meridian — Project Roadmap

> Generated 2026-07-22 from live Linear issues (project: Meridian, team OPS).
> 6 issues, all in Backlog, all assigned to `ctodie`.

## Live Linear State (auto-rendered 2026-07-29 14:32 UTC)

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
| M3 — Prod & Deploy | `230cdba3-59ee-4167-ace1-0483e19ef446` | 2026-09-02 | 2 | 100% (2/2) |
| M2 — Snapshot Pipeline | `7e049290-fbbb-418e-a905-f542efae416c` | 2026-08-19 | 2 | 100% (2/2) |
| M1 — Collector Sources | `a407aaf1-ef8d-4ec6-b55a-4345e53bc05d` | 2026-08-05 | 2 | 100% (2/2) |

```
Meridian — 3 milestone(s)

  M1 — Collector Sources  (due 2026-08-05)  [████████████████████] 100%  2/2
    OPS-858  [Done]  collector slice-3: implement gh.rs — open PRs + CI state per work-surface  @ctodie
    OPS-857  [Done]  collector slice-2: implement git.rs — repo/branch/dirty state per work-surface  @ctodie

  M2 — Snapshot Pipeline  (due 2026-08-19)  [████████████████████] 100%  2/2
    OPS-861  [Done]  snapshot store + publish path — the collector writes locally and nothing ships it  @ctodie
    OPS-860  [Done]  reader: wire VITE_SNAPSHOT_URL — render the real snapshot, not the mock  @ctodie

  M3 — Prod & Deploy  (due 2026-09-02)  [████████████████████] 100%  2/2
    OPS-862  [Done]  deploy activation: pwa-host path + app-sso middleware, then flip DEPLOY_ENABLED  @ctodie
    OPS-859  [Done]  herdr.rs: one malformed pane blanks the entire fleet — skip-and-continue instead  @ctodie
```

*Last 7 days: 9 issue(s) touched, 6 completed.*
*Rendered by `.github/scripts/render-roadmap.sh` (corpus auto-render, schedule + dispatch).*

## What Meridian Is

Meridian is a fleet visibility surface — a "bigboard" that renders the live
state of the operator's work surfaces. Three layers:

1. **Collector** (Rust, `cerebral-work/meridian`) — gathers fleet state from
   multiple source modules (`herdr.rs` → tmux panes/sessions, `git.rs` → repo
   & branch state, `gh.rs` → open PRs + CI status) and emits a JSON snapshot.
2. **Snapshot pipeline** — stores the snapshot where the reader can fetch it
   by URL; the "missing middle" (OPS-861).
3. **Reader** (SvelteKit, Cloudflare Worker) — renders the snapshot at
   `meridian.cerebral.work` behind apex SSO.

The collector spine was built (commit `7d4673a`); `herdr.rs` (slice-1) landed
via PR #2. Everything below is the work to get from "spine + one source
module" to "deployed, real-data board."

---

## Milestones

### M1 — Collector Sources (OPS-857, OPS-858)

Complete the two remaining collector source modules so the snapshot carries
git and GitHub state, not just tmux sessions.

Slice-1 (`herdr.rs`, PR #2) is the worked example: blackwall-dispatched,
manually extracted, reviewed, and committed. The review caught issues
despite a clean `exit 0` — the same rigor applies here.

| Issue | Priority | Title |
|-------|----------|-------|
| [OPS-857](https://linear.app/cerebral-work/issue/OPS-857) | High | collector slice-2: implement `git.rs` — repo/branch/dirty state per work-surface |
| [OPS-858](https://linear.app/cerebral-work/issue/OPS-858) | High | collector slice-3: implement `gh.rs` — open PRs + CI state per work-surface |

**Key risks:**
- `gh.rs` will hit GitHub secondary rate limits across many repos — rate-limit
  strategy (single `search/issues` vs per-repo backoff) must be settled before
  dispatch.
- Both slices use blackwall dispatch; an `exit 0` run can still have written
  files it was told not to touch. Review is not optional.

**Exit criteria:** collector emits a complete snapshot with sessions, git
state, and PR/CI state for every work-surface.

---

### M2 — Snapshot Pipeline (OPS-861, OPS-860)

Connect the collector output to the reader input — the architectural gap
where the collector writes to local disk and nothing ships it to where the
reader can fetch it.

| Issue | Priority | Title |
|-------|----------|-------|
| [OPS-861](https://linear.app/cerebral-work/issue/OPS-861) | High | snapshot store + publish path — the collector writes locally and nothing ships it |
| [OPS-860](https://linear.app/cerebral-work/issue/OPS-860) | High | reader: wire `VITE_SNAPSHOT_URL` — render the real snapshot, not the mock |

**Key risks:**
- Store decision: R2 (keeps the Worker stateless, aligns with
  `alchemy.run.ts`) vs serve from the Worker. R2 is the obvious choice but
  means publish credentials live on the operator's machine for v1 — board
  goes stale when that machine is off. Must be acknowledged, not silently
  accepted.
- Reader has never rendered real data (only a typed mock). Must handle states
  the mock never exercises: fetch failure, stale snapshot, empty
  sessions/swimlanes. A blank board on fetch error is indistinguishable from
  "nothing happening" — wrong failure mode for a visibility surface.

**Exit criteria:** collector publishes snapshots to a store; reader fetches
and renders the live snapshot at build time via `VITE_SNAPSHOT_URL`, with
graceful degradation on fetch failure / staleness.

---

### M3 — Production Readiness & Deploy (OPS-859, OPS-862)

Harden the existing slice-1 code and ship the board behind apex SSO.

| Issue | Priority | Title |
|-------|----------|-------|
| [OPS-859](https://linear.app/cerebral-work/issue/OPS-859) | Medium | `herdr.rs`: one malformed pane blanks the entire fleet — skip-and-continue instead |
| [OPS-862](https://linear.app/cerebral-work/issue/OPS-862) | Medium | deploy activation: pwa-host path + app-sso middleware, then flip `DEPLOY_ENABLED` |

**Key risks:**
- OPS-859 is a bug in shipped code: `panes()` returns `Err` when any single
  pane entry is malformed, and `main.rs` degrades that to an empty fleet. One
  freshly-spawned or exited pane blanks the whole board. Must switch to
  skip-and-continue — a visibility surface that silently shows "no sessions"
  is worse than no surface.
- OPS-862 is the last mile — everything is deliberately gated. `DEPLOY_ENABLED`
  repo variable is currently unset. Prerequisites (OPS-854 app-sso apex
  instance, Keycloak client, OpenBao secret, wildcard cert, DNS, CoreDNS
  split-horizon) are all unmet. This milestone cannot land until the
  operator-gated apex prereqs are satisfied.

**Exit criteria:** collector degrades gracefully on malformed panes;
Meridian is live at `meridian.cerebral.work` behind SSO.

---

## Dependency Graph

```
M1: Collector Sources          M2: Snapshot Pipeline        M3: Prod & Deploy
─────────────────────          ────────────────────         ──────────────────
OPS-857 git.rs ─┐              OPS-861 store+publish ─┐     OPS-859 herdr resilience
                ├─ complete →  OPS-860 reader wire  ───┤──→  OPS-862 deploy activation
OPS-858 gh.rs ──┘              (real snapshot)          │     (gated by apex SSO prereqs)
                                                      │
                         collector emits full snapshot ┘
```

**Critical path:** M1 (sources) → M2 (pipeline) → M3 (deploy). M3's OPS-859
(herdr resilience) can run in parallel with M1/M2 — it's independent of the
new source modules.

---

## Issue Summary

| ID | Title | Priority | State | Milestone |
|----|-------|----------|-------|-----------|
| OPS-857 | collector slice-2: `git.rs` | High | Backlog | M1 — Collector Sources |
| OPS-858 | collector slice-3: `gh.rs` | High | Backlog | M1 — Collector Sources |
| OPS-861 | snapshot store + publish path | High | Backlog | M2 — Snapshot Pipeline |
| OPS-860 | reader: wire `VITE_SNAPSHOT_URL` | High | Backlog | M2 — Snapshot Pipeline |
| OPS-859 | `herdr.rs`: skip-and-continue | Medium | Backlog | M3 — Prod & Deploy |
| OPS-862 | deploy activation behind SSO | Medium | Backlog | M3 — Prod & Deploy |
