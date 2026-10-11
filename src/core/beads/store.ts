import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { discoverBeads, type BeadsDiscoveryResult } from "./discovery.js";
import type { BeadsIssue, BeadsMetadata } from "./types.js";

/**
 * Initialize a Beads workspace in the specified directory (defaults to cwd).
 */
export async function initBeadsWorkspace(
  targetDir: string = process.cwd(),
  options: {
    teamKey?: string;
    projectId?: string;
    idMode?: "linear" | "hash";
  } = {}
): Promise<BeadsDiscoveryResult> {
  const beadsDir = join(targetDir, ".beads");
  if (!existsSync(beadsDir)) {
    mkdirSync(beadsDir, { recursive: true });
  }

  const metadataPath = join(beadsDir, "metadata.json");
  const metadata: BeadsMetadata = {
    backend: "linearctl",
    version: "1.0.0",
    last_sync: undefined,
    team_ids: options.teamKey ? [options.teamKey] : undefined,
    project_id: options.projectId,
    id_mode: options.idMode || "linear",
    sync_relations: true,
  };

  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");

  // Create empty issues.jsonl if not exists
  const issuesPath = join(beadsDir, "issues.jsonl");
  if (!existsSync(issuesPath)) {
    writeFileSync(issuesPath, "", "utf8");
  }

  const discovery = discoverBeads(targetDir);

  // If system bd CLI is available, optionally configure bd linear settings
  if (discovery.hasBdCli && discovery.bdCliPath && options.teamKey) {
    try {
      Bun.spawnSync(["bd", "config", "set", "linear.team_id", options.teamKey], {
        cwd: targetDir,
      });
    } catch {
      // Ignore if bd command fails
    }
  }

  return discovery;
}

/**
 * Load all issues from the discovered Beads workspace.
 */
export function loadBeadsIssues(discovery: BeadsDiscoveryResult): BeadsIssue[] {
  if (!discovery.found || !discovery.issuesPath || !existsSync(discovery.issuesPath)) {
    return [];
  }

  try {
    const content = readFileSync(discovery.issuesPath, "utf8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);
    const issues: BeadsIssue[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.id === "string") {
          issues.push(parsed as BeadsIssue);
        }
      } catch {
        // Skip malformed lines
      }
    }

    return issues;
  } catch (err) {
    throw new Error(`Failed to read Beads issues at ${discovery.issuesPath}: ${String(err)}`);
  }
}

/**
 * Atomically write all issues back to the Beads issues.jsonl file.
 */
export function saveBeadsIssues(discovery: BeadsDiscoveryResult, issues: BeadsIssue[]): void {
  const issuesPath = discovery.issuesPath || (discovery.beadsDir ? join(discovery.beadsDir, "issues.jsonl") : null);
  if (!issuesPath) {
    throw new Error("Cannot save Beads issues: no issues path discovered");
  }

  const dir = discovery.beadsDir || process.cwd();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${issuesPath}.tmp.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  const content = issues.map((issue) => JSON.stringify(issue)).join("\n") + (issues.length > 0 ? "\n" : "");

  writeFileSync(tmpPath, content, "utf8");
  renameSync(tmpPath, issuesPath);
}

/**
 * Load metadata from the discovered workspace.
 */
export function loadBeadsMetadata(discovery: BeadsDiscoveryResult): BeadsMetadata | null {
  if (!discovery.found || !discovery.metadataPath || !existsSync(discovery.metadataPath)) {
    return null;
  }

  try {
    const raw = readFileSync(discovery.metadataPath, "utf8");
    return JSON.parse(raw) as BeadsMetadata;
  } catch {
    return null;
  }
}

/**
 * Save metadata to the discovered workspace.
 */
export function saveBeadsMetadata(discovery: BeadsDiscoveryResult, metadata: BeadsMetadata): void {
  if (!discovery.beadsDir) {
    throw new Error("Cannot save Beads metadata: no beads directory discovered");
  }

  const metadataPath = discovery.metadataPath || join(discovery.beadsDir, "metadata.json");
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n", "utf8");
}
