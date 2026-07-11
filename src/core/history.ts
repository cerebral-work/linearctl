import type { LinearClient } from "@linear/sdk";
import { withRetry } from "../lib/retry.js";

/** Raw shapes as returned by the probed GraphQL query (see HISTORY_QUERY). */
export interface HistoryNode {
  createdAt: string;
  actor: { displayName: string } | null;
  fromState: { name: string } | null;
  toState: { name: string } | null;
  fromAssignee: { displayName: string } | null;
  toAssignee: { displayName: string } | null;
  fromPriority: number | null;
  toPriority: number | null;
  fromTitle: string | null;
  toTitle: string | null;
  updatedDescription: boolean | null;
  addedLabelIds: string[] | null;
  removedLabelIds: string[] | null;
  fromProject: { name: string } | null;
  toProject: { name: string } | null;
}

export interface CommentNode {
  createdAt: string;
  user: { displayName: string } | null;
  body: string;
}

export interface HistoryEvent {
  type:
    | "create"
    | "stateChange"
    | "assignment"
    | "priority"
    | "title"
    | "description"
    | "labels"
    | "projectChange"
    | "comment";
  at: string;
  actor: string;
  detail: string;
}

export interface HistoryResult {
  identifier: string;
  title: string;
  /** Ascending (oldest first) — matches reading order; --limit keeps the newest N. */
  events: HistoryEvent[];
}

const HISTORY_QUERY = /* GraphQL */ `
  query IssueTimeline($id: String!, $first: Int!) {
    issue(id: $id) {
      identifier
      title
      createdAt
      creator {
        displayName
      }
      history(first: $first) {
        nodes {
          createdAt
          actor {
            displayName
          }
          fromState {
            name
          }
          toState {
            name
          }
          fromAssignee {
            displayName
          }
          toAssignee {
            displayName
          }
          fromPriority
          toPriority
          fromTitle
          toTitle
          updatedDescription
          addedLabelIds
          removedLabelIds
          fromProject {
            name
          }
          toProject {
            name
          }
        }
      }
      comments(first: $first) {
        nodes {
          createdAt
          user {
            displayName
          }
          body
        }
      }
    }
  }
`;

const PRIORITY_NAMES = ["None", "Urgent", "High", "Medium", "Low"];
const prio = (p: number | null): string =>
  p === null ? "—" : (PRIORITY_NAMES[p] ?? String(p));

const truncate = (s: string, n = 200): string =>
  s.length > n ? `${s.slice(0, n)}…` : s;

/**
 * Flatten history nodes + comments into a chronological event list. A single
 * history node can carry several changes (state + assignee in one write) —
 * one event per change. Pure; label ids are rendered by the supplied resolver
 * (name lookup happens once, outside). Exported for tests.
 */
export function normalizeTimeline(
  issue: {
    createdAt: string;
    creator: { displayName: string } | null;
    history: HistoryNode[];
    comments: CommentNode[];
  },
  labelName: (id: string) => string = (id) => id,
): HistoryEvent[] {
  const events: HistoryEvent[] = [
    {
      type: "create",
      at: issue.createdAt,
      actor: issue.creator?.displayName ?? "—",
      detail: "created",
    },
  ];

  for (const n of issue.history) {
    const actor = n.actor?.displayName ?? "—";
    const at = n.createdAt;
    if (n.fromState || n.toState) {
      events.push({
        type: "stateChange",
        at,
        actor,
        detail: `state: ${n.fromState?.name ?? "—"} → ${n.toState?.name ?? "—"}`,
      });
    }
    if (n.fromAssignee || n.toAssignee) {
      events.push({
        type: "assignment",
        at,
        actor,
        detail: n.toAssignee
          ? `assigned: ${n.toAssignee.displayName}`
          : `unassigned (was ${n.fromAssignee?.displayName ?? "—"})`,
      });
    }
    if (n.fromPriority !== null || n.toPriority !== null) {
      events.push({
        type: "priority",
        at,
        actor,
        detail: `priority: ${prio(n.fromPriority)} → ${prio(n.toPriority)}`,
      });
    }
    if (n.fromTitle || n.toTitle) {
      events.push({ type: "title", at, actor, detail: `title → ${truncate(n.toTitle ?? "—", 80)}` });
    }
    if (n.updatedDescription) {
      events.push({ type: "description", at, actor, detail: "description edited" });
    }
    if (n.addedLabelIds?.length || n.removedLabelIds?.length) {
      const added = (n.addedLabelIds ?? []).map(labelName).join(", ");
      const removed = (n.removedLabelIds ?? []).map(labelName).join(", ");
      const parts = [added && `+${added}`, removed && `−${removed}`].filter(Boolean);
      events.push({ type: "labels", at, actor, detail: `labels: ${parts.join(" ")}` });
    }
    if (n.fromProject || n.toProject) {
      events.push({
        type: "projectChange",
        at,
        actor,
        detail: `project: ${n.fromProject?.name ?? "—"} → ${n.toProject?.name ?? "—"}`,
      });
    }
  }

  for (const c of issue.comments) {
    events.push({
      type: "comment",
      at: c.createdAt,
      actor: c.user?.displayName ?? "—",
      detail: `comment: ${truncate(c.body.replace(/\s+/g, " "))}`,
    });
  }

  events.sort((a, b) => a.at.localeCompare(b.at));
  return events;
}

/** Fetch and normalize an issue's timeline; `limit` keeps the newest N events. */
export async function history(
  client: LinearClient,
  id: string,
  limit = 20,
): Promise<HistoryResult> {
  type Vars = Record<string, unknown> & { id: string; first: number };
  const vars: Vars = { id, first: Math.min(Math.max(limit, 1), 100) };
  const res = await withRetry(() =>
    client.client.rawRequest<
      {
        issue: {
          identifier: string;
          title: string;
          createdAt: string;
          creator: { displayName: string } | null;
          history: { nodes: HistoryNode[] };
          comments: { nodes: CommentNode[] };
        } | null;
      },
      Vars
    >(HISTORY_QUERY, vars),
  );
  const issue = res.data?.issue;
  if (!issue) throw new Error(`no issue matching ${JSON.stringify(id)}.`);

  // Resolve label names once, only when label events exist.
  const labelIds = new Set<string>();
  for (const n of issue.history.nodes) {
    for (const l of n.addedLabelIds ?? []) labelIds.add(l);
    for (const l of n.removedLabelIds ?? []) labelIds.add(l);
  }
  let labelName: (id: string) => string = (x) => x;
  if (labelIds.size) {
    const labels = await withRetry(() =>
      client.issueLabels({ filter: { id: { in: [...labelIds] } } }),
    );
    const byId = new Map(labels.nodes.map((l) => [l.id, l.name]));
    labelName = (x) => byId.get(x) ?? x;
  }

  const events = normalizeTimeline(
    {
      createdAt: issue.createdAt,
      creator: issue.creator,
      history: issue.history.nodes,
      comments: issue.comments.nodes,
    },
    labelName,
  );

  return {
    identifier: issue.identifier,
    title: issue.title,
    events: events.slice(-limit),
  };
}
