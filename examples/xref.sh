#!/usr/bin/env bash
# Example: linearctl xref --repo "example/project" --json
set -euo pipefail
# Check the selected binary, not just its presence on PATH (requires >= 0.7.0).
version=$(linearctl --version)
IFS=. read -r major minor patch <<< "${version%%-*}"
if (( major == 0 && minor < 7 )); then
  printf '%s\n' 'linearctl >= 0.7.0 is required' >&2
  exit 2
fi
: "${REPO:?Set REPO (for example example/project)}"
: "${LINEAR_API_KEY:?Set LINEAR_API_KEY in the environment}"
linearctl ratelimit --json
linearctl xref --repo "$REPO" --json
