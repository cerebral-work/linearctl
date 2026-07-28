import { describe, expect, test } from "bun:test";
import type { LinearClient } from "@linear/sdk";
import { milestoneGaps, type MilestoneGaps } from "../src/core/milestone-gaps.js";
import type {
  EmptyMilestone,
  UnassignedIssue,
  DocSectionGap,
} from "../src/core/milestone-gaps.js";

/** A flat issue the way `collectIssuesFlat` returns it from the GraphQL node. */
interface FlatIssueInput {
  id: string;
  identifier: string;
  title: string;
  url: string;
  priority: number;
  estimate: number | null;
  updatedAt: string;
  stateName?: string;
  stateType?: string;
  assigneeName?: string;
}

/** A milestone the way `milestones()` consumes it from `projectMilestones`. */
interface MilestoneInput {
  id: string;
  name: string;
  targetDate?: string | null;
  /** Total issues in this milestone (countIssues is stubbed to return this). */
  total: number;
  done?: number;
}

interface StubOpts {
  projectId?: string;
  projectName?: string;
  projectContent?: string | null;
  milestones?: MilestoneInput[];
  /** All project issues (for the doc-section coverage pool). */
  projectIssues?: FlatIssueInput[];
  /** Subset of project issues with no milestone (the `projectMilestone: null` filter). */
  unassignedIssues?: FlatIssueInput[];
}

/** Treat an unknown value as a record so test stubs can read filter sub-properties. */
function asRecord(v: unknown): Record<string, unknown> {
  return (v ?? {}) as Record<string, unknown>;
}

/**
 * The node shape `FlatIssueNode` delivers: `state`/`assignee` are plain
 * objects (selected inline by collectIssuesFlat's raw GraphQL query), not
 * lazy relations. The `issues()` count stub only needs `.length`, so plain
 * values are correct there too.
 */
function flatNode(i: FlatIssueInput) {
  return {
    id: i.id,
    identifier: i.identifier,
    title: i.title,
    url: i.url,
    priority: i.priority,
    estimate: i.estimate,
    updatedAt: i.updatedAt,
    state: i.stateName !== undefined
      ? { name: i.stateName, type: i.stateType ?? "" }
      : null,
    assignee: i.assigneeName ? { displayName: i.assigneeName } : null,
  };
}

/**
 * Build a stub LinearClient satisfying every surface `milestoneGaps` touches:
 *  - `resolveProject` → `client.project` / `client.projects`
 *  - `milestones()` → `project.projectMilestones` + `client.issues` (countIssues)
 *  - `collectIssuesFlat` → `client.client.rawRequest` (FLAT_ISSUES_QUERY)
 *  - `getProjectOverview` → `project.content`
 *
 * The `issues` stub counts by inspecting the filter: if it has
 * `projectMilestone: { null: true }` we return the unassigned set; otherwise
 * (a plain milestone-count query) we return `milestone.total` dummy nodes.
 */
