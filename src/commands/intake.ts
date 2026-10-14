import { makeClient } from "../client.js";
import {
  type IntakePolicy,
  intakeFromTriage,
  intakeSingleIssue,
} from "../core/intake.js";
import { usageError } from "../lib/errors.js";
import { printJson, printTable } from "../lib/output.js";

export interface IntakeCommandOptions {
  team?: string[];
  project?: string;
  triage?: boolean;
  requireLabel?: string[];
  all?: boolean;
  defaultWorkflow?: string;
  tokensPerPoint?: string;
  json?: boolean;
}

export async function intakeCmd(
  id: string | undefined,
  opts: IntakeCommandOptions,
): Promise<void> {
  if (!id && !opts.triage) {
    throw usageError("intake requires an issue <id> or --triage.");
  }

  const requiredLabels = (opts.requireLabel ?? [])
    .flatMap((l) => l.split(","))
    .map((l) => l.trim())
    .filter(Boolean);

  const policyOverrides: Partial<IntakePolicy> = {
    requiredLabels,
    ...(opts.defaultWorkflow ? { defaultWorkflow: opts.defaultWorkflow } : {}),
    ...(opts.tokensPerPoint
      ? { tokensPerPoint: Number.parseInt(opts.tokensPerPoint, 10) }
      : {}),
  };

  const client = makeClient();

  if (id && !opts.triage) {
    const evaluation = await intakeSingleIssue(client, id, policyOverrides);
    const payload =
      opts.all || !evaluation.submission ? evaluation : evaluation.submission;
    if (opts.json) {
      printJson(payload);
      return;
    }
    if (evaluation.submission) {
      const s = evaluation.submission;
      process.stdout.write(
        `${s.linear_issue_id}\tworkflow=${s.workflow}\ttier=${s.tier}\tmaxTokens=${s.budget.maxTokens}\t${s.title}\n`,
      );
    } else {
      process.stdout.write(
        `${evaluation.linear_issue_id}\teligible=false\treasons=${evaluation.reasons.join("; ")}\n`,
      );
    }
    return;
  }

  const evaluations = await intakeFromTriage(
    client,
    { teamKeys: opts.team, project: opts.project },
    policyOverrides,
  );

  if (opts.all) {
    if (opts.json) {
      printJson(evaluations);
      return;
    }
    printTable(
      evaluations.map((e) => ({
        linear_issue_id: e.linear_issue_id,
        eligible: String(e.eligible),
        workflow: e.submission?.workflow ?? "—",
        tier: e.submission?.tier ?? "—",
        reasons: e.reasons.join("; ") || "—",
      })),
      ["linear_issue_id", "eligible", "workflow", "tier", "reasons"],
    );
    return;
  }

  const submissions = evaluations
    .filter((e) => e.eligible && e.submission !== null)
    .map((e) => e.submission!);

  if (opts.json) {
    printJson(submissions);
    return;
  }

  printTable(
    submissions.map((s) => ({
      linear_issue_id: s.linear_issue_id,
      workflow: s.workflow,
      tier: s.tier,
      maxTokens: String(s.budget.maxTokens),
      title: s.title,
    })),
    ["linear_issue_id", "workflow", "tier", "maxTokens", "title"],
  );
}
