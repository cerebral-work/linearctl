#!/usr/bin/env bash
# Example: cat plan.json | linearctl update --stdin --apply --json
set -euo pipefail
# Check the selected binary, not just its presence on PATH (requires >= 0.7.0).
version=$(linearctl --version)
IFS=. read -r major minor patch <<< "${version%%-*}"
if (( major == 0 && minor < 7 )); then
  printf '%s\n' 'linearctl >= 0.7.0 is required' >&2
  exit 2
fi
: "${ISSUE:?Set ISSUE (for example ENG-123)}"
: "${LINEAR_API_KEY:?Set LINEAR_API_KEY in the environment}"
linearctl ratelimit --json
# PLAN is a reviewed JSON array or NDJSON file, e.g. [{"id":"ENG-123","priority":3}].
: "${PLAN:?Set PLAN to the JSON plan file}"
# Preview intentionally exits 6 (refused); all other failures stop this script.
cat "$PLAN" | linearctl update --stdin --json || { code=$?; [ "$code" -eq 6 ] || exit "$code"; }
# Set APPLY=1 after reviewing the preview to execute and re-read.
if [ "${APPLY:-0}" = 1 ]; then
  cat "$PLAN" | linearctl update --stdin --apply --json
  linearctl show "$ISSUE" --json
fi

# Single-issue duplicate relation (writes immediately; no --stdin / --apply):
# linearctl update "$ISSUE" --duplicate-of "${CANONICAL:?Set canonical issue}" --json
# To create the relation AND close in the duplicate state, use close --duplicate-of.
