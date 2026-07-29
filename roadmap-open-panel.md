# OPEN PANEL — Project Roadmap

> Linear project: [OPEN PANEL](https://linear.app/cerebral-work/project/open-panel-74f98a620375)
> Generated: 2026-07-22 via `linearctl roadmap`
> Team: BIZ · 7 issues (6 Done, 1 Canceled) · Project progress: 100%

## Live Linear State (auto-rendered 2026-07-29 14:31 UTC)

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
| Research & Documentation Sweep | `4fd035b5-90d4-4c7e-a3de-55f95cfa81a1` | 2026-07-15 | 3 | 33% (1/3) |
| Parser & Resolver Correctness | `53f84a47-efb9-47f6-923b-81864885395b` | 2026-07-12 | 4 | 75% (3/4) |
| Tooling Foundation & Packaging | `9c714567-02a1-4717-96fd-6361dc834160` | 2026-07-05 | 3 | 67% (2/3) |

```
OPEN PANEL — 3 milestone(s)

  Tooling Foundation & Packaging  (due 2026-07-05)  [█████████████░░░░░░░] 67%  2/3
    BIZ-44  [Backlog]  landgrab: give _scan an overall wall-clock deadline (per-future timeout is misleading)
    BIZ-4  [Done]  Package critpath and wsref (pyproject + console entry + --version)  @richie
    BIZ-2  [Done]  Add unit tests for the Python tools (critpath / landgrab / wsref)  @richie

  Parser & Resolver Correctness  (due 2026-07-12)  [███████████████░░░░░] 75%  3/4
    BIZ-43  [Backlog]  critpath: ignore lineage blocks inside fenced code — phantom DANGLING edges from LINEAGE.md examples
    BIZ-7  [Done]  critpath: `;`-separated multi-refs and parenthetical annotations dangle — parser vs authoring convention  @richie
    BIZ-6  [Done]  critpath: resolve_ref never resolves ../-style refs — NODE.md conforms_to dangles repo-wide  @richie
    BIZ-3  [Done]  wsref: handle truncated / multi-frame unframe edge cases  @richie

  Research & Documentation Sweep  (due 2026-07-15)  [███████░░░░░░░░░░░░░] 33%  1/3
    BIZ-45  [Backlog]  Resolve LICENSE file contradiction — landgrab/pyproject claims MIT but no LICENSE exists
    BIZ-5  [Done]  Research-pass backlog — remaining findings to triage  @richie
    BIZ-1  [Canceled]  Docs site polish: favicon, og:image, meta description, sidebar labels
```

*Last 7 days: 0 issue(s) touched, 0 completed.*
*Rendered by `.github/scripts/render-roadmap.sh` (corpus auto-render, schedule + dispatch).*

## Overview

OPEN PANEL is the workspace validation toolchain for the openpanel monorepo —
three Python tools (`critpath`, `wsref`, `landgrab`) that validate workspace
reference graphs, decode workspace envelopes, and scan domain ecosystems. The
project encompasses packaging, testing, parser correctness, and the research
pass that surfaced every finding.

## Milestones

### Milestone 1: Tooling Foundation & Packaging

**Goal:** Make the three Python tools installable, versioned, and tested — the
non-negotiable baseline before any correctness work.

**Target date:** 2026-07-05

| Issue | Title | State |
|-------|-------|-------|
| BIZ-4 | Package critpath and wsref (pyproject + console entry + --version) | Done |
| BIZ-2 | Add unit tests for the Python tools (critpath / landgrab / wsref) | Done |

**Scope:**
- `pyproject.toml` for critpath and wsref (mirroring landgrab's existing one)
- `[project.scripts]` console entry points for all three tools
- `--version` flag on every tool
- Unit test suite covering wsref codec byte round-trips (all 256), envelope
  frame/unframe + CRC tamper detection, threat matrix + injection regex,
  critpath `resolve_ref` / `critical_path` / `flux` functions
- CI integration via `tools-ci.yml`

---

### Milestone 2: Parser & Resolver Correctness

**Goal:** Fix the reference resolution bugs that produced phantom DANGLING edges
and silent data loss — the core engine correctness pass.

**Target date:** 2026-07-12

| Issue | Title | State |
|-------|-------|-------|
| BIZ-6 | critpath: resolve_ref never resolves ../-style refs — NODE.md conforms_to dangles repo-wide | Done |
| BIZ-7 | critpath: `;`-separated multi-refs and parenthetical annotations dangle — parser vs authoring convention | Done |
| BIZ-3 | wsref: handle truncated / multi-frame unframe edge cases | Done |

**Scope:**
- `resolve_ref` normalization for `../` path segments via `posixpath.normpath`
- Parser tolerance for `;`-separated list fields and parenthetical `(…)` annotations
- wsref `unframe` loop: `find(MAGIC, i+1)` on failure to handle multi-frame-per-run
- Truncated/empty run, MAGIC-at-tail, bogus-length frame edge cases
- Tests for every pattern: empty run, MAGIC-at-tail, two frames in one run,
  length-larger-than-buffer, `../` refs, `;`-separated refs, annotations

---

### Milestone 3: Research & Documentation Sweep

**Goal:** Consolidate findings from the 2026-06-17 research pass, triage
remaining work, and polish the docs site.

**Target date:** 2026-07-15

| Issue | Title | State |
|-------|-------|-------|
| BIZ-5 | Research-pass backlog — remaining findings to triage | Done |
| BIZ-1 | Docs site polish: favicon, og:image, meta description, sidebar labels | Canceled |

**Scope:**
- Consolidated research-pass backlog from `/tmp/openpanel-improvements.md`
- Disposition tracking: done/obsolete/superseded items struck, live items re-pathed
- Remaining live items: critpath fenced-code handling, landgrab wall-clock deadline,
  LICENSE contradiction
- Docs site polish (canceled — obsolated by openpanel absorption into terrarium)

---

## Rendered Roadmap

<!-- The output of `linearctl roadmap --project 'OPEN PANEL'` will be inserted below. -->
