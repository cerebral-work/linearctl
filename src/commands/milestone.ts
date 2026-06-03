export interface MilestoneOptions {
  project?: string;
  json?: boolean;
}

/**
 * `linearctl milestone` — project / milestone progress (issues done vs open per
 * milestone). Ties to the "knock out the existing milestones before the
 * release-please swap" tracking. See docs/spec.md §6.5.
 *
 * Intended implementation (see docs/spec.md §6.5):
 *   const client = makeClient();
 *   const project = await resolveProject(client, opts.project);
 *   const milestones = await project.projectMilestones();
 *   // for each milestone: count issues by completed vs open → percent + bar
 *
 * Status: specified, not yet implemented.
 */
export async function milestone(opts: MilestoneOptions): Promise<void> {
  console.error(
    `linearctl milestone: specified, not yet implemented` +
      `${opts.project ? ` (project=${opts.project})` : ""}. See docs/spec.md §6.5.`,
  );
  process.exit(2);
}
