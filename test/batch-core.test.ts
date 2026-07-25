import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { resolveIssueUuids, batchUpdateIssues } from "../src/core/batch.js";

/**
 * Direct tests for src/core/batch.ts — the N+1 fix for bulk issue mutations.
 *
 * resolveIssueUuids: stubs client.client.rawRequest returning aliased
 * issue(id){id,identifier} nodes; verifies UUID passthrough, identifier
 * resolution, dedup, chunking, missing refs absent from map.
 *
 * batchUpdateIssues: stubs rawRequest returning per-aliased-mutation
 * success/fail; verifies count, chunk boundary, whole-chunk transport failure
 * attribution.
 */

function stubResolveClient(nodes: Array<{ ref: string; id: string; identifier: string } | null>) {
  const data: Record<string, { id: string; identifier: string } | null> = {};
  nodes.forEach((n, i) => {
    data[`r${i}`] = n ? { id: n.id, identifier: n.identifier } : null;
  });

  const client = {
    client: {
      rawRequest: async (_query: string, vars: Record<string, unknown>) => ({
        data: Object.fromEntries(
          Object.keys(vars)
            .filter((k) => k.startsWith("r"))
            .map((k) => [k, data[k] ?? null]),
        ),
      }),
    },
  } as unknown as LinearClient;

  return { client };
}

function stubBatchClient(results: Array<{ ref: string; success: boolean }>) {
  const data: Record<string, { success: boolean }> = {};
  results.forEach((r, i) => {
    data[`m${i}`] = { success: r.success };
  });

  let callCount = 0;
  const client = {
    client: {
      rawRequest: async (_query: string, _vars: Record<string, unknown>) => {
        const chunkData: Record<string, { success: boolean }> = {};
        const offset = callCount * 25;
        results.slice(offset, offset + 25).forEach((r, i) => {
          chunkData[`m${i}`] = { success: r.success };
        });
        callCount++;
        return { data: chunkData };
      },
    },
  } as unknown as LinearClient;

  return { client };
}

function stubFailingClient(errorMsg: string) {
  const client = {
    client: {
      rawRequest: async () => {
        throw new Error(errorMsg);
      },
    },
  } as unknown as LinearClient;

  return { client };
}

describe("resolveIssueUuids", () => {
  test("resolves identifiers to UUIDs", async () => {
    const { client } = stubResolveClient([
      { ref: "CER-1", id: "uuid-1", identifier: "CER-1" },
      { ref: "CER-2", id: "uuid-2", identifier: "CER-2" },
    ]);

    const result = await resolveIssueUuids(client, ["CER-1", "CER-2"]);

    expect(result.size).toBe(2);
    expect(result.get("CER-1")?.uuid).toBe("uuid-1");
    expect(result.get("CER-2")?.uuid).toBe("uuid-2");
  });

  test("UUIDs pass through unchanged", async () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const { client } = stubResolveClient([
      { ref: uuid, id: uuid, identifier: "CER-99" },
    ]);

    const result = await resolveIssueUuids(client, [uuid]);

    expect(result.size).toBe(1);
    expect(result.get(uuid)?.uuid).toBe(uuid);
  });

  test("deduplicates identical refs", async () => {
    const { client } = stubResolveClient([
      { ref: "CER-1", id: "uuid-1", identifier: "CER-1" },
    ]);

    const result = await resolveIssueUuids(client, ["CER-1", "CER-1", "CER-1"]);

    expect(result.size).toBe(1);
  });

  test("unresolvable refs are absent from the map", async () => {
    const { client } = stubResolveClient([
      { ref: "CER-1", id: "uuid-1", identifier: "CER-1" },
      null,
    ]);

    const result = await resolveIssueUuids(client, ["CER-1", "FAKE-999"]);

    expect(result.size).toBe(1);
    expect(result.has("FAKE-999")).toBe(false);
  });

  test("empty refs array returns empty map", async () => {
    const { client } = stubResolveClient([]);

    const result = await resolveIssueUuids(client, []);

    expect(result.size).toBe(0);
  });
});

describe("batchUpdateIssues", () => {
  test("reports succeeded count for all-successful mutations", async () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      uuid: `uuid-${i}`,
      ref: `CER-${i + 1}`,
      input: { priority: 1 },
    }));

    const { client } = stubBatchClient(items.map((it) => ({ ref: it.ref, success: true })));

    const result = await batchUpdateIssues(client, items);

    expect(result.total).toBe(5);
    expect(result.succeeded).toBe(5);
    expect(result.failed).toHaveLength(0);
  });

  test("reports per-item failures when success=false", async () => {
    const items = [
      { uuid: "uuid-0", ref: "CER-1", input: { priority: 1 } },
      { uuid: "uuid-1", ref: "CER-2", input: { priority: 1 } },
      { uuid: "uuid-2", ref: "CER-3", input: { priority: 1 } },
    ];

    const { client } = stubBatchClient([
      { ref: "CER-1", success: true },
      { ref: "CER-2", success: false },
      { ref: "CER-3", success: true },
    ]);

    const result = await batchUpdateIssues(client, items);

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].ref).toBe("CER-2");
    expect(result.failed[0].error).toContain("success=false");
  });

  test("whole-chunk transport failure attributes to every item in the chunk", async () => {
    const items = Array.from({ length: 3 }, (_, i) => ({
      uuid: `uuid-${i}`,
      ref: `CER-${i + 1}`,
      input: { stateId: "ws-1" },
    }));

    const { client } = stubFailingClient("GraphQL validation error: unknown field");

    const result = await batchUpdateIssues(client, items);

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(3);
    for (const f of result.failed) {
      expect(f.error).toBe("GraphQL validation error: unknown field");
    }
  });

  test("empty items array returns zero counts", async () => {
    const { client } = stubBatchClient([]);

    const result = await batchUpdateIssues(client, []);

    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toHaveLength(0);
  });

  test("mixed success and failure in same chunk", async () => {
    const items = Array.from({ length: 4 }, (_, i) => ({
      uuid: `uuid-${i}`,
      ref: `CER-${i + 1}`,
      input: { priority: i },
    }));

    const { client } = stubBatchClient([
      { ref: "CER-1", success: true },
      { ref: "CER-2", success: false },
      { ref: "CER-3", success: false },
      { ref: "CER-4", success: true },
    ]);

    const result = await batchUpdateIssues(client, items);

    expect(result.succeeded).toBe(2);
    expect(result.failed).toHaveLength(2);
    expect(result.failed.map((f) => f.ref).sort()).toEqual(["CER-2", "CER-3"]);
  });
});
