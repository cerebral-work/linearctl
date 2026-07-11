import type { LinearClient } from "@linear/sdk";
import { withRetry } from "../lib/retry.js";
import { scopedTeams, projectClause } from "./issues-query.js";

export interface ReleaseNoteItem {
  identifier: string;
  title: string;
  url: string;
  completedAt: string;
}

export interface ReleaseNotesResult {
  from: string;
  until: string;
  total: number;
  groups: Array<{ label: string; items: ReleaseNoteItem[] }>;
}

const COMPLETED_QUERY = /* GraphQL */ `
  query CompletedForNotes($filter: IssueFilter, $first: Int!, $after: String) {
    issues(filter: $filter, first: $first, after: $after) {
      nodes {
        id
        identifier
        title
        url
        completedAt
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
 * Assemble release notes from issues COMPLETED in [from, until), grouped by
 * label (an issue with several labels lands under its first, alphabetically;
 * unlabeled → "other"). Feeds cut-release / linear-release. Read-only.
 * See spec §7 item 4 (CER-1146).
 */
export async function releaseNotes(
  client: LinearClient,
  opts: { from: Date; until?: Date; teamKeys?: string[]; project?: string },
): Promise<ReleaseNotesResult> {
  const teams = scopedTeams(opts.teamKeys);
  const until = opts.until ?? new Date();
  const filter = {
    ...(teams ? { team: { key: { in: teams } } } : {}),
    completedAt: { gte: opts.from, lte: until },
    ...(opts.project ? { and: projectClause(opts.project) } : {}),
  };

  type Vars = Record<string, unknown> & { first: number; after: string | null };
  const byId = new Map<string, { item: ReleaseNoteItem; label: string }>();
  let after: string | null = null;
  do {
    const vars: Vars = { filter, first: 100, after };
    const res = await withRetry(() =>
      client.client.rawRequest<
        {
          issues: {
            nodes: Array<{
              id: string;
              identifier: string;
              title: string;
              url: string;
              completedAt: string | null;
              labels: { nodes: Array<{ name: string }> };
            }>;
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        },
        Vars
      >(COMPLETED_QUERY, vars),
    );
    const page = res.data?.issues;
    if (!page) throw new Error("issues query returned no data");
    for (const n of page.nodes) {
      const label = n.labels.nodes.map((l) => l.name).sort()[0] ?? "other";
      byId.set(n.id, {
        label,
        item: {
          identifier: n.identifier,
          title: n.title,
          url: n.url,
          completedAt: n.completedAt ?? "",
        },
      });
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);

  const byLabel = new Map<string, ReleaseNoteItem[]>();
  for (const { label, item } of byId.values()) {
    const bucket = byLabel.get(label);
    if (bucket) bucket.push(item);
    else byLabel.set(label, [item]);
  }
  const groups = [...byLabel.entries()]
    .map(([label, items]) => ({
      label,
      items: items.sort((a, b) => a.completedAt.localeCompare(b.completedAt)),
    }))
    .sort((a, b) =>
      a.label === "other" ? 1 : b.label === "other" ? -1 : a.label.localeCompare(b.label),
    );

  return {
    from: opts.from.toISOString(),
    until: until.toISOString(),
    total: byId.size,
    groups,
  };
}

/** Render the result as release-notes markdown. Pure — exported for tests. */
export function renderReleaseNotes(r: ReleaseNotesResult): string {
  const lines = [
    `## Completed ${r.from.slice(0, 10)} → ${r.until.slice(0, 10)} (${r.total} issue${r.total === 1 ? "" : "s"})`,
  ];
  for (const g of r.groups) {
    lines.push("", `### ${g.label}`, "");
    for (const i of g.items) lines.push(`- ${i.identifier}: ${i.title} (${i.url})`);
  }
  return lines.join("\n") + "\n";
}
