import type { LinearClient } from "@linear/sdk";
import { LinearDocument } from "@linear/sdk";
import { withRetry } from "../lib/retry.js";
import { buildSearchFilter, type SearchOptions } from "./search.js";

/**
 * The machine-consumable issue shape the soma WorkSource reconcile loop pulls.
 * Stable field names, no ANSI, one JSON object per issue on stdout.
 * See `docs/funnel-contract.md` — this is the contract the Rust operator
 * implements against Linear GraphQL directly.
 */
export interface PullIssue {
  identifier: string;
  title: string;
  state: string;
  stateType: string;
  priority: number;
  labels: string[];
  description: string;
  url: string;
  updatedAt: string;
}

interface PullIssuesData {
  issues: {
    nodes: Array<{
      id: string;
      identifier: string;
      title: string;
      url: string;
      priority: number;
      description: string | null;
      updatedAt: string;
      state: { name: string; type: string } | null;
      labels: { nodes: Array<{ name: string }> } | null;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

// A wider selection than `FLAT_ISSUES_QUERY` — pulls `description` + `labels`
// inline, which the shared flat query omits to keep grooming/triage/cycle
// payloads small. `pull` is the one consumer that needs the full issue body,
// so it gets its own query rather than bloating every other read.
const PULL_ISSUES_QUERY = /* GraphQL */ `
  query PullIssues($filter: IssueFilter, $orderBy: PaginationOrderBy, $first: Int!, $after: String) {
    issues(filter: $filter, orderBy: $orderBy, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        url
        priority
        description
        updatedAt
        state {
          name
          type
        }
        labels {
          nodes {
            name
          }
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
 * Pull issues as machine-consumable JSON — the soma ingestion funnel's read
 * path. Filters reuse {@link buildSearchFilter} (team / state / label /
 * assignee / project / priority / text / updatedSince / createdSince), then
 * a paginated query selects the full issue body + labels inline.
 *
 * Default scope is active states (completed/canceled excluded), matching
 * `search`; `--state all` lifts it. Ordered by `updatedAt` desc.
 */
export async function pullIssues(
  client: LinearClient,
  opts: SearchOptions,
): Promise<PullIssue[]> {
  const needsResolution = opts.assignee !== undefined && opts.assignee !== "none";
  const resolvedAssigneeId = needsResolution
    ? await import("./issues.js").then((m) => m.resolveAssignee(client, opts.assignee as string))
    : undefined;

  const filter = buildSearchFilter(opts, resolvedAssigneeId);

  // Dedupe by id: under `orderBy: updatedAt`, a row whose updatedAt changes
  // mid-scan can reappear across page boundaries (cursor instability). See
  // collectIssuesFlat for the same guard.
  const byId = new Map<string, PullIssue>();
  let after: string | null = null;
  do {
    const vars: { filter: LinearDocument.IssueFilter; orderBy?: LinearDocument.PaginationOrderBy; first: number; after: string | null } = {
      filter,
      orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
      first: 100,
      after,
    };
    const res = await withRetry(() =>
      client.client.rawRequest<PullIssuesData, typeof vars>(PULL_ISSUES_QUERY, vars),
    );
    const page = res.data?.issues;
    if (!page) throw new Error("pull query returned no data");
    for (const n of page.nodes) {
      byId.set(n.id, {
        identifier: n.identifier,
        title: n.title,
        state: n.state?.name ?? "",
        stateType: n.state?.type ?? "",
        priority: n.priority ?? 0,
        labels: (n.labels?.nodes ?? []).map((l) => l.name).sort(),
        description: n.description ?? "",
        url: n.url,
        updatedAt: n.updatedAt,
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  return [...byId.values()];
}
