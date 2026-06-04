import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Smoke the MCP server end to end: spawn `mcp serve`, complete the
 * initialize + tools/list handshake, and assert the tool surface. Catches a
 * broken server (module-load fault, bad tool registration) at PR time.
 *
 * Runs offline: tool registration is static (no Linear call until a tool is
 * invoked), so a dummy LINEAR_API_KEY is enough to boot the server in CI.
 */
describe("mcp serve handshake", () => {
  test("initializes and lists the full tool surface", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["run", "src/index.ts", "mcp", "serve"],
      env: {
        ...process.env,
        LINEAR_API_KEY: process.env.LINEAR_API_KEY ?? "dummy-key-for-handshake",
      } as Record<string, string>,
    });
    const client = new Client({ name: "handshake-test", version: "0" });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      const readOnly = tools
        .filter((t) => t.annotations?.readOnlyHint)
        .map((t) => t.name);

      // every documented tool is registered
      for (const t of [
        "whoami", "project_list", "digest", "triage", "milestone", "stale",
        "file_issue", "project_create", "issue_update", "issue_close",
      ]) {
        expect(names).toContain(t);
      }
      expect(tools.length).toBeGreaterThanOrEqual(10);

      // read tools carry readOnlyHint; writes do not
      expect(readOnly).toContain("triage");
      expect(readOnly).toContain("digest");
      expect(readOnly).not.toContain("file_issue");
      expect(readOnly).not.toContain("issue_update");
    } finally {
      await client.close();
    }
  }, 30_000);
});
