import { expect, test } from "bun:test";
import { join } from "node:path";

for (const command of ["pull", "search"]) {
  test(`${command} forwards milestone name and --state all through CLI to API`, async () => {
    const child = Bun.spawn([process.execPath, "--preload", "./test/fixtures/milestone-api.ts", "src/index.ts", command, "--milestone", "Launch", "--state", "all", "--json"], {
      cwd: join(import.meta.dir, ".."), env: { ...process.env, LINEAR_API_KEY: "fixture-key" }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(JSON.parse(stdout)[0]).toMatchObject({ identifier: "ENG-123", stateType: "completed" });
  });
}
