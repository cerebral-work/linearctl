export interface DigestOptions {
  since: string;
  team?: string;
  json?: boolean;
}

/**
 * `linearctl digest` — "what have we been up to": issues created / updated / completed
 * in a recent window, grouped by workflow-state type. The scriptable form of the
 * session-start Linear summary.
 *
 * Intended implementation (see docs/spec.md §6.2):
 *   const client = makeClient();
 *   const since = sinceToDate(opts.since);
 *   let page = await client.issues({
 *     filter: {
 *       ...(opts.team ? { team: { key: { eq: opts.team } } } : {}),
 *       updatedAt: { gte: since },
 *     },
 *     first: 100,
 *     orderBy: LinearDocument.PaginationOrderBy.UpdatedAt,
 *   });
 *   const all = [...page.nodes];
 *   while (page.pageInfo.hasNextPage) { page = await page.fetchNext(); all.push(...page.nodes); }
 *   // group by (await issue.state).type → completed / started / triage / backlog
 *
 * Status: specified, not yet implemented. Left as a stub so it can't ship a
 * subtly-wrong filter/await pattern unverified — `whoami` is the verified slice.
 */
export async function digest(opts: DigestOptions): Promise<void> {
  console.error(
    `linearctl digest: specified, not yet implemented ` +
      `(window=${opts.since}${opts.team ? `, team=${opts.team}` : ""}). ` +
      `See docs/spec.md §6.2.`,
  );
  process.exit(2);
}
