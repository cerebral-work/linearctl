import { makeClient } from "../client.js";
import { createProject, listProjectsPaged, updateProject } from "../core/projects.js";
import { readStdinFor } from "../lib/io.js";
import { printJson, printTable } from "../lib/output.js";

export interface ProjectCreateOptions {
  team: string;
  desc?: string;
  json?: boolean;
}

/**
 * `linearctl project create <name> --team CER` — create a Linear project.
 *
 * Delegates to `core.createProject`; this layer handles the `--desc -` stdin
 * convention and output formatting. See docs/spec.md §6.6.
 */
export async function projectCreate(
  name: string,
  opts: ProjectCreateOptions,
): Promise<void> {
  const client = makeClient();
  const description = opts.desc === "-" ? await readStdinFor("--desc -") : opts.desc;

  const project = await createProject(client, {
    name,
    teamKey: opts.team,
    description,
  });

  if (opts.json) {
    printJson(project);
    return;
  }

  process.stdout.write(
    `created project ${project.name}\n` +
      `  url:  ${project.url}\n` +
      `  id:   ${project.id}\n` +
      `  team: ${project.team.name} (${project.team.key})\n`,
  );
}

export interface ProjectListOptions {
  team?: string;
  json?: boolean;
  limit?: number;
}

/**
 * `linearctl project list [--team CER] [--limit N]` — list projects,
 * optionally team-scoped.
 *
 * Delegates to `core.listProjectsPaged`; this layer only formats output and
 * surfaces the partial marker. See docs/spec.md §6.6.
 */
export async function projectList(opts: ProjectListOptions): Promise<void> {
  const client = makeClient();
  const { projects, partial } = await listProjectsPaged(client, {
    teamKey: opts.team,
    limit: opts.limit,
  });

  if (opts.json) {
    // The documented --json shape is a bare array, so truncation is flagged on
    // each row rather than by wrapping and breaking `jq '.[]'` consumers.
    printJson(partial ? projects.map((p) => ({ ...p, partial: true })) : projects);
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
  if (partial) {
    process.stderr.write(
      `partial: showing ${projects.length} project(s); more exist — raise or drop --limit for the full list.\n`,
    );
  }
}

export interface ProjectUpdateOptions {
  state?: string;
  name?: string;
  desc?: string;
  json?: boolean;
}

/**
 * `linearctl project update <ref> [--state] [--name] [--description]` — update
 * a project's state, name, or description. `<ref>` accepts project name or UUID.
 * See CER-1687.
 */
export async function projectUpdate(
  ref: string,
  opts: ProjectUpdateOptions,
): Promise<void> {
  const client = makeClient();
  const description = opts.desc === "-" ? await readStdinFor("--desc -") : opts.desc;

  const project = await updateProject(client, ref, {
    state: opts.state,
    name: opts.name,
    description,
  });

  if (opts.json) {
    printJson(project);
    return;
  }

  process.stdout.write(
    `updated project "${project.name}" (${project.id})\n` +
      `  url:   ${project.url}\n` +
      (project.state ? `  state: ${project.state}\n` : ""),
  );
}
