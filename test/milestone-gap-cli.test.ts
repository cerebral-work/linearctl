import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const KEY = process.env.LINEAR_API_KEY;
const live = test.skipIf(!KEY);

async function runCli(args: string[], envOverrides: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, "src/index.ts", ...args], {
    cwd: root,
    env: { ...process.env, ...envOverrides },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}

describe("milestone gap CLI option parsing — CER-2820", () => {
  test("linearctl milestone gap --help shows --project option", async () => {
    const { code, stdout, stderr } = await runCli(["milestone", "gap", "--help"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("--project <ref>");
  });

  test("linearctl milestone gap without --project exits 2 with usage error", async () => {
    const { code, stderr } = await runCli(["milestone", "gap"]);
    expect(code).toBe(2);
    expect(stderr).toContain("milestone gap needs --project <ref>");
  });

  live("linearctl milestone gap --project <name> returns coverage report (exit 0)", async () => {
    const { code, stdout, stderr } = await runCli(["milestone", "gap", "--project", "linearctl", "--json"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.project).toBe("linearctl");
    expect(Array.isArray(parsed.emptyMilestones)).toBe(true);
    expect(Array.isArray(parsed.unassignedIssues)).toBe(true);
    expect(Array.isArray(parsed.docSectionGaps)).toBe(true);
  });

  live("linearctl milestone --project <name> gap returns coverage report (exit 0)", async () => {
    const { code, stdout, stderr } = await runCli(["milestone", "--project", "linearctl", "gap", "--json"]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.project).toBe("linearctl");
    expect(Array.isArray(parsed.emptyMilestones)).toBe(true);
  });

  live("linearctl milestone gap --project <uuid> returns coverage report for project with milestones", async () => {
    // 57c78591-3e4f-4222-ab7b-f94ea61dd320 is Saga — Multi-Repo Estate Orchestration & TUI
    const { code, stdout, stderr } = await runCli([
      "milestone",
      "gap",
      "--project",
      "57c78591-3e4f-4222-ab7b-f94ea61dd320",
      "--json",
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.project).toBe("Saga — Multi-Repo Estate Orchestration & TUI");
    expect(parsed.emptyMilestones.length).toBeGreaterThan(0);
  });

  live("linearctl milestone gap --project <slugId> returns coverage report", async () => {
    // 263d3f67d2dd is slugId for Saga project
    const { code, stdout, stderr } = await runCli([
      "milestone",
      "gap",
      "--project",
      "263d3f67d2dd",
      "--json",
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.project).toBe("Saga — Multi-Repo Estate Orchestration & TUI");
  });

  live("linearctl milestone gap reports zero milestones project without erroring", async () => {
    // 64bb5e13-4d87-4697-bafc-c477ec463ae0 is Estate Facebook OSS Integration (0 milestones)
    const { code, stdout, stderr } = await runCli([
      "milestone",
      "gap",
      "--project",
      "64bb5e13-4d87-4697-bafc-c477ec463ae0",
      "--json",
    ]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.project).toBe("Estate Facebook OSS Integration");
    expect(parsed.emptyMilestones).toEqual([]);
  });
});
