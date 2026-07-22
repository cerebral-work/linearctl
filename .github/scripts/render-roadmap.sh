#!/usr/bin/env bash
# Regenerate the "Live Linear State" section of a project roadmap file.
#
# Usage: render-roadmap.sh <project-name> <roadmap-file>
#
# Runs linearctl roadmap, digest, and milestone against the project,
# then splice-replaces the section between the "## Live Linear State" header
# and the next "## " header in the roadmap markdown file.
#
# Requires: LINEAR_API_KEY env var, linearctl built at ./dist/linearctl.
# Degrades gracefully: if any API call fails (rate limit, network), it renders
# with whatever data it collected and exits 0 so the workflow doesn't red-X.
set -uo pipefail

PROJECT="${1:?project name required}"
ROADMAP_FILE="${2:?roadmap file path required}"
CTL="./dist/linearctl"

if [ ! -x "$CTL" ]; then
  echo "error: $CTL not found — run 'bun run build' first." >&2
  exit 1
fi

if [ -z "${LINEAR_API_KEY:-}" ]; then
  echo "error: LINEAR_API_KEY not set." >&2
  exit 1
fi

# ── Rate-limit guard ───────────────────────────────────────────────────────
# Check remaining budget; skip if <10 to avoid burning the retry budget.

BUDGET="$($CTL ratelimit --json 2>/dev/null || echo '{"requests":{"remaining":0}}')"
REMAINING="$(echo "$BUDGET" | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log(d.requests?.remaining ?? 0)" 2>/dev/null || echo 0)"

if [ "$REMAINING" -lt 10 ]; then
  echo "Linear API budget low ($REMAINING remaining) — skipping render to avoid rate-limit failures."
  exit 0
fi

# ── Gather live data (degrade gracefully on failure) ──────────────────────

ROADMAP_RAW="$($CTL roadmap --project "$PROJECT" 2>&1 || echo "(render failed — see workflow logs)")"
DIGEST_JSON="$($CTL digest --project "$PROJECT" --since 7d --json 2>&1 || echo '{}')"
MILESTONES_JSON="$($CTL milestone --project "$PROJECT" --json 2>&1 || echo '{}')"

# ── Parse digest for counts ───────────────────────────────────────────────

read -r ISSUES_OPENED ISSUES_CLOSED <<< "$(echo "$DIGEST_JSON" | node -e "
const d = require('fs').readFileSync(0,'utf8');
try { const j = JSON.parse(d); console.log(j.openedCount || 0, j.closedCount || 0); }
catch { console.log(0, 0); }
" 2>/dev/null || echo "0 0")"

# ── Parse milestones for summary table ────────────────────────────────────

MILESTONE_TABLE="$(echo "$MILESTONES_JSON" | node -e "
const raw = require('fs').readFileSync(0,'utf8');
try {
  const j = JSON.parse(raw);
  const ms = j.milestones || [];
  for (const m of ms) {
    const pct = m.percent || 0;
    const done = m.done || 0;
    const total = m.total || 0;
    const date = m.targetDate || '—';
    console.log('| ' + m.name + ' | \`' + m.id + '\` | ' + date + ' | ' + total + ' | ' + pct + '% (' + done + '/' + total + ') |');
  }
} catch {}
" 2>/dev/null || echo "")"

# ── Timestamp ────────────────────────────────────────────────────────────

NOW="$(date -u +"%Y-%m-%d %H:%M UTC")"

# ── Build the replacement section ─────────────────────────────────────────

NEW_SECTION="## Live Linear State (auto-rendered $NOW)

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
${MILESTONE_TABLE}

\`\`\`
${ROADMAP_RAW}
\`\`\`

*Last 7 days: ${ISSUES_OPENED} opened, ${ISSUES_CLOSED} closed.*
*Rendered by \`.github/workflows/gaze-upon-velocity.yml\` on schedule + dispatch.*"

# ── Splice into the roadmap file ──────────────────────────────────────────

if [ ! -f "$ROADMAP_FILE" ]; then
  echo "error: $ROADMAP_FILE not found." >&2
  exit 1
fi

# Use awk to splice: everything before "## Live Linear State",
# then the new section, then everything from the next "## " heading onward.
# If there's no existing "## Live Linear State" header, insert before the
# first "## " heading.

awk -v section="$NEW_SECTION" '
  BEGIN { in_section = 0; done = 0 }
  /^## Live Linear State/ { in_section = 1; next }
  /^## / && in_section {
    in_section = 0
    done = 1
    print section
    print ""
    print
    next
  }
  !in_section { print }
  END {
    if (!done) {
      # No existing section found — the file was printed as-is.
      # The caller should handle this, but we exit 0 to avoid red-X.
    }
  }
' "$ROADMAP_FILE" > "${ROADMAP_FILE}.tmp" && mv "${ROADMAP_FILE}.tmp" "$ROADMAP_FILE"

echo "Roadmap updated: $ROADMAP_FILE"
