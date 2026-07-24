import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { dupcheck, DUPCHECK_DEFAULT_THRESHOLD } from "../src/core/dupcheck.js";
import type { FlatIssueNode } from "../src/core/issues-query.js";

function flatIssue(
  id: string,
  identifier: string,
  title: string,
): FlatIssueNode {
  return {
    id,
    identifier,
    title,
    url: `https://linear.app/cerebral-work/issue/${identifier}`,
    priority: 3,
    estimate: null,
    updatedAt: "2026-07-24T10:00:00.000Z",
    state: { name: "In Progress", type: "started" },
    assignee: null,
  };
}

/**
 * dupcheck() calls collectIssuesFlat(client, filter) which uses
 * client.client.rawRequest internally. We stub that to return a fixed
 * set of issues, then verify dupcheck scores + filters them.
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

describe("dupcheck", () => {
  test("returns matches above threshold, best-first", async () => {
    const client = stubClient([
      flatIssue("1", "CER-1", "Fix the billing error in checkout"),
      flatIssue("2", "CER-2", "Fix the billing bug in checkout flow"),
      flatIssue("3", "CER-3", "Deploy new CDN configuration"),
      flatIssue("4", "CER-4", "Random unrelated feature A"),
    ]);

    const result = await dupcheck(client, "Fix billing error in checkout");

    expect(result.query).toBe("Fix billing error in checkout");
    expect(result.threshold).toBe(DUPCHECK_DEFAULT_THRESHOLD);
    // CER-1 should score highest (near-identical); CER-2 slightly lower (reworded)
    expect(result.matches.length).toBeGreaterThanOrEqual(1);
    expect(result.matches[0].identifier).toBe("CER-1");
    // scores are best-first descending
    for (let i = 1; i < result.matches.length; i++) {
      expect(result.matches[i].score).toBeLessThanOrEqual(result.matches[i - 1].score);
    }
  });

  test("limits results to --limit", async () => {
    const client = stubClient([
      flatIssue("1", "CER-1", "Fix billing error"),
      flatIssue("2", "CER-2", "Fix billing bug"),
      flatIssue("3", "CER-3", "Fix billing issue"),
      flatIssue("4", "CER-4", "Fix billing problem"),
      flatIssue("5", "CER-5", "Fix billing crash"),
    ]);

    const result = await dupcheck(client, "Fix billing error", { limit: 2 });

    expect(result.matches.length).toBeLessThanOrEqual(2);
  });

  test("lower threshold surfaces more matches", async () => {
    const client = stubClient([
      flatIssue("1", "CER-1", "Fix billing error in checkout"),
      flatIssue("2", "CER-2", "Billing checkout problem investigation"),
    ]);

    // High threshold — only near-exact matches
    const strict = await dupcheck(client, "Fix billing error in checkout", { threshold: 0.9 });
    // Lower threshold — reworded matches surface
    const loose = await dupcheck(client, "Fix billing error in checkout", { threshold: 0.3 });

    expect(loose.matches.length).toBeGreaterThanOrEqual(strict.matches.length);
  });

  test("returns empty matches when nothing is similar", async () => {
    const client = stubClient([
      flatIssue("1", "CER-1", "Deploy CDN configuration"),
      flatIssue("2", "CER-2", "Configure monitoring alerts"),
    ]);

    const result = await dupcheck(client, "Fix billing error in checkout");

    expect(result.matches).toEqual([]);
  });

  test("rounds scores to 2 decimal places", async () => {
    const client = stubClient([
      flatIssue("1", "CER-1", "Fix billing error in checkout"),
    ]);

    const result = await dupcheck(client, "Fix billing error in checkout", { threshold: 0.01 });

    for (const m of result.matches) {
      // score * 100 should have no fractional part after rounding
      expect(m.score * 100).toBe(Math.round(m.score * 100));
    }
  });

  test("default threshold is 0.85", () => {
    expect(DUPCHECK_DEFAULT_THRESHOLD).toBe(0.85);
  });

  test("empty issue set returns empty matches", async () => {
    const client = stubClient([]);

    const result = await dupcheck(client, "Anything");

    expect(result.matches).toEqual([]);
  });
});
