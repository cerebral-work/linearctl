import { makeClient } from "../client.js";
import { roadmap as fetchRoadmap } from "../core/roadmap.js";
import { printJson } from "../lib/output.js";

export interface RoadmapOptions {
  project: string;
  json?: boolean;
}

/** A 20-cell ASCII progress bar, e.g. `[██████████░░░░░░░░░░]`. */
function bar(percent: number, width = 20): string {
  const filled = Math.round((percent / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

/**
 * `linearctl roadmap --project <ref>` — render a milestone timeline with
 * progress and issue lists. Sorted by target date. See CER-1688.
 */
export async function roadmap(opts: RoadmapOptions): Promise<void> {
  const client = makeClient();
  const result = await fetchRoadmap(client, opts.project);

  if (opts.json) {
    printJson(result);
    return;
  }

  process.stdout.write(
    `${result.project} — ${result.milestones.length} milestone(s)\n`,
  );
  if (result.milestones.length === 0) {
    process.stdout.write("(no milestones — create some via `linearctl milestone create`).\n");
    return;
  }

  for (const m of result.milestones) {
    process.stdout.write(
      `\n  ${m.name}` +
        (m.targetDate ? `  (due ${m.targetDate})` : "") +
        `  ${bar(m.percent)} ${m.percent}%  ${m.done}/${m.total}\n`,
    );
    if (m.issues.length === 0) {
      process.stdout.write(`    (no issues)\n`);
      continue;
    }
    for (const issue of m.issues) {
      process.stdout.write(
        `    ${issue.identifier}  [${issue.state}]  ${issue.title}` +
          (issue.assignee ? `  @${issue.assignee}` : "") +
          "\n",
      );
    }
  }
}
