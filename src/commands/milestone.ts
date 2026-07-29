import { makeClient } from "../client.js";
import { milestones, deleteMilestone, createMilestone, updateMilestone } from "../core/milestones.js";
import { milestoneGaps } from "../core/milestone-gaps.js";
import { readStdin } from "../lib/io.js";
import { printJson } from "../lib/output.js";

export interface MilestoneOptions {
  project?: string;
  json?: boolean;
}

export interface MilestoneCreateOptions {
  project: string;
  targetDate?: string;
  desc?: string;
  json?: boolean;
}

export interface MilestoneDeleteOptions {
  yes?: boolean;
  json?: boolean;
}

export interface MilestoneUpdateOptions {
  name?: string;
  targetDate?: string;
  desc?: string;
  apply?: boolean;
  json?: boolean;
}

export interface MilestoneGapOptions {
  project: string;
  json?: boolean;
}

/**
 * `linearctl milestone create <name> --project <ref>` — create a project milestone.
 *
 * Delegates to `core.createMilestone`; this layer handles the `--desc -` stdin
 * convention and output formatting. See CER-1686.
 */
export async function milestoneCreate(
  name: string,
  opts: MilestoneCreateOptions,
): Promise<void> {
  const client = makeClient();
  const description = opts.desc === "-" ? await readStdin() : opts.desc;

  const ms = await createMilestone(client, {
    name,
    projectRef: opts.project,
    targetDate: opts.targetDate,
    description,
  });

  if (opts.json) {
    printJson(ms);
    return;
  }

  process.stdout.write(
    `created milestone "${ms.name}" (${ms.id})\n` +
      `  project: ${ms.project}\n` +
      (ms.targetDate ? `  due:    ${ms.targetDate}\n` : ""),
  );
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

/**
 * `linearctl milestone update <id> [--name] [--target-date] [--desc]` — edit a
 * project milestone's fields. Dry-run by default; `--apply` writes. The `--desc -`
 * convention reads markdown from stdin. See CER-1759.
 */
export async function milestoneUpdate(
  id: string,
  opts: MilestoneUpdateOptions,
): Promise<void> {
  const client = makeClient();
  const description = opts.desc === "-" ? await readStdin() : opts.desc;

  const res = await updateMilestone(
    client,
    { id, name: opts.name, targetDate: opts.targetDate, description },
    opts.apply === true,
  );

  if (opts.json) {
    printJson(res);
    return;
  }

  const changes: string[] = [];
  if (res.before.name !== res.after.name) {
    changes.push(`  name:   ${res.before.name} → ${res.after.name}`);
  }
  if (res.before.targetDate !== res.after.targetDate) {
    changes.push(`  due:    ${res.before.targetDate ?? "(none)"} → ${res.after.targetDate ?? "(none)"}`);
  }
  if (res.before.description !== res.after.description) {
    changes.push(`  desc:   (updated)`);
  }

  if (changes.length === 0) {
    process.stdout.write(
      res.updated
        ? `updated milestone "${res.name}" (${res.id}) — no field changes detected.\n`
        : `[dry-run] milestone "${res.name}" (${res.id}) — no field changes specified.\n`,
    );
    return;
  }

  process.stdout.write(
    (res.updated ? "" : "[dry-run] would ") +
      `update milestone "${res.name}" (${res.id}):\n` +
      changes.join("\n") +
      "\n",
  );
  if (!res.updated) {
    process.stdout.write("re-run with --apply to write.\n");
  }
}

/**
 * `linearctl milestone gap --project <ref> [--json]` — surface milestone
 * coverage gaps: empty milestones (ghosts), project issues with no milestone
 * (unassigned), and overview-doc `##` sections with no matching ticket
 * (doc-section gaps). Read-only; see docs/spec.md §6.5/§6.13.
 */
export async function milestoneGap(opts: MilestoneGapOptions): Promise<void> {
  const client = makeClient();
  const gaps = await milestoneGaps(client, opts.project);

  if (opts.json) {
    printJson(gaps);
    return;
  }

  const lines: string[] = [];
  lines.push(
    `${gaps.project} — coverage gaps`,
  );
  lines.push(
    `  empty milestones: ${gaps.emptyMilestones.length}`,
    `  unassigned issues: ${gaps.unassignedIssues.length}`,
    `  doc-section gaps: ${gaps.docSectionGaps.length}`,
  );
  if (gaps.emptyMilestones.length > 0) {
    lines.push("", "empty milestones (zero issues):");
    for (const m of gaps.emptyMilestones) {
      lines.push(
        `  ${m.name}  ${m.id}${m.targetDate ? `  (due ${m.targetDate})` : ""}`,
      );
    }
  }
  if (gaps.unassignedIssues.length > 0) {
    lines.push("", "unassigned to a milestone:");
    for (const i of gaps.unassignedIssues) {
      lines.push(`  ${i.identifier}  ${i.title}  [${i.state}]`);
    }
  }
  if (gaps.docSectionGaps.length > 0) {
    lines.push("", "overview-doc sections with no matching ticket:");
    for (const s of gaps.docSectionGaps) {
      lines.push(`  [${s.index}] ${s.heading}`);
    }
  }
  process.stdout.write(lines.join("\n") + "\n");
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
