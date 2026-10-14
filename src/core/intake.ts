import type { LinearClient } from "@linear/sdk";
import { type TriageItem, triage } from "./grooming.js";
import { withRetry } from "../lib/retry.js";

export const PLAN_SUBMISSION_SCHEMA_VERSION = "escapement.plan-submission.v1";
export const DEFAULT_TOKENS_PER_POINT = 32_000;
export const DEFAULT_MAX_TOKENS = 64_000;
export const MIN_MAX_TOKENS = 16_000;
export const MAX_TOKENS_CAP = 512_000;

export type ExecutionTier = "fast" | "balanced" | "capable" | "review";

export interface PlanBudget {
  maxTokens: number;
  tokensPerPoint: number;
  estimated: boolean;
}

export interface PlanMetadata {
  team: string | null;
  project: string | null;
  state: string;
  stateType: string;
  estimate: number | null;
  assignee: string | null;
  sourceUrl: string | null;
}

export interface PlanSubmission {
  schemaVersion: string;
  linear_issue_id: string;
  identifier: string;
  title: string;
  goal: string;
  workflow: string;
  tier: ExecutionTier;
  priority: number;
  labels: string[];
  budget: PlanBudget;
  metadata: PlanMetadata;
}

export interface IntakeCandidate {
  identifier: string;
  title: string;
  description?: string | null;
  url?: string | null;
  team?: string | null;
  project?: string | null;
  priority: number;
  estimate?: number | null;
  state: string;
  stateType: string;
  labels: string[];
  assignee?: string | null;
}

export interface IntakePolicy {
  requiredLabels: string[];
  blockedLabels: string[];
  allowedStateTypes: string[];
  defaultWorkflow: string;
  tokensPerPoint: number;
  defaultMaxTokens: number;
}

export interface IntakeEvaluation {
  linear_issue_id: string;
  identifier: string;
  eligible: boolean;
  reasons: string[];
  submission: PlanSubmission | null;
}

export function defaultIntakePolicy(overrides?: Partial<IntakePolicy>): IntakePolicy {
  return {
    requiredLabels: overrides?.requiredLabels ?? [],
    blockedLabels: overrides?.blockedLabels ?? [
      "blocked",
      "do-not-automate",
      "needs-human",
      "wontfix",
    ],
    allowedStateTypes: overrides?.allowedStateTypes ?? ["triage", "backlog", "unstarted"],
    defaultWorkflow: overrides?.defaultWorkflow ?? "feature",
    tokensPerPoint: overrides?.tokensPerPoint ?? DEFAULT_TOKENS_PER_POINT,
    defaultMaxTokens: overrides?.defaultMaxTokens ?? DEFAULT_MAX_TOKENS,
  };
}

export function mapPriorityToTier(priority: number): ExecutionTier {
  switch (priority) {
    case 1:
    case 2:
      return "capable";
    case 3:
      return "balanced";
    case 4:
      return "fast";
    default:
      return "review";
  }
}

export function resolveWorkflow(labels: string[], defaultWorkflow = "feature"): string {
  const normalized = labels.map((l) => l.trim().toLowerCase());
  if (normalized.some((l) => l === "security" || l === "cve" || l === "vulnerability")) {
    return "security-fix";
  }
  if (
    normalized.some(
      (l) => l === "bug" || l === "incident" || l === "regression" || l === "defect",
    )
  ) {
    return "bugfix";
  }
  if (normalized.some((l) => l === "docs" || l === "documentation" || l === "runbook")) {
    return "docs";
  }
  if (
    normalized.some(
      (l) => l === "chore" || l === "maintenance" || l === "refactor" || l === "deps",
    )
  ) {
    return "chore";
  }
  return defaultWorkflow;
}

export function computeBudget(
  estimate: number | null | undefined,
  policy: IntakePolicy,
): PlanBudget {
  const tokensPerPoint =
    policy.tokensPerPoint > 0 ? policy.tokensPerPoint : DEFAULT_TOKENS_PER_POINT;
  const defaultMax =
    policy.defaultMaxTokens > 0 ? policy.defaultMaxTokens : DEFAULT_MAX_TOKENS;

  if (typeof estimate === "number" && Number.isFinite(estimate) && estimate > 0) {
    const raw = Math.round(estimate * tokensPerPoint);
    const clamped = Math.min(MAX_TOKENS_CAP, Math.max(MIN_MAX_TOKENS, raw));
    return {
      maxTokens: clamped,
      tokensPerPoint,
      estimated: true,
    };
  }

  return {
    maxTokens: Math.min(MAX_TOKENS_CAP, Math.max(MIN_MAX_TOKENS, defaultMax)),
    tokensPerPoint,
    estimated: false,
  };
}

