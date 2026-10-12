#!/usr/bin/env bash
# Example: linearctl plan --schedule && linearctl plan schedule .saga/plans/smoke.toml
set -euo pipefail
# Check the selected binary, not just its presence on PATH (requires >= 0.19.0).
version=$(linearctl --version)
IFS=. read -r major minor patch <<< "${version%%-*}"
if (( major == 0 && minor < 19 )); then
  printf '%s\n' 'linearctl >= 0.19.0 is required for plan' >&2
  exit 2
fi
: "${LINEAR_API_KEY:?Set LINEAR_API_KEY in the environment}"

# Generate a Saga Spec 0040 CPM plan from local Beads graph or Linear issues
linearctl plan --team "${TEAM:-ENG}" --name "feature-sprint" --out .saga/plans/feature-sprint.toml

# Generate and display execution waves and CPM schedule directly
linearctl plan --team "${TEAM:-ENG}" --schedule

# Schedule an existing Saga plan file (.saga/plans/*.toml)
linearctl plan schedule .saga/plans/feature-sprint.toml --json
