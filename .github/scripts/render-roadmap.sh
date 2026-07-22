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
set -euo pipefail

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

# ── Gather live data ──────────────────────────────────────────────────────

ROADMAP_RAW="$($CTL roadmap --project "$PROJECT" 2>/dev/null)"
DIGEST_JSON="$($CTL digest --project "$PROJECT" --since 7d --json 2>/dev/null)"
MILESTONES_JSON="$($CTL milestone --project "$PROJECT" --json 2>/dev/null)"

# ── Parse digest for counts ───────────────────────────────────────────────

# Extract issue counts from the digest JSON using node (available via bun).
read -r COMPLETED WEEK ISSUES_OPENED ISSUES_CLOSED <<< "$(node -e "
const d = process.argv[1];
const j = JSON.parse(d);
const groups = j.groups || [];
let completed = 0, opened = 0, closed = 0;
for (const g of groups) {
  for (const i of (g.issues || [])) {
    if (g.label === 'Completed' || g.statusType === 'completed') completed++;
    if (g.label === 'Started' || g.statusType === 'started') {} // count separately if needed
  }
}
console.log(completed, 7, j.openedCount || 0, j.closedCount || 0);
" "$DIGEST_JSON" 2>/dev/null || echo "0 7 0 0")"

# ── Parse milestones for summary table ────────────────────────────────────

MILESTONE_TABLE="$(node -e "
const raw = process.argv[1];
const j = JSON.parse(raw);
const ms = j.milestones || [];
for (const m of ms) {
  const pct = m.percent || 0;
  const done = m.done || 0;
  const total = m.total || 0;
  const date = m.targetDate || '—';
  console.log('| ' + m.name + ' | \`' + m.id + '\` | ' + date + ' | ' + total + ' | ' + pct + '% (' + done + '/' + total + ') |');
}
" "$MILESTONES_JSON" 2>/dev/null || echo "")"

# ── Timestamp ────────────────────────────────────────────────────────────

NOW="$(date -u +"%Y-%m-%d %H:%M UTC")"

# ── Build the replacement section ─────────────────────────────────────────

NEW_SECTION="## Live Linear State (auto-rendered $NOW)

4 milestones in the Linear \`$PROJECT\` project; all issues assigned.

| Milestone | Linear ID | Target Date | Issues | Progress |
|----------|-----------|------------|--------|----------|
${MILESTONE_TABLE}

\`\`\`
${ROADMAP_RAW}
\`\`\`

*Last 7 days: ${ISSUES_OPENED} opened, ${ISSUES_CLOSED} closed.*
*Rendered by \`.github/workflows/gaze-upon-velocity.yml\` on schedule + dispatch.*"

# ── Splice into the roadmap file ──────────────────────────────────────────
#
# The file has:
#   ## Live Linear State (...)
#   ...content...
#   ## What gaze-upon Is
#
# We replace everything from "## Live Linear State" up to (but not including)
# the next "## " heading.

if [ ! -f "$ROADMAP_FILE" ]; then
  echo "error: $ROADMAP_FILE not found." >&2
  exit 1
fi

# Use awk to splice: everything before "## Live Linear State",
# then the new section, then everything from the next "## " heading onward.
awk -v section="$NEW_SECTION" '
  BEGIN { in_section = 0; printed = 0 }
  /^## Live Linear State/ { in_section = 1; next }
  /^## / && in_section {
    in_section = 0
    print section
    print ""
    print
    next
  }
  !in_section { print }
' "$ROADMAP_FILE" > "${ROADMAP_FILE}.tmp" && mv "${ROADMAP_FILE}.tmp" "$ROADMAP_FILE"

echo "Roadmap updated: $ROADMAP_FILE"
