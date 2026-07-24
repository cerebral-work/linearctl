import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { roadmap } from "../src/core/roadmap.js";

/** Build a stub milestone with paginated issues for the roadmap function. */
function stubMilestone(opts: {
  id: string;
  name: string;
  targetDate?: string;
  issues?: Array<{
    id: string;
    identifier: string;
    title: string;
    stateName: string;
    stateType: string;
    assignee?: string;
    priorityLabel?: string;
  }>;
}) {
  const issues = (opts.issues ?? []).map((i) => ({
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    priorityLabel: i.priorityLabel ?? null,
    state: Promise.resolve({ name: i.stateName, type: i.stateType }),
    assignee: Promise.resolve(i.assignee ? { displayName: i.assignee } : null),
  }));

  return {
    id: opts.id,
    name: opts.name,
    targetDate: opts.targetDate ?? null,
    issues: () =>
      Promise.resolve({
        nodes: issues,
        pageInfo: { hasNextPage: false, endCursor: null },
        fetchNext: () => Promise.resolve({ nodes: [], pageInfo: { hasNextPage: false } }),
      }),
  };
}

function stubClient(opts: {
  projectId?: string;
  projectName?: string;
  milestones?: ReturnType<typeof stubMilestone>[];
}) {
  const project = {
    id: opts.projectId ?? "proj-uuid-1234",
    name: opts.projectName ?? "linearctl",
    projectMilestones: () =>
      Promise.resolve({
        nodes: opts.milestones ?? [],
        pageInfo: { hasNextPage: false, endCursor: null },
        fetchNext: () =>
          Promise.resolve({ nodes: [], pageInfo: { hasNextPage: false } }),
      }),
  };

  const client = {
    project: () => Promise.resolve(project),
    projects: () => Promise.resolve({ nodes: [project] }),
  } as unknown as LinearClient;

  return { client };
}

describe("roadmap — CER-1688", () => {
  test("returns project name and empty milestones array when none exist", async () => {
    const { client } = stubClient({ milestones: [] });

    const result = await roadmap(client, "linearctl");

    expect(result.project).toBe("linearctl");
    expect(result.milestones).toHaveLength(0);
  });

  test("resolves project by name and fetches milestones", async () => {
    const { client } = stubClient({
      projectName: "My Project",
      milestones: [
        stubMilestone({ id: "ms-1", name: "M1", targetDate: "2026-08-01" }),
      ],
    });

    const result = await roadmap(client, "My Project");

    expect(result.project).toBe("My Project");
    expect(result.milestones).toHaveLength(1);
    expect(result.milestones[0].name).toBe("M1");
  });

  test("sorts milestones by target date ascending", async () => {
    const { client } = stubClient({
      milestones: [
        stubMilestone({ id: "ms-3", name: "Late", targetDate: "2026-12-01" }),
        stubMilestone({ id: "ms-1", name: "Early", targetDate: "2026-08-01" }),
        stubMilestone({ id: "ms-2", name: "Mid", targetDate: "2026-10-01" }),
      ],
    });

    const result = await roadmap(client, "proj-uuid-1234");

    expect(result.milestones.map((m) => m.name)).toEqual([
      "Early",
      "Mid",
      "Late",
    ]);
  });

  test("milestones without target date sort after dated ones", async () => {
    const { client } = stubClient({
      milestones: [
        stubMilestone({ id: "ms-2", name: "Undated" }),
        stubMilestone({ id: "ms-1", name: "Dated", targetDate: "2026-08-01" }),
      ],
    });

    const result = await roadmap(client, "proj-uuid-1234");

    expect(result.milestones.map((m) => m.name)).toEqual(["Dated", "Undated"]);
  });

  test("computes progress: done count, total, and percent", async () => {
    const { client } = stubClient({
      milestones: [
        stubMilestone({
          id: "ms-1",
          name: "Sprint 1",
          targetDate: "2026-08-01",
          issues: [
            { id: "i-1", identifier: "CER-1", title: "A", stateName: "Done", stateType: "completed" },
            { id: "i-2", identifier: "CER-2", title: "B", stateName: "Done", stateType: "completed" },
            { id: "i-3", identifier: "CER-3", title: "C", stateName: "In Progress", stateType: "started" },
          ],
        }),
      ],
    });

    const result = await roadmap(client, "proj-uuid-1234");

    expect(result.milestones).toHaveLength(1);
    const m = result.milestones[0];
    expect(m.done).toBe(2);
    expect(m.total).toBe(3);
    expect(m.percent).toBe(67);
  });

  test("zero issues → 0% progress, not NaN", async () => {
    const { client } = stubClient({
      milestones: [
        stubMilestone({ id: "ms-1", name: "Empty", issues: [] }),
      ],
    });

    const result = await roadmap(client, "proj-uuid-1234");

    expect(result.milestones[0].done).toBe(0);
    expect(result.milestones[0].total).toBe(0);
    expect(result.milestones[0].percent).toBe(0);
  });

  test("issue list includes identifier, state, assignee, priority", async () => {
    const { client } = stubClient({
      milestones: [
        stubMilestone({
          id: "ms-1",
          name: "M1",
          issues: [
            {
              id: "i-1",
              identifier: "CER-100",
              title: "Fix bug",
              stateName: "In Progress",
              stateType: "started",
              assignee: "ctodie",
              priorityLabel: "High",
            },
          ],
        }),
      ],
    });

    const result = await roadmap(client, "proj-uuid-1234");

    const issue = result.milestones[0].issues[0];
    expect(issue.identifier).toBe("CER-100");
    expect(issue.state).toBe("In Progress");
    expect(issue.assignee).toBe("ctodie");
    expect(issue.priority).toBe("High");
  });

  test("null assignee when unassigned", async () => {
    const { client } = stubClient({
      milestones: [
        stubMilestone({
          id: "ms-1",
          name: "M1",
          issues: [
            {
              id: "i-1",
              identifier: "CER-1",
              title: "Unassigned work",
              stateName: "Todo",
              stateType: "unstarted",
            },
          ],
        }),
      ],
    });

    const result = await roadmap(client, "proj-uuid-1234");

    expect(result.milestones[0].issues[0].assignee).toBeNull();
  });
});
