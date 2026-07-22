import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { createIssue } from "../src/core/issues.js";

/**
 * CER-1604 regression: `createIssue` must resolve a project *name* to a UUID
 * before calling the SDK's `createIssue`. The Linear API rejects non-UUID
 * `projectId` with "Argument Validation Error". Previously the `--stdin` batch
 * path (and the single-issue path) passed the raw `project` field through,
 * so the dry-run said "would create" but `--apply` failed.
 */

function stubClient(opts: {
  projectName?: string;
  projectId?: string;
}): { client: LinearClient; calls: { projectId?: string }[] } {
  const calls: { projectId?: string }[] = [];
  const team = { id: "team-1", key: "CER" };
  const project = {
    id: opts.projectId ?? "proj-uuid-1234",
    name: opts.projectName ?? "linearctl",
  };

  const client = {
    teams: () => Promise.resolve({ nodes: [team] }),
    projects: () => Promise.resolve({ nodes: [project] }),
    project: () => Promise.resolve(project),
    createIssue: (input: { projectId?: string; title?: string }) => {
      calls.push({ projectId: input.projectId });
      return Promise.resolve({
        success: true,
        issue: Promise.resolve({
          id: "issue-1",
          identifier: "CER-9999",
          title: input.title ?? "test",
          url: "https://linear.app/x/CER-9999",
        }),
      });
    },
  } as unknown as LinearClient;

  return { client, calls };
}

describe("createIssue — project name resolution (CER-1604)", () => {
  test("resolves a project name to a UUID", async () => {
    const { client, calls } = stubClient({
      projectName: "linearctl",
      projectId: "proj-uuid-1234",
    });

    await createIssue(client, {
      teamKey: "CER",
      title: "smoketest",
      projectId: "linearctl", // a name, not a UUID
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].projectId).toBe("proj-uuid-1234");
  });

  test("passes a UUID projectId through unchanged", async () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const { client, calls } = stubClient({ projectId: uuid });

    await createIssue(client, {
      teamKey: "CER",
      title: "smoketest",
      projectId: uuid,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].projectId).toBe(uuid);
  });

  test("omits projectId when project is absent", async () => {
    const { client, calls } = stubClient({});

    await createIssue(client, {
      teamKey: "CER",
      title: "smoketest",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].projectId).toBeUndefined();
  });
});
