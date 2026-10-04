import { notFoundError } from "../lib/errors.js";
import type { LinearClient, Team } from "@linear/sdk";

/**
 * Resolve a {@link Team} by its key (e.g. `"CER"`), case-insensitively.
 *
 * Domain logic shared by everything that takes a `--team <key>` (issues,
 * projects). Throws a clear error rather than returning `undefined` so callers
 * can let it bubble to the top-level handler. Moved here from `lib/resolve.ts`
 * so the CLI and the MCP server share one team resolver.
 */
export async function resolveTeamByKey(
  client: LinearClient,
  key: string,
): Promise<Team> {
  const k = key.trim();
  const teams = await client.teams({ filter: { key: { eqIgnoreCase: k } } });
  const team = teams.nodes[0];
  if (!team) {
    const keys = await listTeamKeys(client);
    throw notFoundError(
      `no team with key ${JSON.stringify(k)} — available team keys: ${keys.join(", ") || "(none visible)"}; check Linear Settings → Teams.`,
    );
  }
  return team;
}

/** Exhaust the connection so hints do not omit teams beyond the first page. */
export async function listTeamKeys(client: LinearClient): Promise<string[]> {
  const page = await client.teams({ first: 100 });
  const keys = page.nodes.map(t => t.key);
  while (page.pageInfo?.hasNextPage) {
    await page.fetchNext();
    keys.push(...page.nodes.map(t => t.key));
  }
  return [...new Set(keys)].sort();
}
