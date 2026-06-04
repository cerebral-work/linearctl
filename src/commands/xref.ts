import { makeClient } from "../client.js";
import { xref as xrefCore } from "../core/xref.js";
import { printJson, printTable } from "../lib/output.js";

export interface XrefOptions {
  repo?: string;
  team?: string[];
  limit?: string;
  json?: boolean;
}

/**
 * `linearctl xref [--repo owner/repo] [--team KEY...] [--limit 50]` — reconcile
 * GitHub PRs ↔ Linear tickets (read-only). Reports PR↔ticket mismatches. Needs
 * the GitHub CLI (`gh`) installed + authenticated. See docs/spec.md §6.10.
 */
export async function xref(opts: XrefOptions): Promise<void> {
  const client = makeClient();
  const result = await xrefCore(client, {
    repo: opts.repo,
    teamKeys: opts.team,
    mergedLimit: opts.limit !== undefined ? Number(opts.limit) : undefined,
  });

  if (opts.json) {
    printJson(result);
    return;
  }

  process.stdout.write(
    `repo ${result.repo}: ${result.openPRs} open, ${result.mergedPRs} merged PR(s); ` +
      `${result.findings.length} finding(s)\n`,
  );
  printTable(
    result.findings.map((f) => ({
      pr: `#${f.pr}`,
      kind: f.kind,
      refs: f.refs.join(",") || "—",
      detail: f.detail,
    })),
    ["pr", "kind", "refs", "detail"],
  );
}
