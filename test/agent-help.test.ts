import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { LinearClient } from "@linear/sdk";
import { CliError, cliError, errorEnvelope, assertBatchSucceeded } from "../src/lib/errors.js";
import { pickLabelIds } from "../src/lib/labels.js";
import { resolveTeamByKey } from "../src/core/teams.js";
import { EXAMPLES } from "../src/lib/examples.js";

const root = join(import.meta.dir, "..");
async function cli(args: string[], stdin = "", scenario?: string) {
  const child = Bun.spawn([process.execPath, ...(scenario ? ["--preload", "./test/fixtures/agent-api.ts"] : []), "src/index.ts", ...args], {
    cwd: root,
    env: { ...process.env, LINEAR_API_KEY: scenario || stdin ? "test-key" : "", LINEARCTL_TEST_SCENARIO: scenario ?? "", NO_COLOR: "1" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  child.stdin.write(stdin);
  await child.stdin.flush();
  child.stdin.end();
  const [code, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, out, err };
}
function envelope(result: { code: number; err: string }, code: number, kind: string) {
  expect(result.code).toBe(code);
  expect(result.err.trim().split("\n")).toHaveLength(1);
  const value = JSON.parse(result.err).error;
  expect(value).toMatchObject({ code, kind });
  expect(typeof value.message).toBe("string");
  expect(typeof value.hint).toBe("string");
  return value;
}

describe("agent CLI contract", () => {
  test("0: examples and help work without authentication", async () => {
    const result = await cli(["examples", "comment"]);
    expect(result.code).toBe(0);
    expect(result.err).toBe("");
    expect(result.out).toContain(EXAMPLES.comment);
    const help = await cli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.out).toContain("0 ok · 2 usage · 3 auth · 4 not found · 5 rate limited · 6 refused · 1 other");
  });
  test("2: positional comment body explains stdin and correct command", async () => {
    const result = await cli(["comment", "ENG-123", "text", "--json"]);
    const e = envelope(result, 2, "usage");
    expect(e.message).toContain("--body");
    expect(e.hint).toContain("--body -");
    expect(e.hint).toContain("linearctl examples comment");
    expect(result.out).toBe("");
  });
  test("unknown command retains Commander spelling suggestion", async () => {
    const r = await cli(["commnt"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("Did you mean comment?");
  });
  test("unknown commands still fail with --help, without leaking top-level help", async () => {
    for (const name of ["nosuchcmd", "bogus"]) {
      const result = await cli([name, "--help"]);
      expect(result.code).toBe(2);
      expect(result.out).toBe("");
      expect(result.err).toContain(`unknown command '${name}'`);
      expect(result.err).toContain("linearctl examples;");
      expect(result.err).not.toContain("examples comment");
    }
    const typo = await cli(["commnt", "--help"]);
    expect(typo.code).toBe(2);
    expect(typo.err).toContain("Did you mean comment?");
    expect(typo.err).toContain("linearctl examples comment");
    const nested = await cli(["project", "bogus", "--help", "--json"]);
    envelope(nested, 2, "usage");
    expect(nested.out).toBe("");
    // Known commands and help commands remain successful.
    for (const args of [["comment", "--help"], ["project", "list", "--help"], ["milestone", "--project", "Example", "--help"], ["help", "comment"]]) {
      expect((await cli(args)).code).toBe(0);
    }
  });
  test("plain positional comment explicitly explains --body -", async () => {
    const result = await cli(["comment", "X-1", "hello"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("Comment text is not positional");
    expect(result.err).toContain("--body -");
    expect(result.err).toContain("linearctl examples comment");
  });
  test("root --json placement gets actionable guidance", async () => {
    const e = envelope(await cli(["--json", "nosuchcmd"]), 2, "usage");
    expect(e.hint).toContain("Place --json after the subcommand");
    expect(e.hint).toContain("linearctl whoami --json");
  });
  test("unknown-command hint follows the plausible match, or lists all examples", async () => {
    const typo = await cli(["ratelimitt"]);
    expect(typo.err).toContain("linearctl examples ratelimit");
    const unknown = envelope(await cli(["nosuchcmd", "--json"]), 2, "usage");
    expect(unknown.hint).toContain("linearctl examples;");
    expect(unknown.hint).not.toContain("examples comment");
  });
  test("usage takes precedence over missing credentials", async () => {
    const e = envelope(await cli(["file", "--json"]), 2, "usage");
    expect(e.hint).toContain("--desc -");
    expect(e.hint).toContain("examples file");
  });
  test("subcommand usage points to the failing subcommand", async () => {
    const e = envelope(await cli(["project", "create", "Example", "--json"]), 2, "usage");
    expect(e.hint).toContain("linearctl project create");
    expect(e.hint).toContain("--team ENG");
  });
  test("project list no longer requires a team (reaches auth)", async () => {
    envelope(await cli(["project", "list", "--json"]), 3, "auth");
  });
  test("empty and malformed update plans show the pipe and apply hint", async () => {
    // A whitespace-only pipe is empty after trimming but still uses dummy credentials.
    const e = envelope(await cli(["update", "--stdin", "--json"], " \n"), 2, "usage");
    expect(e.hint).toContain("cat plan.json | linearctl update --stdin");
    expect(e.hint).toContain("--apply");
    envelope(await cli(["update", "--stdin", "--json"], "{oops"), 2, "usage");
  });
  test("3: missing and invalid credentials", async () => {
    envelope(await cli(["whoami", "--json"]), 3, "auth");
    envelope(await cli(["whoami", "--json"], "", "auth"), 3, "auth");
    envelope(await cli(["ratelimit", "--json"], "", "auth"), 3, "auth");
  });
  test("4: absent handoff with a known-good lookup control", async () => {
    const store = mkdtempSync(join(tmpdir(), "linearctl-agent-test-"));
    try {
      const created = await cli(["handoff", "create", "--title", "Example", "--body", "Test body", "--store", store, "--json"]);
      expect(created.code).toBe(0);
      const id = JSON.parse(created.out).id;
      expect((await cli(["handoff", "show", id, "--store", store, "--json"])).code).toBe(0);
      envelope(await cli(["handoff", "show", "absent", "--store", store, "--json"]), 4, "not_found");
    } finally { rmSync(store, { recursive: true }); }
  });
  test("2: GraphQL user-input details reach both human and JSON CLI output", async () => {
    const message = 'Duplicate label name - Label "annex-iii-2027" already exists in team Business Development';
    const json = await cli(["whoami", "--json"], "", "userinput");
    expect(envelope(json, 2, "usage").message).toBe(message + " (userError=true)");
    expect(json.out).toBe("");
    const human = await cli(["whoami"], "", "userinput");
    expect(human.code).toBe(2);
    expect(human.err).toContain(message);
    expect(human.err).toContain("userError=true");
    expect(human.err).not.toContain("Authorization");
  });
  test("5: exhausted quota is machine-readable on stderr", async () => {
    envelope(await cli(["ratelimit", "--json"], "", "rate_limit"), 5, "rate_limit");
  });
  test("6: dry-run previews do not masquerade as a write", async () => {
    const result = await cli(["file", "--stdin", "--json"], '[{"title":"Example","team":"ENG"}]');
    expect(result.err).toContain('"code":6');
    const e = envelope(result, 6, "refused");
    expect(JSON.parse(result.out).apply).toBe(false);
    expect(e.hint).toContain("--apply");
  });
  test("update preview never sends a mutation without --apply", async () => {
    const result = await cli(["update", "--stdin", "--json"], '[{"id":"ENG-123","priority":3}]', "bulk");
    envelope(result, 6, "refused");
    expect(JSON.parse(result.out).rows[0].input).toEqual({ priority: 3 });
  });
  test("file label and team failures keep lookup hints through the CLI", async () => {
    const label = envelope(await cli(["file", "Example", "--team", "ENG", "--label", "skills", "--json"], "", "label"), 4, "not_found");
    expect(label.hint).toContain('"skill", "skies", "skills-ui"');
    expect(label.hint).toContain("linearctl label list --team");
    const team = envelope(await cli(["project", "list", "--team", "ENX", "--json"], "", "team"), 4, "not_found");
    expect(team.message).toContain("ENG, OPS");
  });
  test("duplicate guard exits 6 before any create mutation", async () => {
    const e = envelope(await cli(["file", "Fix timeout", "--team", "ENG", "--check-dups", "--json"], "", "dup"), 6, "refused");
    expect(e.message).toContain("likely duplicate");
  });
  test("1: transport errors remain other, with no stack or request dump", async () => {
    const e = envelope(await cli(["ratelimit", "--json"], "", "other"), 1, "other");
    expect(e.message).toBe("fixture transport failure");
  });
  test("labels report three closest names and a discovery command", () => {
    const labels = ["feature", "skill", "skills-ui", "skies", "unrelated"].map(name => ({ id: name, name }));
    expect(pickLabelIds(labels, ["skill"])).toEqual(["skill"]);
    try { pickLabelIds(labels, ["skills"], "ENG"); throw new Error("must fail"); }
    catch (error) {
      const e = errorEnvelope(error).error;
      expect(e.code).toBe(4);
      expect(e.hint).toContain("linearctl label list --team ENG");
      expect(e.hint).toContain('"skill", "skies", "skills-ui"');
      expect(e.hint).not.toContain("unrelated");
    }
  });
  test("unknown team lists keys across pages", async () => {
    const page = { nodes: [{ key: "ENG" }], pageInfo: { hasNextPage: true }, async fetchNext() { this.nodes.push({ key: "OPS" }); this.pageInfo.hasNextPage = false; } };
    const client = { teams: async (opts: { filter?: unknown }) => opts.filter ? { nodes: [] } : page } as unknown as LinearClient;
    try { await resolveTeamByKey(client, "ENX"); throw new Error("must fail"); }
    catch (error) { expect(errorEnvelope(error).error).toMatchObject({ code: 4, kind: "not_found" }); expect((error as Error).message).toContain("ENG, OPS"); }
  });
  test("SDK codes and batch failures preserve stable kinds", () => {
    expect(cliError({ status: 404 }).code).toBe(4);
    expect(cliError({ errors: [{ extensions: { code: "RATELIMITED" } }] }).code).toBe(5);
    expect(() => assertBatchSucceeded([{ error: "failed", kind: "auth" }])).toThrow(CliError);
    try { assertBatchSucceeded([{ kind: "rate_limit" }]); } catch (e) { expect(cliError(e).code).toBe(5); }
    try { assertBatchSucceeded([], ["ENG-999"]); } catch (e) { expect(cliError(e).code).toBe(4); }
  });
  test("examples match their source scripts and cover every root command", async () => {
    for (const [name, script] of Object.entries(EXAMPLES)) {
      expect(script).toBe(readFileSync(join(root, "examples", `${name}.sh`), "utf8"));
      const syntax = Bun.spawn(["bash", "-n"], { stdin: new Blob([script]), stdout: "pipe", stderr: "pipe" });
      expect(await syntax.exited).toBe(0);
    }
    const index = readFileSync(join(root, "src/index.ts"), "utf8");
    const commands = [...index.matchAll(/(?:program|const \w+ = program)\s*\.command\("([^"]+)"\)/g)].map(m => m[1]);
    for (const command of commands) expect(EXAMPLES[command]).toBeDefined();
    const all = await cli(["examples"]);
    expect(all.code).toBe(0);
    for (const command of commands) expect(all.out).toContain(`# --- ${command} ---`);
  });
});
