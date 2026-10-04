#!/usr/bin/env bash
# Example: linearctl backup --out ./backups --team ENG --limit 20 --json && linearctl backup --verify ./backups/linear-* --offline --json
set -euo pipefail
# Check the selected binary, not just its presence on PATH (backup requires >= 0.8.0).
version=$(linearctl --version)
IFS=. read -r major minor patch <<< "${version%%-*}"
if (( major == 0 && minor < 8 )); then
  printf '%s\n' 'linearctl >= 0.8.0 is required for backup' >&2
  exit 2
fi
: "${LINEAR_API_KEY:?Set LINEAR_API_KEY in the environment}"
: "${OUT:?Set OUT to a parent directory; the run is written to $OUT/linear-<UTC>/}"
linearctl ratelimit --json
# A smoke-sized dump: one team, 20 rows per entity. Drop --team/--limit for the full workspace.
linearctl backup --out "$OUT" --team "${TEAM:-ENG}" --limit 20 --json
# Verify the newest run: hashes, counts and references; --offline skips the live comparison.
run=$(ls -d "$OUT"/linear-* | sort | tail -n 1)
linearctl backup --verify "$run" --offline --json
# A dump holds workspace content (issue bodies, comments, user emails): keep it on tmpfs or encrypt before storing.
