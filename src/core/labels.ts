import { notFoundError, usageError } from "../lib/errors.js";
import type { LinearClient } from "@linear/sdk";
import { withRetry } from "../lib/retry.js";
import { resolveTeamByKey } from "./teams.js";
import { scopedTeams } from "./issues-query.js";

export interface LabelInfo {
  id: string;
  name: string;
  color: string | null;
  team: string | null;
  /** Present only when the caller asked for the usage sweep. */
  issues?: number;
}

/** A label listing plus whether it was cut short by `limit`. */
export interface LabelListing {
  labels: LabelInfo[];
  /** True only when `limit` truncated the result; a short last page is complete. */
  partial: boolean;
}

export interface ListLabelsOptions {
  teamKeys?: string[];
  counts?: boolean;
  /** Cap the rows returned. Marks the listing partial when it truncates. */
  limit?: number;
}

const LIST_LABELS_QUERY = /* GraphQL */ `
  query ListLabels($filter: IssueLabelFilter, $first: Int!, $after: String) {
    issueLabels(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        name
        color
        team {
          key
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

interface RawLabelNode {
  id: string;
  name: string;
  color: string | null;
  team: { key: string } | null;
}

/**
 * Decide the next cursor, or null to stop. A paginated read must terminate on
 * any response the server can produce, so this refuses two shapes that would
 * otherwise spin forever: `hasNextPage` without an `endCursor`, and a cursor
 * identical to the one just used (a server that never advances). Treating
 * either as "done" would silently truncate, so the repeated cursor throws.
 */
function nextCursor(
  pageInfo: { hasNextPage?: boolean; endCursor?: string | null } | null | undefined,
  previous: string | null,
  connection: string,
): string | null {
  if (!pageInfo?.hasNextPage) return null;
  const cursor = pageInfo.endCursor ?? null;
  if (!cursor) return null;
  if (previous !== null && cursor === previous) {
    throw new Error(`${connection} pagination did not advance (cursor repeated); aborting.`);
  }
  return cursor;
}

/**
 * List labels, optionally team-scoped. Follows cursors to the end — a
 * workspace with more labels than one page used to be silently cut off at the
 * first page, reporting a short list as if it were complete.
 *
 * Linear's API exposes no per-label issue count, so `counts: true` runs a
 * paginated team-issue sweep and aggregates client-side — opt-in because it
 * costs one request per 100 issues.
 */
export async function listLabelsPaged(
  client: LinearClient,
  opts: ListLabelsOptions = {},
): Promise<LabelListing> {
  const { limit } = opts;
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
    throw usageError("--limit must be a positive integer.");
  }
  const teams = scopedTeams(opts.teamKeys);
  const filter = teams
    ? { or: [{ team: { key: { in: teams } } }, { team: { null: true } }] }
    : undefined;

  // Dedupe by id: a label mutated mid-scan can otherwise reappear across a
  // page boundary (cursor instability), the same guard pullIssues uses.
  const byId = new Map<string, LabelInfo>();
  let after: string | null = null;
  type Vars = { filter?: unknown; first: number; after: string | null };
  do {
    const vars: Vars = { ...(filter ? { filter } : {}), first: 100, after };
    const res = await withRetry(() =>
      client.client.rawRequest<
        {
          issueLabels: {
            nodes: RawLabelNode[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        },
        Vars
      >(LIST_LABELS_QUERY, vars),
    );
    const page = res.data?.issueLabels;
    if (!page) throw new Error("issueLabels query returned no data");
    for (const l of page.nodes ?? []) {
      byId.set(l.id, { id: l.id, name: l.name, color: l.color ?? null, team: l.team?.key ?? null });
    }
    after = nextCursor(page.pageInfo, after, "issueLabels");
    // Deliberately no early exit on `limit`: the API returns labels in its own
    // order, so stopping at the first `limit` rows would cap an arbitrary
    // subset and then sort only that. Fetch every page, sort, then truncate —
    // the cap must be the prefix of the whole listing, not of one page.
  } while (after);

  const rows = [...byId.values()];
  // Sort the complete listing before truncating, so `limit` yields a stable
  // prefix that does not depend on page boundaries or server ordering.
  rows.sort((a, b) => (a.team ?? "").localeCompare(b.team ?? "") || a.name.localeCompare(b.name));
  const partial = limit !== undefined && rows.length > limit;
  const labels = limit !== undefined ? rows.slice(0, limit) : rows;

  if (opts.counts) {
    const usage = await labelUsage(client, teams);
    for (const r of labels) r.issues = usage.get(r.id) ?? 0;
  }
  return { labels, partial };
}

/**
 * Array-returning form, preserved as the stable entry point for callers that
 * do not care about truncation.
 */
export async function listLabels(
  client: LinearClient,
  opts: ListLabelsOptions = {},
): Promise<LabelInfo[]> {
  return (await listLabelsPaged(client, opts)).labels;
}

const LABEL_USAGE_QUERY = /* GraphQL */ `
  query LabelUsage($filter: IssueFilter, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        labels {
          nodes {
            id
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

async function labelUsage(
  client: LinearClient,
  teams: string[] | undefined,
): Promise<Map<string, number>> {
  type Vars = Record<string, unknown> & { first: number; after: string | null };
  const counts = new Map<string, number>();
  let after: string | null = null;
  do {
    const vars: Vars = {
      filter: teams ? { team: { key: { in: teams } } } : {},
      first: 100,
      after,
    };
    const res = await withRetry(() =>
      client.client.rawRequest<
        {
          issues: {
            nodes: Array<{ id: string; labels: { nodes: Array<{ id: string }> } }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        },
        Vars
      >(LABEL_USAGE_QUERY, vars),
    );
    const page = res.data?.issues;
    if (!page) throw new Error("issues query returned no data");
    for (const issue of page.nodes ?? []) {
      for (const l of issue.labels?.nodes ?? []) counts.set(l.id, (counts.get(l.id) ?? 0) + 1);
    }
    after = nextCursor(page.pageInfo, after, "issues");
  } while (after);
  return counts;
}

/** Create a team label. Additive, non-destructive; no --apply gate by design. */
export async function createLabel(
  client: LinearClient,
  opts: { teamKey: string; name: string; color?: string },
): Promise<LabelInfo> {
  const team = await resolveTeamByKey(client, opts.teamKey);
  const res = await withRetry(() =>
    client.createIssueLabel({
      teamId: team.id,
      name: opts.name,
      ...(opts.color ? { color: opts.color } : {}),
    }),
  );
  const label = await res.issueLabel;
  if (!res.success || !label) {
    throw new Error(`could not create label ${JSON.stringify(opts.name)}.`);
  }
  return { id: label.id, name: label.name, color: label.color ?? null, team: team.key };
}

/** Rename a team label (issues re-tag automatically; reversible). */
export async function renameLabel(
  client: LinearClient,
  opts: { teamKey: string; from: string; to: string },
): Promise<LabelInfo> {
  const team = await resolveTeamByKey(client, opts.teamKey);
  const found = await withRetry(() =>
    client.issueLabels({
      filter: {
        and: [{ team: { id: { eq: team.id } } }, { name: { eqIgnoreCase: opts.from } }],
      },
    }),
  );
  const label = found.nodes[0];
  if (!label) {
    throw notFoundError(`no label ${JSON.stringify(opts.from)} on team ${opts.teamKey}.`);
  }
  const res = await withRetry(() => client.updateIssueLabel(label.id, { name: opts.to }));
  const updated = await res.issueLabel;
  if (!res.success || !updated) {
    throw new Error(`could not rename label ${JSON.stringify(opts.from)}.`);
  }
  return { id: updated.id, name: updated.name, color: updated.color ?? null, team: team.key };
}
