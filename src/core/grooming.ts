import type { LinearClient } from "@linear/sdk";
import { LinearDocument } from "@linear/sdk";
import { pickLabelIds } from "../lib/labels.js";
import { withRetry } from "../lib/retry.js";
import { batchUpdateIssues } from "./batch.js";

/** The flat issue shape every grooming read needs — relations selected inline. */
interface FlatIssueNode {
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
  query GroomingIssues($filter: IssueFilter, $orderBy: PaginationOrderBy, $first: Int!, $after: String) {
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
async function collectIssuesFlat(
  client: LinearClient,
  filter: LinearDocument.IssueFilter,
  orderBy?: LinearDocument.PaginationOrderBy,
): Promise<FlatIssueNode[]> {
  // Dedupe by id: under `orderBy: updatedAt`, a row whose updatedAt changes
  // mid-scan can reappear across page boundaries (cursor instability), so a naive
  // concat double-counts. Keep the last-seen node per id, preserving order.
  type FlatIssuesVars = Record<string, unknown> & {
    filter: LinearDocument.IssueFilter;
    orderBy?: LinearDocument.PaginationOrderBy;
    first: number;
    after: string | null;
  };
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
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return [...byId.values()];
}

/** True when team keys actually narrow the query (not empty / not `all`). */
function scopedTeams(teamKeys?: string[]): string[] | undefined {
  if (!teamKeys || teamKeys.length === 0 || teamKeys.includes("all")) return undefined;
  return teamKeys;
}

const PROJECT_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An issue-filter `and`-clause scoping to a project by id OR name (case-insensitive);
 * `[]` when unscoped. Pushed into each grooming query's `and` array so project
 * selection happens server-side (no cross-project client-side noise).
 *
 * Branches on the ref shape: a UUID filters `project.id`, anything else filters
 * `project.name` — feeding a name into the `id` comparator is a server-side ID
 * validation error, so the two must not be OR'd. See spec §6.4.
 */
function projectClause(project?: string): Record<string, unknown>[] {
  if (!project) return [];
  return [
    PROJECT_UUID_RE.test(project)
      ? { project: { id: { eq: project } } }
      : { project: { name: { eqIgnoreCase: project } } },
  ];
}

export interface TriageItem {
  identifier: string;
  title: string;
  state: string;
  stateType: string;
  assignee: string | null;
  priority: number;
  estimate: number | null;
  reasons: string[];
  url: string;
}

/**
 * Surface issues needing triage: in the Triage state, or (in any active state)
 * unassigned / unestimated / no-priority. Completed + canceled issues are
 * excluded server-side. `why-flagged` reasons are computed per issue (an
 * OR-filter match doesn't say which branch hit). See docs/spec.md §6.4.
 */
export async function triage(
  client: LinearClient,
  teamKeys?: string[],
  project?: string,
): Promise<TriageItem[]> {
  const teams = scopedTeams(teamKeys);
  const issues = await collectIssuesFlat(client, {
    ...(teams ? { team: { key: { in: teams } } } : {}),
    and: [
      { state: { type: { nin: ["completed", "canceled"] } } },
      ...projectClause(project),
      {
        or: [
          { state: { type: { eq: "triage" } } },
          { assignee: { null: true } },
          { estimate: { null: true } },
          { priority: { eq: 0 } },
        ],
      },
    ],
  });

  return issues.map((issue) => {
    const reasons: string[] = [];
    if (issue.state?.type === "triage") reasons.push("triage-state");
    if (!issue.assignee) reasons.push("unassigned");
    if (issue.estimate == null) reasons.push("unestimated");
    if (!issue.priority) reasons.push("no-priority");
    return {
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state?.name ?? "",
      stateType: issue.state?.type ?? "",
      assignee: issue.assignee?.displayName ?? null,
      priority: issue.priority ?? 0,
      estimate: issue.estimate ?? null,
      reasons,
      url: issue.url,
    };
  });
}

export interface DigestItem {
  identifier: string;
  title: string;
  state: string;
  assignee: string | null;
  url: string;
}

export interface DigestGroup {
  type: string;
  count: number;
  items: DigestItem[];
}

export interface DigestResult {
  since: string;
  total: number;
  groups: DigestGroup[];
}

// Workflow-state types in the order a digest should read.
const STATE_ORDER = ["completed", "started", "unstarted", "triage", "backlog", "canceled"];

/**
 * "What have we been up to": issues updated since `since`, grouped by
 * workflow-state type (completed / started / …). See docs/spec.md §6.2.
 */
export async function digest(
  client: LinearClient,
  since: Date,
  teamKeys?: string[],
  project?: string,
): Promise<DigestResult> {
  const teams = scopedTeams(teamKeys);
  const issues = await collectIssuesFlat(
    client,
    {
      ...(teams ? { team: { key: { in: teams } } } : {}),
      updatedAt: { gte: since },
      ...(project ? { and: projectClause(project) } : {}),
    },
    LinearDocument.PaginationOrderBy.UpdatedAt,
  );

  const resolved = issues.map((issue) => ({
    type: issue.state?.type ?? "unknown",
    item: {
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state?.name ?? "",
      assignee: issue.assignee?.displayName ?? null,
      url: issue.url,
    } satisfies DigestItem,
  }));

  const byType = new Map<string, DigestItem[]>();
  for (const { type, item } of resolved) {
    const bucket = byType.get(type);
    if (bucket) bucket.push(item);
    else byType.set(type, [item]);
  }

  const order = (t: string) => {
    const i = STATE_ORDER.indexOf(t);
    return i === -1 ? STATE_ORDER.length : i;
  };
  const groups: DigestGroup[] = [...byType.entries()]
    .map(([type, items]) => ({ type, count: items.length, items }))
    .sort((a, b) => order(a.type) - order(b.type));

  return { since: since.toISOString(), total: issues.length, groups };
}

const DAY_MS = 86_400_000;

export interface StaleItem {
  id: string;
  identifier: string;
  title: string;
  state: string;
  assignee: string | null;
  updatedAt: string;
  daysStale: number;
  bucket: "warn" | "critical";
  url: string;
}

export interface StaleResult {
  olderThanDays: number;
  criticalDays: number;
  warn: number;
  critical: number;
  items: StaleItem[];
}

/**
 * Sweep active-state issues by last-update age. Two buckets: `warn` (older than
 * `warnCutoff`) and `critical` (older than `criticalCutoff`, ~90d → close-or-
 * justify). Read-only: surfaces, never mutates. Completed/canceled excluded.
 * See docs/spec.md §6.9.
 */
export async function stale(
  client: LinearClient,
  opts: { teamKeys?: string[]; project?: string; warnCutoff: Date; criticalCutoff: Date; now: Date },
): Promise<StaleResult> {
  const teams = scopedTeams(opts.teamKeys);
  const issues = await collectIssuesFlat(
    client,
    {
      ...(teams ? { team: { key: { in: teams } } } : {}),
      and: [
        { state: { type: { nin: ["completed", "canceled"] } } },
        { updatedAt: { lte: opts.warnCutoff } },
        ...projectClause(opts.project),
      ],
    },
    LinearDocument.PaginationOrderBy.UpdatedAt,
  );

  const items = issues.map((issue) => {
    const updated = new Date(issue.updatedAt);
    const daysStale = Math.floor((opts.now.getTime() - updated.getTime()) / DAY_MS);
    const bucket: "warn" | "critical" =
      updated <= opts.criticalCutoff ? "critical" : "warn";
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state?.name ?? "",
      assignee: issue.assignee?.displayName ?? null,
      updatedAt: updated.toISOString(),
      daysStale,
      bucket,
      url: issue.url,
    } satisfies StaleItem;
  });
  items.sort((a, b) => b.daysStale - a.daysStale);

  return {
    olderThanDays: Math.round((opts.now.getTime() - opts.warnCutoff.getTime()) / DAY_MS),
    criticalDays: Math.round((opts.now.getTime() - opts.criticalCutoff.getTime()) / DAY_MS),
    warn: items.filter((i) => i.bucket === "warn").length,
    critical: items.filter((i) => i.bucket === "critical").length,
    items,
  };
}

export interface StaleLabelResult {
  label: string;
  labelId: string;
  applied: boolean;
  count: number;
  identifiers: string[];
}

/**
 * Apply a label to a set of stale issues (the only mutation `stale` offers, and
 * only via `--label` + `--apply`). Uses `addedLabelIds` so existing labels are
 * preserved. `apply: false` is a dry-run — resolves/validates the label but
 * writes nothing. Never closes an issue (close-or-justify is human; RFC §3.2).
 */
export async function applyStaleLabel(
  client: LinearClient,
  items: StaleItem[],
  labelName: string,
  apply: boolean,
): Promise<StaleLabelResult> {
  const labels = await withRetry(() =>
    client.issueLabels({ filter: { name: { eqIgnoreCase: labelName } } }),
  );
  const [labelId] = pickLabelIds(labels.nodes, [labelName]);
  if (apply) {
    // Batched: one request per chunk of issues instead of one round-trip each.
    const res = await batchUpdateIssues(
      client,
      items.map((i) => ({ uuid: i.id, ref: i.identifier, input: { addedLabelIds: [labelId] } })),
    );
    if (res.failed.length) {
      throw new Error(
        `failed to label ${res.failed.length}/${items.length} issue(s): ` +
          res.failed.slice(0, 5).map((f) => f.ref).join(", ") +
          (res.failed.length > 5 ? ", …" : ""),
      );
    }
  }
  return {
    label: labelName,
    labelId,
    applied: apply,
    count: items.length,
    identifiers: items.map((i) => i.identifier),
  };
}
