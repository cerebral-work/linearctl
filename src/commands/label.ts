import { makeClient } from "../client.js";
import { listLabels, createLabel, renameLabel } from "../core/labels.js";
import { printJson, printTable } from "../lib/output.js";
import { pc } from "../lib/style.js";

export interface LabelListOptions {
  team?: string[];
  counts?: boolean;
  json?: boolean;
}

/** `linearctl label list [--team CER] [--counts]` — see docs/features/label.md. */
export async function labelList(opts: LabelListOptions): Promise<void> {
  const client = makeClient();
  const rows = await listLabels(client, { teamKeys: opts.team, counts: opts.counts });
  if (opts.json) {
    printJson(rows);
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
}

export interface LabelWriteOptions {
  team?: string;
  color?: string;
  json?: boolean;
}

export async function labelCreate(name: string, opts: LabelWriteOptions): Promise<void> {
  if (!opts.team) throw new Error("label create needs --team <key>.");
  const client = makeClient();
  const label = await createLabel(client, { teamKey: opts.team, name, color: opts.color });
  if (opts.json) {
    printJson(label);
    return;
  }
  process.stdout.write(`created label "${label.name}" on ${label.team} (${label.color}).\n`);
}

export async function labelRename(from: string, to: string, opts: LabelWriteOptions): Promise<void> {
  if (!opts.team) throw new Error("label rename needs --team <key>.");
  const client = makeClient();
  const label = await renameLabel(client, { teamKey: opts.team, from, to });
  if (opts.json) {
    printJson(label);
    return;
  }
  process.stdout.write(`renamed "${from}" → "${label.name}" on ${label.team}.\n`);
}
