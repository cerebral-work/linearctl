import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { getIssue, renderIssueDetail, type IssueDetail } from "../src/core/issues.js";

/** Stub the slice of the SDK's lazy-resolving Issue that getIssue touches. */
function stubClient(overrides: Record<string, unknown> = {}): LinearClient {
  const issue = {
    id: "uuid-1",
    identifier: "CER-1406",
    title: "Chunk-embedder swap",
    url: "https://linear.app/x/issue/CER-1406",
    description: "## What\nRoute chunk vectors through EmbedderClient.",
    priority: 2,
    priorityLabel: "High",
    createdAt: new Date("2026-06-20T10:00:00Z"),
    updatedAt: new Date("2026-07-01T09:00:00Z"),
    state: Promise.resolve({ name: "In Progress", type: "started" }),
    assignee: Promise.resolve({ displayName: "aria" }),
    project: Promise.resolve({ name: "reverie-cloud platform prereqs" }),
    parent: Promise.resolve(undefined),
    labels: () => Promise.resolve({ nodes: [{ name: "store" }, { name: "M3" }] }),
    ...overrides,
  };
  return { issue: () => Promise.resolve(issue) } as unknown as LinearClient;
}

describe("getIssue", () => {
  test("assembles full detail from the lazy SDK issue", async () => {
    const detail = await getIssue(stubClient(), "CER-1406");
    expect(detail).toEqual({
      id: "uuid-1",
      identifier: "CER-1406",
      title: "Chunk-embedder swap",
      url: "https://linear.app/x/issue/CER-1406",
      state: "In Progress",
      stateType: "started",
      assignee: "aria",
      priority: "High",
      project: "reverie-cloud platform prereqs",
      labels: ["store", "M3"],
      parent: null,
      description: "## What\nRoute chunk vectors through EmbedderClient.",
      createdAt: "2026-06-20T10:00:00.000Z",
      updatedAt: "2026-07-01T09:00:00.000Z",
    });
  });

  test("tolerates missing optional relations", async () => {
    const detail = await getIssue(
      stubClient({
        description: undefined,
        assignee: Promise.resolve(undefined),
        project: Promise.resolve(undefined),
        labels: () => Promise.resolve({ nodes: [] }),
      }),
      "CER-1406",
    );
    expect(detail.assignee).toBeNull();
    expect(detail.project).toBeNull();
    expect(detail.labels).toEqual([]);
    expect(detail.description).toBeNull();
  });
});

describe("renderIssueDetail", () => {
  const detail: IssueDetail = {
    id: "uuid-1",
    identifier: "CER-9",
    title: "T",
    url: "https://l/CER-9",
    state: "Todo",
    stateType: "unstarted",
    assignee: null,
    priority: "High",
    project: null,
    labels: ["bug"],
    parent: "CER-1",
    description: "body text",
    createdAt: "2026-06-20T10:00:00.000Z",
    updatedAt: "2026-07-01T09:00:00.000Z",
  };

  test("renders header, metadata lines, and the description body", () => {
    const out = renderIssueDetail(detail);
    expect(out).toContain("CER-9 [Todo]: T");
    expect(out).toContain("labels: bug");
    expect(out).toContain("parent: CER-1");
    expect(out).toContain("body text");
  });

  test("says so when there is no description", () => {
    const out = renderIssueDetail({ ...detail, description: null });
    expect(out).toContain("(no description)");
  });
});
