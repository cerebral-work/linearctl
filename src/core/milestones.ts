import type { LinearClient, ProjectMilestone } from "@linear/sdk";
import { mapPool } from "../lib/pool.js";
import { withRetry } from "../lib/retry.js";
import { resolveProject, UUID_RE } from "./projects.js";

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
  id: string;
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
      id: m.id,
      name: m.name,
      targetDate: m.targetDate ? new Date(m.targetDate).toISOString().slice(0, 10) : null,
      done,
      total,
      percent: total === 0 ? 0 : Math.round((done / total) * 100),
    } satisfies MilestoneProgress;
  });

  return { project: projectName, milestones: progress };
}

/**
 * Resolve a milestone ref (UUID passes through, else a name) to its id. Milestones
 * are project-scoped, so pass `projectId` to disambiguate by-name within a project;
 * without it, the first workspace-wide name match wins. Throws on no match.
 */
export async function resolveMilestoneId(
  client: LinearClient,
  ref: string,
  projectId?: string,
): Promise<string> {
  if (UUID_RE.test(ref)) return ref;
  const lc = ref.trim().toLowerCase();
  const nodes = projectId
    ? (await (await withRetry(() => client.project(projectId))).projectMilestones({ first: 100 })).nodes
    : (await withRetry(() => client.projectMilestones({ first: 250 }))).nodes;
  const m = nodes.find((n) => n.name.toLowerCase() === lc);
  if (!m) throw new Error(`no milestone matching ${JSON.stringify(ref)}.`);
  return m.id;
}

export interface DeletedMilestone {
  id: string;
  name: string;
  deleted: boolean;
}

/**
 * Delete a project milestone by UUID. Fetches it first (to surface the name and
 * fail clearly on a bad id), then deletes only when `apply` — `apply: false` is
 * a dry-run preview, mirroring `stale`'s contract for a destructive op. Deleting
 * a milestone removes the grouping only; its issues are not deleted. spec §6.5.
 */
export async function deleteMilestone(
  client: LinearClient,
  id: string,
  apply: boolean,
): Promise<DeletedMilestone> {
  const milestone = await withRetry(() => client.projectMilestone(id));
  if (!milestone) throw new Error(`no milestone with id ${JSON.stringify(id)}.`);
  if (apply) {
    const res = await withRetry(() => client.deleteProjectMilestone(id));
    if (!res.success) throw new Error("Linear reported the milestone delete did not succeed.");
  }
  return { id, name: milestone.name, deleted: apply };
}

export interface CreateMilestoneParams {
  name: string;
  projectRef: string;
  targetDate?: string;
  description?: string;
}

export interface CreatedMilestone {
  id: string;
  name: string;
  project: string;
  targetDate: string | null;
}

/**
 * Create a project milestone. Resolves the project ref (name or UUID) via
 * `resolveProject`, then `client.createProjectMilestone`. The `targetDate`
 * must be `YYYY-MM-DD` (Linear's `TimelessDate` scalar). See CER-1686.
 */
export async function createMilestone(
  client: LinearClient,
  params: CreateMilestoneParams,
): Promise<CreatedMilestone> {
  const project = await resolveProject(client, params.projectRef);

  const res = await withRetry(() =>
    client.createProjectMilestone({
      name: params.name,
      projectId: project.id,
      ...(params.description ? { description: params.description } : {}),
      ...(params.targetDate ? { targetDate: params.targetDate } : {}),
    }),
  );
  if (!res.success) {
    throw new Error("Linear reported the milestone create did not succeed.");
  }
  const ms = await res.projectMilestone;
  if (!ms) {
    throw new Error("milestone created but the payload returned no milestone.");
  }

  return {
    id: ms.id,
    name: ms.name,
    project: project.name,
    targetDate: ms.targetDate ? new Date(ms.targetDate).toISOString().slice(0, 10) : null,
  };
}
