import type { LinearClient } from "@linear/sdk";
import { LinearDocument } from "@linear/sdk";
import { sinceToDate } from "../lib/time.js";
import { parsePriority } from "../lib/priority.js";
import { resolveAssignee } from "./issues.js";
import {
  collectIssuesFlat,
  projectClause,
  scopedTeams,
  type FlatIssueNode,
} from "./issues-query.js";

export interface SearchOptions {
  teamKeys?: string[];
  state?: string;
  /** Filter to issues matching ANY of these state names/types (OR logic). e.g. ["Todo","Backlog"]. */
  stateSet?: string[];
  labels?: string[];
  assignee?: string;
  project?: string;
  priority?: string;
  text?: string;
  updatedSince?: string;
  createdSince?: string;
  /** Cap results for safe soma dev/testing or rate-budget pulls. */
  limit?: number;
}

export interface SearchItem {
  identifier: string;
  title: string;
  state: string;
  stateType: string;
  assignee: string | null;
  priority: number;
  url: string;
}

/** Friendly `--state` keywords → Linear workflow-state types. */
const STATE_TYPE_ALIASES: Record<string, string> = {
  triage: "triage",
  backlog: "backlog",
  todo: "unstarted",
  unstarted: "unstarted",
  started: "started",
  "in-progress": "started",
  done: "completed",
  completed: "completed",
  canceled: "canceled",
  cancelled: "canceled",
};

/**
 * Compose a Linear `IssueFilter` from search flags (AND logic). Pure — the one
 * async input (assignee resolution) is passed in pre-resolved. Default scope is
 * active states (completed/canceled excluded), matching `triage`'s safe default;
 * `--state all` lifts it, `--state done` (etc.) replaces it.
 */
export function buildSearchFilter(
  opts: SearchOptions,
  resolvedAssigneeId?: string,
  now: Date = new Date(),
): LinearDocument.IssueFilter {
  const and: Record<string, unknown>[] = [];

  // stateSet: OR across multiple state names/types (e.g. ["Todo","Backlog"]).
  // Takes precedence over --state; when present, the default active-only filter
  // is NOT applied (the caller explicitly scoped the states).
  if (opts.stateSet?.length) {
    const clauses = opts.stateSet.map((s) => {
      const alias = STATE_TYPE_ALIASES[s.toLowerCase()];
      return alias
        ? { state: { type: { eq: alias } } }
        : { state: { name: { eqIgnoreCase: s } } };
    });
    and.push(clauses.length === 1 ? clauses[0] : { or: clauses });
  } else {
    const state = opts.state?.toLowerCase();
    if (!state) {
      and.push({ state: { type: { nin: ["completed", "canceled"] } } });
    } else if (state !== "all") {
      const type = STATE_TYPE_ALIASES[state];
      and.push(
        type
          ? { state: { type: { eq: type } } }
          : { state: { name: { eqIgnoreCase: opts.state } } },
      );
    }
  }

  for (const label of opts.labels ?? []) {
    and.push({ labels: { some: { name: { eqIgnoreCase: label } } } });
  }

  if (opts.assignee === "none") {
    and.push({ assignee: { null: true } });
  } else if (resolvedAssigneeId) {
    and.push({ assignee: { id: { eq: resolvedAssigneeId } } });
  }

  and.push(...projectClause(opts.project));

  if (opts.priority !== undefined) {
    and.push({ priority: { eq: parsePriority(opts.priority) } });
  }

  if (opts.text) {
    // Server-side full-text over title + description — no re-ranking (spec: non-goal).
    and.push({
      or: [
        { title: { containsIgnoreCase: opts.text } },
        { description: { containsIgnoreCase: opts.text } },
      ],
    });
  }

  if (opts.updatedSince) and.push({ updatedAt: { gte: sinceToDate(opts.updatedSince, now) } });
  if (opts.createdSince) and.push({ createdAt: { gte: sinceToDate(opts.createdSince, now) } });

  const teams = scopedTeams(opts.teamKeys);
  return {
    ...(teams ? { team: { key: { in: teams } } } : {}),
    ...(and.length ? { and } : {}),
  } as LinearDocument.IssueFilter;
}

/**
 * `linearctl search` — arbitrary-criteria issue query, the `grep` for Linear
 * (docs/features/search.md, CER-1560). One paginated flat query; every filter
 * is applied server-side.
 */
export async function search(
  client: LinearClient,
  opts: SearchOptions,
): Promise<SearchItem[]> {
  const needsResolution =
    opts.assignee !== undefined && opts.assignee !== "none";
  const resolvedAssigneeId = needsResolution
    ? await resolveAssignee(client, opts.assignee as string)
    : undefined;

  const issues = await collectIssuesFlat(
    client,
    buildSearchFilter(opts, resolvedAssigneeId),
    LinearDocument.PaginationOrderBy.UpdatedAt,
  );

  return issues.map((issue: FlatIssueNode) => ({
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state?.name ?? "",
    stateType: issue.state?.type ?? "",
    assignee: issue.assignee?.displayName ?? null,
    priority: issue.priority ?? 0,
    url: issue.url,
  }));
}
