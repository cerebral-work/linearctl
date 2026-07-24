import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { stale } from "../src/core/grooming.js";
import type { FlatIssueNode } from "../src/core/issues-query.js";

const DAY_MS = 86_400_000;

function flatIssue(
  id: string,
  identifier: string,
  title: string,
  updatedAt: string,
  stateType = "started",
): FlatIssueNode {
  return {
    id,
    identifier,
    title,
    url: `https://linear.app/cerebral-work/issue/${identifier}`,
    priority: 3,
    estimate: null,
    updatedAt,
    state: { name: stateType === "started" ? "In Progress" : "Todo", type: stateType },
    assignee: null,
  };
}

/**
 * stale() calls collectIssuesFlat(client, filter, orderBy) which uses
 * client.client.rawRequest internally. We stub that to return a fixed
 * set of issues.
 */
function stubClient(issues: FlatIssueNode[]): LinearClient {
  return {
    client: {
      rawRequest: async () => ({
        data: {
          issues: {
            nodes: issues,
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    },
  } as unknown as LinearClient;
}

const NOW = new Date("2026-07-24T12:00:00.000Z");

describe("stale", () => {
  test("buckets issues into warn and critical by updatedAt", async () => {
    const issues = [
      flatIssue("1", "CER-1", "A", new Date(NOW.getTime() - 10 * DAY_MS).toISOString()),    // 10d → warn
      flatIssue("2", "CER-2", "B", new Date(NOW.getTime() - 40 * DAY_MS).toISOString()),    // 40d → critical
      flatIssue("3", "CER-3", "C", new Date(NOW.getTime() - 5 * DAY_MS).toISOString()),     // 5d → warn
    ];

    const client = stubClient(issues);
    const result = await stale(client, {
      warnCutoff: new Date(NOW.getTime() - 7 * DAY_MS),      // >7d = stale
      criticalCutoff: new Date(NOW.getTime() - 30 * DAY_MS),  // >30d = critical
      now: NOW,
    });

    expect(result.warn).toBe(2);   // CER-1 (10d), CER-3 (5d)
    expect(result.critical).toBe(1); // CER-2 (40d)
  });

  test("sorts items by daysStale descending (most stale first)", async () => {
    const issues = [
      flatIssue("1", "CER-1", "A", new Date(NOW.getTime() - 10 * DAY_MS).toISOString()),
      flatIssue("2", "CER-2", "B", new Date(NOW.getTime() - 40 * DAY_MS).toISOString()),
      flatIssue("3", "CER-3", "C", new Date(NOW.getTime() - 15 * DAY_MS).toISOString()),
    ];

    const client = stubClient(issues);
    const result = await stale(client, {
      warnCutoff: new Date(NOW.getTime() - 7 * DAY_MS),
      criticalCutoff: new Date(NOW.getTime() - 30 * DAY_MS),
      now: NOW,
    });

    expect(result.items[0].identifier).toBe("CER-2");  // 40d
    expect(result.items[1].identifier).toBe("CER-3");  // 15d
    expect(result.items[2].identifier).toBe("CER-1");  // 10d
  });

  test("computes daysStale correctly", async () => {
    const issues = [
      flatIssue("1", "CER-1", "A", new Date(NOW.getTime() - 14 * DAY_MS).toISOString()),
    ];

    const client = stubClient(issues);
    const result = await stale(client, {
      warnCutoff: new Date(NOW.getTime() - 7 * DAY_MS),
      criticalCutoff: new Date(NOW.getTime() - 30 * DAY_MS),
      now: NOW,
    });

    expect(result.items[0].daysStale).toBe(14);
  });

  test("reportability: olderThanDays and criticalDays are derived from cutoffs", async () => {
    const client = stubClient([]);
    const result = await stale(client, {
      warnCutoff: new Date(NOW.getTime() - 30 * DAY_MS),
      criticalCutoff: new Date(NOW.getTime() - 90 * DAY_MS),
      now: NOW,
    });

    expect(result.olderThanDays).toBe(30);
    expect(result.criticalDays).toBe(90);
  });

  test("returns empty items when nothing is stale", async () => {
    const client = stubClient([]);
    const result = await stale(client, {
      warnCutoff: new Date(NOW.getTime() - 7 * DAY_MS),
      criticalCutoff: new Date(NOW.getTime() - 30 * DAY_MS),
      now: NOW,
    });

    expect(result.items).toEqual([]);
    expect(result.warn).toBe(0);
    expect(result.critical).toBe(0);
  });

  test("boundary: exactly at warnCutoff is included (lte)", async () => {
    const issues = [
      flatIssue("1", "CER-1", "A", new Date(NOW.getTime() - 7 * DAY_MS).toISOString()),
    ];

    const client = stubClient(issues);
    const result = await stale(client, {
      warnCutoff: new Date(NOW.getTime() - 7 * DAY_MS),   // exactly 7d
      criticalCutoff: new Date(NOW.getTime() - 30 * DAY_MS),
      now: NOW,
    });

    // The filter is updatedAt: { lte: warnCutoff }, so exactly-at is included
    expect(result.items).toHaveLength(1);
    expect(result.items[0].daysStale).toBe(7);
  });

  test("boundary: exactly at criticalCutoff is critical (lte)", async () => {
    const issues = [
      flatIssue("1", "CER-1", "A", new Date(NOW.getTime() - 30 * DAY_MS).toISOString()),
    ];

    const client = stubClient(issues);
    const result = await stale(client, {
      warnCutoff: new Date(NOW.getTime() - 7 * DAY_MS),
      criticalCutoff: new Date(NOW.getTime() - 30 * DAY_MS),  // exactly 30d
      now: NOW,
    });

    expect(result.items[0].bucket).toBe("critical");
  });

  test("item carries identifier, title, state, assignee, url", async () => {
    const issues = [
      flatIssue("1", "CER-1", "Fix bug", new Date(NOW.getTime() - 10 * DAY_MS).toISOString()),
    ];

    const client = stubClient(issues);
    const result = await stale(client, {
      warnCutoff: new Date(NOW.getTime() - 7 * DAY_MS),
      criticalCutoff: new Date(NOW.getTime() - 30 * DAY_MS),
      now: NOW,
    });

    const item = result.items[0];
    expect(item.identifier).toBe("CER-1");
    expect(item.title).toBe("Fix bug");
    expect(item.state).toBe("In Progress");
    expect(item.assignee).toBeNull();
    expect(item.url).toContain("CER-1");
  });
});
