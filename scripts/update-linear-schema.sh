#!/usr/bin/env bash
# Refresh test/fixtures/linear-schema.graphql from linear/linear (MIT).
# Usage: scripts/update-linear-schema.sh [commit-sha]   (default: current master)
set -euo pipefail
cd "$(dirname "$0")/.."
sha="${1:-$(gh api repos/linear/linear/commits/master --jq .sha)}"
url="https://raw.githubusercontent.com/linear/linear/${sha}/packages/sdk/src/schema.graphql"
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL "$url" -o "$tmp"
[ "$(wc -c <"$tmp")" -gt 100000 ] || { echo "schema download looks truncated" >&2; exit 1; }
{
  printf '# Vendored Linear public GraphQL schema (MIT).\n'
  printf '# Source: https://github.com/linear/linear/blob/%s/packages/sdk/src/schema.graphql\n' "$sha"
  printf '# Commit: %s\n' "$sha"
  printf '# Refresh with scripts/update-linear-schema.sh; used offline by test/graphql-documents.test.ts.\n\n'
  cat "$tmp"
} > test/fixtures/linear-schema.graphql
echo "updated to $sha"
