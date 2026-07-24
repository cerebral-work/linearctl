import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { pullIssues } from "../src/core/pull.js";
import type { PullIssue } from "../src/core/pull.js";

/**
 * Test the PullIssue mapping guarantees from the funnel contract
 * (docs/funnel-contract.md §1): field names are stable, labels are always
 * sorted arrays (never null), description is always a string (never null),
 * priority defaults to 0, state/stateType fall back to empty string.
 *
 * These are the contract guarantees the soma-operator's Rust reconcile loop
 * depends on — a break here breaks the funnel.
 */

interface RawNode {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number | null;
  description: string | null;
  updatedAt: string;
  state: { name: string; type: string } | null;
  labels: { nodes: { name: string }[] } | null;
}

function stubClient(nodes: RawNode[], hasNextPage = false) {
  const client = {
    client: {
      rawRequest: async () => ({
        data: {
          issues: {
            nodes,
            pageInfo: { hasNextPage, endCursor: hasNextPage ? "cursor-1" : null },
          },
        },
      }),
    },
  } as unknown as LinearClient;

  return { client };
}

describe("pullIssues — funnel contract mapping", () => {
  test("id field is the Linear issue UUID", async () => {
    const { client } = stubClient([
      {
        id: "7b638a93-cc26-48e0-b6cf-98e890165809",
        identifier: "CER-100",
        title: "Test",
        url: "https://linear.app/x",
        priority: 3,
        description: "body",
        updatedAt: "2026-07-24T10:00:00Z",
        state: { name: "Todo", type: "unstarted" },
        labels: { nodes: [{ name: "bug" }] },
      },
    ]);

    const result = await pullIssues(client, { teamKeys: ["CER"] });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("7b638a93-cc26-48e0-b6cf-98e890165809");
  });

  test("labels are sorted alphabetically and always an array (never null)", async () => {
    const { client } = stubClient([
      {
        id: "1",
        identifier: "CER-1",
        title: "A",
        url: "u",
        priority: 2,
        description: "x",
        updatedAt: "2026-07-24T10:00:00Z",
        state: { name: "In Progress", type: "started" },
        labels: { nodes: [{ name: "zebra" }, { name: "apple" }, { name: "mango" }] },
      },
    ]);

    const result = await pullIssues(client, { teamKeys: ["CER"] });

    expect(result[0].labels).toEqual(["apple", "mango", "zebra"]);
  });

  test("empty labels → empty array (not null)", async () => {
    const { client } = stubClient([
      {
        id: "1",
        identifier: "CER-1",
        title: "A",
        url: "u",
        priority: 0,
        description: "x",
        updatedAt: "2026-07-24T10:00:00Z",
        state: { name: "Todo", type: "unstarted" },
        labels: { nodes: [] },
      },
    ]);

    const result = await pullIssues(client, { teamKeys: ["CER"] });

    expect(result[0].labels).toEqual([]);
  });

  test("null labels → empty array (defensive)", async () => {
    const { client } = stubClient([
      {
        id: "1",
        identifier: "CER-1",
        title: "A",
        url: "u",
        priority: 0,
        description: "some body",
        updatedAt: "2026-07-24T10:00:00Z",
        state: { name: "Todo", type: "unstarted" },
        labels: null,
      },
    ]);

    const result = await pullIssues(client, { teamKeys: ["CER"] });

    expect(result[0].labels).toEqual([]);
  });

  test("null description → empty string (never null)", async () => {
    const { client } = stubClient([
      {
        id: "1",
        identifier: "CER-1",
        title: "A",
        url: "u",
        priority: 0,
        description: null,
        updatedAt: "2026-07-24T10:00:00Z",
        state: { name: "Todo", type: "unstarted" },
        labels: { nodes: [] },
      },
    ]);

    const result = await pullIssues(client, { teamKeys: ["CER"] });

    expect(result[0].description).toBe("");
  });

  test("null priority → 0", async () => {
    const { client } = stubClient([
      {
        id: "1",
        identifier: "CER-1",
        title: "A",
        url: "u",
        priority: null,
        description: "x",
        updatedAt: "2026-07-24T10:00:00Z",
        state: { name: "Todo", type: "unstarted" },
        labels: { nodes: [] },
      },
    ]);

    const result = await pullIssues(client, { teamKeys: ["CER"] });

    expect(result[0].priority).toBe(0);
  });

  test("null state → empty state and stateType strings", async () => {
    const { client } = stubClient([
      {
        id: "1",
        identifier: "CER-1",
        title: "A",
        url: "u",
        priority: 3,
        description: "x",
        updatedAt: "2026-07-24T10:00:00Z",
        state: null,
        labels: { nodes: [] },
      },
    ]);

    const result = await pullIssues(client, { teamKeys: ["CER"] });

    expect(result[0].state).toBe("");
    expect(result[0].stateType).toBe("");
  });

  test("dedupes by id across pages (updatedAt cursor instability)", async () => {
    const node: RawNode = {
      id: "dup-1",
      identifier: "CER-42",
      title: "Updated issue",
      url: "u",
      priority: 2,
      description: "v2 body",
      updatedAt: "2026-07-24T12:00:00Z",
      state: { name: "In Progress", type: "started" },
      labels: { nodes: [{ name: "bug" }] },
    };

    const client = {
      client: {
        rawRequest: async (_query: string, vars: { after: string | null }) => ({
          data: {
            issues: {
              nodes: vars.after === null ? [node] : [node],
              pageInfo: {
                hasNextPage: vars.after === null,
                endCursor: vars.after === null ? "cursor-1" : null,
              },
            },
          },
        }),
      },
    } as unknown as LinearClient;

    const result = await pullIssues(client, { teamKeys: ["CER"] });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("dup-1");
  });

  test("full PullIssue shape matches contract (10 fields)", async () => {
    const { client } = stubClient([
      {
        id: "7b638a93-cc26-48e0-b6cf-98e890165809",
        identifier: "EST-83",
        title: "soma smoke-test payload",
        url: "https://linear.app/cerebral-work/issue/EST-83/soma-smoke-test-payload",
        priority: 3,
        description: "Full markdown body of the issue…",
        updatedAt: "2026-07-24T16:52:01.638Z",
        state: { name: "Todo", type: "unstarted" },
        labels: { nodes: [{ name: "soma-ingest" }] },
      },
    ]);

    const result = await pullIssues(client, { teamKeys: ["EST"] });

    const expected: PullIssue = {
      id: "7b638a93-cc26-48e0-b6cf-98e890165809",
      identifier: "EST-83",
      title: "soma smoke-test payload",
      state: "Todo",
      stateType: "unstarted",
      priority: 3,
      labels: ["soma-ingest"],
      description: "Full markdown body of the issue…",
      url: "https://linear.app/cerebral-work/issue/EST-83/soma-smoke-test-payload",
      updatedAt: "2026-07-24T16:52:01.638Z",
    };

    expect(result[0]).toEqual(expected);
  });
});
