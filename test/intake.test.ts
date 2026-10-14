import { describe, expect, test } from "bun:test";
import type { TriageItem } from "../src/core/grooming.js";
import {
  DEFAULT_MAX_TOKENS,
  PLAN_SUBMISSION_SCHEMA_VERSION,
  candidateFromTriageItem,
  computeBudget,
  defaultIntakePolicy,
  evaluateIntake,
  mapPriorityToTier,
  resolveWorkflow,
  toPlanSubmission,
} from "../src/core/intake.js";

describe("lnr -> escapement intake mapping", () => {
  test("maps Linear priority 0..4 to execution tiers", () => {
    expect(mapPriorityToTier(1)).toBe("capable");
    expect(mapPriorityToTier(2)).toBe("capable");
    expect(mapPriorityToTier(3)).toBe("balanced");
    expect(mapPriorityToTier(4)).toBe("fast");
    expect(mapPriorityToTier(0)).toBe("review");
  });

  test("maps issue labels to escapement workflow names", () => {
    expect(resolveWorkflow(["bug", "agent-eligible"])).toBe("bugfix");
    expect(resolveWorkflow(["security", "bug"])).toBe("security-fix");
    expect(resolveWorkflow(["runbook"])).toBe("docs");
    expect(resolveWorkflow(["refactor"])).toBe("chore");
    expect(resolveWorkflow(["agent-eligible"], "feature")).toBe("feature");
  });

  test("computes token budgets from story-point estimates with clamping", () => {
    const policy = defaultIntakePolicy();
    const estimated = computeBudget(3, policy);
    expect(estimated.estimated).toBe(true);
    expect(estimated.maxTokens).toBe(96_000);

    const unestimated = computeBudget(null, policy);
    expect(unestimated.estimated).toBe(false);
    expect(unestimated.maxTokens).toBe(DEFAULT_MAX_TOKENS);
  });

  test("converts enriched TriageItem to PlanSubmission and preserves linear_issue_id", () => {
    const triageItem: TriageItem = {
      identifier: "CER-2130",
      title: "Wire lnr to escapement intake edge",
      priority: 2,
      estimate: 3,
      assignee: null,
      state: "Todo",
      stateType: "unstarted",
      reasons: ["unassigned"],
      url: "https://linear.app/cerebral/issue/CER-2130",
      labels: ["agent-eligible", "bug"],
      project: "Estates",
    };

    const candidate = candidateFromTriageItem(triageItem);
    const evalResult = evaluateIntake(candidate, {
      requiredLabels: ["agent-eligible"],
    });

    expect(evalResult.eligible).toBe(true);
    expect(evalResult.linear_issue_id).toBe("CER-2130");
    expect(evalResult.submission).not.toBeNull();

    const sub = evalResult.submission!;
    expect(sub.schemaVersion).toBe(PLAN_SUBMISSION_SCHEMA_VERSION);
    expect(sub.linear_issue_id).toBe("CER-2130");
    expect(sub.identifier).toBe("CER-2130");
    expect(sub.tier).toBe("capable");
    expect(sub.workflow).toBe("bugfix");
    expect(sub.budget.maxTokens).toBe(96_000);
    expect(sub.metadata.team).toBe("CER");
    expect(sub.metadata.project).toBe("Estates");
    expect(sub.metadata.sourceUrl).toBe("https://linear.app/cerebral/issue/CER-2130");
  });

  test("filters out candidates with blocked labels, missing required labels, or terminal stateType", () => {
    const base = toPlanSubmission({
      identifier: "ENG-404",
      title: "Blocked task",
      priority: 3,
      estimate: 2,
      state: "Todo",
      stateType: "unstarted",
      labels: ["blocked", "agent-eligible"],
    });
    expect(base.linear_issue_id).toBe("ENG-404");

    const blockedEval = evaluateIntake(
      {
        identifier: "ENG-404",
        title: "Blocked task",
        priority: 3,
        estimate: 2,
        state: "Todo",
        stateType: "unstarted",
        labels: ["blocked", "agent-eligible"],
      },
      { requiredLabels: ["agent-eligible"] },
    );
    expect(blockedEval.eligible).toBe(false);
    expect(blockedEval.submission).toBeNull();
    expect(blockedEval.reasons.some((r) => r.includes("blocked"))).toBe(true);

    const completedEval = evaluateIntake({
      identifier: "ENG-405",
      title: "Already done",
      priority: 3,
      estimate: 1,
      state: "Done",
      stateType: "completed",
      labels: ["agent-eligible"],
    });
    expect(completedEval.eligible).toBe(false);
    expect(completedEval.reasons.some((r) => r.includes("stateType"))).toBe(true);
  });
});
