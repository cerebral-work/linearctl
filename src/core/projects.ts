import { notFoundError, refusedError, usageError } from "../lib/errors.js";
import type { LinearClient, Project } from "@linear/sdk";
import { applyLimit, drainUnique } from "../lib/paginate.js";
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
  if (!project) throw notFoundError(`no project matching ${JSON.stringify(ref)}.`);
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

/** A project listing plus whether `--limit` cut it short. */
export interface ProjectListing {
  projects: ProjectSummary[];
  /** True only when `limit` dropped rows; a complete listing is never partial. */
  partial: boolean;
}

export interface ListProjectsOptions {
  teamKey?: string;
  /** Cap the rows returned. Marks the listing partial when it truncates. */
  limit?: number;
}

/**
 * List projects, optionally restricted to a team (resolved by key).
 *
 * Follows the listing contract (docs/agent-facility.md): the connection is
 * drained to the end, each project is returned once, the rows are ordered
 * before any cap is applied, and `--limit` marks the result partial. The
 * previous implementation pushed `connection.nodes` into a separate array on
 * every `fetchNext()`, and since the SDK appends to that same array it
 * reported 141 rows for 91 projects.
 */
export async function listProjectsPaged(
  client: LinearClient,
  opts: ListProjectsOptions = {},
): Promise<ProjectListing> {
  const connection = opts.teamKey
    ? await (await resolveTeamByKey(client, opts.teamKey)).projects({ first: 50 })
    : await client.projects({ first: 50 });

  const all = await drainUnique(connection);

  const rows: ProjectSummary[] = all.map((p) => ({
    id: p.id,
    name: p.name,
    url: p.url,
    state: p.state,
    progress: p.progress,
  }));
  // Order the complete listing before truncating, so a cap is a stable prefix
  // and does not depend on page boundaries or server ordering.
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const { rows: projects, partial } = applyLimit(rows, opts.limit);
  return { projects, partial };
}

/**
 * Array-returning form, preserved as the stable entry point for callers that
 * do not care about truncation.
 */
export async function listProjects(
  client: LinearClient,
  teamKey?: string,
): Promise<ProjectSummary[]> {
  return (await listProjectsPaged(client, { teamKey })).projects;
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
    throw refusedError(
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

export interface UpdateProjectParams {
  name?: string;
  description?: string;
  state?: string;
}

export interface UpdatedProject {
  id: string;
  name: string;
  slugId: string;
  state: string | null;
  url: string;
}

/**
 * Update a project's name, description, or state. `state` is matched against
 * the workspace's project-status set by type (backlog, planned, started,
 * paused, completed, canceled). See CER-1687.
 */
export async function updateProject(
  client: LinearClient,
  projectRef: string,
  params: UpdateProjectParams,
): Promise<UpdatedProject> {
  const p = await resolveProject(client, projectRef);

  if (!params.name && params.description === undefined && !params.state) {
    throw usageError("project update needs at least one of --state, --name, --description.");
  }

  let statusId: string | undefined;
  if (params.state) {
    const statuses = await client.projectStatuses({ first: 100 });
    const match = statuses.nodes.find(
      (s) => s.type.toLowerCase() === params.state!.toLowerCase(),
    );
    if (!match) {
      const valid = [...new Set(statuses.nodes.map((s) => s.type))].join(", ");
      throw notFoundError(
        `no project state matching ${JSON.stringify(params.state)}. Valid: ${valid}.`,
      );
    }
    statusId = match.id;
  }

  const payload = await client.updateProject(p.id, {
    ...(params.name ? { name: params.name } : {}),
    ...(params.description !== undefined ? { description: params.description } : {}),
    ...(statusId ? { statusId } : {}),
  });
  if (!payload.success) {
    throw new Error("Linear reported the project update did not succeed.");
  }
  const updated = (await payload.project) ?? p;

  return {
    id: updated.id,
    name: updated.name,
    slugId: updated.slugId,
    state: (await updated.status)?.type ?? null,
    url: updated.url,
  };
}
