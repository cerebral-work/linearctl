import type { LinearClient } from "@linear/sdk";
import { closestNames } from "../lib/closest.js";
import { notFoundError } from "../lib/errors.js";
import { withRetry } from "../lib/retry.js";
import { resolveProject, UUID_RE } from "./projects.js";

/** Resolve every matching name, so workspace-wide reads never pick an arbitrary project. */
export async function resolveReadMilestones(
  client: LinearClient,
  ref: string | undefined,
  projectRef?: string,
): Promise<{ ids: string[]; projectId?: string } | undefined> {
  // Keep the existing UUID path: send the id directly to the issue filter.
  if (ref === undefined || UUID_RE.test(ref.trim())) return undefined;
  const name = ref.trim();
  const project = projectRef ? await resolveProject(client, projectRef) : undefined;
  const scope = project ? { project: { id: { eq: project.id } } } : {};
  const matches = await withRetry(() => client.projectMilestones({
    first: 100,
    filter: { ...scope, name: { eqIgnoreCase: name } },
  }));
  while (matches.pageInfo.hasNextPage) await withRetry(() => matches.fetchNext());
  if (matches.nodes.length) {
    return { ids: [...new Set(matches.nodes.map(m => m.id))], projectId: project?.id };
  }

  // A successful catalog query is the control for a negative lookup and supplies hints.
  const available = await withRetry(() => client.projectMilestones({ first: 100, filter: scope }));
  while (available.pageInfo.hasNextPage) await withRetry(() => available.fetchNext());
  const closest = closestNames([name], available.nodes.map(m => m.name));
  const location = project ? `in project ${JSON.stringify(project.name)}` : "across all projects accessible to the viewer";
  throw notFoundError(
    `no milestone matching ${JSON.stringify(name)} ${location}.`,
    `List milestones: linearctl milestone${project ? ` --project ${project.id}` : ""} --json; closest: ${closest.map(n => JSON.stringify(n)).join(", ") || "(none available)"}.`,
  );
}
