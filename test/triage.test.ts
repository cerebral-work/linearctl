import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { triage } from "../src/core/grooming.js";

/**
 * Test the triage function: surfaces issues needing triage — in the Triage
 * state, or unassigned, or unestimated, or no priority. Each issue gets a
 * `reasons` array listing which triage signals it hit.
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

describe("triage — reason tagging", () => {
  test("triage-state reason when issue is in triage state type", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "Triage me", url: "u", priority: 3, estimate: 2, updatedAt: "2026-07-24T00:00:00Z", state: { name: "Triage", type: "triage" }, assignee: { displayName: "alice" } },
    ]);

    const result = await triage(client);

    expect(result[0].reasons).toContain("triage-state");
  });

  test("unassigned reason when assignee is null", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "No owner", url: "u", priority: 3, estimate: 2, updatedAt: "2026-07-24T00:00:00Z", state: { name: "Todo", type: "unstarted" }, assignee: null },
    ]);

    const result = await triage(client);

    expect(result[0].reasons).toContain("unassigned");
  });

  test("unestimated reason when estimate is null", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "No estimate", url: "u", priority: 3, estimate: null, updatedAt: "2026-07-24T00:00:00Z", state: { name: "Todo", type: "unstarted" }, assignee: { displayName: "bob" } },
    ]);

    const result = await triage(client);

    expect(result[0].reasons).toContain("unestimated");
  });

  test("no-priority reason when priority is 0", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "No priority", url: "u", priority: 0, estimate: 2, updatedAt: "2026-07-24T00:00:00Z", state: { name: "Todo", type: "unstarted" }, assignee: { displayName: "bob" } },
    ]);

    const result = await triage(client);

    expect(result[0].reasons).toContain("no-priority");
  });

  test("issue hitting all four reasons gets all four", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "Everything wrong", url: "u", priority: 0, estimate: null, updatedAt: "2026-07-24T00:00:00Z", state: { name: "Triage", type: "triage" }, assignee: null },
    ]);

    const result = await triage(client);

    expect(result[0].reasons).toEqual([
      "triage-state",
      "unassigned",
      "unestimated",
      "no-priority",
    ]);
  });

  test("issue with all fields set gets no reasons (but still listed if in triage query)", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "Healthy", url: "u", priority: 3, estimate: 2, updatedAt: "2026-07-24T00:00:00Z", state: { name: "In Progress", type: "started" }, assignee: { displayName: "alice" } },
    ]);

    const result = await triage(client);

    expect(result[0].reasons).toEqual([]);
  });

  test("null state → empty state name and stateType", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "No state", url: "u", priority: 0, estimate: null, updatedAt: "2026-07-24T00:00:00Z", state: null, assignee: null },
    ]);

    const result = await triage(client);

    expect(result[0].state).toBe("");
    expect(result[0].stateType).toBe("");
  });

  test("item fields: identifier, title, state, stateType, assignee, priority, estimate, reasons, url", async () => {
    const { client } = stubClient([
      {
        id: "1",
        identifier: "CER-100",
        title: "Fix issue",
        url: "https://linear.app/x/CER-100",
        priority: 2,
        estimate: 3,
        updatedAt: "2026-07-24T00:00:00Z",
        state: { name: "Todo", type: "unstarted" },
        assignee: null,
      },
    ]);

    const result = await triage(client);

    const item = result[0];
    expect(item.identifier).toBe("CER-100");
    expect(item.title).toBe("Fix issue");
    expect(item.state).toBe("Todo");
    expect(item.stateType).toBe("unstarted");
    expect(item.assignee).toBeNull();
    expect(item.priority).toBe(2);
    expect(item.estimate).toBe(3);
    expect(item.reasons).toEqual(["unassigned"]);
    expect(item.url).toBe("https://linear.app/x/CER-100");
  });
});
