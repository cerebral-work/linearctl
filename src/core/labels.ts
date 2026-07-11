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

/**
 * List labels, optionally team-scoped. Linear's API exposes no per-label
 * issue count, so `counts: true` runs a paginated team-issue sweep and
 * aggregates client-side — opt-in because it costs one request per 100
 * issues; the plain list is a single request.
 */
export async function listLabels(
  client: LinearClient,
  opts: { teamKeys?: string[]; counts?: boolean } = {},
): Promise<LabelInfo[]> {
  const teams = scopedTeams(opts.teamKeys);
  const labels = await withRetry(() =>
    client.issueLabels({
      first: 250,
      ...(teams
        ? { filter: { or: [{ team: { key: { in: teams } } }, { team: { null: true } }] } }
        : {}),
    }),
  );
  const rows: LabelInfo[] = await Promise.all(
    labels.nodes.map(async (l) => {
      const team = await l.team;
      return { id: l.id, name: l.name, color: l.color ?? null, team: team?.key ?? null };
    }),
  );
  rows.sort((a, b) => (a.team ?? "").localeCompare(b.team ?? "") || a.name.localeCompare(b.name));

  if (opts.counts) {
    const usage = await labelUsage(client, teams);
    for (const r of rows) r.issues = usage.get(r.id) ?? 0;
  }
  return rows;
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
    for (const issue of page.nodes) {
      for (const l of issue.labels.nodes) counts.set(l.id, (counts.get(l.id) ?? 0) + 1);
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
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
    throw new Error(`no label ${JSON.stringify(opts.from)} on team ${opts.teamKey}.`);
  }
  const res = await withRetry(() => client.updateIssueLabel(label.id, { name: opts.to }));
  const updated = await res.issueLabel;
  if (!res.success || !updated) {
    throw new Error(`could not rename label ${JSON.stringify(opts.from)}.`);
  }
  return { id: updated.id, name: updated.name, color: updated.color ?? null, team: team.key };
}
