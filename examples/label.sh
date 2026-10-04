#!/usr/bin/env bash
# Example: linearctl label list --team "ENG" --json
set -euo pipefail
# Check the selected binary, not just its presence on PATH (requires >= 0.7.0).
version=$(linearctl --version)
IFS=. read -r major minor patch <<< "${version%%-*}"
if (( major == 0 && minor < 7 )); then
  printf '%s\n' 'linearctl >= 0.7.0 is required' >&2
  exit 2
fi
: "${TEAM:?Set TEAM (for example ENG)}"
: "${LINEAR_API_KEY:?Set LINEAR_API_KEY in the environment}"
linearctl ratelimit --json
linearctl label list --team "$TEAM" --json

# Omit --team for the cross-team view: every team's labels plus the
# workspace-scoped ones (team: null). The listing follows API cursors to the
# end, so it is complete however many labels the workspace holds.
linearctl label list --json

# Workspace-scoped labels only.
linearctl label list --json | jq '[.[] | select(.team == null)]'

# --limit caps the rows. The cap is applied to the whole sorted listing, not
# to whichever page the API answered with first.
linearctl label list --limit 5 --json

# A capped listing is an incomplete answer, so every row carries
# "partial": true under --json (and text mode notes it on stderr). Without
# --limit the output is never partial. Check before treating a list as whole:
if linearctl label list --limit 5 --json | jq -e 'any(.[]; .partial == true)' > /dev/null; then
  printf '%s\n' 'labels truncated by --limit; raise or drop it for the full list' >&2
fi

# A bad --limit is a usage error (exit 2), not an empty list.
status=0
linearctl label list --limit 0 --json > /dev/null 2>&1 || status=$?
test "$status" -eq 2
