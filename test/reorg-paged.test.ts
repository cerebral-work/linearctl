import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { census, RateTracker, TokenBucket } from "../src/core/reorg.js";

/**
 * `reorg census --limit` capped a page-bound subset: `paged()` returned as
 * soon as the rows it happened to have reached the limit, so the cap depended
 * on page boundaries rather than on the whole scan. It also treated `0` as
 * "no limit" (the guard was `limit &&`), and a non-numeric `--limit` became
 * NaN — both silently fetched the entire workspace and exited 0.
 *
 * These drive the real census through a rawRequest stub, so the assertions
 * cover the public behaviour rather than a private helper.
 */
function fastPace() {
  return { bucket: new TokenBucket(1e9, 200), tracker: new RateTracker() };
}

/** Serve `pages` per connection name, recording how many reads each took. */
function stubClient(pages: Record<string, unknown[][]>) {
  const reads: Record<string, number> = {};
  const rawRequest = async (query: string, _vars: Record<string, unknown>) => {
    // Non-paginated singletons the census also reads.
    if (/\borganization\s*\{/.test(query)) {
      return { data: { organization: { id: "org-1", urlKey: "example" } } };
    }
    const name = Object.keys(pages).find((k) =>
      new RegExp(`\\b${k}\\s*\\(`).test(query),
    );
    if (!name) throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    const idx = reads[name] ?? 0;
    reads[name] = idx + 1;
    const pageList = pages[name];
    const nodes = pageList[idx] ?? [];
    const hasNextPage = idx < pageList.length - 1;
    return {
      data: {
        [name]: {
          nodes,
          pageInfo: { hasNextPage, endCursor: hasNextPage ? `cur-${idx + 1}` : null },
        },
      },
    };
  };
  return { client: { client: { rawRequest } } as unknown as LinearClient, reads };
}

const team = (key: string) => ({
  id: `t-${key}`,
  key,
  name: key,
  triageEnabled: false,
  private: false,
  archivedAt: null,
  issueCount: 0,
  states: { nodes: [] },
});
const issue = (id: string) => ({
  id,
  identifier: id,
  state: { id: "s" },
  labels: { nodes: [] },
  project: null,
  cycle: null,
  team: { id: "t-EX", key: "EX" },
  archivedAt: null,
});

/** Every connection the census reads; override the ones a test cares about. */
function censusPages(over: Record<string, unknown[][]> = {}) {
  return {
    teams: [[team("EX")]],
    issues: [[]],
    issueLabels: [[]],
    projects: [[]],
    initiatives: [[]],
    ...over,
  };
}

describe("reorg census pagination", () => {
  test("drains every page when no limit is given", async () => {
    const { client, reads } = stubClient(
      censusPages({ issues: [[issue("a"), issue("b")], [issue("c")]] }),
    );
    const data = await census(client, {}, fastPace());
    expect(data.issues).toHaveLength(3);
    expect(reads.issues).toBe(2);
  });

  test("a limit stops fetching at the page that satisfies it (smoke cap)", async () => {
    const { client, reads } = stubClient(
      censusPages({ issues: [[issue("a"), issue("b")], [issue("c")], [issue("d")]] }),
    );
    const data = await census(client, { limit: 2 }, fastPace());
    expect(data.issues).toHaveLength(2);
    // The cap exists to keep a probe cheap against the shared request budget,
    // so it must NOT drain the remaining pages first.
    expect(reads.issues).toBe(1);
  });

  test("--limit 5 costs at most two page requests, not a full scan", async () => {
    // Ten pages available; a 5-row cap must not walk them.
    const pages = Array.from({ length: 10 }, (_, p) =>
      Array.from({ length: 4 }, (_, i) => issue(`i${p * 4 + i}`)),
    );
    const { client, reads } = stubClient(censusPages({ issues: pages }));
    const data = await census(client, { limit: 5 }, fastPace());
    expect(data.issues).toHaveLength(5);
    expect(reads.issues).toBeLessThanOrEqual(2);
  });

  test("a capped census is marked partial; an uncapped one is not", async () => {
    const capped = await census(
      stubClient(censusPages({ issues: [[issue("a"), issue("b")]] })).client,
      { limit: 1 },
      fastPace(),
    );
    expect(capped.partial).toBe(true);

    const full = await census(
      stubClient(censusPages({ issues: [[issue("a")]] })).client,
      {},
      fastPace(),
    );
    expect(full.partial).toBe(false);
  });

  test("a limit above the total returns everything", async () => {
    const { client } = stubClient(censusPages({ issues: [[issue("a"), issue("b")]] }));
    const data = await census(client, { limit: 50 }, fastPace());
    expect(data.issues).toHaveLength(2);
  });

  test("zero, negative and non-integer limits are usage errors, not full scans", async () => {
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      const { client } = stubClient(censusPages({ issues: [[issue("a")]] }));
      await expect(census(client, { limit: bad }, fastPace())).rejects.toThrow(
        /--limit must be a positive integer/,
      );
    }
  });

  test("a cursor that does not advance terminates instead of spinning", async () => {
    let reads = 0;
    const client = {
      client: {
        rawRequest: async (query: string) => {
          if (/\borganization\s*\{/.test(query)) {
            return { data: { organization: { id: "org-1", urlKey: "example" } } };
          }
          if (!/\bissues\s*\(/.test(query)) {
            const name = ["teams", "issueLabels", "projects", "initiatives"].find((k) =>
              new RegExp(`\\b${k}\\s*\\(`).test(query),
            );
            return {
              data: {
                [name!]: {
                  nodes: name === "teams" ? [team("EX")] : [],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            };
          }
          reads++;
          if (reads > 50) throw new Error("spun out of control");
          return {
            data: {
              issues: {
                nodes: [issue("a")],
                pageInfo: { hasNextPage: true, endCursor: "stuck" },
              },
            },
          };
        },
      },
    } as unknown as LinearClient;
    const data = await census(client, {}, fastPace());
    expect(reads).toBeLessThan(5);
    expect(data.issues.length).toBeGreaterThan(0);
  });
});
