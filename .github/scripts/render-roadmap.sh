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
# digest --json emits { total, since, groups: [{ type, count, items }] } —
# "touched" is the total, "completed" is the completed-type group's count.

read -r ISSUES_TOUCHED ISSUES_COMPLETED <<< "$(echo "$DIGEST_JSON" | node -e "
const d = require('fs').readFileSync(0,'utf8');
try {
  const j = JSON.parse(d);
  const done = (j.groups || []).find((g) => g.type === 'completed');
  console.log(j.total || 0, done ? done.count : 0);
} catch { console.log(0, 0); }
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

*Last 7 days: ${ISSUES_TOUCHED} issue(s) touched, ${ISSUES_COMPLETED} completed.*
*Rendered by \`.github/scripts/render-roadmap.sh\` (corpus auto-render, schedule + dispatch).*"

# ── Splice into the roadmap file ──────────────────────────────────────────

if [ ! -f "$ROADMAP_FILE" ]; then
  echo "error: $ROADMAP_FILE not found." >&2
  exit 1
fi

# Use awk to splice: replace the existing "## Live Linear State" section
# (header through the line before the next "## " heading). If the file has
# no such section yet, insert it before the FIRST "## " heading so every
# manifest file self-seeds on first render. A section that is the last
# heading in the file is replaced through EOF.

awk -v section="$NEW_SECTION" '
  BEGIN { in_section = 0; placed = 0 }
  /^## Live Linear State/ {
    in_section = 1
    if (!placed) { placed = 1; print section }
    next
  }
  /^## / {
    if (in_section) { in_section = 0; print ""; print; next }
    if (!placed) { placed = 1; print section; print "" }
    print
    next
  }
  !in_section { print }
  END {
    if (!placed) {
      # No "## " heading anywhere — append the section at EOF.
      print ""
      print section
    }
  }
' "$ROADMAP_FILE" > "${ROADMAP_FILE}.tmp" && mv "${ROADMAP_FILE}.tmp" "$ROADMAP_FILE"

echo "Roadmap updated: $ROADMAP_FILE"
