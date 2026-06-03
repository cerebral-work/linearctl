export interface TriageOptions {
  team: string;
  json?: boolean;
}

/**
 * `lw triage` — surface issues needing attention: in the Triage state, or
 * unassigned / unestimated in the backlog. Complements the `issue-triage` skill
 * with a headless, scriptable listing (pipe to `jq`, feed a standup, gate CI).
 * See SPEC.md §6.4.
 *
 * Intended implementation (see SPEC.md §6.4):
 *   const client = makeClient();
 *   const issues = await client.issues({
 *     filter: {
 *       team: { key: { eq: opts.team } },
 *       or: [
 *         { state: { type: { eq: "triage" } } },
 *         { assignee: { null: true } },
 *         { estimate: { null: true } },
 *       ],
 *     },
 *     first: 100,
 *   });
 *   // render identifier / title / state / assignee / why-flagged
 *
 * Status: specified, not yet implemented.
 */
export async function triage(opts: TriageOptions): Promise<void> {
  console.error(
    `lw triage: specified, not yet implemented (team=${opts.team}). See SPEC.md §6.4.`,
  );
  process.exit(2);
}
