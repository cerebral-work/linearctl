import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverBeads,
  initBeadsWorkspace,
  loadBeadsIssues,
  saveBeadsIssues,
  loadBeadsMetadata,
  saveBeadsMetadata,
  evaluateReadiness,
  getReadyIssues,
  getIssueBlockers,
  getIssueDependents,
  claimIssue,
  closeIssue,
  detectCycles,
  convertLinearToBeads,
  linearPriorityToBeads,
  beadsPriorityToLinear,
  linearStateTypeToBeads,
  beadsStatusToLinearStateType,
  inferIssueType,
  type BeadsIssue,
} from "../src/core/beads/index.js";

describe("Beads Integration — Core & Graph", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "linearctl-beads-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("Discovery & Storage", () => {
    it("reports found: false when no beads workspace exists", () => {
      const res = discoverBeads(tempDir);
      expect(res.found).toBe(false);
      expect(res.beadsDir).toBeUndefined();
    });

    it("initializes a workspace and discovers it", async () => {
      const initRes = await initBeadsWorkspace(tempDir, { teamKey: "CER", projectId: "p-123" });
      expect(initRes.found).toBe(true);
      expect(existsSync(join(tempDir, ".beads"))).toBe(true);
      expect(existsSync(join(tempDir, ".beads", "metadata.json"))).toBe(true);
      expect(existsSync(join(tempDir, ".beads", "issues.jsonl"))).toBe(true);

      const res = discoverBeads(tempDir);
      expect(res.found).toBe(true);
      expect(res.beadsDir).toBe(join(tempDir, ".beads"));

      const meta = loadBeadsMetadata(res);
      expect(meta?.backend).toBe("linearctl");
      expect(meta?.team_ids).toEqual(["CER"]);
      expect(meta?.project_id).toBe("p-123");
    });

    it("round-trips issues through saveBeadsIssues and loadBeadsIssues", async () => {
      const discovery = await initBeadsWorkspace(tempDir);
      const testIssues: BeadsIssue[] = [
        {
          id: "CER-101",
          title: "First issue",
          status: "open",
          priority: 1,
          issue_type: "feature",
          created_at: "2026-10-10T10:00:00Z",
          updated_at: "2026-10-10T10:00:00Z",
          external_ref: "https://linear.app/team/issue/CER-101",
        },
        {
          id: "CER-102",
          title: "Second issue",
          status: "in_progress",
          priority: 0,
          issue_type: "bug",
          assignee: "Alice",
          created_at: "2026-10-10T11:00:00Z",
          updated_at: "2026-10-10T11:30:00Z",
          started_at: "2026-10-10T11:30:00Z",
          dependencies: [
            {
              issue_id: "CER-102",
              depends_on_id: "CER-101",
              type: "blocks",
            },
          ],
        },
      ];

      saveBeadsIssues(discovery, testIssues);
      const loaded = loadBeadsIssues(discovery);

      expect(loaded.length).toBe(2);
      expect(loaded[0].id).toBe("CER-101");
      expect(loaded[0].title).toBe("First issue");
      expect(loaded[1].id).toBe("CER-102");
      expect(loaded[1].dependencies?.length).toBe(1);
      expect(loaded[1].dependencies![0].depends_on_id).toBe("CER-101");
    });

    it("respects BEADS_DIR environment variable", async () => {
      const customDir = join(tempDir, "custom-beads");
      await initBeadsWorkspace(customDir);

      const oldEnv = process.env.BEADS_DIR;
      process.env.BEADS_DIR = join(customDir, ".beads");
      try {
        const res = discoverBeads(tempDir);
        expect(res.found).toBe(true);
        expect(res.beadsDir).toBe(join(customDir, ".beads"));
      } finally {
        if (oldEnv === undefined) {
          delete process.env.BEADS_DIR;
        } else {
          process.env.BEADS_DIR = oldEnv;
        }
      }
    });
  });

  describe("Field & Priority Mapping", () => {
    it("maps Linear priorities to Beads priorities correctly", () => {
      expect(linearPriorityToBeads(1)).toBe(0); // Urgent -> Critical
      expect(linearPriorityToBeads(2)).toBe(1); // High -> High
      expect(linearPriorityToBeads(3)).toBe(2); // Medium -> Medium
      expect(linearPriorityToBeads(4)).toBe(3); // Low -> Low
      expect(linearPriorityToBeads(0)).toBe(4); // None -> Backlog
      expect(linearPriorityToBeads(null)).toBe(4);
    });

    it("maps Beads priorities back to Linear priorities", () => {
      expect(beadsPriorityToLinear(0)).toBe(1); // Critical -> Urgent
      expect(beadsPriorityToLinear(1)).toBe(2); // High -> High
      expect(beadsPriorityToLinear(2)).toBe(3); // Medium -> Medium
      expect(beadsPriorityToLinear(3)).toBe(4); // Low -> Low
      expect(beadsPriorityToLinear(4)).toBe(0); // Backlog -> None
    });

    it("maps Linear state types to Beads status", () => {
      expect(linearStateTypeToBeads("backlog")).toBe("open");
      expect(linearStateTypeToBeads("unstarted")).toBe("open");
      expect(linearStateTypeToBeads("started")).toBe("in_progress");
      expect(linearStateTypeToBeads("completed")).toBe("closed");
      expect(linearStateTypeToBeads("canceled")).toBe("closed");
    });

    it("maps Beads status to Linear state type", () => {
      expect(beadsStatusToLinearStateType("open")).toBe("unstarted");
      expect(beadsStatusToLinearStateType("in_progress")).toBe("started");
      expect(beadsStatusToLinearStateType("closed")).toBe("completed");
    });

    it("infers issue types from labels and hierarchy", () => {
      expect(inferIssueType(["bug", "backend"])).toBe("bug");
      expect(inferIssueType(["feature", "ui"])).toBe("feature");
      expect(inferIssueType(["enhancement"])).toBe("feature");
      expect(inferIssueType(["refactor", "chore"])).toBe("chore");
      expect(inferIssueType([], true)).toBe("epic"); // Parent issue
      expect(inferIssueType([])).toBe("task");
    });
  });

  describe("Graph Resolution & Ready Detection", () => {
    it("identifies unblocked issues as ready", () => {
      const issues: BeadsIssue[] = [
        {
          id: "CER-1",
          title: "Standalone task",
          status: "open",
          priority: 2,
          created_at: "2026-10-10T10:00:00Z",
          updated_at: "2026-10-10T10:00:00Z",
        },
      ];

      const ready = getReadyIssues(issues);
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe("CER-1");
    });

    it("marks an issue as blocked if its blocker is open", () => {
      const issues: BeadsIssue[] = [
        {
          id: "CER-1",
          title: "Blocker task",
          status: "open",
          priority: 1,
          created_at: "2026-10-10T10:00:00Z",
          updated_at: "2026-10-10T10:00:00Z",
        },
        {
          id: "CER-2",
          title: "Blocked task",
          status: "open",
          priority: 2,
          created_at: "2026-10-10T10:00:00Z",
          updated_at: "2026-10-10T10:00:00Z",
          dependencies: [
            {
              issue_id: "CER-2",
              depends_on_id: "CER-1",
              type: "blocks",
            },
          ],
        },
      ];

      const res = evaluateReadiness(issues);
      expect(res.ready.length).toBe(1);
      expect(res.ready[0].id).toBe("CER-1");

      expect(res.blocked.length).toBe(1);
      expect(res.blocked[0].issue.id).toBe("CER-2");
      expect(res.blocked[0].blockers.length).toBe(1);
      expect(res.blocked[0].blockers[0].id).toBe("CER-1");
    });

    it("unblocks an issue when its blocker is closed", () => {
      const issues: BeadsIssue[] = [
        {
          id: "CER-1",
          title: "Blocker task",
          status: "closed", // Closed!
          priority: 1,
          created_at: "2026-10-10T10:00:00Z",
          updated_at: "2026-10-10T10:00:00Z",
        },
        {
          id: "CER-2",
          title: "Blocked task",
          status: "open",
          priority: 2,
          created_at: "2026-10-10T10:00:00Z",
          updated_at: "2026-10-10T10:00:00Z",
          dependencies: [
            {
              issue_id: "CER-2",
              depends_on_id: "CER-1",
              type: "blocks",
            },
          ],
        },
      ];

      const ready = getReadyIssues(issues);
      expect(ready.length).toBe(1);
      expect(ready[0].id).toBe("CER-2");
    });

    it("handles multiple blockers and requires all to be closed", () => {
      const issues: BeadsIssue[] = [
        { id: "CER-1", title: "Blocker 1", status: "closed", priority: 1, created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z" },
        { id: "CER-2", title: "Blocker 2", status: "in_progress", priority: 1, created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z" },
        {
          id: "CER-3",
          title: "Blocked by both",
          status: "open",
          priority: 2,
          created_at: "2026-10-10T10:00:00Z",
          updated_at: "2026-10-10T10:00:00Z",
          dependencies: [
            { issue_id: "CER-3", depends_on_id: "CER-1", type: "blocks" },
            { issue_id: "CER-3", depends_on_id: "CER-2", type: "blocks" },
          ],
        },
      ];

      const res = evaluateReadiness(issues);
      expect(res.ready.length).toBe(0); // CER-2 is in_progress, so not ready
      expect(res.blocked.length).toBe(1);
      expect(res.blocked[0].issue.id).toBe("CER-3");
      expect(res.blocked[0].blockers.map((b) => b.id)).toEqual(["CER-2"]);
    });

    it("detects dependency cycles", () => {
      const issues: BeadsIssue[] = [
        {
          id: "CER-1",
          title: "Cycle 1",
          status: "open",
          priority: 1,
          created_at: "2026-10-10T10:00:00Z",
          updated_at: "2026-10-10T10:00:00Z",
          dependencies: [{ issue_id: "CER-1", depends_on_id: "CER-2", type: "blocks" }],
        },
        {
          id: "CER-2",
          title: "Cycle 2",
          status: "open",
          priority: 1,
          created_at: "2026-10-10T10:00:00Z",
          updated_at: "2026-10-10T10:00:00Z",
          dependencies: [{ issue_id: "CER-2", depends_on_id: "CER-1", type: "blocks" }],
        },
      ];

      const cycles = detectCycles(issues);
      expect(cycles.length).toBeGreaterThan(0);
    });
  });

  describe("Claim & Close Operations", () => {
    it("claims an open issue atomically", () => {
      const issues: BeadsIssue[] = [
        { id: "CER-10", title: "Task 10", status: "open", priority: 1, created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z" },
      ];

      const { updatedIssue, allIssues } = claimIssue("CER-10", "agent-1", issues);
      expect(updatedIssue.status).toBe("in_progress");
      expect(updatedIssue.assignee).toBe("agent-1");
      expect(updatedIssue.started_at).toBeDefined();
      expect(allIssues[0].status).toBe("in_progress");
    });

    it("refuses to claim a closed issue", () => {
      const issues: BeadsIssue[] = [
        { id: "CER-10", title: "Task 10", status: "closed", priority: 1, created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z" },
      ];

      expect(() => claimIssue("CER-10", "agent-1", issues)).toThrow();
    });

    it("closes an issue and detects newly unblocked downstream issues", () => {
      const issues: BeadsIssue[] = [
        { id: "CER-1", title: "Blocker", status: "in_progress", priority: 1, created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z" },
        {
          id: "CER-2",
          title: "Dependent",
          status: "open",
          priority: 2,
          created_at: "2026-10-10T10:00:00Z",
          updated_at: "2026-10-10T10:00:00Z",
          dependencies: [{ issue_id: "CER-2", depends_on_id: "CER-1", type: "blocks" }],
        },
      ];

      const { closedIssue, newlyReady, allIssues } = closeIssue("CER-1", { reason: "Done" }, issues);
      expect(closedIssue.status).toBe("closed");
      expect(closedIssue.closed_at).toBeDefined();
      expect(closedIssue.close_reason).toBe("Done");

      expect(newlyReady.length).toBe(1);
      expect(newlyReady[0].id).toBe("CER-2");
    });
  });

  describe("Linear Data Conversion", () => {
    it("converts Linear raw nodes and relations to Beads issues with blocking graph", () => {
      const rawIssues = [
        {
          id: "u-1",
          identifier: "CER-101",
          title: "First issue",
          url: "https://linear.app/team/issue/CER-101",
          priority: 1,
          createdAt: "2026-10-10T10:00:00Z",
          updatedAt: "2026-10-10T10:00:00Z",
          state: { id: "s-1", name: "In Progress", type: "started" },
          assignee: { id: "u-a", name: "Alice", displayName: "Alice Smith" },
          labels: { nodes: [{ name: "bug" }] },
        },
        {
          id: "u-2",
          identifier: "CER-102",
          title: "Second issue",
          url: "https://linear.app/team/issue/CER-102",
          priority: 2,
          createdAt: "2026-10-10T10:05:00Z",
          updatedAt: "2026-10-10T10:05:00Z",
          state: { id: "s-2", name: "Todo", type: "unstarted" },
          labels: { nodes: [{ name: "feature" }] },
        },
      ];

      const rawRelations = [
        {
          id: "rel-1",
          type: "blocks",
          issue: { id: "u-1", identifier: "CER-101" }, // CER-101 blocks CER-102
          relatedIssue: { id: "u-2", identifier: "CER-102" },
          createdAt: "2026-10-10T10:06:00Z",
        },
      ];

      const beads = convertLinearToBeads(rawIssues, rawRelations);
      expect(beads.length).toBe(2);

      const b1 = beads.find((b) => b.id === "CER-101")!;
      expect(b1.status).toBe("in_progress");
      expect(b1.priority).toBe(0); // Urgent -> 0
      expect(b1.issue_type).toBe("bug");
      expect(b1.assignee).toBe("Alice Smith");

      const b2 = beads.find((b) => b.id === "CER-102")!;
      expect(b2.status).toBe("open");
      expect(b2.priority).toBe(1); // High -> 1
      expect(b2.issue_type).toBe("feature");
      expect(b2.dependencies?.length).toBe(1);
      expect(b2.dependencies![0].issue_id).toBe("CER-102");
      expect(b2.dependencies![0].depends_on_id).toBe("CER-101");
      expect(b2.dependencies![0].type).toBe("blocks");

      // Verify ready calculation: b2 is blocked by b1
      const ready = getReadyIssues(beads);
      expect(ready.length).toBe(0); // b1 is in_progress, b2 is blocked
    });
  });
});
