import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { stale } from "../src/core/grooming.js";

/**
 * Test the stale function: active-state issues bucketed by last-update age.
 * Critical = older than criticalCutoff; warn = between warnCutoff and
 * criticalCutoff. Sorted by days stale descending.
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

const NOW = new Date("2026-07-24T12:00:00Z");
const WARN_CUTOFF = new Date("2026-07-10T12:00:00Z"); // 14 days ago
const CRITICAL_CUTOFF = new Date("2026-07-03T12:00:00Z"); // 21 days ago
const DAY_MS = 86_400_000;

describe("stale — age-based bucketing", () => {
  test("issue updated between warn and critical cutoff → warn bucket", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "Stale", url: "u", priority: 0, estimate: null, updatedAt: new Date(NOW.getTime() - 16 * DAY_MS).toISOString(), state: { name: "In Progress", type: "started" }, assignee: null },
    ]);

    const result = await stale(client, { warnCutoff: WARN_CUTOFF, criticalCutoff: CRITICAL_CUTOFF, now: NOW });

    expect(result.items[0].bucket).toBe("warn");
    expect(result.warn).toBe(1);
    expect(result.critical).toBe(0);
  });

  test("issue older than critical cutoff → critical bucket", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "Very stale", url: "u", priority: 0, estimate: null, updatedAt: new Date(NOW.getTime() - 30 * DAY_MS).toISOString(), state: { name: "Todo", type: "unstarted" }, assignee: null },
    ]);

    const result = await stale(client, { warnCutoff: WARN_CUTOFF, criticalCutoff: CRITICAL_CUTOFF, now: NOW });

    expect(result.items[0].bucket).toBe("critical");
    expect(result.critical).toBe(1);
    expect(result.warn).toBe(0);
  });

  test("daysStale is floor of (now - updated) / DAY_MS", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "X", url: "u", priority: 0, estimate: null, updatedAt: new Date(NOW.getTime() - 15.9 * DAY_MS).toISOString(), state: { name: "Todo", type: "unstarted" }, assignee: null },
    ]);

    const result = await stale(client, { warnCutoff: WARN_CUTOFF, criticalCutoff: CRITICAL_CUTOFF, now: NOW });

    expect(result.items[0].daysStale).toBe(15);
  });

  test("items sorted by daysStale descending (most stale first)", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "14d", url: "u", priority: 0, estimate: null, updatedAt: new Date(NOW.getTime() - 14 * DAY_MS).toISOString(), state: { name: "Todo", type: "unstarted" }, assignee: null },
      { id: "2", identifier: "CER-2", title: "30d", url: "u", priority: 0, estimate: null, updatedAt: new Date(NOW.getTime() - 30 * DAY_MS).toISOString(), state: { name: "Todo", type: "unstarted" }, assignee: null },
      { id: "3", identifier: "CER-3", title: "20d", url: "u", priority: 0, estimate: null, updatedAt: new Date(NOW.getTime() - 20 * DAY_MS).toISOString(), state: { name: "Todo", type: "unstarted" }, assignee: null },
    ]);

    const result = await stale(client, { warnCutoff: WARN_CUTOFF, criticalCutoff: CRITICAL_CUTOFF, now: NOW });

    expect(result.items.map((i) => i.daysStale)).toEqual([30, 20, 14]);
  });

  test("olderThanDays and criticalDays in result", async () => {
    const { client } = stubClient([]);

    const result = await stale(client, { warnCutoff: WARN_CUTOFF, criticalCutoff: CRITICAL_CUTOFF, now: NOW });

    expect(result.olderThanDays).toBe(14);
    expect(result.criticalDays).toBe(21);
  });

  test("null assignee → null in item", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "X", url: "u", priority: 0, estimate: null, updatedAt: new Date(NOW.getTime() - 25 * DAY_MS).toISOString(), state: { name: "Todo", type: "unstarted" }, assignee: null },
    ]);

    const result = await stale(client, { warnCutoff: WARN_CUTOFF, criticalCutoff: CRITICAL_CUTOFF, now: NOW });

    expect(result.items[0].assignee).toBeNull();
  });

  test("null state → empty string", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "X", url: "u", priority: 0, estimate: null, updatedAt: new Date(NOW.getTime() - 25 * DAY_MS).toISOString(), state: null, assignee: null },
    ]);

    const result = await stale(client, { warnCutoff: WARN_CUTOFF, criticalCutoff: CRITICAL_CUTOFF, now: NOW });

    expect(result.items[0].state).toBe("");
  });

  test("exactly at criticalCutoff → critical (lte boundary)", async () => {
    const { client } = stubClient([
      { id: "1", identifier: "CER-1", title: "Boundary", url: "u", priority: 0, estimate: null, updatedAt: CRITICAL_CUTOFF.toISOString(), state: { name: "Todo", type: "unstarted" }, assignee: null },
    ]);

    const result = await stale(client, { warnCutoff: WARN_CUTOFF, criticalCutoff: CRITICAL_CUTOFF, now: NOW });

    expect(result.items[0].bucket).toBe("critical");
  });
});
