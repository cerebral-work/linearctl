# Feature: `linearctl plan` — Saga Spec 0040 Critical-Path Plan & CPM Wave Generation

**Status:** implemented
**Command:** `linearctl plan [generate|schedule]` · `linearctl beads plan`
**Integration:** [cerebral-work/saga](https://github.com/cerebral-work/saga) (Spec 0040: CPM & Wave Execution)

## Motivation

The agentic IDE suite `saga` coordinates autonomous software engineering teams using the Critical Path Method (CPM) and wave execution ([Spec 0040](file:///home/ctodie/projects/cerebral-work/saga/specs/0040-cpm-and-wave-execution.md)). In Saga, plans under `.saga/plans/*.toml` define flow steps with durations and dependency constraints (`deps = [...]`). Saga computes early start (ES), early finish (EF), late start (LS), late finish (LF), slack, and critical path to split work into deterministic concurrent execution waves.

`linearctl plan` bridges Linear issue tracking and local Beads dependency graphs to Saga Spec 0040:
- Translates Linear issues and local Beads DAGs into valid `.saga/plans/*.toml` files.
- Computes CPM scheduling bounds and execution waves (U1, U2, U3 parity with Saga).
- Inspects and validates existing plan files with embedded CPM or native `saga plan schedule`.
- Offers `linearctl beads plan` for local graph offline generation.

---

## Architectural Role: Saga as Integrator

In the estate's tool hierarchy:
1. **Saga is the orchestrator:** It coordinates execution flows, agent harnesses (Builder / Critic), Blackwall custody, Heimdal gates, and CPM wave scheduling.
2. **`linearctl` is the domain tool:** It manages Linear authentication, API rate limits, query evaluation, and local directed issue graphs (Beads).
3. **Subprocess contract:** Saga integrates `linearctl` over CLI subprocesses with `--json` (`linearctl search --json`, `linearctl beads ready --json`). `linearctl plan` acts as a clean export and inspection utility.

---

## Command Reference

### 1. `linearctl plan` / `linearctl plan generate`

Generates a Saga Spec 0040 plan file from local Beads graph or live Linear query.

```bash
# Generate plan to stdout from discovered Beads workspace or Linear
linearctl plan --team CER --name "feature-wave"

# Save plan directly to .saga/plans/
linearctl plan --team CER --name "feature-wave" --out .saga/plans/feature-wave.toml

# Generate and immediately inspect execution waves and CPM schedule
linearctl plan --team CER --schedule

# Automatically pair builder steps with critic verify steps (Saga custody compliance)
linearctl plan --team CER --add-critic --out .saga/plans/custody-wave.toml
```

#### Options:
- `--name <name>`: Flow name (default: `linear-cpm-plan`).
- `--desc <text>`: Flow description.
- `--out <file>`: Output file path.
- `--from <source>`: Source of issues: `beads`, `linear`, or `auto` (default: `auto`).
- `--team <key...>`: Restrict to team key(s).
- `--project <ref>`: Restrict to project name or ID.
- `--milestone <ref>`: Restrict to milestone name or ID.
- `--label <name...>`: Filter by label(s).
- `--priority <0-4>`: Filter by priority threshold.
- `--include-closed`: Include closed issues in the plan.
- `--max-concurrency <n>`: Max concurrent steps per wave (default: 3).
- `--pr-base <branch>`: Base branch for PRs (default: `development`).
- `--on-halt <policy>`: Halt policy: `cancel-dependents` or `halt-all` (default: `cancel-dependents`).
- `--open-prs`: Enable PR creation on critic pass.
- `--merge-on-green`: Enable automated merge step after critic.
- `--add-critic`: Pair builder steps with critic verify steps.
- `--schedule`: Print CPM schedule and wave breakdown.
- `--json`: Emit JSON.

### 2. `linearctl plan schedule [file]`

Prints the critical-path schedule (ES, EF, LS, LF, slack) and execution waves for any plan file or stdin. Uses native `saga plan schedule` if installed, falling back to embedded TypeScript engine.

```bash
# Inspect schedule of a plan file
linearctl plan schedule .saga/plans/feature-wave.toml

# Inspect schedule via stdin pipe
cat .saga/plans/feature-wave.toml | linearctl plan schedule -

# Output machine-readable saga.plan.v1 JSON
linearctl plan schedule .saga/plans/feature-wave.toml --json
```

### 3. `linearctl beads plan`

Direct shortcut to generate a Saga plan from the local Beads graph:

```bash
linearctl beads plan --name "local-sprint" --schedule
```

---

## Saga Spec 0040 Parity

The plan generator adheres to Saga Spec 0040 invariants:
- **Strict fields:** Serializes only recognized fields under `[flow]` and `[[step]]` to avoid `config_invalid` schema faults.
- **Dependency pruning:** Unknown/external dependencies outside the plan are pruned to prevent `REQ-0040-01 UnknownDependency` faults.
- **U9 classification:** Maps issue types and labels to roles (`builder`, `critic`, `probe`, `main_session`).
- **U3 wave sorting:** Sorts waves by critical first, then smaller slack, then lower ES, then step ID.
