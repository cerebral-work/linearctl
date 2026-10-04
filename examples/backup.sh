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
# Requires the post-0.8.0 backup exit contract: report on stdout, error envelope on stderr.
if linearctl backup --verify "$run" --offline --json; then
  printf '%s\n' 'Verification passed.' >&2
else
  rc=$?
  case "$rc" in
    6) printf '%s\n' 'Verification refused: inspect the report before using this dump.' >&2 ;;
    2) printf '%s\n' 'Invalid verification arguments or missing manifest.' >&2 ;;
    3) printf '%s\n' 'Missing or rejected credentials.' >&2 ;;
    4) printf '%s\n' 'API resource not found.' >&2 ;;
    5) printf '%s\n' 'Rate limit exhausted; retry after quota reset.' >&2 ;;
    *) printf '%s\n' 'Verification failed.' >&2 ;;
  esac
  exit "$rc"
fi
# A dump holds workspace content (issue bodies, comments, user emails): keep it on tmpfs or encrypt before storing.
