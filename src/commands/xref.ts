import { makeClient } from "../client.js";
import { xref as xrefCore, planXrefFixes, type XrefFixAction } from "../core/xref.js";
import { closeIssue, startIssue, type UpdatedIssue } from "../core/issues.js";
import { mapPool } from "../lib/pool.js";
import { printJson, printTable } from "../lib/output.js";
import { isInteractive } from "../lib/interactive.js";
import { promptSelect } from "../lib/prompts.js";

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
 * Walk a fix plan through a per-action prompt. `yes`/`no` act on one action,
 * `all` fast-tracks the rest, `abort` skips everything remaining. Pure given
 * the injected prompt — exported for tests.
 */
export async function gateFixPlan(
  plan: XrefFixAction[],
  ask: (a: XrefFixAction) => Promise<string>,
): Promise<{ confirmed: XrefFixAction[]; skipped: FixOutcome[] }> {
  const confirmed: XrefFixAction[] = [];
  const skipped: FixOutcome[] = [];
  let applyRest = false;
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    if (!applyRest) {
      const answer = await ask(a);
      if (answer === "abort") {
        skipped.push(...plan.slice(i).map((r) => ({ ...r, error: "skipped (aborted)" })));
        break;
      }
      if (answer === "no") {
        skipped.push({ ...a, error: "skipped (declined)" });
        continue;
      }
      if (answer === "all") applyRest = true;
    }
    confirmed.push(a);
  }
  return { confirmed, skipped };
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

  // Interactive apply: confirm each remediation before writing. Declined
  // actions are reported as skipped, never executed. Headless --apply is
  // unchanged (the batch/CI path deliberately has no gate — spec §6.10).
  let toApply = plan;
  let skipped: FixOutcome[] = [];
  if (opts.apply && plan.length && isInteractive(opts.json)) {
    const gated = await gateFixPlan(plan, (a) =>
      promptSelect(`${a.ref}: ${a.action} (${a.reason}) — apply?`, [
        { name: "yes", value: "yes" },
        { name: "no (skip)", value: "no" },
        { name: "yes to all remaining", value: "all" },
        { name: "abort (skip all remaining)", value: "abort" },
      ]),
    );
    toApply = gated.confirmed;
    skipped = gated.skipped;
  }

  if (opts.apply && toApply.length) {
    outcomes = await mapPool(toApply, 2, async (a): Promise<FixOutcome> => {
      try {
        const result =
          a.action === "close" ? await closeIssue(client, a.ref) : await startIssue(client, a.ref);
        return { ...a, result };
      } catch (err) {
        return { ...a, error: err instanceof Error ? err.message : String(err) };
      }
    });
  } else if (opts.apply) {
    outcomes = [];
  }
  outcomes = [...outcomes, ...skipped];

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
