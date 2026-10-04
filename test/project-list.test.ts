import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { listProjects, listProjectsPaged } from "../src/core/projects.js";

/**
 * `project list` reported 141 rows for 91 projects. The SDK's `fetchNext()`
 * APPENDS to the connection's own `nodes` array and advances `pageInfo` in
 * place; the caller also pushed `connection.nodes` into a separate array each
 * pass, so page one was re-counted for every later page.
 *
 * These stubs reproduce that append semantics exactly — a regression to the
 * old shape shows up here as duplicate rows rather than passing quietly.
 */
interface RawProject {
  id: string;
  name: string;
  url: string;
  state: string;
  progress: number;
}

const project = (id: string, name = `project-${id}`): RawProject => ({
  id,
  name,
  url: `https://example.com/${id}`,
  state: "started",
  progress: 0.5,
});

/** A connection whose fetchNext() appends, exactly like the Linear SDK. */
function stubClient(pages: RawProject[][]) {
  let page = 0;
  const connection = {
    nodes: [...(pages[0] ?? [])],
    pageInfo: { hasNextPage: pages.length > 1, endCursor: "c0" },
    fetches: 0,
    async fetchNext() {
      connection.fetches++;
      page++;
      connection.nodes = [...connection.nodes, ...(pages[page] ?? [])];
      connection.pageInfo.hasNextPage = page < pages.length - 1;
      return connection;
    },
  };
  const client = { projects: async () => connection } as unknown as LinearClient;
  return { client, connection };
}

describe("listProjectsPaged — the double-count regression", () => {
  test("the 50-per-page shape that produced 141 rows for 91 projects", async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => project(`p${i}`));
    const page2 = Array.from({ length: 41 }, (_, i) => project(`p${50 + i}`));
    const { projects } = await listProjectsPaged(stubClient([page1, page2]).client);
    expect(projects).toHaveLength(91);
    expect(new Set(projects.map((p) => p.id)).size).toBe(91);
  });

  test("returns every project exactly once across pages", async () => {
    const { client } = stubClient([
      [project("1"), project("2")],
      [project("3")],
      [project("4")],
    ]);
    const { projects, partial } = await listProjectsPaged(client);
    expect(projects.map((p) => p.id)).toEqual(["1", "2", "3", "4"]);
    expect(partial).toBe(false);
  });

  test("de-duplicates a project repeated across pages (cursor instability)", async () => {
    const { client } = stubClient([
      [project("1"), project("2")],
      [project("2"), project("3")],
    ]);
    const { projects } = await listProjectsPaged(client);
    expect(projects.map((p) => p.id)).toEqual(["1", "2", "3"]);
  });

  test("drains every page rather than stopping at the first", async () => {
    const { client, connection } = stubClient([
      [project("1")],
      [project("2")],
      [project("3")],
    ]);
    await listProjectsPaged(client);
    expect(connection.fetches).toBe(2);
  });

  test("a single page needs no fetch and is complete", async () => {
    const { client, connection } = stubClient([[project("1")]]);
    const { projects, partial } = await listProjectsPaged(client);
    expect(projects).toHaveLength(1);
    expect(partial).toBe(false);
    expect(connection.fetches).toBe(0);
  });

  test("an empty workspace yields no projects and is not partial", async () => {
    const { client } = stubClient([[]]);
    const { projects, partial } = await listProjectsPaged(client);
    expect(projects).toEqual([]);
    expect(partial).toBe(false);
  });

  test("maps the summary fields the renderer depends on", async () => {
    const { client } = stubClient([[project("1", "alpha")]]);
    const { projects } = await listProjectsPaged(client);
    expect(projects[0]).toEqual({
      id: "1",
      name: "alpha",
      url: "https://example.com/1",
      state: "started",
      progress: 0.5,
    });
  });
});

describe("listProjectsPaged — ordering and --limit", () => {
  test("orders by name across page boundaries", async () => {
    const { client } = stubClient([
      [project("1", "zulu"), project("2", "charlie")],
      [project("3", "alpha")],
    ]);
    const { projects } = await listProjectsPaged(client);
    expect(projects.map((p) => p.name)).toEqual(["alpha", "charlie", "zulu"]);
  });

  test("the cap is the sorted prefix of ALL pages, not of page one", async () => {
    // The whole answer lives on page 2: a page-bound cap returns yankee/zulu.
    const { client } = stubClient([
      [project("1", "yankee"), project("2", "zulu")],
      [project("3", "alpha"), project("4", "bravo")],
    ]);
    const { projects, partial } = await listProjectsPaged(client, { limit: 2 });
    expect(projects.map((p) => p.name)).toEqual(["alpha", "bravo"]);
    expect(partial).toBe(true);
  });

  test("fetches every page under a limit", async () => {
    const { client, connection } = stubClient([
      [project("1", "a"), project("2", "b")],
      [project("3", "c")],
      [project("4", "d")],
    ]);
    await listProjectsPaged(client, { limit: 2 });
    expect(connection.fetches).toBe(2);
  });

  test("a limit at or above the total is not partial", async () => {
    for (const limit of [2, 50]) {
      const { client } = stubClient([[project("1", "a"), project("2", "b")]]);
      const { projects, partial } = await listProjectsPaged(client, { limit });
      expect(projects).toHaveLength(2);
      expect(partial).toBe(false);
    }
  });

  test("rejects a non-positive or non-integer limit as a usage error", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      const { client } = stubClient([[project("1")]]);
      await expect(listProjectsPaged(client, { limit: bad })).rejects.toThrow(
        /--limit must be a positive integer/,
      );
    }
  });
});

describe("listProjects — array form preserved", () => {
  test("returns the projects array directly, de-duplicated across pages", async () => {
    const { client } = stubClient([[project("1")], [project("2")]]);
    const rows = await listProjects(client);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map((p) => p.id)).toEqual(["1", "2"]);
  });

  test("passes the team scope through to the team's connection", async () => {
    let teamResolved = false;
    const connection = {
      nodes: [project("1")],
      pageInfo: { hasNextPage: false, endCursor: null },
      fetchNext: async () => connection,
    };
    const client = {
      teams: async () => ({ nodes: [{ id: "t1", key: "CER", name: "Cerebral" }] }),
      projects: async () => {
        throw new Error("must use the team-scoped connection");
      },
    } as unknown as LinearClient;
    // resolveTeamByKey reads client.teams(); the team object supplies projects().
    (client as unknown as { teams: () => Promise<unknown> }).teams = async () => ({
      nodes: [
        {
          id: "t1",
          key: "CER",
          name: "Cerebral",
          projects: async () => {
            teamResolved = true;
            return connection;
          },
        },
      ],
    });
    const rows = await listProjects(client, "CER");
    expect(teamResolved).toBe(true);
    expect(rows).toHaveLength(1);
  });
});
