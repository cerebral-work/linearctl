import type { LinearClient, Project } from "@linear/sdk";
import { resolveTeamByKey } from "./teams.js";

export const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Resolve a project by UUID, slug id, or name (case-insensitive). */
export async function resolveProject(
  client: LinearClient,
  ref: string,
): Promise<Project> {
  if (UUID_RE.test(ref)) return client.project(ref);
  const projects = await client.projects({
    filter: { or: [{ name: { eqIgnoreCase: ref } }, { slugId: { eq: ref } }] },
  });
  const project = projects.nodes[0];
  if (!project) throw new Error(`no project matching ${JSON.stringify(ref)}.`);
  return project;
}

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

export interface ProjectOverview {
  project: { id: string; name: string; url: string; slugId: string };
  /** The overview document as markdown; null when the project has none. */
  content: string | null;
}

/**
 * Read a project's overview (the `Project.content` markdown document — what the
 * Linear UI shows on the project's Overview tab). See docs/spec.md §6.13.
 */
export async function getProjectOverview(
  client: LinearClient,
  projectRef: string,
): Promise<ProjectOverview> {
  const p = await resolveProject(client, projectRef);
  return {
    project: { id: p.id, name: p.name, url: p.url, slugId: p.slugId },
    content: p.content ?? null,
  };
}

/**
 * Replace a project's overview document with `content` (markdown, whole-document
 * semantics — Linear has no partial-update surface for `Project.content`).
 * Refuses empty content: blanking an overview is a delete, not an update, and
 * must be an explicit human act in the UI. See docs/spec.md §6.13.
 */
export async function setProjectOverview(
  client: LinearClient,
  projectRef: string,
  content: string,
): Promise<ProjectOverview> {
  if (content.trim() === "") {
    throw new Error(
      "refusing to write an empty overview (that would blank the project's Overview doc).",
    );
  }
  const p = await resolveProject(client, projectRef);
  const payload = await client.updateProject(p.id, { content });
  if (!payload.success) {
    throw new Error("Linear reported the overview update did not succeed.");
  }
  const updated = (await payload.project) ?? p;
  return {
    project: {
      id: updated.id,
      name: updated.name,
      url: updated.url,
      slugId: updated.slugId,
    },
    content: updated.content ?? content,
  };
}
