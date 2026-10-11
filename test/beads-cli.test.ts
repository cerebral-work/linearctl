import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initBeadsWorkspace,
  saveBeadsIssues,
  type BeadsIssue,
} from "../src/core/beads/index.js";

describe("Beads CLI Subcommands", () => {
  let tempDir: string;
  let oldBeadsDir: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "linearctl-beads-cli-test-"));
    oldBeadsDir = process.env.BEADS_DIR;
    process.env.BEADS_DIR = join(tempDir, ".beads");
  });

  afterEach(() => {
    if (oldBeadsDir === undefined) {
      delete process.env.BEADS_DIR;
    } else {
      process.env.BEADS_DIR = oldBeadsDir;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("handles beads status when workspace is initialized", async () => {
    const discovery = await initBeadsWorkspace(tempDir, { teamKey: "CER" });
    const proc = Bun.spawnSync(["bun", "run", "src/index.ts", "beads", "status", "--json"], {
      env: { ...process.env, BEADS_DIR: discovery.beadsDir },
    });
    expect(proc.exitCode).toBe(0);
    const output = JSON.parse(proc.stdout.toString());
    expect(output.found).toBe(true);
    expect(output.teamIds).toEqual(["CER"]);
    expect(output.counts.total).toBe(0);
  });

  it("lists ready tasks via beads ready --json", async () => {
    const discovery = await initBeadsWorkspace(tempDir);
    const testIssues: BeadsIssue[] = [
      { id: "CER-1", title: "Unblocked task", status: "open", priority: 0, created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z" },
      {
        id: "CER-2",
        title: "Blocked task",
        status: "open",
        priority: 1,
        created_at: "2026-10-10T10:00:00Z",
        updated_at: "2026-10-10T10:00:00Z",
        dependencies: [{ issue_id: "CER-2", depends_on_id: "CER-1", type: "blocks" }],
      },
    ];
    saveBeadsIssues(discovery, testIssues);

    const proc = Bun.spawnSync(["bun", "run", "src/index.ts", "beads", "ready", "--json"], {
      env: { ...process.env, BEADS_DIR: discovery.beadsDir },
    });
    expect(proc.exitCode).toBe(0);
    const ready = JSON.parse(proc.stdout.toString());
    expect(ready.length).toBe(1);
    expect(ready[0].id).toBe("CER-1");
  });

  it("shows issue details via beads show <id>", async () => {
    const discovery = await initBeadsWorkspace(tempDir);
    const testIssues: BeadsIssue[] = [
      { id: "CER-1", title: "Task 1", status: "open", priority: 1, created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z" },
    ];
    saveBeadsIssues(discovery, testIssues);

    const proc = Bun.spawnSync(["bun", "run", "src/index.ts", "beads", "show", "CER-1", "--json"], {
      env: { ...process.env, BEADS_DIR: discovery.beadsDir },
    });
    expect(proc.exitCode).toBe(0);
    const details = JSON.parse(proc.stdout.toString());
    expect(details.issue.id).toBe("CER-1");
    expect(details.blockers).toEqual([]);
  });

  it("claims an issue via beads claim <id>", async () => {
    const discovery = await initBeadsWorkspace(tempDir);
    const testIssues: BeadsIssue[] = [
      { id: "CER-1", title: "Task 1", status: "open", priority: 1, created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z" },
    ];
    saveBeadsIssues(discovery, testIssues);

    const proc = Bun.spawnSync(["bun", "run", "src/index.ts", "beads", "claim", "CER-1", "--json"], {
      env: { ...process.env, BEADS_DIR: discovery.beadsDir, USER: "test-agent" },
    });
    expect(proc.exitCode).toBe(0);
    const res = JSON.parse(proc.stdout.toString());
    expect(res.status).toBe("in_progress");
    expect(res.assignee).toBe("test-agent");
  });

  it("closes an issue via beads close <id> and reveals newly unblocked issues", async () => {
    const discovery = await initBeadsWorkspace(tempDir);
    const testIssues: BeadsIssue[] = [
      { id: "CER-1", title: "Blocker", status: "in_progress", priority: 1, created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z" },
      {
        id: "CER-2",
        title: "Blocked",
        status: "open",
        priority: 2,
        created_at: "2026-10-10T10:00:00Z",
        updated_at: "2026-10-10T10:00:00Z",
        dependencies: [{ issue_id: "CER-2", depends_on_id: "CER-1", type: "blocks" }],
      },
    ];
    saveBeadsIssues(discovery, testIssues);

    const proc = Bun.spawnSync(["bun", "run", "src/index.ts", "beads", "close", "CER-1", "--reason", "Fixed", "--json"], {
      env: { ...process.env, BEADS_DIR: discovery.beadsDir },
    });
    expect(proc.exitCode).toBe(0);
    const res = JSON.parse(proc.stdout.toString());
    expect(res.closed.status).toBe("closed");
    expect(res.closed.close_reason).toBe("Fixed");
    expect(res.newlyReady.length).toBe(1);
    expect(res.newlyReady[0].id).toBe("CER-2");
  });

  it("exports and imports issues.jsonl", async () => {
    const discovery = await initBeadsWorkspace(tempDir);
    const testIssues: BeadsIssue[] = [
      { id: "CER-1", title: "Task 1", status: "open", priority: 1, created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z" },
    ];
    saveBeadsIssues(discovery, testIssues);

    const exportPath = join(tempDir, "export.jsonl");
    const exportProc = Bun.spawnSync(["bun", "run", "src/index.ts", "beads", "export", "--out", exportPath], {
      env: { ...process.env, BEADS_DIR: discovery.beadsDir },
    });
    expect(exportProc.exitCode).toBe(0);

    // Import into fresh workspace
    const newDir = join(tempDir, "new-workspace");
    const newDiscovery = await initBeadsWorkspace(newDir);
    const importProc = Bun.spawnSync(["bun", "run", "src/index.ts", "beads", "import", exportPath], {
      env: { ...process.env, BEADS_DIR: newDiscovery.beadsDir },
    });
    expect(importProc.exitCode).toBe(0);

    const statusProc = Bun.spawnSync(["bun", "run", "src/index.ts", "beads", "status", "--json"], {
      env: { ...process.env, BEADS_DIR: newDiscovery.beadsDir },
    });
    const status = JSON.parse(statusProc.stdout.toString());
    expect(status.counts.total).toBe(1);
  });

  it("fails pull --beads when no workspace is discovered", async () => {
    delete process.env.BEADS_DIR;
    const entryPath = join(process.cwd(), "src/index.ts");
    const proc = Bun.spawnSync(["bun", "run", entryPath, "pull", "--beads"], {
      cwd: tempDir,
    });
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("No Beads workspace discovered");
  });
});
