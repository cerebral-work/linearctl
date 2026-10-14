import { makeClient } from "../client.js";
import { digest as digestCore, renderBlackwallToml } from "../core/grooming.js";
import { usageError } from "../lib/errors.js";
import { sinceToDate } from "../lib/time.js";
import { printJson, printTable } from "../lib/output.js";
import { pc } from "../lib/style.js";

export interface DigestOptions {
  since: string;
  team?: string[];
  project?: string;
  format?: string;
  json?: boolean;
}

/**
 * `linearctl digest [--since 7d] [--team KEY...] [--format default|blackwall]` — recent issue activity grouped
 * by workflow-state type. Delegates to `core.digest`; this layer parses the
 * window and formats. See docs/spec.md §6.2.
 */
export async function digest(opts: DigestOptions): Promise<void> {
  const fmt = (opts.format ?? "default").toLowerCase();
  if (fmt !== "default" && fmt !== "blackwall") {
    throw usageError(
      `invalid --format "${opts.format}": expected 'default' or 'blackwall'.`,
      "Example: linearctl digest --format blackwall",
    );
  }
  const client = makeClient();
  const since = sinceToDate(opts.since);
  const result = await digestCore(client, since, opts.team, opts.project);

  if (opts.json) {
    printJson(result);
    return;
  }

  if (fmt === "blackwall") {
    process.stdout.write(renderBlackwallToml(result));
    return;
  }

  process.stdout.write(
    `${result.total} issue(s) updated since ${result.since}\n`,
  );
  for (const group of result.groups) {
    process.stdout.write(`\n${pc.bold(`${group.type} (${group.count})`)}\n`);
    printTable(
      group.items.map((i) => ({
        identifier: i.identifier,
        state: i.state,
        assignee: i.assignee ?? "—",
        title: i.title,
      })),
      ["identifier", "state", "assignee", "title"],
      (value, column) => (column === "identifier" ? pc.cyan(value) : value),
    );
  }
}
