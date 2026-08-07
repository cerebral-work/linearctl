import type { LinearClient } from "@linear/sdk";
import { LinearDocument } from "@linear/sdk";
import { withRetry } from "../lib/retry.js";

/** The flat issue shape shared reads need — relations selected inline. */
export interface FlatIssueNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  estimate: number | null;
  updatedAt: string;
  state: { name: string; type: string } | null;
  assignee: { displayName: string } | null;
}

interface FlatIssuesData {
  issues: {
    nodes: FlatIssueNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

const FLAT_ISSUES_QUERY = /* GraphQL */ `
  query FlatIssues($filter: IssueFilter, $orderBy: PaginationOrderBy, $first: Int!, $after: String) {
    issues(filter: $filter, orderBy: $orderBy, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        url
        priority
        estimate
        updatedAt
        state {
          name
          type
        }
        assignee {
          displayName
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/**
 * Collect every issue matching a filter, paginating to the end, with state +
 * assignee selected INLINE — one request per 100-issue page instead of two
 * lazy round-trips per issue. The lazy-relation N+1 burned the full 2500/hr
 * org budget on full-workspace runs (spec §10); this is the fix.
 *
 * Grooming audits (RFC §3.4 health invariants) must be exhaustive — a `first:
 * 100` cap would silently truncate and make "no issue >30d…" unsound — so this
 * paginates fully rather than taking the first page.
 */
export async function collectIssuesFlat(
  client: LinearClient,
  filter: LinearDocument.IssueFilter,
  orderBy?: LinearDocument.PaginationOrderBy,
  /** Stop paginating once this many issues are collected (default: exhaustive). */
  limit?: number,
): Promise<FlatIssueNode[]> {
  type FlatIssuesVars = Record<string, unknown> & {
    filter: LinearDocument.IssueFilter;
    orderBy?: LinearDocument.PaginationOrderBy;
    first: number;
    after: string | null;
  };
  // Dedupe by id: under `orderBy: updatedAt`, a row whose updatedAt changes
  // mid-scan can reappear across page boundaries (cursor instability), so a naive
  // concat double-counts. Keep the last-seen node per id, preserving order.
  const byId = new Map<string, FlatIssueNode>();
  let after: string | null = null;
  do {
    const vars: FlatIssuesVars = { filter, orderBy, first: 100, after };
    const res = await withRetry(() =>
      client.client.rawRequest<FlatIssuesData, FlatIssuesVars>(FLAT_ISSUES_QUERY, vars),
    );
    const page = res.data?.issues;
    if (!page) throw new Error("issues query returned no data");
    for (const n of page.nodes) byId.set(n.id, n);
    after =
      page.pageInfo.hasNextPage && (limit === undefined || byId.size < limit)
        ? page.pageInfo.endCursor
        : null;
  } while (after);
  const all = [...byId.values()];
  return limit === undefined ? all : all.slice(0, limit);
}

/**
 * Workflow-state types that mean an issue is closed. Linear has a fourth
 * terminal type, `duplicate`, beyond completed/canceled — a sweep that
 * filters only the first two keeps listing duplicate-closed issues as open
 * (CER-1930 kept surfacing in stale/triage sweeps after being closed).
 */
export const TERMINAL_STATE_TYPES = ["completed", "canceled", "duplicate"];

/** True when team keys actually narrow the query (not empty / not `all`). */
export function scopedTeams(teamKeys?: string[]): string[] | undefined {
  if (!teamKeys || teamKeys.length === 0 || teamKeys.includes("all")) return undefined;
  return teamKeys;
}

const PROJECT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An issue-filter `and`-clause scoping to a project by id OR name (case-insensitive);
 * `[]` when unscoped. Pushed into each query's `and` array so project selection
 * happens server-side (no cross-project client-side noise).
 *
 * Branches on the ref shape: a UUID filters `project.id`, anything else filters
 * `project.name` — feeding a name into the `id` comparator is a server-side ID
 * validation error, so the two must not be OR'd. See spec §6.4.
 */
export function projectClause(project?: string): Record<string, unknown>[] {
  if (!project) return [];
  return [
    PROJECT_UUID_RE.test(project)
      ? { project: { id: { eq: project } } }
      : { project: { name: { eqIgnoreCase: project } } },
  ];
}
