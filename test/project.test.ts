import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { updateProject, resolveProject } from "../src/core/projects.js";

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

function stubResolveClient(opts: {
  projectId?: string;
  projectName?: string;
  projectSlugId?: string;
}): { client: LinearClient; projectCalls: string[]; projectsCalls: { count: number } } {
  const project = {
    id: opts.projectId ?? "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
    name: opts.projectName ?? "linearctl",
    url: "https://linear.app/x/P/linearctl",
    slugId: opts.projectSlugId ?? "abc123def",
  };
  const counter = { count: 0 };
  const projectCalls: string[] = [];

  const client = {
    project: (id: string) => {
      projectCalls.push(id);
      return Promise.resolve(project);
    },
    projects: () => {
      counter.count++;
      return Promise.resolve({ nodes: [project], pageInfo: { hasNextPage: false, endCursor: null } });
    },
  } as unknown as LinearClient;

  return { client, projectCalls, projectsCalls: counter };
}
describe("resolveProject — CER-1734", () => {
  test("passes a UUID directly to client.project() without filtering", async () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const { client, projectCalls, projectsCalls } = stubResolveClient({ projectId: uuid });

    const result = await resolveProject(client, uuid);

    expect(projectCalls).toEqual([uuid]);
    expect(projectsCalls.count).toBe(0);
    expect(result.id).toBe(uuid);
  });

  test("resolves a project name (case-insensitive) via projects() filter", async () => {
    const { client, projectCalls, projectsCalls } = stubResolveClient({ projectName: "linearctl" });

    const result = await resolveProject(client, "LinearCtl");

    expect(projectCalls).toEqual([]);
    expect(projectsCalls.count).toBe(1);
    expect(result.name).toBe("linearctl");
  });

  test("resolves a slug id via projects() filter", async () => {
    const { client, projectsCalls } = stubResolveClient({ projectSlugId: "abc123def" });

    const result = await resolveProject(client, "abc123def");

    expect(projectsCalls.count).toBe(1);
    expect(result.slugId).toBe("abc123def");
  });

  test("throws when no project matches the ref", async () => {
    const client = {
      projects: () => Promise.resolve({ nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }),
    } as unknown as LinearClient;

    await expect(
      resolveProject(client, "nonexistent-project"),
    ).rejects.toThrow(/no project matching/);
  });

  test("UUID regex does not match short strings or non-UUID refs", async () => {
    const { client, projectsCalls } = stubResolveClient({});

    // These are NOT UUIDs — should go through the projects() filter path.
    await resolveProject(client, "linearctl");
    await resolveProject(client, "abc123");
    await resolveProject(client, "proj-uuid-1234");

    expect(projectsCalls.count).toBe(3);
  });
});
