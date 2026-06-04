import type { LinearClient, Project, ProjectMilestone } from "@linear/sdk";
import { mapPool } from "../lib/pool.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a project by UUID, slug id, or name (case-insensitive). */
async function resolveProject(client: LinearClient, ref: string): Promise<Project> {
  if (UUID_RE.test(ref)) return client.project(ref);
  const projects = await client.projects({
    filter: { or: [{ name: { eqIgnoreCase: ref } }, { slugId: { eq: ref } }] },
  });
  const project = projects.nodes[0];
  if (!project) throw new Error(`no project matching ${JSON.stringify(ref)}.`);
  return project;
}

/** Count every issue matching a filter (paginated; connection has no aggregate). */
async function countIssues(
  client: LinearClient,
  filter: Record<string, unknown>,
): Promise<number> {
  let page = await client.issues({ filter, first: 250 });
  let n = page.nodes.length;
  while (page.pageInfo.hasNextPage) {
    page = await page.fetchNext();
    n += page.nodes.length;
  }
  return n;
}

export interface MilestoneProgress {
  name: string;
  targetDate: string | null;
  done: number;
  total: number;
  percent: number;
}

export interface MilestoneResult {
  project: string | null;
  milestones: MilestoneProgress[];
}

/**
 * Per-milestone burn-down (issues done vs open) for a project, or across all
 * accessible milestones when `projectRef` is omitted. Counts come from two
 * filtered queries per milestone (total, and `state.type = completed`) — no
 * per-issue N+1. See docs/spec.md §6.5.
 */
export async function milestones(
  client: LinearClient,
  projectRef?: string,
): Promise<MilestoneResult> {
  let projectName: string | null = null;
  let page;
  if (projectRef) {
    const project = await resolveProject(client, projectRef);
    projectName = project.name;
    page = await project.projectMilestones({ first: 100 });
  } else {
    page = await client.projectMilestones({ first: 100 });
  }
  const all: ProjectMilestone[] = [...page.nodes];
  while (page.pageInfo.hasNextPage) {
    page = await page.fetchNext();
    all.push(...page.nodes);
  }

  const progress = await mapPool(all, 5, async (m) => {
    const base = { projectMilestone: { id: { eq: m.id } } };
    const [total, done] = await Promise.all([
      countIssues(client, base),
      countIssues(client, { ...base, state: { type: { eq: "completed" } } }),
    ]);
    return {
      name: m.name,
      targetDate: m.targetDate ? new Date(m.targetDate).toISOString().slice(0, 10) : null,
      done,
      total,
      percent: total === 0 ? 0 : Math.round((done / total) * 100),
    } satisfies MilestoneProgress;
  });

  return { project: projectName, milestones: progress };
}
