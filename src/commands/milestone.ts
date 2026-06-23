import { makeClient } from "../client.js";
import { milestones, deleteMilestone } from "../core/milestones.js";
import { printJson } from "../lib/output.js";

export interface MilestoneOptions {
  project?: string;
  json?: boolean;
}

export interface MilestoneDeleteOptions {
  yes?: boolean;
  json?: boolean;
}

/**
 * `linearctl milestone delete <id> [--yes]` — delete a project milestone by UUID.
 * Dry-run by default (prints what would be deleted); `--yes` performs the delete.
 * Find ids via `milestone --json`. See docs/spec.md §6.5.
 */
export async function milestoneDelete(id: string, opts: MilestoneDeleteOptions): Promise<void> {
  const client = makeClient();
  const res = await deleteMilestone(client, id, opts.yes === true);

  if (opts.json) {
    printJson(res);
    return;
  }
  process.stdout.write(
    res.deleted
      ? `deleted milestone "${res.name}" (${res.id}).\n`
      : `[dry-run] would delete milestone "${res.name}" (${res.id}); re-run with --yes to delete.\n`,
  );
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
