import { describe, expect, test } from "bun:test";
import type { LinearClient, Project, ProjectMilestone } from "@linear/sdk";
import { roadmap } from "../src/core/roadmap.js";

// ---- stub factory ----

/** A mock Linear issue node as roadmap() consumes it. */
function makeIssue(overrides: {
  id: string;
  identifier: string;
  title: string;
  stateName: string;
  stateType: string;
  assigneeName?: string;
  priorityLabel?: string;
}) {
  return {
    id: overrides.id,
    identifier: overrides.identifier,
    title: overrides.title,
    priorityLabel: overrides.priorityLabel ?? null,
    state: Promise.resolve({
      name: overrides.stateName,
      type: overrides.stateType,
    }),
    assignee: overrides.assigneeName
      ? Promise.resolve({ displayName: overrides.assigneeName })
      : Promise.resolve(null),
  };
}

function makeMilestone(overrides: {
  id: string;
  name: string;
  targetDate?: string;
  issues?: ReturnType<typeof makeIssue>[];
}): ProjectMilestone {
  const issueNodes = overrides.issues ?? [];
  return {
    id: overrides.id,
    name: overrides.name,
    targetDate: overrides.targetDate ?? null,
    issues: () => Promise.resolve({ nodes: issueNodes, pageInfo: { hasNextPage: false } }),
  } as unknown as ProjectMilestone;
}

function stubClient(opts: {
  projectName?: string;
  milestones?: ProjectMilestone[];
}): { client: LinearClient } {
  const project: Project = {
    id: "proj-1",
    name: opts.projectName ?? "linearctl",
    projectMilestones: () =>
      Promise.resolve({
        nodes: opts.milestones ?? [],
        pageInfo: { hasNextPage: false },
      }),
  } as unknown as Project;

  const client = {
    project: () => Promise.resolve(project),
    projects: () => Promise.resolve({ nodes: [project] }),
  } as unknown as LinearClient;

  return { client };
}

// ---- roadmap (CER-1688) ----

describe("roadmap — CER-1688", () => {
  test("returns project name + empty milestones when none exist", async () => {
    const { client } = stubClient({ milestones: [] });

    const result = await roadmap(client, "linearctl");

    expect(result.project).toBe("linearctl");
    expect(result.milestones).toEqual([]);
  });

  test("computes progress: done/total/percent", async () => {
    const { client } = stubClient({
      milestones: [
        makeMilestone({
          id: "ms-1",
          name: "M1",
          issues: [
            makeIssue({ id: "i1", identifier: "CER-1", title: "A", stateName: "Done", stateType: "completed" }),
            makeIssue({ id: "i2", identifier: "CER-2", title: "B", stateName: "Todo", stateType: "unstarted" }),
            makeIssue({ id: "i3", identifier: "CER-3", title: "C", stateName: "In Progress", stateType: "started" }),
            makeIssue({ id: "i4", identifier: "CER-4", title: "D", stateName: "Done", stateType: "completed" }),
          ],
        }),
      ],
    });

    const result = await roadmap(client, "linearctl");

    expect(result.milestones).toHaveLength(1);
    const m = result.milestones[0];
    expect(m.name).toBe("M1");
    expect(m.done).toBe(2);
    expect(m.total).toBe(4);
    expect(m.percent).toBe(50);
  });

  test("zero issues → 0% not NaN", async () => {
    const { client } = stubClient({
      milestones: [makeMilestone({ id: "ms-empty", name: "Empty", issues: [] })],
    });

    const result = await roadmap(client, "linearctl");

    expect(result.milestones[0].done).toBe(0);
    expect(result.milestones[0].total).toBe(0);
    expect(result.milestones[0].percent).toBe(0);
  });

  test("sorts milestones by targetDate ascending", async () => {
    const { client } = stubClient({
      milestones: [
        makeMilestone({ id: "ms-late", name: "Late", targetDate: "2026-12-01T00:00:00.000Z" }),
        makeMilestone({ id: "ms-early", name: "Early", targetDate: "2026-08-01T00:00:00.000Z" }),
        makeMilestone({ id: "ms-mid", name: "Mid", targetDate: "2026-10-01T00:00:00.000Z" }),
      ],
    });

    const result = await roadmap(client, "linearctl");

    expect(result.milestones.map((m) => m.name)).toEqual(["Early", "Mid", "Late"]);
  });

  test("milestones with no target date sort after those with dates", async () => {
    const { client } = stubClient({
      milestones: [
        makeMilestone({ id: "ms-nodate", name: "NoDate" }),
        makeMilestone({ id: "ms-dated", name: "Dated", targetDate: "2026-08-01T00:00:00.000Z" }),
      ],
    });

    const result = await roadmap(client, "linearctl");

    expect(result.milestones.map((m) => m.name)).toEqual(["Dated", "NoDate"]);
  });

  test("formats targetDate as YYYY-MM-DD", async () => {
    const { client } = stubClient({
      milestones: [
        makeMilestone({ id: "ms-1", name: "M1", targetDate: "2026-08-15T12:30:00.000Z" }),
      ],
    });

    const result = await roadmap(client, "linearctl");

    expect(result.milestones[0].targetDate).toBe("2026-08-15");
  });

  test("targetDate is null when absent", async () => {
    const { client } = stubClient({
      milestones: [makeMilestone({ id: "ms-1", name: "M1" })],
    });

    const result = await roadmap(client, "linearctl");

    expect(result.milestones[0].targetDate).toBeNull();
  });

  test("issue summaries carry state, assignee, priority", async () => {
    const { client } = stubClient({
      milestones: [
        makeMilestone({
          id: "ms-1",
          name: "M1",
          issues: [
            makeIssue({
              id: "i1",
              identifier: "CER-1",
              title: "Fix flux",
              stateName: "In Progress",
              stateType: "started",
              assigneeName: "ctodie",
              priorityLabel: "High",
            }),
          ],
        }),
      ],
    });

    const result = await roadmap(client, "linearctl");
    const issue = result.milestones[0].issues[0];

    expect(issue.identifier).toBe("CER-1");
    expect(issue.state).toBe("In Progress");
    expect(issue.stateType).toBe("started");
    expect(issue.assignee).toBe("ctodie");
    expect(issue.priority).toBe("High");
  });

  test("assignee is null when unassigned", async () => {
    const { client } = stubClient({
      milestones: [
        makeMilestone({
          id: "ms-1",
          name: "M1",
          issues: [
            makeIssue({
              id: "i1",
              identifier: "CER-1",
              title: "X",
              stateName: "Todo",
              stateType: "unstarted",
            }),
          ],
        }),
      ],
    });

    const result = await roadmap(client, "linearctl");

    expect(result.milestones[0].issues[0].assignee).toBeNull();
  });
});
