import { makeClient } from "../client.js";
import { stale as staleCore, applyStaleLabel } from "../core/grooming.js";
import { sinceToDate } from "../lib/time.js";
import { printJson, printTable } from "../lib/output.js";

export interface StaleOptions {
  team?: string[];
  olderThan?: string;
  label?: string;
  apply?: boolean;
  json?: boolean;
}

/**
 * `linearctl stale [--team KEY...] [--older-than 30d] [--label NAME [--apply]]` —
 * sweep issues by last-update age (RFC §3.2 stale-sweep). **Read-only by
 * default.** `--label` adds a label to the surfaced issues, but only writes with
 * `--apply` — otherwise it's a dry-run preview. Never closes anything.
 * See docs/spec.md §6.9.
 */
export async function stale(opts: StaleOptions): Promise<void> {
  const client = makeClient();
  const now = new Date();
  const warnCutoff = sinceToDate(opts.olderThan ?? "30d", now);
  const ninetyCutoff = sinceToDate("90d", now);
  // criticalCutoff is the older of (90d, --older-than) so a >90d window still buckets.
  const criticalCutoff = warnCutoff < ninetyCutoff ? warnCutoff : ninetyCutoff;

  const result = await staleCore(client, {
    teamKeys: opts.team,
    warnCutoff,
    criticalCutoff,
    now,
  });

  const labelResult = opts.label
    ? await applyStaleLabel(client, result.items, opts.label, opts.apply === true)
    : undefined;

  if (opts.json) {
    printJson({ ...result, ...(labelResult ? { labelAction: labelResult } : {}) });
    return;
  }

  process.stdout.write(
    `${result.items.length} stale issue(s): ${result.warn} warn (>${result.olderThanDays}d), ` +
      `${result.critical} critical (>${result.criticalDays}d)\n`,
  );
  printTable(
    result.items.map((i) => ({
      identifier: i.identifier,
      bucket: i.bucket,
      days: String(i.daysStale),
      state: i.state,
      assignee: i.assignee ?? "—",
      title: i.title,
    })),
    ["identifier", "bucket", "days", "state", "assignee", "title"],
  );
  if (labelResult) {
    process.stdout.write(
      labelResult.applied
        ? `\napplied label "${labelResult.label}" to ${labelResult.count} issue(s).\n`
        : `\n[dry-run] would apply label "${labelResult.label}" to ${labelResult.count} issue(s); re-run with --apply to write.\n`,
    );
  }
}
