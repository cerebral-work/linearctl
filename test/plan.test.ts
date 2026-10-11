import { describe, expect, test } from "bun:test";
import {
  classifyStepRole,
  computeCpm,
  computeWaves,
  generateSagaPlan,
  serializePlanToToml,
  parseSagaPlanToml,
  runSagaCliSchedule,
  type SagaPlan,
  type SagaPlanStep,
} from "../src/core/plan/index.js";
import type { BeadsIssue } from "../src/core/beads/types.js";

describe("Saga Spec 0040 Plan & CPM", () => {
  test("classifyStepRole implements Spec 0040 U9 rules", () => {
    expect(classifyStepRole({ id: "s1", title: "Write code", kind: "impl" })).toBe("builder");
    expect(classifyStepRole({ id: "s2", title: "Run tests", kind: "verify" })).toBe("probe");
    expect(classifyStepRole({ id: "s3", title: "Review PR", kind: "verify" })).toBe("critic");
    expect(classifyStepRole({ id: "s4", title: "Critic check", kind: "verify" })).toBe("critic");
    expect(classifyStepRole({ id: "s5", title: "Deploy gate", kind: "gate" })).toBe("main_session");
    expect(classifyStepRole({ id: "s6", title: "Custom", kind: "verify", agent: "critic" })).toBe("critic");
    expect(classifyStepRole({ id: "s7", title: "Custom gate", kind: "verify", gate: "heimdal:approval" })).toBe("main_session");
  });

  test("computeCpm calculates ES, EF, LS, LF, slack and critical path", () => {
    const steps: SagaPlanStep[] = [
      { id: "A", title: "Task A", kind: "impl", duration: 10 },
      { id: "B", title: "Task B", kind: "impl", duration: 15, deps: ["A"] },
      { id: "C", title: "Task C", kind: "verify", duration: 5, deps: ["A"] },
      { id: "D", title: "Task D", kind: "gate", duration: 1, deps: ["B", "C"] },
    ];

    const result = computeCpm(steps);
    expect(result.total_duration).toBe(26); // A(10) + B(15) + D(1) = 26
    expect(result.critical_path).toEqual(["A", "B", "D"]);

    const stepA = result.steps.get("A")!;
    expect(stepA.es).toBe(0);
    expect(stepA.ef).toBe(10);
    expect(stepA.slack).toBe(0);
    expect(stepA.critical).toBe(true);

    const stepB = result.steps.get("B")!;
    expect(stepB.es).toBe(10);
    expect(stepB.ef).toBe(25);
    expect(stepB.slack).toBe(0);
    expect(stepB.critical).toBe(true);

    const stepC = result.steps.get("C")!;
    expect(stepC.es).toBe(10);
    expect(stepC.ef).toBe(15);
    expect(stepC.ls).toBe(20);
    expect(stepC.lf).toBe(25);
    expect(stepC.slack).toBe(10);
    expect(stepC.critical).toBe(false);

    const stepD = result.steps.get("D")!;
    expect(stepD.es).toBe(25);
    expect(stepD.ef).toBe(26);
    expect(stepD.slack).toBe(0);
    expect(stepD.critical).toBe(true);
  });

  test("computeWaves partitions steps into waves with U3 concurrency limit", () => {
    const steps: SagaPlanStep[] = [
      { id: "A", title: "Task A", kind: "impl", duration: 10 },
      { id: "B", title: "Task B", kind: "verify", duration: 5 },
      { id: "C", title: "Task C", kind: "verify", duration: 5 },
      { id: "D", title: "Task D", kind: "impl", duration: 10, deps: ["A"] },
      { id: "E", title: "Task E", kind: "verify", duration: 5, deps: ["B"] },
    ];

    const plan: SagaPlan = {
      flow: { name: "test-wave-flow", max_concurrency: 2 },
      steps,
    };

    const wavesResult = computeWaves(plan);
    expect(wavesResult.schema).toBe("saga.plan.v1");
    expect(wavesResult.waves.length).toBeGreaterThan(1);
    expect(wavesResult.waves[0].length).toBeLessThanOrEqual(2);
  });

  test("computeCpm detects cycles and throws clear error", () => {
    const steps: SagaPlanStep[] = [
      { id: "X", title: "Task X", kind: "impl", deps: ["Y"] },
      { id: "Y", title: "Task Y", kind: "impl", deps: ["X"] },
    ];

    expect(() => computeCpm(steps)).toThrow("dependency cycle");
  });

  test("serializePlanToToml and parseSagaPlanToml round-trip", () => {
    const plan: SagaPlan = {
      flow: {
        name: "feature-sprint",
        description: "Sprint execution plan",
        max_concurrency: 3,
        pr_base: "development",
        on_halt: "cancel-dependents",
      },
      steps: [
        {
          id: "CER-101",
          title: "Core schema",
          kind: "impl",
          agent: "builder",
          duration: 20,
        },
        {
          id: "CER-102",
          title: "API endpoint",
          kind: "verify",
          agent: "probe",
          duration: 5,
          deps: ["CER-101"],
          verify_cmd: ["bun", "test"],
        },
      ],
    };

    const toml = serializePlanToToml(plan);
    expect(toml).toContain('[flow]');
    expect(toml).toContain('name = "feature-sprint"');
    expect(toml).toContain('[[step]]');
    expect(toml).toContain('id = "CER-101"');
    expect(toml).toContain('deps = ["CER-101"]');

    const parsed = parseSagaPlanToml(toml);
    expect(parsed.flow.name).toBe("feature-sprint");
    expect(parsed.steps.length).toBe(2);
    expect(parsed.steps[0].id).toBe("CER-101");
    expect(parsed.steps[1].deps).toEqual(["CER-101"]);
  });

  test("generateSagaPlan translates Beads issues with blocking relations", () => {
    const issues: BeadsIssue[] = [
      {
        id: "CER-201",
        title: "Database migrations",
        status: "open",
        priority: 1,
        created_at: "2026-10-11T10:00:00Z",
        updated_at: "2026-10-11T10:00:00Z",
        dependencies: [],
      },
      {
        id: "CER-202",
        title: "Write API service",
        status: "open",
        priority: 2,
        created_at: "2026-10-11T10:00:00Z",
        updated_at: "2026-10-11T10:00:00Z",
        dependencies: [
          {
            issue_id: "CER-202",
            depends_on_id: "CER-201",
            type: "blocks",
          },
        ],
      },
      {
        id: "CER-203",
        title: "Verify end-to-end integration",
        status: "open",
        priority: 2,
        created_at: "2026-10-11T10:00:00Z",
        updated_at: "2026-10-11T10:00:00Z",
        dependencies: [
          {
            issue_id: "CER-203",
            depends_on_id: "CER-202",
            type: "blocks",
          },
        ],
      },
    ];

    const plan = generateSagaPlan(issues, {
      name: "migration-wave",
      maxConcurrency: 2,
    });

    expect(plan.flow.name).toBe("migration-wave");
    expect(plan.steps.length).toBe(3);

    const step201 = plan.steps.find((s) => s.id === "CER-201")!;
    expect(step201.deps).toBeUndefined();

    const step202 = plan.steps.find((s) => s.id === "CER-202")!;
    expect(step202.deps).toEqual(["CER-201"]);

    const step203 = plan.steps.find((s) => s.id === "CER-203")!;
    expect(step203.kind).toBe("verify");
    expect(step203.deps).toEqual(["CER-202"]);

    // Calculate waves
    const schedule = computeWaves(plan);
    expect(schedule.waves.length).toBe(3);
    expect(schedule.waves[0]).toEqual(["CER-201"]);
    expect(schedule.waves[1]).toEqual(["CER-202"]);
    expect(schedule.waves[2]).toEqual(["CER-203"]);
  });
});
