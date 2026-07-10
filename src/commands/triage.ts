import { makeClient } from "../client.js";
import { triage as triageCore } from "../core/grooming.js";
import { printJson, printTable } from "../lib/output.js";
import { pc } from "../lib/style.js";

export interface TriageOptions {
  team?: string[];
  project?: string;
  json?: boolean;
}

/**
 * `linearctl triage [--team KEY...]` — surface issues needing triage (Triage
 * state, or unassigned / unestimated / no-priority in an active state). The
 * grooming SURFACE step (RFC §3.2). Delegates to `core.triage`; this layer only
 * formats. See docs/spec.md §6.4.
 */
export async function triage(opts: TriageOptions): Promise<void> {
  const client = makeClient();
  const items = await triageCore(client, opts.team, opts.project);

  if (opts.json) {
    printJson(items);
    return;
  }

  printTable(
    items.map((i) => ({
      identifier: i.identifier,
      state: i.state,
      assignee: i.assignee ?? "—",
      why: i.reasons.join("+"),
      title: i.title,
    })),
    ["identifier", "state", "assignee", "why", "title"],
    (value, column, row) => {
      if (column === "identifier") return pc.cyan(value);
      if (column === "why") return pc.yellow(value);
      if (column === "assignee" && row.assignee === "—") return pc.dim(value);
      return value;
    },
  );
}
