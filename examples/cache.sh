#!/usr/bin/env bash
# Example: linearctl cache sync --team ENG && linearctl cache status --json
set -euo pipefail
# Check the selected binary, not just its presence on PATH (requires >= 0.9.0).
version=$(linearctl --version)
IFS=. read -r major minor patch <<< "${version%%-*}"
if (( major == 0 && minor < 9 )); then
  printf '%s\n' 'linearctl >= 0.9.0 is required for cache' >&2
  exit 2
fi
: "${LINEAR_API_KEY:?Set LINEAR_API_KEY in the environment}"

# Inspect initial cache status
linearctl cache status --json

# Synchronize tickets and metadata into local SQLite cache
linearctl cache sync --team "${TEAM:-ENG}" --json

# Perform local FTS5 / ORM queries without hitting Linear API
linearctl cache query --team "${TEAM:-ENG}" --limit 10 --json

# Read cached issues using the standard pull interface with --cache
linearctl pull --team "${TEAM:-ENG}" --cache --limit 10 --json
