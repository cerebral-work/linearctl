import { expect, test } from "bun:test";
import { join } from "node:path";

async function cli(command: string, ref: string, scenario = "", project?: string) {
  const child = Bun.spawn([process.execPath, "--preload", "./test/fixtures/milestone-api.ts", "src/index.ts", command,
    "--milestone", ref, "--state", "all", "--json", ...(project ? ["--project", project] : [])], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, LINEAR_API_KEY: "fixture-key", MILESTONE_TEST_SCENARIO: scenario }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr };
}

for (const command of ["pull", "search"]) {
  test(`${command} resolves a bare name across all visible projects and includes all matching ids`, async () => {
    const { code, stdout, stderr } = await cli(command, "Launch");
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)[0]).toMatchObject({ identifier: "ENG-123", stateType: "completed" });
  });
  test(`${command} distinguishes unknown names from known empty milestones`, async () => {
    const empty = await cli(command, "Launch", "empty");
    expect(empty.code).toBe(0);
    expect(JSON.parse(empty.stdout)).toEqual([]);
    expect(empty.stderr).toBe("");
    const missing = await cli(command, "Launc", "missing");
    expect(missing.code).toBe(4);
    expect(missing.stdout).toBe("");
    expect(missing.stderr.trim().split("\n")).toHaveLength(1);
    const error = JSON.parse(missing.stderr).error;
    expect(error).toMatchObject({ code: 4, kind: "not_found" });
    expect(error.message).toContain('"Launc"');
    expect(error.message).toContain("all projects accessible to the viewer");
    expect(error.hint).toContain('closest: "Launch", "Launch QA", "Launch UI"');
    expect(error.hint).not.toContain("Unrelated");
  });
  test(`${command} unknown scoped name identifies the project and lists scoped suggestions`, async () => {
    const { code, stdout, stderr } = await cli(command, "Launc", "scoped-missing", "Example project");
    expect(code).toBe(4);
    expect(stdout).toBe("");
    const error = JSON.parse(stderr).error;
    expect(error.message).toContain('in project "Example project"');
    expect(error.hint).toContain('closest: "Launch", "Launch QA", "Launch UI"');
    expect(error.hint).toContain("linearctl milestone --project 00000000-0000-4000-8000-000000000010 --json");
  });
  test(`${command} retains direct UUID filtering without a milestone lookup`, async () => {
    const { code, stdout, stderr } = await cli(command, "00000000-0000-4000-8000-000000000001", "uuid");
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toHaveLength(1);
  });
  test(`${command} help documents workspace-wide bare names and ambiguity`, async () => {
    const child = Bun.spawn([process.execPath, "src/index.ts", command, "--help"], { cwd: join(import.meta.dir, ".."), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const help = (await new Response(child.stdout).text()).replace(/\s+/g, " ");
    expect(await child.exited).toBe(0);
    expect(help).toContain("bare names match all accessible projects (may be ambiguous)");
    expect(help).toContain("--project narrows scope");
  });
}
