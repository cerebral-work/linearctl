export interface TriageOptions {
  team: string;
  json?: boolean;
}

/**
 * `linearctl triage` — surface issues needing attention: in the Triage state, or
 * unassigned / unestimated in the backlog. Complements the `issue-triage` skill
 * with a headless, scriptable listing (pipe to `jq`, feed a standup, gate CI).
 * See docs/spec.md §6.4.
 *
 * Intended implementation (see docs/spec.md §6.4):
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
    `linearctl triage: specified, not yet implemented (team=${opts.team}). See docs/spec.md §6.4.`,
  );
  process.exit(2);
}
