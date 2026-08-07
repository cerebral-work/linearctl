import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { groupMine, mine } from "../src/core/mine.js";
import { renderMine } from "../src/commands/mine.js";
import type { FlatIssueNode } from "../src/core/issues-query.js";

function node(
  id: string,
  identifier: string,
  stateType: string,
  priority: number,
  title = "t",
): FlatIssueNode {
  return {
    id,
    identifier,
    title,
    url: "u",
    priority,
    estimate: null,
    updatedAt: "2026-08-04T00:00:00Z",
    state: { name: stateType, type: stateType },
    assignee: { displayName: "me" },
  };
}

function stubClient(nodes: FlatIssueNode[], capture?: { filter?: unknown }) {
  return {
    client: {
      rawRequest: async (_q: string, vars: { filter: unknown }) => {
        if (capture) capture.filter = vars.filter;
        return {
          data: {
            issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } },
          },
        };
      },
    },
  } as unknown as LinearClient;
}

describe("mine — grouping and ordering", () => {
  test("groups active-first: started, triage, unstarted, backlog", () => {
    const result = groupMine([
      node("1", "A-1", "backlog", 3),
      node("2", "A-2", "started", 2),
      node("3", "A-3", "unstarted", 1),
      node("4", "A-4", "triage", 0),
    ]);
    expect(result.total).toBe(4);
    expect(result.groups.map((g) => g.type)).toEqual([
      "started",
      "triage",
      "unstarted",
      "backlog",
    ]);
  });

  test("orders within a group by priority, none (0) last", () => {
    const result = groupMine([
      node("1", "A-1", "started", 0),
      node("2", "A-2", "started", 3),
      node("3", "A-3", "started", 1),
    ]);
    expect(result.groups[0].items.map((i) => i.identifier)).toEqual([
      "A-3",
      "A-2",
      "A-1",
    ]);
  });

  test("filters isMe server-side and excludes done states by default", async () => {
    const capture: { filter?: unknown } = {};
    await mine(stubClient([], capture));
    expect(capture.filter).toEqual({
      assignee: { isMe: { eq: true } },
      state: { type: { nin: ["completed", "canceled", "duplicate"] } },
    });
  });

  test("--all drops the state exclusion; team keys narrow", async () => {
    const capture: { filter?: unknown } = {};
    await mine(stubClient([], capture), ["OPS"], true);
    expect(capture.filter).toEqual({
      assignee: { isMe: { eq: true } },
      team: { key: { in: ["OPS"] } },
    });
  });
});

describe("mine — render", () => {
  test("renders headings and priority tags", () => {
    const text = renderMine(
      groupMine([node("1", "A-1", "started", 1, "Fix the thing")]),
    );
    expect(text).toContain("1 issue(s) assigned to you");
    expect(text).toContain("In progress (1)");
    expect(text).toContain("A-1  Fix the thing [urgent]");
  });

  test("empty state", () => {
    expect(renderMine(groupMine([]))).toBe("No issues assigned to you.\n");
  });
});
