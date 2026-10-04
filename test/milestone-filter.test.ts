import { expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { resolveReadMilestones } from "../src/core/milestone-filter.js";
import { resolveSearchFilter } from "../src/core/search.js";
import { CliError } from "../src/lib/errors.js";

function connection(pages: Array<Array<{ id: string; name: string }>>) {
  let page = 0;
  return {
    nodes: [...pages[0]], pageInfo: { hasNextPage: pages.length > 1 },
    async fetchNext() { this.nodes.push(...pages[++page]); this.pageInfo.hasNextPage = page + 1 < pages.length; return this; },
  };
}

test("name resolution exhausts pages and preserves all matching ids", async () => {
  const client = { projectMilestones: async () => connection([[{ id: "m1", name: "Launch" }], [{ id: "m2", name: "Launch" }]]) } as unknown as LinearClient;
  expect(await resolveReadMilestones(client, "launch")).toEqual({ ids: ["m1", "m2"], projectId: undefined });
});

test("negative name hints include closest names from later catalog pages", async () => {
  const client = { projectMilestones: async (args: { filter: { name?: unknown } }) => args.filter.name
    ? connection([[]])
    : connection([[{ id: "m1", name: "Unrelated" }], [{ id: "m2", name: "Launch" }, { id: "m3", name: "Launch QA" }, { id: "m4", name: "Launch UI" }]]) } as unknown as LinearClient;
  let caught: unknown;
  try { await resolveReadMilestones(client, "Launc"); } catch (err) { caught = err; }
  expect(caught).toBeInstanceOf(CliError);
  expect((caught as CliError).code).toBe(4);
  expect((caught as CliError).hint).toContain('closest: "Launch", "Launch QA", "Launch UI"');
  expect((caught as CliError).hint).not.toContain("Unrelated");
});

test("project-scoped resolution uses the canonical project id in both lookups and issue filter", async () => {
  const client = {
    projects: async () => ({ nodes: [{ id: "00000000-0000-4000-8000-000000000010", name: "Example project" }] }),
    projectMilestones: async (args: unknown) => {
      expect(args).toEqual({ first: 100, filter: { project: { id: { eq: "00000000-0000-4000-8000-000000000010" } }, name: { eqIgnoreCase: "Launch" } } });
      return connection([[{ id: "milestone-id", name: "Launch" }]]);
    },
  } as unknown as LinearClient;
  expect(await resolveSearchFilter(client, { project: "example-slug", milestone: "Launch", state: "all" })).toEqual({ and: [
    { project: { id: { eq: "00000000-0000-4000-8000-000000000010" } } }, { projectMilestone: { id: { in: ["milestone-id"] } } },
  ] });
});

test("catalog permission errors remain auth errors rather than claiming absence", async () => {
  const denied = new CliError("auth", "authentication failed");
  const client = { projectMilestones: async () => { throw denied; } } as unknown as LinearClient;
  await expect(resolveReadMilestones(client, "Launch")).rejects.toBe(denied);
});
