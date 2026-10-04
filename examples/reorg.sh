#!/usr/bin/env bash
# Example: linearctl reorg census --team ENG --limit 50, then a plan dry-run
set -euo pipefail
# Check the selected binary, not just its presence on PATH (requires >= 0.8.0).
version=$(linearctl --version)
IFS=. read -r major minor patch <<< "${version%%-*}"
if (( major == 0 && minor < 8 )); then
  printf '%s\n' 'linearctl >= 0.8.0 is required' >&2
  exit 2
fi
: "${LINEAR_API_KEY:?Set LINEAR_API_KEY in the environment}"
linearctl ratelimit --json
# Read-only snapshot the planner consumes.
linearctl reorg census --team ENG --limit 50 --out /tmp/reorg-census.json --json
# Generate + dry-run a plan (rules live OUTSIDE the repo; toy schema in
# examples/reorg-rules.example.json). Dry-run prints per-op diffs + the request
# budget; --check adds a live drift pre-read; --apply additionally needs
# --backup-record < backup.verified.json < 24h old.
linearctl reorg plan --rules rules.json --census /tmp/reorg-census.json --out /tmp/reorg-plan.jsonl
linearctl reorg apply /tmp/reorg-plan.jsonl --phase 1            # dry-run
linearctl reorg apply /tmp/reorg-plan.jsonl --phase 1 --check    # + live drift pre-read
