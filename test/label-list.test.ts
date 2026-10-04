import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { listLabels, listLabelsPaged } from "../src/core/labels.js";

/**
 * `label list` must follow cursors to the end (CER-2349). It previously asked
 * for a single page and reported a truncated list as if it were complete, so
 * these cover: multi-page accumulation, the stable sort across pages, the
 * `--limit` partial flag, and the boundary cases around it.
 */

interface RawLabel {
  id: string;
  name: string;
  color: string | null;
  team: { key: string } | null;
}

/** Serve `pages` in order, one per rawRequest call, recording the vars seen. */
function stubClient(pages: RawLabel[][]) {
  const calls: Array<{ first: number; after: string | null; filter?: unknown }> = [];
  let call = 0;
  const client = {
    client: {
      rawRequest: async (_q: string, vars: { first: number; after: string | null }) => {
        calls.push({ ...vars });
        const idx = call++;
        const nodes = pages[idx] ?? [];
        const hasNextPage = idx < pages.length - 1;
        return {
          data: {
            issueLabels: {
              nodes,
              pageInfo: { hasNextPage, endCursor: hasNextPage ? `cursor-${idx + 1}` : null },
            },
          },
        };
      },
    },
  } as unknown as LinearClient;
  return { client, calls };
}

const label = (id: string, name: string, teamKey: string | null = null): RawLabel => ({
  id,
  name,
  color: "#bec2c8",
  team: teamKey ? { key: teamKey } : null,
});

describe("listLabelsPaged — pagination", () => {
  test("follows cursors across pages and returns every label", async () => {
    const { client, calls } = stubClient([
      [label("1", "alpha"), label("2", "bravo")],
      [label("3", "charlie"), label("4", "delta")],
      [label("5", "echo")],
    ]);
    const { labels, partial } = await listLabelsPaged(client);
    expect(labels.map((l) => l.name)).toEqual(["alpha", "bravo", "charlie", "delta", "echo"]);
    expect(partial).toBe(false);
    expect(calls).toHaveLength(3);
    // The first page sends no cursor; later pages send the previous endCursor.
    expect(calls[0].after).toBeNull();
    expect(calls[1].after).toBe("cursor-1");
    expect(calls[2].after).toBe("cursor-2");
  });

  test("a listing that fits one page is not partial", async () => {
    const { client, calls } = stubClient([[label("1", "only")]]);
    const { labels, partial } = await listLabelsPaged(client);
    expect(labels).toHaveLength(1);
    expect(partial).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test("an empty workspace yields no labels and is not partial", async () => {
    const { client } = stubClient([[]]);
    const { labels, partial } = await listLabelsPaged(client);
    expect(labels).toEqual([]);
    expect(partial).toBe(false);
  });

  test("sorts by team then name across page boundaries", async () => {
    // Deliberately out of order, and split so a per-page sort would not suffice.
    const { client } = stubClient([
      [label("1", "zulu", "CER"), label("2", "alpha")],
      [label("3", "bravo", "BRAND"), label("4", "alpha", "CER")],
    ]);
    const { labels } = await listLabelsPaged(client);
    expect(labels.map((l) => `${l.team ?? "-"}/${l.name}`)).toEqual([
      "-/alpha",
      "BRAND/bravo",
      "CER/alpha",
      "CER/zulu",
    ]);
  });

  test("de-duplicates a label repeated across pages (cursor instability)", async () => {
    const { client } = stubClient([
      [label("1", "alpha"), label("2", "bravo")],
      [label("2", "bravo"), label("3", "charlie")],
    ]);
    const { labels } = await listLabelsPaged(client);
    expect(labels.map((l) => l.id)).toEqual(["1", "2", "3"]);
  });

  test("maps a missing color to null and a missing team to null", async () => {
    const { client } = stubClient([[{ id: "1", name: "x", color: null, team: null }]]);
    const { labels } = await listLabelsPaged(client);
    expect(labels[0]).toMatchObject({ color: null, team: null });
  });

  test("scoping by team sends a filter; omitting --team sends none", async () => {
    const scoped = stubClient([[label("1", "a", "CER")]]);
    await listLabelsPaged(scoped.client, { teamKeys: ["CER"] });
    expect(scoped.calls[0].filter).toBeDefined();

    const unscoped = stubClient([[label("1", "a")]]);
    await listLabelsPaged(unscoped.client);
    expect(unscoped.calls[0].filter).toBeUndefined();
  });

  test("throws when the query returns no data rather than reporting an empty list", async () => {
    const client = {
      client: { rawRequest: async () => ({ data: null }) },
    } as unknown as LinearClient;
    await expect(listLabelsPaged(client)).rejects.toThrow(/no data/);
  });
});

describe("listLabelsPaged — --limit", () => {
  test("marks the listing partial and truncates when more rows exist", async () => {
    const { client } = stubClient([
      [label("1", "alpha"), label("2", "bravo")],
      [label("3", "charlie")],
    ]);
    const { labels, partial } = await listLabelsPaged(client, { limit: 2 });
    expect(labels.map((l) => l.name)).toEqual(["alpha", "bravo"]);
    expect(partial).toBe(true);
  });

  test("stops fetching once the limit is met", async () => {
    const { client, calls } = stubClient([
      [label("1", "alpha"), label("2", "bravo")],
      [label("3", "charlie")],
      [label("4", "delta")],
    ]);
    await listLabelsPaged(client, { limit: 2 });
    expect(calls).toHaveLength(1);
  });

  test("a limit equal to the total is not partial", async () => {
    const { client } = stubClient([[label("1", "alpha"), label("2", "bravo")]]);
    const { labels, partial } = await listLabelsPaged(client, { limit: 2 });
    expect(labels).toHaveLength(2);
    expect(partial).toBe(false);
  });

  test("a limit above the total is not partial", async () => {
    const { client } = stubClient([[label("1", "alpha")]]);
    const { labels, partial } = await listLabelsPaged(client, { limit: 50 });
    expect(labels).toHaveLength(1);
    expect(partial).toBe(false);
  });

  test("the truncated rows are the stable sorted prefix, not page order", async () => {
    const { client } = stubClient([
      [label("1", "zulu"), label("2", "alpha")],
      [label("3", "bravo")],
    ]);
    const { labels } = await listLabelsPaged(client, { limit: 1 });
    expect(labels.map((l) => l.name)).toEqual(["alpha"]);
  });

  test("rejects a non-positive or non-integer limit as a usage error", async () => {
    const { client } = stubClient([[label("1", "alpha")]]);
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(listLabelsPaged(client, { limit: bad })).rejects.toThrow(
        /--limit must be a positive integer/,
      );
    }
  });
});

describe("listLabels — array form preserved", () => {
  test("returns the labels array directly across pages", async () => {
    const { client } = stubClient([[label("1", "alpha")], [label("2", "bravo")]]);
    const rows = await listLabels(client);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map((l) => l.name)).toEqual(["alpha", "bravo"]);
  });
});
