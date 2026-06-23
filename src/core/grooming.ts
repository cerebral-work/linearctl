import type { LinearClient, Issue } from "@linear/sdk";
import { LinearDocument } from "@linear/sdk";
import { pickLabelIds } from "../lib/labels.js";
import { mapPool } from "../lib/pool.js";
import { withRetry } from "../lib/retry.js";
import { batchUpdateIssues } from "./batch.js";

type IssuesArgs = Parameters<LinearClient["issues"]>[0];

/**
 * Collect every issue matching a query, following `fetchNext()` to the end.
 *
 * Grooming audits (RFC §3.4 health invariants) must be exhaustive — a `first:
 * 100` cap would silently truncate and make "no issue >30d…" unsound — so this
 * paginates fully rather than taking the first page.
 *
 * N+1 note (spec §10): callers that `await issue.state`/`.assignee` per node pay
 * one round-trip each; acceptable for v1, the thing to watch on a full-workspace run.
 */
async function collectIssues(client: LinearClient, args: IssuesArgs): Promise<Issue[]> {
  let page = await withRetry(() => client.issues(args));
  const all = [...page.nodes];
  while (page.pageInfo.hasNextPage) {
    const current = page;
    page = await withRetry(() => current.fetchNext());
    all.push(...page.nodes);
  }
  return all;
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
  const issues = await collectIssues(client, {
    first: 100,
    filter: {
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
    },
  });

  return mapPool(issues, 10, async (issue) => {
    const [state, assignee] = await Promise.all([issue.state, issue.assignee]);
    const reasons: string[] = [];
    if (state?.type === "triage") reasons.push("triage-state");
    if (!assignee) reasons.push("unassigned");
    if (issue.estimate == null) reasons.push("unestimated");
    if (!issue.priority) reasons.push("no-priority");
    return {
      identifier: issue.identifier,
      title: issue.title,
      state: state?.name ?? "",
      stateType: state?.type ?? "",
      assignee: assignee?.displayName ?? null,
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
  const issues = await collectIssues(client, {
    first: 100,
    orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
    filter: {
      ...(teams ? { team: { key: { in: teams } } } : {}),
      updatedAt: { gte: since },
      ...(project ? { and: projectClause(project) } : {}),
    },
  });

  const resolved = await mapPool(issues, 10, async (issue) => {
    const [state, assignee] = await Promise.all([issue.state, issue.assignee]);
    return {
      type: state?.type ?? "unknown",
      item: {
        identifier: issue.identifier,
        title: issue.title,
        state: state?.name ?? "",
        assignee: assignee?.displayName ?? null,
        url: issue.url,
      } satisfies DigestItem,
    };
  });

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
  const issues = await collectIssues(client, {
    first: 100,
    orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
    filter: {
      ...(teams ? { team: { key: { in: teams } } } : {}),
      and: [
        { state: { type: { nin: ["completed", "canceled"] } } },
        { updatedAt: { lte: opts.warnCutoff } },
        ...projectClause(opts.project),
      ],
    },
  });

  const items = await mapPool(issues, 10, async (issue) => {
    const [state, assignee] = await Promise.all([issue.state, issue.assignee]);
    const updated = new Date(issue.updatedAt);
    const daysStale = Math.floor((opts.now.getTime() - updated.getTime()) / DAY_MS);
    const bucket: "warn" | "critical" =
      updated <= opts.criticalCutoff ? "critical" : "warn";
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      state: state?.name ?? "",
      assignee: assignee?.displayName ?? null,
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
