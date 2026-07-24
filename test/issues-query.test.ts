import { describe, expect, test } from "bun:test";
import { scopedTeams, projectClause, collectIssuesFlat } from "../src/core/issues-query.js";
import type { LinearClient } from "@linear/sdk";

describe("scopedTeams", () => {
  test("returns undefined when no keys provided", () => {
    expect(scopedTeams()).toBeUndefined();
    expect(scopedTeams([])).toBeUndefined();
  });

  test("returns undefined for 'all'", () => {
    expect(scopedTeams(["all"])).toBeUndefined();
    expect(scopedTeams(["CER", "all"])).toBeUndefined();
  });

  test("passes through real team keys", () => {
    expect(scopedTeams(["CER"])).toEqual(["CER"]);
    expect(scopedTeams(["CER", "OPS", "TOD"])).toEqual(["CER", "OPS", "TOD"]);
  });
});

describe("projectClause", () => {
  test("returns empty array when no project", () => {
    expect(projectClause()).toEqual([]);
    expect(projectClause(undefined)).toEqual([]);
  });

  test("UUID filters by project.id", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(projectClause(uuid)).toEqual([{ project: { id: { eq: uuid } } }]);
  });

  test("non-UUID filters by project.name (eqIgnoreCase)", () => {
    expect(projectClause("linearctl")).toEqual([
      { project: { name: { eqIgnoreCase: "linearctl" } } },
    ]);
  });

  test("does not misclassify a short hex string as a UUID", () => {
    expect(projectClause("abc123")).toEqual([
      { project: { name: { eqIgnoreCase: "abc123" } } },
    ]);
  });
});

describe("collectIssuesFlat", () => {
  test("paginates through multiple pages and dedupes by id", async () => {
    const calls: { after: string | null }[] = [];
    const pages = [
      {
        nodes: [
          { id: "i1", identifier: "CER-1", title: "alpha", url: "u1", priority: 3, estimate: null, updatedAt: "2026-07-24T10:00:00Z", state: { name: "Todo", type: "unstarted" }, assignee: null },
          { id: "i2", identifier: "CER-2", title: "beta", url: "u2", priority: 0, estimate: null, updatedAt: "2026-07-24T11:00:00Z", state: { name: "In Progress", type: "started" }, assignee: { displayName: "ctodie" } },
        ],
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      },
      {
        nodes: [
          { id: "i1", identifier: "CER-1", title: "alpha UPDATED", url: "u1", priority: 3, estimate: null, updatedAt: "2026-07-24T12:00:00Z", state: { name: "Todo", type: "unstarted" }, assignee: null },
          { id: "i3", identifier: "CER-3", title: "gamma", url: "u3", priority: 2, estimate: 5, updatedAt: "2026-07-24T12:30:00Z", state: { name: "Done", type: "completed" }, assignee: { displayName: "mgoudet" } },
        ],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    ];
    const client = {
      client: {
        rawRequest: async (_q: string, vars: { after: string | null }) => {
          calls.push({ after: vars.after });
          return { data: { issues: pages.shift()! } };
        },
      },
    } as unknown as LinearClient;
    const result = await collectIssuesFlat(client, {} as never);
    expect(calls).toHaveLength(2);
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.id).sort()).toEqual(["i1", "i2", "i3"]);
    const i1 = result.find((r) => r.id === "i1");
    expect(i1?.title).toBe("alpha UPDATED");
  });

  test("respects the limit parameter", async () => {
    const pages = [
      {
        nodes: Array.from({ length: 100 }, (_, i) => ({
          id: `i${i}`, identifier: `CER-${i}`, title: `t${i}`, url: `u${i}`,
          priority: 0, estimate: null, updatedAt: "2026-07-24T10:00:00Z",
          state: { name: "Todo", type: "unstarted" }, assignee: null,
        })),
        pageInfo: { hasNextPage: true, endCursor: "cursor-1" },
      },
    ];
    const client = {
      client: {
        rawRequest: async () => ({ data: { issues: pages.shift()! } }),
      },
    } as unknown as LinearClient;
    const result = await collectIssuesFlat(client, {} as never, undefined, 5);
    expect(result).toHaveLength(5);
  });

  test("empty result when query returns no issues", async () => {
    const client = {
      client: {
        rawRequest: async () => ({
          data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        }),
      },
    } as unknown as LinearClient;
    const result = await collectIssuesFlat(client, {} as never);
    expect(result).toEqual([]);
  });
});
