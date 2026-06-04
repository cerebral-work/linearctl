import { makeClient } from "../client.js";
import { milestones } from "../core/milestones.js";
import { printJson } from "../lib/output.js";

export interface MilestoneOptions {
  project?: string;
  json?: boolean;
}

/** A 20-cell ASCII progress bar, e.g. `[██████████░░░░░░░░░░]`. */
function bar(percent: number, width = 20): string {
  const filled = Math.round((percent / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

/**
 * `linearctl milestone [--project ID]` — per-milestone burn-down (done vs open,
 * percent + bar). Delegates to `core.milestones`; this layer formats.
 * See docs/spec.md §6.5.
 */
export async function milestone(opts: MilestoneOptions): Promise<void> {
  const client = makeClient();
  const result = await milestones(client, opts.project);

  if (opts.json) {
    printJson(result);
    return;
  }

  process.stdout.write(
    `${result.project ?? "(all projects)"} — ${result.milestones.length} milestone(s)\n`,
  );
  if (result.milestones.length === 0) {
    process.stdout.write("(none)\n");
    return;
  }
  const nameW = Math.max(...result.milestones.map((m) => m.name.length));
  for (const m of result.milestones) {
    process.stdout.write(
      `  ${m.name.padEnd(nameW)}  ${bar(m.percent)} ${String(m.percent).padStart(3)}%  ` +
        `${m.done}/${m.total}${m.targetDate ? `  (due ${m.targetDate})` : ""}\n`,
    );
  }
}
