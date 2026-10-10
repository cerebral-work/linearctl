import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");
const SCRIPT_PATH = path.join(REPO_ROOT, "scripts", "cpm-wave-runner.sh");
const PLAN_PATH = path.join(REPO_ROOT, "docs", "plans", "linearctl-cpm-agent-sprint-waves.md");
const QUEUE_JSON_PATH = path.join(REPO_ROOT, "sprints", "2026-10-10-linearctl-waves.queue.json");
const QUEUE_MD_PATH = path.join(REPO_ROOT, "sprints", "2026-10-10-linearctl-waves.queue.md");

describe("CPM & Agent Sprint Wave Runner", () => {
  it("script exists and is executable", () => {
    expect(fs.existsSync(SCRIPT_PATH)).toBe(true);
    expect(() => fs.accessSync(SCRIPT_PATH, fs.constants.X_OK)).not.toThrow();
  });

  it("cpm-wave-runner.sh --check passes preflight and path disjointness", () => {
    const result = spawnSync(SCRIPT_PATH, ["--check"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[PASS] Host memory floor satisfied");
    expect(result.stdout).toContain("[PASS] No git index locks detected");
    expect(result.stdout).toContain("[PASS] Path disjointness confirmed across all waves");
    expect(result.stdout).toContain("[PASS] Check completed successfully");
  });

  it("cpm-wave-runner.sh --dry-run completes cleanly", () => {
    const result = spawnSync(SCRIPT_PATH, ["--dry-run"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("[INFO] Dry run enabled");
    expect(result.stdout).toContain("[PASS] Dry run completed successfully");
  });

  it("cpm-wave-runner.sh rejects unknown options", () => {
    const result = spawnSync(SCRIPT_PATH, ["--unknown-flag-xyz"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[ERROR] Unknown option: --unknown-flag-xyz");
  });

  it("cpm-wave-runner.sh rejects invalid wave numbers", () => {
    const result = spawnSync(SCRIPT_PATH, ["--wave", "99"], {
      cwd: REPO_ROOT,
      encoding: "utf-8",
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[ERROR] Invalid wave: 99");
  });

  it("CPM specification document is comprehensive", () => {
    expect(fs.existsSync(PLAN_PATH)).toBe(true);
    const content = fs.readFileSync(PLAN_PATH, "utf-8");
    expect(content).toContain("Critical Path Method (CPM)");
    expect(content).toContain("Agent Sprint Wave Plan");
    expect(content).toContain("Total Makespan");
    expect(content).toContain("Strict Path-Disjoint Assignment Matrix");
    expect(content).toContain("Capacity Tiers");
  });

  it("Sprint queue manifests are structured and valid", () => {
    expect(fs.existsSync(QUEUE_JSON_PATH)).toBe(true);
    expect(fs.existsSync(QUEUE_MD_PATH)).toBe(true);

    const jsonRaw = fs.readFileSync(QUEUE_JSON_PATH, "utf-8");
    const queueData = JSON.parse(jsonRaw);

    expect(queueData.slug).toBe("linearctl-waves");
    expect(queueData.queues).toBeDefined();
    expect(queueData.queues["wave-0"]).toBeArray();
    expect(queueData.queues["wave-1"]).toBeArray();
    expect(queueData.queues["wave-2"]).toBeArray();
    expect(queueData.queues["wave-3"]).toBeArray();
  });

  it("Blackwall task manifests exist across all waves", () => {
    const tasks = ["wave-1-cache-core", "wave-2-cli-relate", "wave-3-verification"];
    for (const task of tasks) {
      const taskToml = path.join(REPO_ROOT, "tasks", task, "task.toml");
      const promptMd = path.join(REPO_ROOT, "tasks", task, "prompt.md");
      expect(fs.existsSync(taskToml)).toBe(true);
      expect(fs.existsSync(promptMd)).toBe(true);
      const tomlContent = fs.readFileSync(taskToml, "utf-8");
      expect(tomlContent).toContain("provider");
      expect(tomlContent).toContain("model");
      expect(tomlContent).toContain("conventional_subject");
    }
  });
});
