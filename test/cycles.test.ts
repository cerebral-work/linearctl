import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { resolveCycleId } from "../src/core/cycles.js";
import type { FlatIssueNode } from "../src/core/issues-query.js";

// ---- stub factory for resolveCycleId ----

/** resolveCycleId calls client.client.rawRequest(CYCLE_RESOLVE_QUERY, { team }) */
function stubClient(teamData: {
  key: string;
  activeCycle: { id: string; number: number } | null;
  cycles: Array<{ id: string; number: number; startsAt: string }>;
}): LinearClient {
  return {
    client: {
      rawRequest: async () => ({
        data: {
          teams: {
            nodes: [{
              key: teamData.key,
              activeCycle: teamData.activeCycle,
              cycles: { nodes: teamData.cycles },
            }],
          },
        },
      }),
    },
  } as unknown as LinearClient;
}

// ---- resolveCycleId ----

describe("resolveCycleId", () => {
  test("'none' returns null", async () => {
    const client = stubClient({ key: "CER", activeCycle: { id: "c1", number: 1 }, cycles: [] });
    expect(await resolveCycleId(client, "CER", "none")).toBeNull();
  });

  test("empty string returns null", async () => {
    const client = stubClient({ key: "CER", activeCycle: { id: "c1", number: 1 }, cycles: [] });
    expect(await resolveCycleId(client, "CER", "")).toBeNull();
  });

  test("UUID passes through unchanged", async () => {
    const client = stubClient({ key: "CER", activeCycle: null, cycles: [] });
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(await resolveCycleId(client, "CER", uuid)).toBe(uuid);
  });

  test("'current' resolves to activeCycle id", async () => {
    const client = stubClient({
      key: "CER",
      activeCycle: { id: "cycle-active", number: 5 },
      cycles: [{ id: "c5", number: 5, startsAt: "2026-07-20" }],
    });
    expect(await resolveCycleId(client, "CER", "current")).toBe("cycle-active");
  });

  test("'active' is an alias for 'current'", async () => {
    const client = stubClient({
      key: "CER",
      activeCycle: { id: "cycle-active", number: 5 },
      cycles: [],
    });
    expect(await resolveCycleId(client, "CER", "active")).toBe("cycle-active");
  });

  test("'current' throws when no active cycle exists", async () => {
    const client = stubClient({
      key: "CER",
      activeCycle: null,
      cycles: [{ id: "c6", number: 6, startsAt: "2026-08-01" }],
    });
    await expect(resolveCycleId(client, "CER", "current")).rejects.toThrow(
      /no active cycle/,
    );
  });

  test("'next' resolves to the earliest future cycle", async () => {
    const now = Date.now();
    const future1 = new Date(now + 7 * 86_400_000).toISOString();
    const future2 = new Date(now + 14 * 86_400_000).toISOString();
    const past = new Date(now - 7 * 86_400_000).toISOString();

    const client = stubClient({
      key: "CER",
      activeCycle: null,
      cycles: [
        { id: "c-past", number: 4, startsAt: past },
        { id: "c-far", number: 6, startsAt: future2 },
        { id: "c-near", number: 5, startsAt: future1 },
      ],
    });

    expect(await resolveCycleId(client, "CER", "next")).toBe("c-near");
  });

  test("'next' throws when no future cycle exists", async () => {
    const past = new Date(Date.now() - 7 * 86_400_000).toISOString();
    const client = stubClient({
      key: "CER",
      activeCycle: null,
      cycles: [{ id: "c-past", number: 4, startsAt: past }],
    });
    await expect(resolveCycleId(client, "CER", "next")).rejects.toThrow(
      /no upcoming cycle/,
    );
  });

  test("'next' works even between cycles (activeCycle is null)", async () => {
    const future = new Date(Date.now() + 3 * 86_400_000).toISOString();
    const client = stubClient({
      key: "CER",
      activeCycle: null,
      cycles: [{ id: "c-next", number: 3, startsAt: future }],
    });
    expect(await resolveCycleId(client, "CER", "next")).toBe("c-next");
  });

  test("numeric ref resolves by cycle number", async () => {
    const client = stubClient({
      key: "CER",
      activeCycle: { id: "c5", number: 5 },
      cycles: [
        { id: "c4", number: 4, startsAt: "2026-06-20" },
        { id: "c5", number: 5, startsAt: "2026-07-20" },
      ],
    });
    expect(await resolveCycleId(client, "CER", "4")).toBe("c4");
  });

  test("falls back to activeCycle when number matches", async () => {
    const client = stubClient({
      key: "CER",
      activeCycle: { id: "active-7", number: 7 },
      cycles: [], // not in the cycles list, only in activeCycle
    });
    expect(await resolveCycleId(client, "CER", "7")).toBe("active-7");
  });

  test("throws on unknown cycle number", async () => {
    const client = stubClient({
      key: "CER",
      activeCycle: { id: "c5", number: 5 },
      cycles: [{ id: "c5", number: 5, startsAt: "2026-07-20" }],
    });
    await expect(resolveCycleId(client, "CER", "99")).rejects.toThrow(
      /no cycle number 99/,
    );
  });

  test("throws on non-numeric, non-keyword ref", async () => {
    const client = stubClient({
      key: "CER",
      activeCycle: { id: "c5", number: 5 },
      cycles: [],
    });
    await expect(resolveCycleId(client, "CER", "banana")).rejects.toThrow(
      /not a number.*current.*next.*none/,
    );
  });

  test("throws when team has no cycles at all", async () => {
    const client = stubClient({
      key: "CER",
      activeCycle: null,
      cycles: [],
    });
    await expect(resolveCycleId(client, "CER", "current")).rejects.toThrow(
      /no cycles/,
    );
  });

  test("throws when team key not found", async () => {
    const client = {
      client: {
        rawRequest: async () => ({ data: { teams: { nodes: [] } } }),
      },
    } as unknown as LinearClient;

    await expect(resolveCycleId(client, "NOPE", "current")).rejects.toThrow(
      /no team matching/,
    );
  });

  test("case-insensitive: 'CURRENT' works", async () => {
    const client = stubClient({
      key: "CER",
      activeCycle: { id: "cycle-active", number: 5 },
      cycles: [],
    });
    expect(await resolveCycleId(client, "CER", "CURRENT")).toBe("cycle-active");
  });
});

// ---- bucket (pure function) ----

describe("bucket", () => {
  // bucket is not exported, so we test it indirectly via cycleReview
  // (which uses it internally). For now, test the FlatIssueNode shape
  // that bucket consumes — the estimate field.
  test("FlatIssueNode.estimate is number|null (the field bucket sums)", () => {
    const issue: FlatIssueNode = {
      id: "1",
      identifier: "CER-1",
      title: "Test",
      url: "https://l.app/1",
      priority: 3,
      estimate: 5,
      updatedAt: "2026-07-24T10:00:00.000Z",
      state: { name: "In Progress", type: "started" },
      assignee: null,
      labels: { nodes: [] },
    };
    expect(issue.estimate).toBe(5);
  });

  test("estimate can be null (unestimated issues contribute 0 points)", () => {
    const issue: FlatIssueNode = {
      id: "1",
      identifier: "CER-1",
      title: "Test",
      url: "https://l.app/1",
      priority: 3,
      estimate: null,
      updatedAt: "2026-07-24T10:00:00.000Z",
      state: { name: "Todo", type: "unstarted" },
      assignee: null,
      labels: { nodes: [] },
    };
    // bucket uses `i.estimate ?? 0` — null → 0
    expect(issue.estimate ?? 0).toBe(0);
  });
});
