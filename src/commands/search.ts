import { makeClient } from "../client.js";
import { search as searchCore } from "../core/search.js";
import { printJson, printTable } from "../lib/output.js";
import { pc } from "../lib/style.js";

export interface SearchCmdOptions {
  team?: string[];
  state?: string;
  label?: string[];
  assignee?: string;
  project?: string;
  priority?: string;
  text?: string;
  updatedSince?: string;
  createdSince?: string;
  json?: boolean;
}

const PRIORITY_NAMES = ["—", "urgent", "high", "medium", "low"];

/**
 * `linearctl search [--team KEY...] [--state done] [--label bug] …` — the
 * general issue query the purpose-built sweeps (triage/stale/digest) are
 * special cases of. Delegates to `core.search`; this layer only formats.
 * See docs/features/search.md (CER-1560).
 */
export async function searchCmd(opts: SearchCmdOptions): Promise<void> {
  const client = makeClient();
  const items = await searchCore(client, {
    teamKeys: opts.team,
    state: opts.state,
    labels: opts.label,
    assignee: opts.assignee,
    project: opts.project,
    priority: opts.priority,
    text: opts.text,
    updatedSince: opts.updatedSince,
    createdSince: opts.createdSince,
  });

  if (opts.json) {
    printJson(items);
    return;
  }

  printTable(
    items.map((i) => ({
      identifier: i.identifier,
      state: i.state,
      prio: PRIORITY_NAMES[i.priority] ?? String(i.priority),
      assignee: i.assignee ?? "—",
      title: i.title,
    })),
    ["identifier", "state", "prio", "assignee", "title"],
    (value, column, row) => {
      if (column === "identifier") return pc.cyan(value);
      if (column === "prio" && row.prio === "urgent") return pc.red(value);
      if (column === "prio" && row.prio === "high") return pc.yellow(value);
      if (column === "assignee" && row.assignee === "—") return pc.dim(value);
      return value;
    },
  );
}
