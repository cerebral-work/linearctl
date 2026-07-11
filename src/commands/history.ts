import { makeClient } from "../client.js";
import { history as historyCore } from "../core/history.js";
import { printJson, printTable } from "../lib/output.js";
import { pc } from "../lib/style.js";

export interface HistoryOptions {
  limit?: string;
  json?: boolean;
}

/**
 * `linearctl history <id> [--limit 20]` — the audit trail `show` doesn't
 * surface: chronological timeline of state/assignee/priority/label/comment
 * events, oldest first (newest N under --limit). Read-only.
 * See docs/features/history.md (CER-1561).
 */
export async function historyCmd(id: string, opts: HistoryOptions): Promise<void> {
  const client = makeClient();
  const result = await historyCore(
    client,
    id,
    opts.limit !== undefined ? Number(opts.limit) : undefined,
  );

  if (opts.json) {
    printJson(result);
    return;
  }

  process.stdout.write(`${result.identifier} · ${JSON.stringify(result.title)}\n\n`);
  printTable(
    result.events.map((e) => ({
      time: e.at.replace("T", " ").slice(0, 16),
      actor: e.actor,
      event: e.detail,
    })),
    ["time", "actor", "event"],
    (value, column, row) => {
      if (column === "time") return pc.dim(value);
      if (column === "event" && row.event.startsWith("state:")) return pc.cyan(value);
      if (column === "event" && row.event.startsWith("comment:")) return pc.yellow(value);
      return value;
    },
  );
}
