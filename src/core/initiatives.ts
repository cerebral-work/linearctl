import type { LinearClient } from "@linear/sdk";
import { withRetry } from "../lib/retry.js";

export interface InitiativeProject {
  name: string;
  state: string;
  /** 0..1 as reported by Linear. */
  progress: number;
  targetDate: string | null;
  url: string;
}

export interface InitiativeRollup {
  name: string;
  status: string;
  targetDate: string | null;
  url: string;
  projects: InitiativeProject[];
  /** Mean of project progress, 0..1; null with no projects. */
  progress: number | null;
}

interface InitiativesData {
  initiatives: {
    nodes: {
      id: string;
      name: string;
      status: string;
      targetDate: string | null;
      url: string;
      projects: {
        nodes: {
          name: string;
          state: string;
          progress: number;
          targetDate: string | null;
          url: string;
        }[];
      };
    }[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

// Projects selected inline (same N+1 avoidance as issues-query). 50 projects
// per initiative is far above any real initiative on this workspace.
const INITIATIVES_QUERY = /* GraphQL */ `
  query InitiativeRollup($first: Int!, $after: String) {
    initiatives(first: $first, after: $after) {
      nodes {
        id
        name
        status
        targetDate
        url
        projects(first: 50) {
          nodes {
            name
            state
            progress
            targetDate
            url
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

/** Shape one initiative node into a rollup. Pure — exported for tests. */
export function rollupInitiative(
  node: InitiativesData["initiatives"]["nodes"][number],
): InitiativeRollup {
  const projects = node.projects.nodes.map((p) => ({
    name: p.name,
    state: p.state,
    progress: p.progress,
    targetDate: p.targetDate,
    url: p.url,
  }));
  const progress =
    projects.length === 0
      ? null
      : projects.reduce((sum, p) => sum + p.progress, 0) / projects.length;
  return {
    name: node.name,
    status: node.status,
    targetDate: node.targetDate,
    url: node.url,
    projects,
    progress,
  };
}

/**
 * Initiative rollup: every initiative with its projects and a mean progress.
 * Completed initiatives are excluded unless `all` — the rollup is a
 * where-are-we view, not an archive.
 */
export async function initiatives(
  client: LinearClient,
  all?: boolean,
): Promise<InitiativeRollup[]> {
  type Vars = Record<string, unknown> & { first: number; after: string | null };
  const nodes: InitiativesData["initiatives"]["nodes"] = [];
  let after: string | null = null;
  do {
    const vars: Vars = { first: 50, after };
    const res = await withRetry(() =>
      client.client.rawRequest<InitiativesData, Vars>(INITIATIVES_QUERY, vars),
    );
    const page = res.data?.initiatives;
    if (!page) throw new Error("initiatives query returned no data");
    nodes.push(...page.nodes);
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  return nodes
    .map(rollupInitiative)
    .filter((i) => all || i.status.toLowerCase() !== "completed");
}
