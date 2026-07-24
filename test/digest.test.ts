import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { digest } from "../src/core/grooming.js";

/**
 * Test the digest function: issues updated since a cutoff, grouped by
 * workflow-state type in a canonical order (completed → started → unstarted
 * → triage → backlog → canceled). Unknown types sort last.
 */

interface RawNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  estimate: number | null;
  updatedAt: string;
  state: { name: string; type: string } | null;
  assignee: { displayName: string } | null;
}

function stubClient(nodes: RawNode[]) {
  const client = {
    client: {
      rawRequest: async () => ({
        data: {
          issues: {
            nodes,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    },
  } as unknown as LinearClient;

  return { client };
}

const SINCE = new Date("2026-07-17T00:00:00Z");

describe("digest — issue grouping by state type", () => {
  test("groups issues by state type in canonical order", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "Done item", url: "u", priority: 3, estimate: null, updatedAt: "2026-07-18T00:00:00Z", state: { name: "Done", type: "completed" }, assignee: { displayName: "alice" } },
      { id: "2", identifier: "CER-2", title: "Active item", url: "u", priority: 2, estimate: 2, updatedAt: "2026-07-19T00:00:00Z", state: { name: "In Progress", type: "started" }, assignee: { displayName: "bob" } },
      { id: "3", identifier: "CER-3", title: "Todo item", url: "u", priority: 1, estimate: 1, updatedAt: "2026-07-20T00:00:00Z", state: { name: "Todo", type: "unstarted" }, assignee: null },
    ]);

    const result = await digest(client, SINCE);

    expect(result.total).toBe(3);
    expect(result.groups.map((g) => g.type)).toEqual([
      "completed",
      "started",
      "unstarted",
    ]);
  });

  test("completed comes before started, started before backlog", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "B-1", title: "Backlog", url: "u", priority: 0, estimate: null, updatedAt: "2026-07-18T00:00:00Z", state: { name: "Backlog", type: "backlog" }, assignee: null },
      { id: "2", identifier: "S-1", title: "Started", url: "u", priority: 0, estimate: null, updatedAt: "2026-07-18T00:00:00Z", state: { name: "In Progress", type: "started" }, assignee: null },
      { id: "3", identifier: "C-1", title: "Completed", url: "u", priority: 0, estimate: null, updatedAt: "2026-07-18T00:00:00Z", state: { name: "Done", type: "completed" }, assignee: null },
    ]);

    const result = await digest(client, SINCE);

    expect(result.groups.map((g) => g.type)).toEqual([
      "completed",
      "started",
      "backlog",
    ]);
  });

  test("unknown state type sorts after all known types", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "U-1", title: "Unknown", url: "u", priority: 0, estimate: null, updatedAt: "2026-07-18T00:00:00Z", state: { name: "Weird", type: "custom-type" }, assignee: null },
      { id: "2", identifier: "C-1", title: "Completed", url: "u", priority: 0, estimate: null, updatedAt: "2026-07-18T00:00:00Z", state: { name: "Done", type: "completed" }, assignee: null },
    ]);

    const result = await digest(client, SINCE);

    expect(result.groups.map((g) => g.type)).toEqual(["completed", "custom-type"]);
  });

  test("count per group matches items in group", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "C-1", title: "Done 1", url: "u", priority: 0, estimate: null, updatedAt: "2026-07-18T00:00:00Z", state: { name: "Done", type: "completed" }, assignee: null },
      { id: "2", identifier: "C-2", title: "Done 2", url: "u", priority: 0, estimate: null, updatedAt: "2026-07-18T00:00:00Z", state: { name: "Done", type: "completed" }, assignee: null },
      { id: "3", identifier: "S-1", title: "Active", url: "u", priority: 0, estimate: null, updatedAt: "2026-07-18T00:00:00Z", state: { name: "In Progress", type: "started" }, assignee: null },
    ]);

    const result = await digest(client, SINCE);

    const completed = result.groups.find((g) => g.type === "completed")!;
    expect(completed.count).toBe(2);
    expect(completed.items).toHaveLength(2);
  });

  test("since timestamp in result matches input", async () => {
    const { client } = stubClient([]);

    const result = await digest(client, SINCE);

    expect(result.since).toBe(SINCE.toISOString());
  });

  test("empty issues → total 0, no groups", async () => {
    const { client } = stubClient([]);

    const result = await digest(client, SINCE);

    expect(result.total).toBe(0);
    expect(result.groups).toHaveLength(0);
  });

  test("null assignee → null in item (not a fallback string)", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "Unassigned", url: "u", priority: 0, estimate: null, updatedAt: "2026-07-18T00:00:00Z", state: { name: "Done", type: "completed" }, assignee: null },
    ]);

    const result = await digest(client, SINCE);

    expect(result.groups[0].items[0].assignee).toBeNull();
  });

  test("null state → empty state name, type 'unknown'", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "No state", url: "u", priority: 0, estimate: null, updatedAt: "2026-07-18T00:00:00Z", state: null, assignee: null },
    ]);

    const result = await digest(client, SINCE);

    // type "unknown" sorts last (after all known STATE_ORDER entries)
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].type).toBe("unknown");
    expect(result.groups[0].items[0].state).toBe("");
  });

  test("item fields: identifier, title, state, assignee, url", async () => {
    const { client } = stubClient([
      {
        id: "1",
        identifier: "CER-100",
        title: "Fix the thing",
        url: "https://linear.app/x/CER-100",
        priority: 2,
        estimate: 3,
        updatedAt: "2026-07-18T00:00:00Z",
        state: { name: "In Progress", type: "started" },
        assignee: { displayName: "ctodie" },
      },
    ]);

    const result = await digest(client, SINCE);

    const item = result.groups[0].items[0];
    expect(item.identifier).toBe("CER-100");
    expect(item.title).toBe("Fix the thing");
    expect(item.state).toBe("In Progress");
    expect(item.assignee).toBe("ctodie");
    expect(item.url).toBe("https://linear.app/x/CER-100");
  });
});
