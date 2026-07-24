import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { updateProject } from "../src/core/projects.js";

/** Type guard: does the record have this key? */
function has<K extends string>(obj: Record<string, unknown>, key: K): obj is Record<K, unknown> & Record<string, unknown> {
  return key in obj;
}

function stubClient(opts: {
  projectId?: string;
  projectName?: string;
  stateType?: string;
  stateId?: string;
  updateSuccess?: boolean;
}): {
  client: LinearClient;
  calls: Record<string, unknown>[];
} {
  const calls: Record<string, unknown>[] = [];
  const project = {
    id: opts.projectId ?? "proj-uuid-1234",
    name: opts.projectName ?? "linearctl",
    slugId: "slug-123",
    url: "https://linear.app/x/proj/linearctl",
    status: Promise.resolve(
      opts.stateType ? { type: opts.stateType } : null,
    ),
  };

  const client = {
    project: () => Promise.resolve(project),
    projects: () => Promise.resolve({ nodes: [project] }),
    projectStatuses: () =>
      Promise.resolve({
        nodes: [
          { id: opts.stateId ?? "status-1", type: opts.stateType ?? "started" },
          { id: "status-2", type: "backlog" },
          { id: "status-3", type: "completed" },
        ],
      }),
    updateProject: (id: string, input: Record<string, unknown>) => {
      calls.push({ id, ...input });
      return Promise.resolve({
        success: opts.updateSuccess ?? true,
        project: Promise.resolve(project),
      });
    },
  } as unknown as LinearClient;

  return { client, calls };
}

describe("updateProject — CER-1687", () => {
  test("updates project name, resolving project ref by name", async () => {
    const { client, calls } = stubClient({ projectName: "linearctl" });

    const result = await updateProject(client, "linearctl", {
      name: "linearctl-v2",
    });

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(has(call, "name")).toBe(true);
    expect(has(call, "id")).toBe(true);
    expect(call.id).toBe("proj-uuid-1234");
    expect(call.name).toBe("linearctl-v2");
    expect(result.name).toBe("linearctl");
    expect(result.id).toBe("proj-uuid-1234");
  });

  test("updates description", async () => {
    const { client, calls } = stubClient({});

    await updateProject(client, "proj-uuid-1234", {
      description: "New description text",
    });

    const call = calls[0];
    expect(has(call, "description")).toBe(true);
    expect(call.description).toBe("New description text");
  });

  test("resolves state by type (case-insensitive) and sends statusId", async () => {
    const { client, calls } = stubClient({
      stateType: "started",
      stateId: "status-1",
    });

    await updateProject(client, "proj-uuid-1234", {
      state: "STARTED",
    });

    const call = calls[0];
    expect(has(call, "statusId")).toBe(true);
    expect(call.statusId).toBe("status-1");
  });

  test("omits statusId when no state provided", async () => {
    const { client, calls } = stubClient({});

    await updateProject(client, "proj-uuid-1234", {
      name: "renamed",
    });

    expect("statusId" in calls[0]).toBe(false);
  });

  test("throws on unknown state type with valid options listed", async () => {
    const { client } = stubClient({ stateType: "started" });

    await expect(
      updateProject(client, "proj-uuid-1234", { state: "bogus" }),
    ).rejects.toThrow(/no project state matching.*Valid:/);
  });

  test("throws when no fields provided", async () => {
    const { client } = stubClient({});

    await expect(
      updateProject(client, "proj-uuid-1234", {}),
    ).rejects.toThrow(/at least one of/);
  });

  test("throws when Linear reports failure", async () => {
    const { client } = stubClient({ updateSuccess: false });

    await expect(
      updateProject(client, "proj-uuid-1234", { name: "x" }),
    ).rejects.toThrow(/did not succeed/);
  });
});
