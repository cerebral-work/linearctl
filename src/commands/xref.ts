import { makeClient } from "../client.js";
import { xref as xrefCore, planXrefFixes, type XrefFixAction } from "../core/xref.js";
import { closeIssue, startIssue, type UpdatedIssue } from "../core/issues.js";
import { mapPool } from "../lib/pool.js";
import { printJson, printTable } from "../lib/output.js";

export interface XrefOptions {
  repo?: string;
  team?: string[];
  limit?: string;
  fix?: boolean;
  apply?: boolean;
  json?: boolean;
}

interface FixOutcome extends XrefFixAction {
  result?: UpdatedIssue;
  error?: string;
}

/**
 * `linearctl xref [--repo owner/repo] [--team KEY...] [--limit 50] [--fix [--apply]]`
 * — reconcile GitHub PRs ↔ Linear tickets. Read-only by default; `--fix` plans
 * ticket-state remediation from the findings (closing magic word → close,
 * bare ref on a never-started ticket → started state) and `--apply` executes
 * the plan. Needs the GitHub CLI (`gh`). See docs/spec.md §6.10.
 */
export async function xref(opts: XrefOptions): Promise<void> {
  const client = makeClient();
  const result = await xrefCore(client, {
    repo: opts.repo,
    teamKeys: opts.team,
    mergedLimit: opts.limit !== undefined ? Number(opts.limit) : undefined,
  });

  if (!opts.fix) {
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
    return;
  }

  const plan = planXrefFixes(result.findings);
  let outcomes: FixOutcome[] = plan;

  if (opts.apply && plan.length) {
    outcomes = await mapPool(plan, 2, async (a): Promise<FixOutcome> => {
      try {
        const result =
          a.action === "close" ? await closeIssue(client, a.ref) : await startIssue(client, a.ref);
        return { ...a, result };
      } catch (err) {
        return { ...a, error: err instanceof Error ? err.message : String(err) };
      }
    });
  }

  if (opts.json) {
    printJson({ applied: Boolean(opts.apply), plan: outcomes });
    return;
  }

  const mode = opts.apply ? "applied" : "dry-run (pass --apply to write)";
  process.stdout.write(`fix plan — ${plan.length} action(s), ${mode}\n`);
  printTable(
    outcomes.map((o) => ({
      ref: o.ref,
      action: o.action,
      reason: o.reason,
      outcome: o.error ?? (o.result ? `→ ${o.result.state}` : "planned"),
    })),
    ["ref", "action", "reason", "outcome"],
  );
}
