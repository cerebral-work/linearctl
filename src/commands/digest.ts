import { makeClient } from "../client.js";
import { digest as digestCore } from "../core/grooming.js";
import { sinceToDate } from "../lib/time.js";
import { printJson, printTable } from "../lib/output.js";

export interface DigestOptions {
  since: string;
  team?: string[];
  project?: string;
  json?: boolean;
}

/**
 * `linearctl digest [--since 7d] [--team KEY...]` — recent issue activity grouped
 * by workflow-state type. Delegates to `core.digest`; this layer parses the
 * window and formats. See docs/spec.md §6.2.
 */
export async function digest(opts: DigestOptions): Promise<void> {
  const client = makeClient();
  const since = sinceToDate(opts.since);
  const result = await digestCore(client, since, opts.team, opts.project);

  if (opts.json) {
    printJson(result);
    return;
  }

  process.stdout.write(
    `${result.total} issue(s) updated since ${result.since}\n`,
  );
  for (const group of result.groups) {
    process.stdout.write(`\n${group.type} (${group.count})\n`);
    printTable(
      group.items.map((i) => ({
        identifier: i.identifier,
        state: i.state,
        assignee: i.assignee ?? "—",
        title: i.title,
      })),
      ["identifier", "state", "assignee", "title"],
    );
  }
}
