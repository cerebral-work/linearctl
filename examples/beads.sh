#!/usr/bin/env bash
# Example: linearctl beads sync && linearctl beads ready --json
set -euo pipefail
# Check the selected binary, not just its presence on PATH (requires >= 0.19.0).
version=$(linearctl --version)
IFS=. read -r major minor patch <<< "${version%%-*}"
if (( major == 0 && minor < 19 )); then
  printf '%s\n' 'linearctl >= 0.19.0 is required for beads' >&2
  exit 2
fi
: "${LINEAR_API_KEY:?Set LINEAR_API_KEY in the environment}"

# Initialize local Beads workspace if not already initialized
linearctl beads init --team "${TEAM:-ENG}"

# Check status of local Beads graph
linearctl beads status --json

# Synchronize issues and relations from Linear into local Beads graph
linearctl beads sync --team "${TEAM:-ENG}" --json

# Query unblocked ready issues
linearctl beads ready --json
