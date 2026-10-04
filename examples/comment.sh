#!/usr/bin/env bash
# Example: printf '%s\n' 'Verified the fix.' | linearctl comment ENG-123 --body - --json
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
linearctl comment "$ISSUE" --body - --json <<'BODY'
Verified the fix and regression test.
BODY
linearctl show "$ISSUE" --json
