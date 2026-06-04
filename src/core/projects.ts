import type { LinearClient } from "@linear/sdk";
import { resolveTeamByKey } from "./teams.js";

export interface CreateProjectParams {
  name: string;
  teamKey: string;
  description?: string;
}

export interface CreatedProject {
  id: string;
  name: string;
  url: string;
  slugId: string;
  state: string;
  team: { id: string; key: string; name: string };
}

/**
 * Create a Linear project under a team (resolved by key). Pure domain logic:
 * the caller resolves `description` (CLI stdin handling) and shapes output.
 */
export async function createProject(
  client: LinearClient,
  params: CreateProjectParams,
): Promise<CreatedProject> {
  const team = await resolveTeamByKey(client, params.teamKey);

  const payload = await client.createProject({
    name: params.name,
    teamIds: [team.id],
    ...(params.description ? { description: params.description } : {}),
  });
  if (!payload.success) {
    throw new Error("Linear reported the project create did not succeed.");
  }
  const project = await payload.project;
  if (!project) {
    throw new Error("project created but the payload returned no project.");
  }

  return {
    id: project.id,
    name: project.name,
    url: project.url,
    slugId: project.slugId,
    state: project.state,
    team: { id: team.id, key: team.key, name: team.name },
  };
}

export interface ProjectSummary {
  id: string;
  name: string;
  url: string;
  state: string;
  progress: number;
}

/**
 * List projects, optionally restricted to a team (resolved by key). Returns the
 * connection's nodes as plain summaries; the caller renders them.
 */
export async function listProjects(
  client: LinearClient,
  teamKey?: string,
): Promise<ProjectSummary[]> {
  const connection = teamKey
    ? await (await resolveTeamByKey(client, teamKey)).projects()
    : await client.projects();

  return connection.nodes.map((p) => ({
    id: p.id,
    name: p.name,
    url: p.url,
    state: p.state,
    progress: p.progress,
  }));
}
