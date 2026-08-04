import type { LinearClient } from "@linear/sdk";
import { collectIssuesFlat, scopedTeams, type FlatIssueNode } from "./issues-query.js";

export interface MineItem {
  identifier: string;
  title: string;
  state: string;
  priority: number;
  url: string;
}

export interface MineGroup {
  type: string;
  count: number;
  items: MineItem[];
}

export interface MineResult {
  total: number;
  groups: MineGroup[];
}

// Active-first: what am I doing → what needs a decision → what's queued.
// completed/canceled only appear under --all.
const MINE_ORDER = ["started", "triage", "unstarted", "backlog", "completed", "canceled"];

/** Priority sort key: 1=Urgent first, 0=None last. */
function priorityKey(p: number): number {
  return p === 0 ? 5 : p;
}

/** Group + order the viewer's issues. Pure — exported for tests. */
export function groupMine(nodes: FlatIssueNode[]): MineResult {
  const byType = new Map<string, MineItem[]>();
  for (const n of nodes) {
    const type = n.state?.type ?? "unknown";
    const items = byType.get(type) ?? [];
    items.push({
      identifier: n.identifier,
      title: n.title,
      state: n.state?.name ?? "",
      priority: n.priority ?? 0,
      url: n.url,
    });
    byType.set(type, items);
  }

  const groups: MineGroup[] = [...byType.entries()]
    .sort(([a], [b]) => {
      const ia = MINE_ORDER.indexOf(a);
      const ib = MINE_ORDER.indexOf(b);
      return (ia === -1 ? MINE_ORDER.length : ia) - (ib === -1 ? MINE_ORDER.length : ib);
    })
    .map(([type, items]) => ({
      type,
      count: items.length,
      items: items.sort((a, b) => priorityKey(a.priority) - priorityKey(b.priority)),
    }));

  return { total: nodes.length, groups };
}

/**
 * The viewer's issues grouped by workflow-state type, active states first.
 * Server-side scoped: `assignee.isMe` plus optional team keys; completed +
 * canceled are excluded unless `all` (a "what am I doing" view should not
 * page through history by default).
 */
export async function mine(
  client: LinearClient,
  teamKeys?: string[],
  all?: boolean,
): Promise<MineResult> {
  const teams = scopedTeams(teamKeys);
  const nodes = await collectIssuesFlat(client, {
    assignee: { isMe: { eq: true } },
    ...(teams ? { team: { key: { in: teams } } } : {}),
    ...(all ? {} : { state: { type: { nin: ["completed", "canceled"] } } }),
  });
  return groupMine(nodes);
}
