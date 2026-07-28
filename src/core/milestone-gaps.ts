import type { LinearClient } from "@linear/sdk";
import { milestones, type MilestoneProgress } from "./milestones.js";
import { collectIssuesFlat, projectClause, type FlatIssueNode } from "./issues-query.js";
import { getProjectOverview } from "./projects.js";

/** A milestone whose issue count is zero — a roadmap ghost. */
export interface EmptyMilestone {
  id: string;
  name: string;
  targetDate: string | null;
}

/** A project issue with no milestone set. */
export interface UnassignedIssue {
  id: string;
  identifier: string;
  title: string;
  url: string;
  state: string;
  stateType: string;
  assignee: string | null;
}

/** A `## ...` section heading in the overview doc with no matching Linear ticket. */
export interface DocSectionGap {
  /** Zero-based index of the section in document order. */
  index: number;
  /** The heading text without the leading `##`. */
  heading: string;
}

export interface MilestoneGaps {
  project: string;
  /** (1) milestones with zero issues. */
  emptyMilestones: EmptyMilestone[];
  /** (2) project issues assigned to no milestone. */
  unassignedIssues: UnassignedIssue[];
  /** (3) overview-doc sections with no matching ticket. */
  docSectionGaps: DocSectionGap[];
}

/** Pull `## ...` (H2) headings out of the overview markdown. Skips `###`+. */
function extractH2Headings(markdown: string): string[] {
  const headings: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    // `## ` opens an H2; `### ` is an H3+ (closer to `## `, so guard the prefix).
    const m = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
    if (m && !line.startsWith("###")) {
      headings.push(m[1].trim());
    }
  }
  return headings;
}

/**
 * A heading counts as "covered" if ANY project issue is referenced in it. We
 * match two ways: by the issue's ticket identifier (`CER-123`) appearing in the
 * heading text, or by the issue's title appearing (case-insensitive substring)
 * in the heading text. This is the lighter version of the `spec-align` coverage
 * matrix — section heading ↔ ticket, not full spec parsing.
 *
 * Headings themselves often *contain* a bare identifier (e.g. `## CER-1149:
 * operator daemon`), so identifier substring is the primary signal; title
 * substring catches `## operator daemon` against an issue titled "operator
 * daemon".
 */
function headingMatches(
  heading: string,
  issues: FlatIssueNode[],
): boolean {
  const h = heading.toLowerCase();
  // Identifier check (case-insensitive — `CER-123`).
  for (const it of issues) {
    if (h.includes(it.identifier.toLowerCase())) return true;
  }
  // Title check: only flag a match for a reasonably long title, so a 3-char
  // title like "Bug" can't satisfy a `## Bug Bash` heading spuriously... we
  // still allow it though — coverage matching is intentionally permissive. A
  // false "covered" just hides a gap; a false "uncovered" is what an operator
  // filing-on-failure would catch. Keep it permissive.
  for (const it of issues) {
    if (it.title.trim().length > 0 && h.includes(it.title.toLowerCase())) {
      return true;
    }
  }
  return false;
}

/**
 * Compute milestone coverage gaps for a project. Three categories:
 * (1) milestones with zero issues ("ghosts"); (2) project issues with no
 * milestone ("unassigned"); (3) overview-doc `##` sections with no matching
 * ticket ("doc-section gaps"). The first reuses `milestones()`; (2) is a
 * single paginated issue query with `projectMilestone: { null: true }`; (3)
 * reads the project overview (`doc get-overview`) and matches `##` headings
 * against issue identifiers/titles. See docs/spec.md §6.5/§6.13.
 *
 * `projectRef` is required (a gap view is project-scoped — "unassigned" and
 * "doc-section" are meaningless across all projects).
 */
export async function milestoneGaps(
  client: LinearClient,
  projectRef: string,
): Promise<MilestoneGaps> {
  // (1) empty milestones + the readable project name, reusing the shared
  // burn-down path so the gap view and `milestone --json` never disagree.
  const milestoneResult = await milestones(client, projectRef);
  const projectName = milestoneResult.project ?? projectRef;
  const emptyMilestones: EmptyMilestone[] = milestoneResult.milestones
    .filter((m: MilestoneProgress) => m.total === 0)
    .map((m) => ({ id: m.id, name: m.name, targetDate: m.targetDate }));

  // The project is resolved inside `milestones()`/`getProjectOverview()`; for
  // the issues filter we scope by `projectClause(projectRef)` (server-side,
  // works for UUID or name). Combine it with the unassigned-milestone clause.
  const andClauses = projectClause(projectRef);
  const unassignedFilter = {
    and: [...andClauses, { projectMilestone: { null: true } }],
  };

  // (2) unassigned issues — separate paginated flat query. We could derive this
  // from a full issue list, but `FlatIssueNode` carries no `milestoneId`, so a
  // distinct filter is the single-query path.
  const unassigned = await collectIssuesFlat(client, unassignedFilter);
  const unassignedIssues: UnassignedIssue[] = unassigned.map((i) => ({
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    url: i.url,
    state: i.state?.name ?? "(no state)",
    stateType: i.state?.type ?? "",
    assignee: i.assignee?.displayName ?? null,
  }));

  // (3) doc-section gaps. Read the overview, extract `##` headings, find the
  // ones no project issue references. We need the full issue list (not just the
  // unassigned ones) — a milestone-assigned ticket covers a section just fine.
  // Fetching all project issues is one extra paginated query; cheap relative to
  // the linearctl latency budget (CER-1149's 10s SLA is for the watch loop).
  let docSectionGaps: DocSectionGap[] = [];
  const overview = await getProjectOverview(client, projectRef);
  if (overview.content) {
    const allIssues = await collectIssuesFlat(client, {
      and: andClauses,
    });
    const headings = extractH2Headings(overview.content);
    docSectionGaps = headings
      .map((heading, index) => ({ index, heading }))
      .filter((entry) => !headingMatches(entry.heading, allIssues));
  }

  return {
    project: projectName,
    emptyMilestones,
    unassignedIssues,
    docSectionGaps,
  };
}
