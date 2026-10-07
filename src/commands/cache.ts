import { rmSync, existsSync } from "node:fs";
import { makeClient } from "../client.js";
import { openCacheDb, getCacheDbPath } from "../core/cache/db.js";
import { syncCache, getCacheStatus } from "../core/cache/sync.js";
import { searchCachedIssues } from "../core/cache/query.js";
import { printJson, printTable } from "../lib/output.js";
import { pc } from "../lib/style.js";

export interface CacheSyncOptions {
  full?: boolean;
  since?: string;
  team?: string[];
  dbPath?: string;
  json?: boolean;
}

export interface CacheStatusOptions {
  dbPath?: string;
  json?: boolean;
}

export interface CacheClearOptions {
  force?: boolean;
  dbPath?: string;
  json?: boolean;
}

export interface CacheQueryOptions {
  team?: string[];
  state?: string;
  label?: string[];
  priority?: string;
  text?: string;
  limit?: number;
  dbPath?: string;
  json?: boolean;
}

const PRIORITY_NAMES = ["—", "urgent", "high", "medium", "low"];

/**
 * Format byte count to human-readable string (KB, MB).
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * `linearctl cache sync` — synchronize Linear workspace data into local SQLite cache.
 */
export async function cacheSyncCmd(opts: CacheSyncOptions): Promise<void> {
  const client = makeClient();
  const cache = openCacheDb({ dbPath: opts.dbPath });

  const logFn = opts.json
    ? undefined
    : (msg: string) => {
        process.stderr.write(`${pc.dim("[cache-sync]")} ${msg}\n`);
      };

  try {
    const result = await syncCache(client, {
      teams: opts.team,
      since: opts.since,
      full: opts.full,
      dbInstance: cache,
      log: logFn,
    });

    if (opts.json) {
      printJson(result);
      return;
    }

    process.stdout.write(
      `\n${pc.green("✓")} Cache sync completed in ${pc.bold(`${result.durationMs}ms`)} (${result.isFullSync ? "full" : "delta"})\n`,
    );
    process.stdout.write(`  Database:   ${pc.cyan(result.dbPath || cache.path)}\n`);
    process.stdout.write(`  Timestamp:  ${pc.dim(result.syncedAt)}\n`);
    process.stdout.write(
      `  Counts:     ${result.counts.issues} issues, ${result.counts.teams} teams, ${result.counts.workflowStates} states, ${result.counts.issueLabels} labels, ${result.counts.projects} projects, ${result.counts.cycles} cycles\n`,
    );
  } finally {
    cache.close();
  }
}

/**
 * `linearctl cache status` — display local cache metadata, entity counts, and database size.
 */
export async function cacheStatusCmd(opts: CacheStatusOptions): Promise<void> {
  const cache = openCacheDb({ dbPath: opts.dbPath });
  try {
    const status = await getCacheStatus(cache);

    if (opts.json) {
      printJson(status);
      return;
    }

    process.stdout.write(pc.bold("\nLinear Local Cache Status\n"));
    process.stdout.write(`  Database path:  ${pc.cyan(status.dbPath)}\n`);
    process.stdout.write(`  Database size:  ${pc.yellow(formatBytes(status.sizeBytes ?? 0))}\n`);
    process.stdout.write(
      `  Last sync:      ${status.lastSyncAt ? pc.green(status.lastSyncAt) : pc.dim("never")}\n\n`,
    );

    const rows = [
      { Entity: "Issues", Count: status.counts.issues },
      { Entity: "Teams", Count: status.counts.teams },
      { Entity: "Workflow States", Count: status.counts.workflowStates },
      { Entity: "Issue Labels", Count: status.counts.issueLabels },
      { Entity: "Projects", Count: status.counts.projects },
      { Entity: "Project Milestones", Count: status.counts.projectMilestones },
      { Entity: "Cycles", Count: status.counts.cycles },
      { Entity: "Issue Relations", Count: status.counts.issueRelations },
      { Entity: "Users", Count: status.counts.users },
    ];

    printTable(
      rows.map((r) => ({ Entity: r.Entity, Count: String(r.Count) })),
      ["Entity", "Count"],
      (value, col) => {
        if (col === "Entity") return pc.bold(value);
        return value === "0" ? pc.dim(value) : pc.cyan(value);
      },
    );
  } finally {
    cache.close();
  }
}

/**
 * `linearctl cache clear` — delete the local SQLite cache database.
 */
export async function cacheClearCmd(opts: CacheClearOptions): Promise<void> {
  const path = opts.dbPath || getCacheDbPath();
  const walPath = `${path}-wal`;
  const shmPath = `${path}-shm`;

  let removed = 0;
  for (const p of [path, walPath, shmPath]) {
    if (existsSync(p)) {
      rmSync(p, { force: true });
      removed++;
    }
  }

  if (opts.json) {
    printJson({ success: true, path, filesRemoved: removed });
    return;
  }

  if (removed > 0) {
    process.stdout.write(`${pc.green("✓")} Removed local cache files (${pc.cyan(path)})\n`);
  } else {
    process.stdout.write(`${pc.dim("Cache database did not exist")} (${pc.cyan(path)})\n`);
  }
}

/**
 * `linearctl cache query` — ad-hoc search directly against the local cache.
 */
export async function cacheQueryCmd(opts: CacheQueryOptions): Promise<void> {
  const cache = openCacheDb({ dbPath: opts.dbPath });
  try {
    const items = searchCachedIssues(cache, {
      teamKeys: opts.team,
      state: opts.state,
      labels: opts.label,
      priority: opts.priority,
      text: opts.text,
      limit: opts.limit,
    });

    if (opts.json) {
      printJson(items);
      return;
    }

    if (items.length === 0) {
      process.stdout.write(`${pc.dim("No cached issues matched criteria.")}\n`);
      return;
    }

    printTable(
      items.map((i) => ({
        identifier: i.identifier,
        state: i.state,
        prio: PRIORITY_NAMES[i.priority] ?? String(i.priority),
        labels: i.labels.join(", ") || "—",
        title: i.title,
      })),
      ["identifier", "state", "prio", "labels", "title"],
      (value, column, row) => {
        if (column === "identifier") return pc.cyan(value);
        if (column === "prio" && row.prio === "urgent") return pc.red(value);
        if (column === "prio" && row.prio === "high") return pc.yellow(value);
        if (column === "labels" && value === "—") return pc.dim(value);
        return value;
      },
    );
  } finally {
    cache.close();
  }
}
