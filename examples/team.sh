#!/usr/bin/env bash
# Example: linearctl team list --cache
set -euo pipefail
# Check the selected binary, not just its presence on PATH (requires >= 0.12.0).
version=$(linearctl --version)
IFS=. read -r major minor patch <<< "${version%%-*}"
if (( major == 0 && minor < 12 )); then
  printf '%s\n' 'linearctl >= 0.12.0 is required' >&2
  exit 2
fi
# List all visible teams from the local SQLite cache
linearctl team list --cache

# Resolve team by key or name
linearctl team resolve CER --cache
