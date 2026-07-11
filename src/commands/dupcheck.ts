import { makeClient } from "../client.js";
import { dupcheck as dupcheckCore } from "../core/dupcheck.js";
import { printJson, printTable } from "../lib/output.js";
import { pc } from "../lib/style.js";

export interface DupcheckCmdOptions {
  team?: string[];
  project?: string;
  threshold?: string;
  limit?: string;
  json?: boolean;
}

/**
 * `linearctl dupcheck <title> --team CER [--threshold 0.85]` — surface likely
 * duplicates before filing. Read-only. See docs/features/dupcheck.md.
 */
export async function dupcheckCmd(title: string, opts: DupcheckCmdOptions): Promise<void> {
  const client = makeClient();
  const result = await dupcheckCore(client, title, {
    teamKeys: opts.team,
    project: opts.project,
    threshold: opts.threshold !== undefined ? Number(opts.threshold) : undefined,
    limit: opts.limit !== undefined ? Number(opts.limit) : undefined,
  });

  if (opts.json) {
    printJson(result);
    return;
  }

  if (result.matches.length === 0) {
    process.stdout.write(`no likely duplicates (threshold ${result.threshold}).\n`);
    return;
  }
  process.stdout.write(
    `possible duplicates (${result.matches.length} ≥ ${result.threshold} threshold):\n`,
  );
  printTable(
    result.matches.map((m) => ({
      identifier: m.identifier,
      score: m.score.toFixed(2),
      title: m.title,
    })),
    ["identifier", "score", "title"],
    (value, column) => {
      if (column === "identifier") return pc.cyan(value);
      if (column === "score") return pc.yellow(value);
      return value;
    },
  );
}
