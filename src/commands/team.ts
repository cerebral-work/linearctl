import { makeClient } from "../client.js";
import { listTeams, resolveTeam } from "../core/teams.js";
import { printJson, printTable } from "../lib/output.js";
import { notFoundError, usageError } from "../lib/errors.js";

export interface TeamListOptions {
  json?: boolean;
  cache?: boolean;
}

export interface TeamResolveOptions {
  json?: boolean;
  cache?: boolean;
}

/**
 * `linearctl team list [--cache] [--json]` — list accessible Linear teams.
 * Supports reading from local SQLite cache via `--cache` or LINEARCTL_CACHE=true.
 */
export async function teamList(opts: TeamListOptions): Promise<void> {
  const useCache = opts.cache ?? (process.env.LINEARCTL_CACHE === "true");

  if (useCache) {
    const { openCacheDb } = await import("../core/cache/db.js");
    const { getCachedTeams } = await import("../core/cache/query.js");
    const cache = openCacheDb();
    try {
      const teams = getCachedTeams(cache);
      if (opts.json) {
        printJson(teams);
        return;
      }
      printTable(
        teams.map((t) => ({
          key: t.key,
          name: t.name,
          id: t.id,
          description: t.description ?? "",
        })),
        ["key", "name", "id", "description"],
      );
      return;
    } finally {
      cache.close();
    }
  }

  const client = makeClient();
  const teams = await listTeams(client);

  if (opts.json) {
    printJson(teams);
    return;
  }

  printTable(
    teams.map((t) => ({
      key: t.key,
      name: t.name,
      id: t.id,
      description: t.description ?? "",
    })),
    ["key", "name", "id", "description"],
  );
}

/**
 * `linearctl team resolve <ref> [--cache] [--json]` — resolve a team by key, name, or id.
 */
export async function teamResolve(ref: string | undefined, opts: TeamResolveOptions): Promise<void> {
  if (!ref || !ref.trim()) {
    throw usageError("team resolve requires a team key, name, or id (e.g. CER or Cerebral).");
  }

  const useCache = opts.cache ?? (process.env.LINEARCTL_CACHE === "true");

  if (useCache) {
    const { openCacheDb } = await import("../core/cache/db.js");
    const { getCachedTeam } = await import("../core/cache/query.js");
    const cache = openCacheDb();
    try {
      const team = getCachedTeam(cache, ref);
      if (!team) {
        throw notFoundError(`team matching ${JSON.stringify(ref.trim())} not found in local cache.`);
      }
      if (opts.json) {
        printJson(team);
        return;
      }
      process.stdout.write(
        `team ${team.name} (${team.key})\n` +
          `  id:          ${team.id}\n` +
          (team.description ? `  description: ${team.description}\n` : ""),
      );
      return;
    } finally {
      cache.close();
    }
  }

  const client = makeClient();
  const team = await resolveTeam(client, ref);

  if (opts.json) {
    printJson(team);
    return;
  }

  process.stdout.write(
    `team ${team.name} (${team.key})\n` +
      `  id:          ${team.id}\n` +
      (team.description ? `  description: ${team.description}\n` : ""),
  );
}
