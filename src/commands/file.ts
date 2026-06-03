export interface FileOptions {
  team: string;
  project?: string;
  desc?: string;
  label?: string[];
  json?: boolean;
}

/**
 * `linearctl file <title>` — create a Linear issue from the CLI (headless / batch).
 *
 * Complements the `file-bug` / `linear-file-spec` skills for non-interactive use
 * (CI, scripts, loops). Bypasses the LOCAL MCP `save_issue` rate-guard, but is
 * still subject to Linear's own `RATELIMITED` complexity limits — batch with
 * backoff. See docs/spec.md §6.3.
 *
 * Intended implementation (see docs/spec.md §6.3):
 *   const client = makeClient();
 *   const team = await resolveTeamByKey(client, opts.team);   // teams({ filter: { key: { eq } } })
 *   const desc = opts.desc === "-" ? await readStdin() : opts.desc;
 *   const res = await client.createIssue({ teamId: team.id, title, description: desc, projectId: opts.project });
 *   const issue = await res.issue;  // print issue.identifier + issue.url
 *
 * Status: specified, not yet implemented.
 */
export async function file(title: string, opts: FileOptions): Promise<void> {
  console.error(
    `linearctl file: specified, not yet implemented ` +
      `(title=${JSON.stringify(title)}, team=${opts.team}). See docs/spec.md §6.3.`,
  );
  process.exit(2);
}
