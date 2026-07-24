import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { commentsByAuthor } from "../src/core/comments.js";

function stubClient(opts: {
  viewerId?: string;
  users?: { id: string; displayName: string }[];
  nodes?: Array<{
    createdAt: string;
    body: string;
    url: string;
    user: { displayName: string } | null;
    issue: { identifier: string; title: string } | null;
  }>;
}): LinearClient {
  return {
    viewer: Promise.resolve({ id: opts.viewerId ?? "viewer-1" }),
    users: () =>
      Promise.resolve({
        nodes: opts.users ?? [{ id: "user-1", displayName: "alice" }],
      }),
    client: {
      rawRequest: async () => ({
        data: {
          comments: {
            nodes: opts.nodes ?? [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      }),
    },
  } as unknown as LinearClient;
}

const SINCE = new Date("2026-07-17T00:00:00Z");

describe("commentsByAuthor", () => {
  test("resolves author 'me' to viewer id", async () => {
    const client = stubClient({ viewerId: "viewer-1", nodes: [] });

    const result = await commentsByAuthor(client, {
      author: "me",
      since: SINCE,
    });

    expect(result).toEqual([]);
  });

  test("maps raw comment nodes to AuthorComment shape", async () => {
    const client = stubClient({
      nodes: [
        {
          createdAt: "2026-07-20T10:00:00Z",
          body: "Looks good",
          url: "https://linear.app/x#c1",
          user: { displayName: "alice" },
          issue: { identifier: "CER-100", title: "Fix bug" },
        },
      ],
    });

    const result = await commentsByAuthor(client, {
      author: "alice",
      since: SINCE,
    });

    expect(result).toHaveLength(1);
    expect(result[0].at).toBe("2026-07-20T10:00:00Z");
    expect(result[0].author).toBe("alice");
    expect(result[0].issue).toBe("CER-100");
    expect(result[0].issueTitle).toBe("Fix bug");
    expect(result[0].body).toBe("Looks good");
    expect(result[0].url).toBe("https://linear.app/x#c1");
  });

  test("sorts comments by createdAt descending (newest first)", async () => {
    const client = stubClient({
      nodes: [
        { createdAt: "2026-07-18T00:00:00Z", body: "old", url: "u1", user: null, issue: null },
        { createdAt: "2026-07-22T00:00:00Z", body: "new", url: "u2", user: null, issue: null },
        { createdAt: "2026-07-20T00:00:00Z", body: "mid", url: "u3", user: null, issue: null },
      ],
    });

    const result = await commentsByAuthor(client, {
      author: "alice",
      since: SINCE,
    });

    expect(result.map((c) => c.body)).toEqual(["new", "mid", "old"]);
  });

  test("null user means author is em dash", async () => {
    const client = stubClient({
      nodes: [
        { createdAt: "2026-07-20T00:00:00Z", body: "x", url: "u", user: null, issue: null },
      ],
    });

    const result = await commentsByAuthor(client, {
      author: "alice",
      since: SINCE,
    });

    expect(result[0].author).toBe("—");
  });

  test("null issue means issue is em dash, issueTitle is empty string", async () => {
    const client = stubClient({
      nodes: [
        { createdAt: "2026-07-20T00:00:00Z", body: "x", url: "u", user: { displayName: "a" }, issue: null },
      ],
    });

    const result = await commentsByAuthor(client, {
      author: "alice",
      since: SINCE,
    });

    expect(result[0].issue).toBe("—");
    expect(result[0].issueTitle).toBe("");
  });

  test("limit caps the result count", async () => {
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      createdAt: new Date(2026, 6, 20 - i).toISOString(),
      body: `c${i}`,
      url: `u${i}`,
      user: { displayName: "alice" },
      issue: { identifier: `CER-${i}`, title: `T${i}` },
    }));

    const client = stubClient({ nodes });

    const result = await commentsByAuthor(client, {
      author: "alice",
      since: SINCE,
      limit: 3,
    });

    expect(result).toHaveLength(3);
  });
});