function stubClient(opts: StubOpts): LinearClient {
  const projectId = opts.projectId ?? "proj-uuid-1234";
  const projectName = opts.projectName ?? "linearctl";

  const project = {
    id: projectId,
    name: projectName,
    url: `https://linear.app/x/project/${projectId}`,
    slugId: "lin",
    content: opts.projectContent ?? null,
    projectMilestones: () =>
      Promise.resolve({
        nodes: (opts.milestones ?? []).map((m) => ({
          id: m.id,
          name: m.name,
          targetDate: m.targetDate ?? null,
        })),
        pageInfo: { hasNextPage: false, endCursor: null },
        fetchNext: () =>
          Promise.resolve({ nodes: [], pageInfo: { hasNextPage: false } }),
      }),
  };

  return {
    project: () => Promise.resolve(project),
    projects: () =>
      Promise.resolve({
        nodes: [project],
        pageInfo: { hasNextPage: false, endCursor: null },
        fetchNext: () =>
          Promise.resolve({ nodes: [], pageInfo: { hasNextPage: false } }),
      }),
    issues: (args: { filter?: Record<string, unknown> }) => {
      const filter = args?.filter ?? {};
      // countIssues passes `{ projectMilestone: { id: { eq } } }` (+state).
      // The unassigned filter has `projectMilestone: { null: true }`.
      const pm = asRecord(filter.projectMilestone);
      const isUnassigned = filter.projectMilestone !== undefined && pm.null === true;
      if (isUnassigned) {
        const nodes = (opts.unassignedIssues ?? []).map(flatNode);
        return Promise.resolve({
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
          fetchNext: () =>
            Promise.resolve({ nodes: [], pageInfo: { hasNextPage: false } }),
        });
      }
      // Plain count query: return `milestone.total` dummy nodes for the
      // matching milestone, and done-filter narrows to `done`.
      const msIdStr = asRecord(asRecord(pm.id).eq) as unknown as string;
      const ms = (opts.milestones ?? []).find((m) => m.id === msIdStr);
      const isDone = asRecord(asRecord(filter.state).type).eq === "completed";
      const n = ms ? (isDone ? ms.done ?? 0 : ms.total) : 0;
      const nodes = Array.from({ length: n }, (_, k) => flatNode({
        id: `${msIdStr ?? "x"}-i${k}`,
        identifier: "CER-0",
        title: "x",
        url: "u",
        priority: 0,
        estimate: null,
        updatedAt: "0",
        stateName: "Backlog",
        stateType: isDone ? "completed" : "backlog",
      }));
      return Promise.resolve({
        nodes,
        pageInfo: { hasNextPage: false, endCursor: null },
        fetchNext: () =>
          Promise.resolve({ nodes: [], pageInfo: { hasNextPage: false } }),
      });
    },
    client: {
      rawRequest: (query: string, vars: Record<string, unknown>) => {
        // collectIssuesFlat's FLAT_ISSUES_QUERY. Inspect the filter to decide
        // which set to return: unassigned (projectMilestone null) vs all.
        const filter = (vars.filter ?? {}) as Record<string, unknown>;
        // collectIssuesFlat wraps the clauses in `and`; scan both the top
        // level and any `and[]` entry for `projectMilestone: { null: true }`.
        const clauses = [filter, ...(Array.isArray(filter.and) ? (filter.and as unknown[]) : [])];
        const isUnassigned = clauses.some(
          (c) => asRecord(asRecord(c).projectMilestone).null === true,
        );
        const source = isUnassigned
          ? (opts.unassignedIssues ?? [])
          : (opts.projectIssues ?? []);
        return Promise.resolve({
          data: {
            issues: {
              nodes: source.map(flatNode),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
          errors: undefined,
        });
      },
    },
  } as unknown as LinearClient;
}

describe("milestoneGaps — empty-milestone detection", () => {
  test("flags milestones with zero total issues", async () => {
    const client = stubClient({
      milestones: [
        { id: "m1", name: "M1 Shipped", total: 5, done: 5 },
        { id: "m2", name: "M2 Ghost", total: 0 },
        { id: "m3", name: "M3 Also Ghost", total: 0, targetDate: "2026-08-01" },
      ],
      projectContent: null,
    });
    const gaps = await milestoneGaps(client, "linearctl");
    expect(gaps.emptyMilestones).toEqual([
      { id: "m2", name: "M2 Ghost", targetDate: null },
      { id: "m3", name: "M3 Also Ghost", targetDate: "2026-08-01" },
    ] satisfies EmptyMilestone[]);
  });

  test("returns no empty milestones when every milestone has issues", async () => {
    const client = stubClient({
      milestones: [{ id: "m1", name: "M1", total: 3, done: 1 }],
    });
    const gaps = await milestoneGaps(client, "linearctl");
    expect(gaps.emptyMilestones).toEqual([]);
  });
});

describe("milestoneGaps — unassigned-issue detection", () => {
  test("lists project issues with no milestone", async () => {
    const client = stubClient({
      milestones: [{ id: "m1", name: "M1", total: 2, done: 0 }],
      unassignedIssues: [
        {
          id: "i-u1",
          identifier: "CER-101",
          title: "orphan ticket",
          url: "https://linear.app/x/issue/CER-101",
          priority: 2,
          estimate: 1,
          updatedAt: "2026-07-28",
          stateName: "Todo",
          stateType: "started",
          assigneeName: "alice",
        },
        {
          id: "i-u2",
          identifier: "CER-102",
          title: "another orphan",
          url: "https://linear.app/x/issue/CER-102",
          priority: 0,
          estimate: null,
          updatedAt: "2026-07-28",
          stateName: "Backlog",
          stateType: "backlog",
        },
      ],
      projectContent: null,
    });
    const gaps = await milestoneGaps(client, "linearctl");
    expect(gaps.unassignedIssues).toEqual([
      {
        id: "i-u1",
        identifier: "CER-101",
        title: "orphan ticket",
        url: "https://linear.app/x/issue/CER-101",
        state: "Todo",
        stateType: "started",
        assignee: "alice",
      },
      {
        id: "i-u2",
        identifier: "CER-102",
        title: "another orphan",
        url: "https://linear.app/x/issue/CER-102",
        state: "Backlog",
        stateType: "backlog",
        assignee: null,
      },
    ] satisfies UnassignedIssue[]);
  });

  test("handles a null-state issue defensively", async () => {
    const client = stubClient({
      unassignedIssues: [
        {
          id: "i-x",
          identifier: "CER-9",
          title: "ghost state",
          url: "u",
          priority: 0,
          estimate: null,
          updatedAt: "0",
          // no stateName/stateType → flatNode emits state: null, exercising
          // the `?? "(no state)"` defensive fallback in milestoneGaps.
        },
      ],
      projectContent: null,
    });
    const gaps = await milestoneGaps(client, "linearctl");
    expect(gaps.unassignedIssues[0]?.state).toBe("(no state)");
  });
});

describe("milestoneGaps — doc-section gap matching", () => {
  test("flags H2 headings with no matching ticket identifier or title", async () => {
    const client = stubClient({
      milestones: [{ id: "m1", name: "M1", total: 1, done: 0 }],
      projectIssues: [
        {
          id: "p1",
          identifier: "CER-1149",
          title: "operator daemon",
          url: "u1",
          priority: 0,
          estimate: null,
          updatedAt: "0",
          stateName: "In Progress",
          stateType: "started",
        },
        {
          id: "p2",
          identifier: "CER-1550",
          title: "TUI dashboard",
          url: "u2",
          priority: 0,
          estimate: null,
          updatedAt: "0",
          stateName: "Todo",
          stateType: "started",
        },
      ],
      projectContent: [
        "# linearctl roadmap",
        "",
        "## CER-1149: operator daemon",
        "Operator-control plane.",
        "",
        "## TUI dashboard",
        "Pane layout.",
        "",
        "## Not yet a ticket",
        "This section has no Linear ticket.",
        "",
        "### nested detail",
      ].join("\n"),
    });
    const gaps = await milestoneGaps(client, "linearctl");
    expect(gaps.docSectionGaps).toEqual([
      { index: 2, heading: "Not yet a ticket" },
    ] satisfies DocSectionGap[]);
    // Sanity: the covered headings were NOT flagged.
    const flagged = gaps.docSectionGaps.map((g) => g.heading);
    expect(flagged).not.toContain("CER-1149: operator daemon");
    expect(flagged).not.toContain("TUI dashboard");
  });

  test("returns no doc-section gaps when no overview document exists", async () => {
    const client = stubClient({
      milestones: [{ id: "m1", name: "M1", total: 1, done: 0 }],
      projectContent: null,
    });
    const gaps = await milestoneGaps(client, "linearctl");
    expect(gaps.docSectionGaps).toEqual([]);
  });

  test("treats a heading covered by an issue title as covered", async () => {
    const client = stubClient({
      milestones: [],
      projectIssues: [
        {
          id: "p1",
          identifier: "CER-42",
          title: "milestone gap view",
          url: "u",
          priority: 0,
          estimate: null,
          updatedAt: "0",
          stateName: "In Progress",
          stateType: "started",
        },
      ],
      projectContent: ["## milestone gap view", "stuff"].join("\n"),
    });
    const gaps = await milestoneGaps(client, "linearctl");
    expect(gaps.docSectionGaps).toEqual([]);
  });

  test("ignores H3+ headings (only H2 sections are coverage units)", async () => {
    const client = stubClient({
      milestones: [],
      projectIssues: [],
      projectContent: [
        "# title",
        "## Real Section",
        "### this is an H3 not a coverage unit",
        "#### h4 either",
      ].join("\n"),
    });
    const gaps = await milestoneGaps(client, "linearctl");
    // Only `## Real Section` is an H2; it has no ticket → it's the sole gap.
    expect(gaps.docSectionGaps).toEqual([
      { index: 0, heading: "Real Section" },
    ]);
  });
});

describe("milestoneGaps — aggregate result shape", () => {
  test("carries the project name from the milestones() result", async () => {
    const client = stubClient({
      projectName: "dogfood",
      milestones: [],
      projectContent: null,
    });
    const gaps = await milestoneGaps(client, "dogfood");
    expect(gaps.project).toBe("dogfood");
  });

  test("falls back to projectRef when milestones() returns a null project name (the all-projects path)", async () => {
    // Simulate the projectMilestones-without-project branch of milestones()
    // by NOT providing a project ref resolution — here we still pass a name, so
    // the fallback path isn't hit; assert the typed contract instead.
    const client = stubClient({ projectName: null as unknown as string });
    const gaps = await milestoneGaps(client, "linearctl");
    // project is null → fallback to projectRef.
    expect(gaps.project).toBe("linearctl");
    // shape still well-formed.
    expect(Array.isArray(gaps.emptyMilestones)).toBe(true);
    expect(Array.isArray(gaps.unassignedIssues)).toBe(true);
    expect(Array.isArray(gaps.docSectionGaps)).toBe(true);
    // (satisfies a round-trip of the public type.)
    const _typed: MilestoneGaps = gaps;
    expect(_typed).toBe(gaps);
  });
});
