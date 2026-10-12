import type { BeadsIssue, BeadsStatus } from "./types.js";

export interface BlockerInfo {
  id: string;
  title: string;
  status: BeadsStatus;
  priority: number;
}

export interface ReadyEvaluationResult {
  ready: BeadsIssue[];
  blocked: {
    issue: BeadsIssue;
    blockers: BlockerInfo[];
  }[];
}

/**
 * Builds an index of issues by id and external_ref for fast lookup.
 */
export function buildIssueIndex(issues: BeadsIssue[]): Map<string, BeadsIssue> {
  const index = new Map<string, BeadsIssue>();
  for (const issue of issues) {
    index.set(issue.id, issue);
    if (issue.external_ref) {
      index.set(issue.external_ref, issue);
    }
  }
  return index;
}

/**
 * Evaluates all issues in the local graph and partitions them into ready and blocked.
 * An issue is ready if:
 * 1. status === "open"
 * 2. defer_until is either unset or in the past
 * 3. All dependencies with type === "blocks" point to issues whose status === "closed"
 */
export function evaluateReadiness(issues: BeadsIssue[]): ReadyEvaluationResult {
  const index = buildIssueIndex(issues);
  const now = new Date();

  const ready: BeadsIssue[] = [];
  const blocked: { issue: BeadsIssue; blockers: BlockerInfo[] }[] = [];

  for (const issue of issues) {
    if (issue.status !== "open") {
      continue;
    }

    if (issue.defer_until) {
      const deferDate = new Date(issue.defer_until);
      if (deferDate > now) {
        continue; // Still deferred
      }
    }

    const blockers: BlockerInfo[] = [];
    const deps = issue.dependencies || [];

    for (const dep of deps) {
      if (dep.type === "blocks" && dep.issue_id === issue.id) {
        const blocker = index.get(dep.depends_on_id);
        if (blocker) {
          if (blocker.status !== "closed") {
            blockers.push({
              id: blocker.id,
              title: blocker.title,
              status: blocker.status,
              priority: blocker.priority,
            });
          }
        } else {
          // Blocker is unknown / external: treat as unresolved blocker
          blockers.push({
            id: dep.depends_on_id,
            title: "(external issue)",
            status: "open",
            priority: 4,
          });
        }
      }
    }

    if (blockers.length === 0) {
      ready.push(issue);
    } else {
      blocked.push({ issue, blockers });
    }
  }

  // Sort ready issues by priority ascending (0=critical first), then created_at ascending
  ready.sort((a, b) => {
    if (a.priority !== b.priority) {
      return a.priority - b.priority;
    }
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  return { ready, blocked };
}

/**
 * Returns all ready (unblocked) issues.
 */
export function getReadyIssues(issues: BeadsIssue[]): BeadsIssue[] {
  return evaluateReadiness(issues).ready;
}

/**
 * Get active blockers for a specific issue.
 */
export function getIssueBlockers(issueId: string, issues: BeadsIssue[]): BlockerInfo[] {
  const index = buildIssueIndex(issues);
  const target = index.get(issueId);
  if (!target) return [];

  const blockers: BlockerInfo[] = [];
  for (const dep of target.dependencies || []) {
    if (dep.type === "blocks" && dep.issue_id === target.id) {
      const blocker = index.get(dep.depends_on_id);
      if (blocker && blocker.status !== "closed") {
        blockers.push({
          id: blocker.id,
          title: blocker.title,
          status: blocker.status,
          priority: blocker.priority,
        });
      } else if (!blocker) {
        blockers.push({
          id: dep.depends_on_id,
          title: "(external issue)",
          status: "open",
          priority: 4,
        });
      }
    }
  }
  return blockers;
}

/**
 * Get dependent issues (issues that this issue is currently blocking).
 */
export function getIssueDependents(issueId: string, issues: BeadsIssue[]): BeadsIssue[] {
  const index = buildIssueIndex(issues);
  const target = index.get(issueId);
  if (!target) return [];

  const dependents: BeadsIssue[] = [];
  for (const issue of issues) {
    for (const dep of issue.dependencies || []) {
      if (dep.type === "blocks" && dep.depends_on_id === target.id && dep.issue_id === issue.id) {
        dependents.push(issue);
      }
    }
  }
  return dependents;
}

/**
 * Atomically claim an issue: transitions status to in_progress, sets assignee, and stamps started_at.
 */
export function claimIssue(
  issueId: string,
  actor: string,
  issues: BeadsIssue[]
): { updatedIssue: BeadsIssue; allIssues: BeadsIssue[] } {
  const index = buildIssueIndex(issues);
  const target = index.get(issueId);

  if (!target) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  if (target.status === "closed") {
    throw new Error(`Cannot claim closed issue: ${issueId}`);
  }

  const now = new Date().toISOString();
  const updatedIssue: BeadsIssue = {
    ...target,
    status: "in_progress",
    assignee: actor,
    started_at: target.started_at || now,
    updated_at: now,
  };

  const allIssues = issues.map((i) => (i.id === target.id ? updatedIssue : i));
  return { updatedIssue, allIssues };
}

/**
 * Close an issue: transitions status to closed, stamps closed_at, and identifies newly unblocked ready issues.
 */
export function closeIssue(
  issueId: string,
  options: { reason?: string; session?: string } = {},
  issues: BeadsIssue[]
): { closedIssue: BeadsIssue; newlyReady: BeadsIssue[]; allIssues: BeadsIssue[] } {
  const index = buildIssueIndex(issues);
  const target = index.get(issueId);

  if (!target) {
    throw new Error(`Issue not found: ${issueId}`);
  }

  const beforeReadyIds = new Set(getReadyIssues(issues).map((i) => i.id));
  const now = new Date().toISOString();

  const closedIssue: BeadsIssue = {
    ...target,
    status: "closed",
    closed_at: now,
    close_reason: options.reason || "Completed",
    closed_by_session: options.session,
    updated_at: now,
  };

  const allIssues = issues.map((i) => (i.id === target.id ? closedIssue : i));
  const afterReady = getReadyIssues(allIssues);
  const newlyReady = afterReady.filter((i) => !beforeReadyIds.has(i.id) && i.id !== closedIssue.id);

  return { closedIssue, newlyReady, allIssues };
}

/**
 * Detect cycles in the blocking dependency graph.
 * Returns arrays of issue IDs that form cycles.
 */
export function detectCycles(issues: BeadsIssue[]): string[][] {
  const adj = new Map<string, string[]>();
  for (const issue of issues) {
    const blockers: string[] = [];
    for (const dep of issue.dependencies || []) {
      if (dep.type === "blocks" && dep.issue_id === issue.id) {
        blockers.push(dep.depends_on_id);
      }
    }
    adj.set(issue.id, blockers);
  }

  const visited = new Set<string>();
  const recStack = new Set<string>();
  const cycles: string[][] = [];

  function dfs(node: string, path: string[]) {
    visited.add(node);
    recStack.add(node);
    path.push(node);

    const neighbors = adj.get(node) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        dfs(neighbor, path);
      } else if (recStack.has(neighbor)) {
        const cycleStartIndex = path.indexOf(neighbor);
        if (cycleStartIndex !== -1) {
          cycles.push([...path.slice(cycleStartIndex), neighbor]);
        }
      }
    }

    recStack.delete(node);
    path.pop();
  }

  for (const issue of issues) {
    if (!visited.has(issue.id)) {
      dfs(issue.id, []);
    }
  }

  return cycles;
}
