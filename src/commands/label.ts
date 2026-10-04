import { usageError } from "../lib/errors.js";
import { makeClient } from "../client.js";
import { listLabelsPaged, createLabel, renameLabel } from "../core/labels.js";
import { printJson, printTable } from "../lib/output.js";
import { pc } from "../lib/style.js";

export interface LabelListOptions {
  team?: string[];
  counts?: boolean;
  json?: boolean;
  limit?: number;
}

/** `linearctl label list [--team CER] [--counts] [--limit N]` — see docs/features/label.md. */
export async function labelList(opts: LabelListOptions): Promise<void> {
  const client = makeClient();
  const { labels: rows, partial } = await listLabelsPaged(client, {
    teamKeys: opts.team,
    counts: opts.counts,
    limit: opts.limit,
  });
  if (opts.json) {
    // The documented --json shape is a bare array (docs/features/label.md),
    // so truncation is flagged on each row rather than by wrapping the array
    // and breaking every `jq '.[]'` consumer.
    printJson(partial ? rows.map((r) => ({ ...r, partial: true })) : rows);
    return;
  }
  printTable(
    rows.map((r) => ({
      team: r.team ?? "(workspace)",
      name: r.name,
      ...(opts.counts ? { issues: String(r.issues ?? 0) } : {}),
      color: r.color ?? "—",
    })),
    ["team", "name", ...(opts.counts ? ["issues"] : []), "color"],
    (value, column, row) => {
      if (column === "name") return pc.cyan(value);
      if (column === "issues" && row.issues === "0") return pc.dim(value);
      return value;
    },
  );
  if (partial) {
    process.stderr.write(
      `partial: showing ${rows.length} label(s); more exist — raise or drop --limit for the full list.\n`,
    );
  }
}

export interface LabelWriteOptions {
  team?: string;
  color?: string;
  json?: boolean;
}

export async function labelCreate(name: string, opts: LabelWriteOptions): Promise<void> {
  if (!opts.team) throw usageError("label create needs --team <key>.");
  const client = makeClient();
  const label = await createLabel(client, { teamKey: opts.team, name, color: opts.color });
  if (opts.json) {
    printJson(label);
    return;
  }
  process.stdout.write(`created label "${label.name}" on ${label.team} (${label.color}).\n`);
}

export async function labelRename(from: string, to: string, opts: LabelWriteOptions): Promise<void> {
  if (!opts.team) throw usageError("label rename needs --team <key>.");
  const client = makeClient();
  const label = await renameLabel(client, { teamKey: opts.team, from, to });
  if (opts.json) {
    printJson(label);
    return;
  }
  process.stdout.write(`renamed "${from}" → "${label.name}" on ${label.team}.\n`);
}
