import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { createComment } from "../src/core/issues.js";

/**
 * Stub the slice of the SDK that createComment touches:
 * `client.issue(id)` resolves the issue, `client.createComment({issueId,body})`
 * returns a MutationSuccessPayload whose `.comment` is a thenable.
 */
function stubClient(overrides: Record<string, unknown> = {}): LinearClient {
  const issue = {
    id: "uuid-1",
    identifier: "CER-1406",
    url: "https://linear.app/x/issue/CER-1406",
    ...overrides,
  };
  const comment = { id: "comment-uuid-1" };
  const createCommentResult = {
    success: true,
    comment: Promise.resolve(comment),
  };
  return {
    issue: () => Promise.resolve(issue),
    createComment: () => Promise.resolve(createCommentResult),
  } as unknown as LinearClient;
}

describe("createComment", () => {
  test("resolves identifier + commentId + url from the mutation result", async () => {
    const result = await createComment(stubClient(), "CER-1406", "test comment");
    expect(result).toEqual({
      identifier: "CER-1406",
      commentId: "comment-uuid-1",
      url: "https://linear.app/x/issue/CER-1406",
    });
  });

  test("throws when Linear reports the mutation did not succeed", async () => {
    const client = {
      issue: () => Promise.resolve({ id: "uuid-1", identifier: "CER-1", url: "u" }),
      createComment: () => Promise.resolve({ success: false, comment: Promise.resolve(null) }),
    } as unknown as LinearClient;
    await expect(createComment(client, "CER-1", "x")).rejects.toThrow(
      "Linear reported the comment create did not succeed.",
    );
  });

  test("throws when the payload returns no comment despite success", async () => {
    const client = {
      issue: () => Promise.resolve({ id: "uuid-1", identifier: "CER-1", url: "u" }),
      createComment: () => Promise.resolve({ success: true, comment: Promise.resolve(null) }),
    } as unknown as LinearClient;
    await expect(createComment(client, "CER-1", "x")).rejects.toThrow(
      "comment created but the payload returned no comment.",
    );
  });
});
