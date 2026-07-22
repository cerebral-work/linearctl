# OPEN PANEL — Project Roadmap

> Linear project: [OPEN PANEL](https://linear.app/cerebral-work/project/open-panel-74f98a620375)
> Generated: 2026-07-22 via `linearctl roadmap`
> Team: BIZ · 7 issues (6 Done, 1 Canceled) · Project progress: 100%

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
