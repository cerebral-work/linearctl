import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { createMilestone, resolveMilestoneId, deleteMilestone } from "../src/core/milestones.js";

/** Type guard: does the record have this key? */
function has<K extends string>(obj: Record<string, unknown>, key: K): obj is Record<K, unknown> & Record<string, unknown> {
  return key in obj;
}

function stubClient(opts: {
  projectId?: string;
  projectName?: string;
  milestoneId?: string;
  milestoneName?: string;
  createSuccess?: boolean;
  deleteSuccess?: boolean;
}): {
  client: LinearClient;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  const project = {
    id: opts.projectId ?? "proj-uuid-1234",
    name: opts.projectName ?? "linearctl",
    projectMilestones: () =>
      Promise.resolve({
        nodes: [
          { id: opts.milestoneId ?? "ms-1", name: opts.milestoneName ?? "M1" },
        ],
      }),
  };

  const client = {
    project: () => Promise.resolve(project),
    projects: () => Promise.resolve({ nodes: [project] }),
    projectMilestones: () =>
      Promise.resolve({
        nodes: [
          { id: opts.milestoneId ?? "ms-1", name: opts.milestoneName ?? "M1" },
        ],
      }),
    projectMilestone: () =>
      Promise.resolve({
        id: opts.milestoneId ?? "ms-1",
        name: opts.milestoneName ?? "M1",
      }),
    createProjectMilestone: (input: Record<string, unknown>) => {
      calls.push(input);
      return Promise.resolve({
        success: opts.createSuccess ?? true,
        projectMilestone: Promise.resolve({
          id: opts.milestoneId ?? "ms-new",
          name: input.name as string,
          targetDate: input.targetDate ?? null,
        }),
      });
    },
    deleteProjectMilestone: (id: string) => {
      calls.push({ delete: id });
      return Promise.resolve({ success: opts.deleteSuccess ?? true });
    },
  } as unknown as LinearClient;

  return { client, calls };
}

describe("createMilestone — CER-1686", () => {
  test("creates a milestone with name + project ref, resolving project name to UUID", async () => {
    const { client, calls } = stubClient({
      projectId: "proj-uuid-1234",
      projectName: "linearctl",
    });

    const result = await createMilestone(client, {
      name: "v1.0",
      projectRef: "linearctl",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(has(call, "projectId")).toBe(true);
    expect(has(call, "name")).toBe(true);
    expect(call.projectId).toBe("proj-uuid-1234");
    expect(call.name).toBe("v1.0");
    expect(result.id).toBe("ms-new");
    expect(result.name).toBe("v1.0");
    expect(result.project).toBe("linearctl");
  });

  test("passes targetDate through when provided", async () => {
    const { client, calls } = stubClient({});

    await createMilestone(client, {
      name: "Sprint 1",
      projectRef: "proj-uuid-1234",
      targetDate: "2026-08-01",
    });

    const call = calls[0];
    expect(has(call, "targetDate")).toBe(true);
    expect(call.targetDate).toBe("2026-08-01");
  });

  test("omits targetDate and description when absent", async () => {
    const { client, calls } = stubClient({});

    await createMilestone(client, {
      name: "Baseline",
      projectRef: "proj-uuid-1234",
    });

    expect("targetDate" in calls[0]).toBe(false);
    expect("description" in calls[0]).toBe(false);
  });

  test("throws when Linear reports failure", async () => {
    const { client } = stubClient({ createSuccess: false });

    await expect(
      createMilestone(client, { name: "X", projectRef: "proj-uuid-1234" }),
    ).rejects.toThrow(/did not succeed/);
  });
});

describe("resolveMilestoneId", () => {
  test("UUID passes through unchanged", async () => {
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const { client } = stubClient({});

    const result = await resolveMilestoneId(client, uuid);
    expect(result).toBe(uuid);
  });

  test("resolves a name to a milestone id (project-scoped)", async () => {
    const { client } = stubClient({
      milestoneId: "ms-42",
      milestoneName: "Sprint 2",
    });

    const result = await resolveMilestoneId(client, "sprint 2", "proj-uuid-1234");
    expect(result).toBe("ms-42");
  });

  test("throws on no match", async () => {
    const { client } = stubClient({ milestoneName: "M1" });

    await expect(
      resolveMilestoneId(client, "nonexistent", "proj-uuid-1234"),
    ).rejects.toThrow(/no milestone matching/);
  });
});

describe("deleteMilestone", () => {
  test("dry-run (apply=false) returns deleted=false, does not call delete", async () => {
    const { client, calls } = stubClient({});

    const result = await deleteMilestone(client, "ms-1", false);

    expect(result.deleted).toBe(false);
    expect(result.name).toBeDefined();
    expect(calls.filter((c) => "delete" in c)).toHaveLength(0);
  });

  test("apply=true deletes and returns deleted=true", async () => {
    const { client, calls } = stubClient({ deleteSuccess: true });

    const result = await deleteMilestone(client, "ms-1", true);

    expect(result.deleted).toBe(true);
    expect(calls.filter((c) => "delete" in c)).toHaveLength(1);
  });

  test("throws when Linear reports delete failure", async () => {
    const { client } = stubClient({ deleteSuccess: false });

    await expect(deleteMilestone(client, "ms-1", true)).rejects.toThrow(/did not succeed/);
  });
});
