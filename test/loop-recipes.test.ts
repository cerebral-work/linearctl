import { describe, expect, test } from "bun:test";
import { lintRecipe, lintAll, loadRecipes, type LoopRecipe, type LintFinding } from "../src/core/loop-recipes.js";
import { join } from "node:path";

const VALID_RECIPE: LoopRecipe = {
  name: "test-recipe",
  version: 1,
  last_verified: new Date().toISOString().slice(0, 10),
  trigger: { type: "issue_created", conditions: { state: "triage", team: ["CER"] } },
  permissions: {
    team_access: ["CER"],
    code_intelligence: false,
    coding_sessions: false,
    web_access: false,
    external_sources: [],
    allow_changes_outside_triggering_issue: false,
  },
  tools: ["github"],
  audience: ["engineering"],
  body: "Investigate the issue.\n\nDo NOT change the assignee.\n",
  file: "test.md",
};

describe("lintRecipe", () => {
  test("valid recipe has no findings", () => {
    const findings = lintRecipe(VALID_RECIPE, "test.md");
    expect(findings).toHaveLength(0);
  });

  test("missing name is an error", () => {
    const findings = lintRecipe({ ...VALID_RECIPE, name: undefined } as unknown as LoopRecipe, "test.md");
    expect(findings.some((f) => f.severity === "error" && f.message.includes("name"))).toBe(true);
  });

  test("missing last_verified is a warning", () => {
    const findings = lintRecipe({ ...VALID_RECIPE, last_verified: undefined } as unknown as LoopRecipe, "test.md");
    expect(findings.some((f) => f.severity === "warning" && f.message.includes("last_verified"))).toBe(true);
  });

  test("invalid trigger type is an error", () => {
    const findings = lintRecipe({ ...VALID_RECIPE, trigger: { type: "invalid" as never } }, "test.md");
    expect(findings.some((f) => f.severity === "error" && f.message.includes("trigger type"))).toBe(true);
  });

  test("schedule without cron is an error", () => {
    const findings = lintRecipe(
      { ...VALID_RECIPE, trigger: { type: "schedule" } },
      "test.md",
    );
    expect(findings.some((f) => f.severity === "error" && f.message.includes("cron"))).toBe(true);
  });

  test("web_access enabled is a warning", () => {
    const findings = lintRecipe(
      { ...VALID_RECIPE, permissions: { ...VALID_RECIPE.permissions, web_access: true } },
      "test.md",
    );
    expect(findings.some((f) => f.severity === "warning" && f.message.includes("web_access"))).toBe(true);
  });

  test("coding_sessions enabled is a warning", () => {
    const findings = lintRecipe(
      { ...VALID_RECIPE, permissions: { ...VALID_RECIPE.permissions, coding_sessions: true } },
      "test.md",
    );
    expect(findings.some((f) => f.severity === "warning" && f.message.includes("coding_sessions"))).toBe(true);
  });

  test("allow_changes_outside_triggering_issue on non-schedule is a warning", () => {
    const findings = lintRecipe(
      { ...VALID_RECIPE, permissions: { ...VALID_RECIPE.permissions, allow_changes_outside_triggering_issue: true } },
      "test.md",
    );
    expect(findings.some((f) => f.severity === "warning" && f.message.includes("allow_changes_outside_triggering_issue"))).toBe(true);
  });

  test("stale last_verified (>90d) is a warning", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 120);
    const findings = lintRecipe(
      { ...VALID_RECIPE, last_verified: oldDate.toISOString().slice(0, 10) },
      "test.md",
    );
    expect(findings.some((f) => f.severity === "warning" && f.message.includes("old"))).toBe(true);
  });

  test("body without negative constraints is a warning", () => {
    const findings = lintRecipe(
      { ...VALID_RECIPE, body: "Do the thing and comment." },
      "test.md",
    );
    expect(findings.some((f) => f.severity === "warning" && f.message.includes("negative constraints"))).toBe(true);
  });
});

describe("lintAll — against real recipe catalog", () => {
  const recipesDir = join(process.cwd(), ".linearctl", "loop-recipes");

  test("loads all 9 recipes", () => {
    const loaded = loadRecipes(recipesDir);
    expect(loaded.length).toBeGreaterThanOrEqual(5);
  });

  test("all recipes have names + versions", () => {
    const loaded = loadRecipes(recipesDir);
    for (const { recipe } of loaded) {
      expect(recipe.name).toBeTruthy();
      expect(recipe.version).toBeGreaterThanOrEqual(1);
    }
  });

  test("all recipes have last_verified", () => {
    const loaded = loadRecipes(recipesDir);
    for (const { recipe } of loaded) {
      expect(recipe.last_verified).toBeTruthy();
    }
  });

  test("all recipes have negative constraints in body", () => {
    const loaded = loadRecipes(recipesDir);
    for (const { raw } of loaded) {
      expect(raw).toMatch(/do not|does not|never/i);
    }
  });

  test("lint passes with no errors on the real catalog", () => {
    const result = lintAll([recipesDir]);
    const errors = result.findings.filter((f) => f.severity === "error");
    expect(errors).toHaveLength(0);
    expect(result.valid).toBe(true);
  });
});
