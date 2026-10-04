import { describe, expect, test } from "bun:test";
import { countConnection, drainConnection } from "../src/lib/paginate.js";
import type { PageConnection } from "../src/lib/paginate.js";

/**
 * The SDK's `fetchNext()` APPENDS to the connection's own `nodes` array and
 * advances `pageInfo` in place. Code that also pushes `connection.nodes` into
 * a separate array on every iteration therefore re-counts every page already
 * fetched — `project list` returned 141 rows for 91 projects, and the
 * milestone issue count reported 2500 for 1000 issues.
 *
 * These stubs reproduce that append semantics exactly, so a regression to the
 * old shape shows up as duplicates rather than passing quietly.
 */
function sdkConnection<T>(pages: T[][]): PageConnection<T> & { fetches: number } {
  let page = 0;
  const conn = {
    nodes: [...(pages[0] ?? [])],
    pageInfo: { hasNextPage: pages.length > 1 },
    fetches: 0,
    async fetchNext() {
      conn.fetches++;
      page++;
      // Exactly what the SDK does: append, then update pageInfo in place.
      conn.nodes = [...conn.nodes, ...(pages[page] ?? [])];
      conn.pageInfo.hasNextPage = page < pages.length - 1;
      return conn;
    },
  };
  return conn;
}

const row = (id: string) => ({ id });

describe("drainConnection", () => {
  test("returns every node exactly once across pages", async () => {
    const conn = sdkConnection([[row("1"), row("2")], [row("3")], [row("4")]]);
    const all = await drainConnection(conn);
    expect(all.map((r) => r.id)).toEqual(["1", "2", "3", "4"]);
    // The duplicate bug produced 1,2,1,2,3,1,2,3,4 — assert distinctness.
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
  });

  test("the 50-per-page shape that produced 141 rows for 91 projects", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => row(`p${i}`));
    const page2 = Array.from({ length: 41 }, (_, i) => row(`p${50 + i}`));
    const all = await drainConnection(sdkConnection([page1, page2]));
    expect(all).toHaveLength(91);
    expect(new Set(all.map((r) => r.id)).size).toBe(91);
  });

  test("a single page needs no fetch", async () => {
    const conn = sdkConnection([[row("1")]]);
    expect(await drainConnection(conn)).toHaveLength(1);
    expect(conn.fetches).toBe(0);
  });

  test("an empty connection drains to nothing", async () => {
    expect(await drainConnection(sdkConnection<{ id: string }>([[]]))).toEqual([]);
  });

  test("fetches every page, not just until some threshold", async () => {
    const conn = sdkConnection([[row("1")], [row("2")], [row("3")], [row("4")]]);
    await drainConnection(conn);
    expect(conn.fetches).toBe(3);
  });

  test("a missing pageInfo is treated as a single page", async () => {
    const conn: PageConnection<{ id: string }> = {
      nodes: [row("1")],
      pageInfo: null,
      fetchNext: async () => {
        throw new Error("must not fetch when pageInfo is absent");
      },
    };
    expect(await drainConnection(conn)).toHaveLength(1);
  });

  test("a hasNextPage that never clears terminates instead of spinning", async () => {
    let fetches = 0;
    const conn: PageConnection<{ id: string }> = {
      nodes: [row("1")],
      pageInfo: { hasNextPage: true },
      fetchNext: async () => {
        fetches++;
        if (fetches > 100) throw new Error("spun out of control");
        return conn; // adds no rows, and never clears hasNextPage
      },
    };
    expect(await drainConnection(conn)).toHaveLength(1);
    expect(fetches).toBe(1);
  });
});

describe("countConnection", () => {
  test("counts each node once (the 2500-for-1000 inflation)", async () => {
    const pages = Array.from({ length: 4 }, (_, p) =>
      Array.from({ length: 250 }, (_, i) => row(`i${p * 250 + i}`)),
    );
    // The old shape summed nodes.length per pass: 250+500+750+1000 = 2500.
    expect(await countConnection(sdkConnection(pages))).toBe(1000);
  });

  test("counts an empty connection as zero", async () => {
    expect(await countConnection(sdkConnection<{ id: string }>([[]]))).toBe(0);
  });
});