export function candidateFromTriageItem(item: TriageItem): IntakeCandidate {
  const dashIdx = item.identifier.indexOf("-");
  const team = dashIdx > 0 ? item.identifier.slice(0, dashIdx) : null;
  return {
    identifier: item.identifier,
    title: item.title,
    description: null,
    url: item.url || null,
    team,
    project: item.project ?? null,
    priority: item.priority,
    estimate: item.estimate ?? null,
    state: item.state,
    stateType: item.stateType,
    labels: item.labels ?? [],
    assignee: item.assignee ?? null,
  };
}

export function toPlanSubmission(
  candidate: IntakeCandidate,
  policyInput?: Partial<IntakePolicy>,
): PlanSubmission {
  const policy = defaultIntakePolicy(policyInput);
  const sortedLabels = Array.from(
    new Set(
      (candidate.labels ?? [])
        .map((l) => l.trim())
        .filter((l) => l.length > 0),
    ),
  ).sort();

  const desc = candidate.description?.trim();
  const goal = desc ? `${candidate.title.trim()}\n\n${desc}` : candidate.title.trim();

  const dashIdx = candidate.identifier.indexOf("-");
  const derivedTeam = dashIdx > 0 ? candidate.identifier.slice(0, dashIdx) : null;

  return {
    schemaVersion: PLAN_SUBMISSION_SCHEMA_VERSION,
    linear_issue_id: candidate.identifier,
    identifier: candidate.identifier,
    title: candidate.title,
    goal,
    workflow: resolveWorkflow(sortedLabels, policy.defaultWorkflow),
    tier: mapPriorityToTier(candidate.priority),
    priority: candidate.priority,
    labels: sortedLabels,
    budget: computeBudget(candidate.estimate, policy),
    metadata: {
      team: candidate.team ?? derivedTeam,
      project: candidate.project ?? null,
      state: candidate.state,
      stateType: candidate.stateType,
      estimate: candidate.estimate ?? null,
      assignee: candidate.assignee ?? null,
      sourceUrl: candidate.url ?? null,
    },
  };
}

export function evaluateIntake(
  candidate: IntakeCandidate,
  policyInput?: Partial<IntakePolicy>,
): IntakeEvaluation {
  const policy = defaultIntakePolicy(policyInput);
  const reasons: string[] = [];

  const stateTypeLower = candidate.stateType.trim().toLowerCase();
  if (
    policy.allowedStateTypes.length > 0 &&
    !policy.allowedStateTypes.some((s) => s.trim().toLowerCase() === stateTypeLower)
  ) {
    reasons.push(
      `stateType '${candidate.stateType}' is not in allowedStateTypes [${policy.allowedStateTypes.join(", ")}]`,
    );
  }

  const candidateLabelsLower = (candidate.labels ?? []).map((l) => l.trim().toLowerCase());
  for (const blocked of policy.blockedLabels) {
    const b = blocked.trim().toLowerCase();
    if (b && candidateLabelsLower.includes(b)) {
      reasons.push(`blocked by label '${blocked}'`);
    }
  }

  for (const required of policy.requiredLabels) {
    const r = required.trim().toLowerCase();
    if (r && !candidateLabelsLower.includes(r)) {
      reasons.push(`missing required label '${required}'`);
    }
  }

  const eligible = reasons.length === 0;
  return {
    linear_issue_id: candidate.identifier,
    identifier: candidate.identifier,
    eligible,
    reasons,
    submission: eligible ? toPlanSubmission(candidate, policy) : null,
  };
}

export async function intakeSingleIssue(
  client: LinearClient,
  id: string,
  policyInput?: Partial<IntakePolicy>,
): Promise<IntakeEvaluation> {
  const issue = await withRetry(() => client.issue(id));
  const [state, assignee, project, team, labels] = await Promise.all([
    issue.state,
    issue.assignee,
    issue.project,
    issue.team,
    issue.labels(),
  ]);
  const candidate: IntakeCandidate = {
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? null,
    url: issue.url,
    team: team?.key ?? null,
    project: project?.name ?? null,
    priority: issue.priority ?? 0,
    estimate: issue.estimate ?? null,
    state: state?.name ?? "",
    stateType: state?.type ?? "unstarted",
    labels: labels.nodes.map((l) => l.name).sort(),
    assignee: assignee?.displayName ?? null,
  };
  return evaluateIntake(candidate, policyInput);
}

export async function intakeFromTriage(
  client: LinearClient,
  opts?: { teamKeys?: string[]; project?: string },
  policyInput?: Partial<IntakePolicy>,
): Promise<IntakeEvaluation[]> {
  const items = await triage(client, opts?.teamKeys, opts?.project);
  return items.map((item) =>
    evaluateIntake(candidateFromTriageItem(item), policyInput),
  );
}
