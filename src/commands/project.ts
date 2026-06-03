import { makeClient } from "../client.js";
import { resolveTeamByKey } from "../lib/resolve.js";
import { readStdin } from "../lib/io.js";
import { printJson, printTable } from "../lib/output.js";

export interface ProjectCreateOptions {
  team: string;
  desc?: string;
  json?: boolean;
}

/**
 * `linearctl project create <name> --team CER` — create a Linear project.
 *
 * The Project container that `file`'s issues attach to: the first half of the
 * M2 dogfood loop (create the project, then `file` its backlog into it). Resolves
 * the team by key, calls `createProject({ name, teamIds, description })`, and
 * prints the new project's name + url + id. See docs/spec.md §6.6.
 */
export async function projectCreate(
  name: string,
  opts: ProjectCreateOptions,
): Promise<void> {
  const client = makeClient();
  const team = await resolveTeamByKey(client, opts.team);
  const description = opts.desc === "-" ? await readStdin() : opts.desc;

  const payload = await client.createProject({
    name,
    teamIds: [team.id],
    ...(description ? { description } : {}),
  });
  if (!payload.success) {
    throw new Error("Linear reported the project create did not succeed.");
  }
  const project = await payload.project;
  if (!project) {
    throw new Error("project created but the payload returned no project.");
  }

  if (opts.json) {
    printJson({
      id: project.id,
      name: project.name,
      url: project.url,
      slugId: project.slugId,
      state: project.state,
      team: { id: team.id, key: team.key, name: team.name },
    });
    return;
  }

  process.stdout.write(
    `created project ${project.name}\n` +
      `  url:  ${project.url}\n` +
      `  id:   ${project.id}\n` +
      `  team: ${team.name} (${team.key})\n`,
  );
}

export interface ProjectListOptions {
  team?: string;
  json?: boolean;
}

/**
 * `linearctl project list [--team CER]` — list projects, optionally team-scoped.
 *
 * Powers the create-then-verify loop and a quick "what projects exist" glance.
 * Renders name / state / progress / id (or `--json`). See docs/spec.md §6.6.
 */
export async function projectList(opts: ProjectListOptions): Promise<void> {
  const client = makeClient();
  const connection = opts.team
    ? await (await resolveTeamByKey(client, opts.team)).projects()
    : await client.projects();
  const projects = connection.nodes;

  if (opts.json) {
    printJson(
      projects.map((p) => ({
        id: p.id,
        name: p.name,
        url: p.url,
        state: p.state,
        progress: p.progress,
      })),
    );
    return;
  }

  printTable(
    projects.map((p) => ({
      name: p.name,
      state: p.state ?? "",
      progress: `${Math.round((p.progress ?? 0) * 100)}%`,
      id: p.id,
    })),
    ["name", "state", "progress", "id"],
  );
}
