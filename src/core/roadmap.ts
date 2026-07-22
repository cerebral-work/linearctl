import type { LinearClient, ProjectMilestone } from "@linear/sdk";
import { mapPool } from "../lib/pool.js";
import { withRetry } from "../lib/retry.js";
import { resolveProject } from "./projects.js";

export interface RoadmapIssue {
  id: string;
  identifier: string;
  title: string;
  state: string;
  stateType: string;
  assignee: string | null;
  priority: string | null;
}

export interface RoadmapMilestone {
  id: string;
  name: string;
  targetDate: string | null;
  done: number;
  total: number;
  percent: number;
  issues: RoadmapIssue[];
}

export interface RoadmapResult {
  project: string;
  milestones: RoadmapMilestone[];
}

/**
 * Render a project roadmap: milestones sorted by target date, each with
 * progress counts and issue summaries. See CER-1688.
 */
export async function roadmap(
  client: LinearClient,
  projectRef: string,
): Promise<RoadmapResult> {
  const project = await resolveProject(client, projectRef);
  let page = await project.projectMilestones({ first: 100 });
  const all: ProjectMilestone[] = [...page.nodes];
  while (page.pageInfo.hasNextPage) {
    page = await page.fetchNext();
    all.push(...page.nodes);
  }

  const milestones = await mapPool(all, 5, async (m) => {
    const issues = await withRetry(() => m.issues({ first: 100 }));
    const issueList: RoadmapIssue[] = [];
    let ipage = issues;
    for (const issue of ipage.nodes) {
      const state = await issue.state;
      const assignee = await issue.assignee;
      issueList.push({
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        state: state?.name ?? "—",
        stateType: state?.type ?? "—",
        assignee: assignee?.displayName ?? null,
        priority: issue.priorityLabel ?? null,
      });
    }
    while (ipage.pageInfo.hasNextPage) {
      ipage = await ipage.fetchNext();
      for (const issue of ipage.nodes) {
        const state = await issue.state;
        const assignee = await issue.assignee;
        issueList.push({
          id: issue.id,
          identifier: issue.identifier,
          title: issue.title,
          state: state?.name ?? "—",
          stateType: state?.type ?? "—",
          assignee: assignee?.displayName ?? null,
          priority: issue.priorityLabel ?? null,
        });
      }
    }

    const done = issueList.filter((i) => i.stateType === "completed").length;
    const total = issueList.length;

    return {
      id: m.id,
      name: m.name,
      targetDate: m.targetDate ? new Date(m.targetDate).toISOString().slice(0, 10) : null,
      done,
      total,
      percent: total === 0 ? 0 : Math.round((done / total) * 100),
      issues: issueList,
    };
  });

  milestones.sort((a, b) => {
    if (a.targetDate && b.targetDate) return a.targetDate.localeCompare(b.targetDate);
    if (a.targetDate) return -1;
    if (b.targetDate) return 1;
    return 0;
  });

  return { project: project.name, milestones };
}
