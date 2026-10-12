import { existsSync } from "fs";
import { join, dirname, resolve } from "path";

export interface BeadsDiscoveryResult {
  found: boolean;
  rootDir?: string;
  beadsDir?: string;
  issuesPath?: string; // Path to issues.jsonl
  metadataPath?: string; // Path to metadata.json
  configPath?: string; // Path to config.yaml
  hasBdCli: boolean;
  bdCliPath?: string;
}

/**
 * Discover an active Beads workspace.
 * Checks:
 * 1. BEADS_DIR environment variable
 * 2. .beads/ directory in current directory or any ancestor directory (up to root or .git boundary)
 * 3. Availability of system `bd` CLI
 */
export function discoverBeads(startDir: string = process.cwd()): BeadsDiscoveryResult {
  // Check if `bd` binary exists in PATH
  let hasBdCli = false;
  let bdCliPath: string | undefined;
  try {
    const whichResult = Bun.which("bd");
    if (whichResult) {
      hasBdCli = true;
      bdCliPath = whichResult;
    }
  } catch {
    // Bun.which failed or not available in this context
  }

  // 1. Explicit BEADS_DIR override
  const envBeadsDir = process.env.BEADS_DIR;
  if (envBeadsDir && existsSync(envBeadsDir)) {
    const resolved = resolve(envBeadsDir);
    const rootDir = dirname(resolved);
    return buildDiscoveryResult(rootDir, resolved, hasBdCli, bdCliPath);
  }

  // 2. Upward directory walk (stopping at git root or filesystem boundary)
  let current = resolve(startDir);
  const root = resolve("/");
  const home = process.env.HOME ? resolve(process.env.HOME) : "";

  while (true) {
    const candidateBeadsDir = join(current, ".beads");
    const candidateIssuesJsonl = join(current, "issues.jsonl");

    // Check if this directory is a valid Beads workspace
    if (existsSync(candidateBeadsDir)) {
      // If it's the home directory, only treat as workspace if it has project files (metadata.json or issues.jsonl)
      const hasWorkspaceFiles =
        existsSync(join(candidateBeadsDir, "metadata.json")) ||
        existsSync(join(candidateBeadsDir, "issues.jsonl")) ||
        existsSync(join(candidateBeadsDir, "config.yaml"));

      if (current !== home || hasWorkspaceFiles) {
        return buildDiscoveryResult(current, candidateBeadsDir, hasBdCli, bdCliPath);
      }
    }

    if (existsSync(candidateIssuesJsonl)) {
      return buildDiscoveryResult(current, candidateBeadsDir, hasBdCli, bdCliPath);
    }

    // Stop if we reached the git root boundary
    if (existsSync(join(current, ".git"))) {
      break;
    }

    // Stop at filesystem root
    if (current === root) {
      break;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return {
    found: false,
    hasBdCli,
    bdCliPath,
  };
}

function buildDiscoveryResult(
  rootDir: string,
  beadsDir: string,
  hasBdCli: boolean,
  bdCliPath?: string
): BeadsDiscoveryResult {
  // Standard beads stores issues in .beads/issues.jsonl or root/issues.jsonl
  const beadsIssues = join(beadsDir, "issues.jsonl");
  const rootIssues = join(rootDir, "issues.jsonl");
  const issuesPath = existsSync(beadsIssues) ? beadsIssues : existsSync(rootIssues) ? rootIssues : beadsIssues;

  const metadataPath = join(beadsDir, "metadata.json");
  const configPath = join(beadsDir, "config.yaml");

  return {
    found: true,
    rootDir,
    beadsDir,
    issuesPath,
    metadataPath,
    configPath,
    hasBdCli,
    bdCliPath,
  };
}
