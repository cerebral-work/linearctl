import type { BeadsIssue } from "../beads/types.js";
import type {
  SagaPlan,
  SagaPlanFlow,
  SagaPlanStep,
  PlanGenerateOptions,
} from "./types.js";
import { computeCpm } from "./cpm.js";

/**
 * Derives step kind and agent role from issue attributes and labels.
 */
function inferStepKindAndAgent(issue: BeadsIssue): {
  kind: "impl" | "verify" | "gate";
  agent?: string;
  gate?: string;
} {
  const titleLower = issue.title.toLowerCase();
  const labelsLower = (issue.labels || []).map((l) => l.toLowerCase());
  const typeLower = (issue.issue_type || "").toLowerCase();

  // 1. Gate steps
  const isGate =
    typeLower === "epic" ||
    labelsLower.some((l) => l.includes("gate") || l.includes("approval")) ||
    titleLower.includes("operator-gate") ||
    titleLower.includes("approval gate");

  if (isGate) {
    return {
      kind: "gate",
      agent: "main_session",
      gate: "heimdal:approval",
    };
  }

  // 2. Verify / Probe / Critic steps
  const isCritic =
    labelsLower.some((l) => l.includes("critic") || l.includes("review")) ||
    titleLower.includes("critic") ||
    titleLower.includes("code review");

  if (isCritic) {
    return {
      kind: "verify",
      agent: "critic",
    };
  }

  const isVerify =
    labelsLower.some((l) =>
      l.includes("verify") ||
      l.includes("test") ||
      l.includes("spec") ||
      l.includes("qa") ||
      l.includes("probe")
    ) ||
    titleLower.startsWith("verify") ||
    titleLower.startsWith("test ") ||
    titleLower.startsWith("check ");

  if (isVerify) {
    return {
      kind: "verify",
      agent: "probe",
    };
  }

  // 3. Impl steps (default)
  return {
    kind: "impl",
    agent: "builder",
  };
}

/**
 * Derives a prompt string from description and acceptance criteria.
 */
function formatStepPrompt(issue: BeadsIssue): string | undefined {
  const parts: string[] = [];

  if (issue.description && issue.description.trim().length > 0) {
    parts.push(issue.description.trim());
  }

  if (issue.acceptance_criteria && issue.acceptance_criteria.trim().length > 0) {
    parts.push(`\nAcceptance Criteria:\n${issue.acceptance_criteria.trim()}`);
  }

  if (parts.length === 0) {
    return undefined;
  }

  return parts.join("\n\n");
}

/**
 * Filters raw issues based on generation options.
 */
function filterIssues(issues: BeadsIssue[], options: PlanGenerateOptions): BeadsIssue[] {
  return issues.filter((issue) => {
    // Open-only filter (default true unless includeClosed is true)
    if (options.openOnly !== false && !options.includeClosed) {
      if (issue.status === "closed") {
        return false;
      }
    }

    // Team filter
    if (options.team && options.team.length > 0) {
      const matchesTeam = options.team.some((t) => issue.id.startsWith(t + "-"));
      if (!matchesTeam) {
        return false;
      }
    }

    // Priority filter (less than or equal to threshold, where 0=P0 urgent)
    if (options.priority !== undefined) {
      if (issue.priority > options.priority) {
        return false;
      }
    }

    // Label filter
    if (options.labels && options.labels.length > 0) {
      const issueLabels = (issue.labels || []).map((l) => l.toLowerCase());
      const hasLabels = options.labels.every((l) => issueLabels.includes(l.toLowerCase()));
      if (!hasLabels) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Generates a Saga Spec 0040 Plan from Beads issues.
 */
export function generateSagaPlan(
  rawIssues: BeadsIssue[],
  options: PlanGenerateOptions = {}
): SagaPlan {
  const filtered = filterIssues(rawIssues, options);

  if (filtered.length === 0) {
    throw new Error("No issues matched the filter criteria for plan generation.");
  }

  const includedIds = new Set<string>(filtered.map((i) => i.id));
  const steps: SagaPlanStep[] = [];

  for (const issue of filtered) {
    const { kind, agent, gate } = inferStepKindAndAgent(issue);

    // Filter dependencies: only keep blockers that are included in the plan
    const rawDeps = issue.dependencies || [];
    const blockerIds = rawDeps
      .filter((d) => d.type === "blocks" && d.issue_id === issue.id)
      .map((d) => d.depends_on_id)
      .filter((depId) => includedIds.has(depId) && depId !== issue.id);

    const deps = Array.from(new Set(blockerIds)).sort();

    const step: SagaPlanStep = {
      id: issue.id,
      title: issue.title,
      kind,
      agent,
      deps: deps.length > 0 ? deps : undefined,
    };

    if (gate) {
      step.gate = gate;
    }

    if (issue.estimated_minutes && issue.estimated_minutes > 0) {
      step.duration = Math.max(1, Math.round(issue.estimated_minutes / 60));
    }

    const prompt = formatStepPrompt(issue);
    if (prompt) {
      step.prompt = prompt;
    }

    if (kind === "verify" && options.defaultVerifyCmd && options.defaultVerifyCmd.length > 0) {
      step.verify_cmd = options.defaultVerifyCmd;
    }

    steps.push(step);
  }

  // Handle addCritic option: pair each impl step with a critic verify step
  if (options.addCritic) {
    const additionalSteps: SagaPlanStep[] = [];
    const implToCriticMap = new Map<string, string>();

    for (const step of steps) {
      if (step.kind === "impl") {
        const criticId = `${step.id}-critic`;
        implToCriticMap.set(step.id, criticId);

        additionalSteps.push({
          id: criticId,
          title: `Review ${step.title}`,
          kind: "verify",
          agent: options.criticAgent || "critic",
          deps: [step.id],
          duration: 5,
        });
      }
    }

    // Retarget downstream dependencies to depend on the critic instead of the builder
    for (const step of steps) {
      if (step.deps && step.deps.length > 0) {
        step.deps = step.deps.map((depId) => implToCriticMap.get(depId) || depId);
      }
    }

    steps.push(...additionalSteps);
  }

  // Build flow definition
  const flowName = options.name || "linear-cpm-plan";
  const flow: SagaPlanFlow = {
    name: flowName,
    max_concurrency: options.maxConcurrency ?? 3,
    pr_base: options.prBase || "development",
    on_halt: options.onHalt || "cancel-dependents",
  };

  if (options.description) {
    flow.description = options.description;
  }
  if (options.mergeOnGreen !== undefined) {
    flow.merge_on_green = options.mergeOnGreen;
  }
  if (options.mergeWaitSecs !== undefined) {
    flow.merge_wait_secs = options.mergeWaitSecs;
  }
  if (options.openPrs !== undefined) {
    flow.open_prs = options.openPrs;
  }
  if (options.criticAgent) {
    flow.critic_agent = options.criticAgent;
  }
  if (options.builderModel) {
    flow.builder_model = options.builderModel;
  }

  const plan: SagaPlan = {
    flow,
    steps,
  };

  // Validate the plan with CPM calculation (ensures no cycles, empty IDs, etc.)
  computeCpm(plan.steps);

  return plan;
}
