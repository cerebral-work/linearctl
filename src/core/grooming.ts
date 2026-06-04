import type { LinearClient, Issue } from "@linear/sdk";
import { LinearDocument } from "@linear/sdk";

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
  let page = await client.issues(args);
  const all = [...page.nodes];
  while (page.pageInfo.hasNextPage) {
    page = await page.fetchNext();
    all.push(...page.nodes);
  }
  return all;
}

/** True when team keys actually narrow the query (not empty / not `all`). */
function scopedTeams(teamKeys?: string[]): string[] | undefined {
  if (!teamKeys || teamKeys.length === 0 || teamKeys.includes("all")) return undefined;
  return teamKeys;
}

/**
 * Map over items with bounded concurrency, preserving order. Tames the
 * per-issue `.state`/`.assignee` N+1 (spec §10): instead of 2×N *serial*
 * round-trips (sluggish + a cron foot-gun on a big team), at most `limit` run at
 * once — fast without flooding into `RATELIMITED`.
 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
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
): Promise<TriageItem[]> {
  const teams = scopedTeams(teamKeys);
  const issues = await collectIssues(client, {
    first: 100,
    filter: {
      ...(teams ? { team: { key: { in: teams } } } : {}),
      and: [
        { state: { type: { nin: ["completed", "canceled"] } } },
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
): Promise<DigestResult> {
  const teams = scopedTeams(teamKeys);
  const issues = await collectIssues(client, {
    first: 100,
    orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
    filter: {
      ...(teams ? { team: { key: { in: teams } } } : {}),
      updatedAt: { gte: since },
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
