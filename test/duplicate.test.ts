import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { markDuplicate } from "../src/core/duplicate.js";
import { cliError } from "../src/lib/errors.js";

function stub(opts: { existing?: string[]; noState?: boolean; missing?: string; relationFail?: boolean; noRelationReadback?: boolean; closeFail?: boolean; noStateReadback?: boolean; paginated?: boolean } = {}) {
  const calls: Array<{ query: string; vars: any }> = [];
  let relations = opts.existing ?? [];
  let state = { id: "todo", name: "Todo", type: "unstarted" };
  const rawRequest = async (query: string, vars: any) => {
    calls.push({ query, vars });
    if (query.includes("query DuplicateIssue")) {
      const canonical = ["CAN-1", "canonical"].includes(vars.id);
      return { data: { issue: vars.id === opts.missing ? null : {
        id: canonical ? "canonical" : "source", identifier: canonical ? "CAN-1" : "SRC-1",
        title: "Title", url: "https://example.com/issue", team: { id: "source-team" }, state, assignee: null,
      } } };
    }
    if (query.includes("query DuplicateState")) return { data: { workflowStates: { nodes: opts.noState ? [] : [{ id: "dupe-state", name: "Redundant" }] } } };
    if (query.includes("query DuplicateRelations")) {
      const first = opts.paginated && !vars.after;
      return { data: { issue: { relations: { nodes: first ? [{ type: "related", relatedIssue: { id: "unrelated" } }] : relations.map(id => ({ type: "duplicate", relatedIssue: { id } })), pageInfo: { hasNextPage: !!first, endCursor: first ? "next" : null } } } } };
    }
    if (query.includes("mutation DuplicateRelationCreate")) {
      if (!opts.relationFail && !opts.noRelationReadback) relations = [vars.input.relatedIssueId];
      return { data: { issueRelationCreate: { success: !opts.relationFail } } };
    }
    if (query.includes("mutation DuplicateClose")) {
      if (!opts.closeFail && !opts.noStateReadback) state = { id: vars.input.stateId, name: "Redundant", type: "duplicate" };
      return { data: { issueUpdate: { success: !opts.closeFail } } };
    }
    throw new Error(`unexpected query: ${query}`);
  };
  return { client: { client: { rawRequest } } as unknown as LinearClient, calls };
}
const writes = (s: ReturnType<typeof stub>) => s.calls.filter(c => c.query.startsWith("mutation"));

describe("duplicate relations", () => {
  test("update creates source -> canonical duplicate relation and re-reads", async () => {
    const s = stub();
    const result = await markDuplicate(s.client, "SRC-1", "CAN-1");
    expect(writes(s).map(c => c.vars)).toEqual([{ input: { issueId: "source", relatedIssueId: "canonical", type: "duplicate" } }]);
    expect(result).toMatchObject({ identifier: "SRC-1", state: "Todo", duplicateOf: { id: "canonical", identifier: "CAN-1" } });
    expect(s.calls.at(-1)?.query).toContain("query DuplicateIssue");
    expect(s.calls.filter(c => c.query.includes("query DuplicateRelations"))).toHaveLength(2);
  });
  test("close selects the source team's duplicate TYPE, wires first, state-only update, then confirms", async () => {
    const s = stub();
    const r = await markDuplicate(s.client, "SRC-1", "CAN-1", true);
    const stateQuery = s.calls.find(c => c.query.includes("query DuplicateState"))!;
    expect(stateQuery.vars).toEqual({ team: "source-team" });
    expect(stateQuery.query).toContain('type: { eq: "duplicate" }');
    expect(writes(s).map(c => c.vars)).toEqual([
      { input: { issueId: "source", relatedIssueId: "canonical", type: "duplicate" } },
      { id: "source", input: { stateId: "dupe-state" } },
    ]);
    const create = s.calls.findIndex(c => c.query.includes("mutation DuplicateRelationCreate"));
    expect(s.calls[create + 1].query).toContain("query DuplicateRelations");
    expect(r.state).toBe("Redundant");
  });
  test("existing matching relation on a later page is reused", async () => {
    const s = stub({ existing: ["canonical"], paginated: true });
    await markDuplicate(s.client, "SRC-1", "CAN-1");
    expect(writes(s)).toHaveLength(0);
    expect(s.calls.some(c => c.vars.after === "next")).toBe(true);
  });
  test("self reference (even different aliases), missing canonical, missing state and conflicting target write nothing", async () => {
    for (const [options, target, close, kind] of [
      [{}, "source", false, "usage"], [{ missing: "CAN-1" }, "CAN-1", false, "not_found"],
      [{ noState: true }, "CAN-1", true, "not_found"], [{ existing: ["other"] }, "CAN-1", false, "refused"],
    ] as const) {
      const s = stub(options as Parameters<typeof stub>[0]);
      try { await markDuplicate(s.client, "SRC-1", target, close); throw new Error("expected rejection"); }
      catch (e) { expect(cliError(e).kind).toBe(kind); }
      expect(writes(s)).toHaveLength(0);
    }
  });
  test("failed creation or absent readback never closes", async () => {
    for (const options of [{ relationFail: true }, { noRelationReadback: true }]) {
      const s = stub(options);
      await expect(markDuplicate(s.client, "SRC-1", "CAN-1", true)).rejects.toThrow(/relation/);
      expect(writes(s)).toHaveLength(1);
    }
  });
  test("failed close and stale readback surface partial-write failures", async () => {
    for (const options of [{ closeFail: true }, { noStateReadback: true }]) {
      const s = stub(options);
      await expect(markDuplicate(s.client, "SRC-1", "CAN-1", true)).rejects.toThrow(/duplicate relation exists/);
    }
  });
  test("Linear's missing duplicate error has the actionable flag hint", () => {
    const e = cliError(new Error("Missing duplicate relation - Issues can only be moved to a duplicate state when a duplicate issue relation exists"));
    expect(e.kind).toBe("usage");
    expect(e.code).toBe(2);
    expect(e.hint).toContain("linearctl close <id> --duplicate-of <canonical>");
    expect(e.hint).toContain("linearctl update <id> --duplicate-of <canonical>");
  });
});

describe("duplicate CLI wiring", () => {
  async function cli(args: string[]) {
    const proc = Bun.spawn([process.execPath, "--preload", "./test/fixtures/duplicate-api.ts", "src/index.ts", ...args], {
      cwd: import.meta.dir + "/..", env: { ...process.env, LINEAR_API_KEY: "test-only-key" },
      stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, out, err };
  }
  test("update wires only the relation; close wires then moves to duplicate", async () => {
    for (const command of ["update", "close"]) {
      const r = await cli([command, "SRC-1", "--duplicate-of", "CAN-1", "--json"]);
      expect(r.code).toBe(0);
      expect(r.err).toBe("");
      expect(JSON.parse(r.out)).toMatchObject({ identifier: "SRC-1", state: command === "close" ? "Duplicate" : "Todo", duplicateOf: { id: "canonical", identifier: "CAN-1" } });
    }
  });
  test("bulk rejects the single-issue flag instead of silently ignoring it", async () => {
    const r = await cli(["update", "--stdin", "--duplicate-of", "CAN-1", "--json"]);
    expect(r.code).toBe(2);
    expect(r.out).toBe("");
    expect(JSON.parse(r.err).error.kind).toBe("usage");
  });
});
