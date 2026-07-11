import { describe, expect, test } from "bun:test";
import { LinearClient } from "@linear/sdk";
import { collectIssuesFlat } from "../src/core/issues-query.js";
import { buildSearchFilter } from "../src/core/search.js";
import { fetchRateLimit } from "../src/core/ratelimit.js";

/**
 * Live-API contract tests (CER-1140). READ-ONLY — no mutations, ever.
 * Gated on LINEAR_API_KEY: absent (CI without the secret, contributors
 * without a key) → the whole suite skips. Present → verifies the GraphQL
 * contracts the raw queries depend on, so a Linear schema change surfaces
 * here instead of as a runtime surprise.
 */
const KEY = process.env.LINEAR_API_KEY;
const live = test.skipIf(!KEY);

const client = KEY ? new LinearClient({ apiKey: KEY }) : (null as unknown as LinearClient);

describe("live API contract (skips without LINEAR_API_KEY)", () => {
  live("viewer resolves (auth path)", async () => {
    const viewer = await client.viewer;
    expect(viewer.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  live("flat issue query returns the shape every read command depends on", async () => {
    const issues = await collectIssuesFlat(
      client,
      buildSearchFilter({ state: "all" }),
      undefined,
      5,
    );
    expect(issues.length).toBeGreaterThan(0);
    const i = issues[0];
    expect(typeof i.id).toBe("string");
    expect(i.identifier).toMatch(/^[A-Z]+-\d+$/);
    expect(typeof i.title).toBe("string");
    expect(typeof i.url).toBe("string");
    // state/assignee may be null but when present must carry the fields we select
    if (i.state) expect(typeof i.state.type).toBe("string");
    if (i.assignee) expect(typeof i.assignee.displayName).toBe("string");
  });

  live("rate-limit headers still expose both axes", async () => {
    const info = await fetchRateLimit(KEY as string);
    expect(info.requests.limit).toBeGreaterThan(0);
    expect(info.complexity.limit).toBeGreaterThan(0);
  });

  live("issue history contract (timeline command)", async () => {
    // Any issue works; grab one from the flat query rather than hardcoding.
    const [issue] = await collectIssuesFlat(client, buildSearchFilter({ state: "all" }), undefined, 1);
    const res = await client.client.rawRequest<
      { issue: { history: { nodes: unknown[] } } | null },
      Record<string, unknown>
    >(
      `query($id: String!) { issue(id: $id) { history(first: 1) { nodes { createdAt } } } }`,
      { id: issue.identifier },
    );
    expect(res.data?.issue?.history.nodes).toBeDefined();
  });
});
