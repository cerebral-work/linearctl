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
    throw new Error(
      `no team with key ${JSON.stringify(k)} — check the key in Linear (Settings → Teams).`,
    );
  }
  return team;
}
