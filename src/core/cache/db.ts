import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import * as schema from "./schema.js";

export interface CacheDbInstance {
  db: BunSQLiteDatabase<typeof schema>;
  sqlite: Database;
  path: string;
  close: () => void;
}

/**
 * Resolve the cache database path for a given organization or workspace.
 */
export function getCacheDbPath(orgSlug?: string): string {
  if (process.env.LINEARCTL_CACHE_FILE) {
    return process.env.LINEARCTL_CACHE_FILE;
  }
  const baseDir =
    process.env.LINEARCTL_CACHE_DIR ||
    process.env.XDG_CACHE_HOME ||
    join(homedir(), ".cache", "linearctl");
  const fileName = orgSlug ? `${orgSlug}.db` : "cache.db";
  return join(baseDir, fileName);
}

/**
 * Initialize all database tables, indexes, and SQLite FTS5 virtual tables and triggers.
 */
export function initTables(sqlite: Database): void {
  sqlite.run(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS teams (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      display_name TEXT,
      description TEXT,
      created_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_teams_key ON teams(key);
    CREATE INDEX IF NOT EXISTS idx_teams_key_nocase ON teams(key COLLATE NOCASE);

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      display_name TEXT,
      email TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

    CREATE TABLE IF NOT EXISTS workflow_states (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      color TEXT,
      position REAL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_states_team ON workflow_states(team_id);
    CREATE INDEX IF NOT EXISTS idx_workflow_states_type ON workflow_states(type);
    CREATE INDEX IF NOT EXISTS idx_workflow_states_name ON workflow_states(name);

    CREATE TABLE IF NOT EXISTS issue_labels (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      name TEXT NOT NULL,
      color TEXT,
      description TEXT,
      created_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_issue_labels_team ON issue_labels(team_id);
    CREATE INDEX IF NOT EXISTS idx_issue_labels_name ON issue_labels(name);

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      slug_id TEXT,
      state TEXT,
      lead_id TEXT,
      start_date TEXT,
      target_date TEXT,
      created_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
    CREATE INDEX IF NOT EXISTS idx_projects_slug ON projects(slug_id);

    CREATE TABLE IF NOT EXISTS project_milestones (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      description TEXT,
      target_date TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_milestones_project ON project_milestones(project_id);
    CREATE INDEX IF NOT EXISTS idx_project_milestones_name ON project_milestones(name);

    CREATE TABLE IF NOT EXISTS cycles (
      id TEXT PRIMARY KEY,
      team_id TEXT,
      number INTEGER,
      name TEXT,
      starts_at TEXT,
      ends_at TEXT,
      completed_at TEXT,
      created_at TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cycles_team ON cycles(team_id);
    CREATE INDEX IF NOT EXISTS idx_cycles_number ON cycles(number);

    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL UNIQUE,
      number INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      priority INTEGER DEFAULT 0,
      priority_label TEXT,
      estimate REAL,
      team_id TEXT,
      team_key TEXT,
      state_id TEXT,
      state_name TEXT NOT NULL,
      state_type TEXT NOT NULL,
      project_id TEXT,
      project_name TEXT,
      project_milestone_id TEXT,
      cycle_id TEXT,
      cycle_number INTEGER,
      assignee_id TEXT,
      assignee_name TEXT,
      creator_id TEXT,
      parent_id TEXT,
      url TEXT NOT NULL,
      branch_name TEXT,
      due_date TEXT,
      labels_json TEXT NOT NULL DEFAULT '[]',
      label_ids_json TEXT NOT NULL DEFAULT '[]',
      trashed INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      canceled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_issues_identifier ON issues(identifier);
    CREATE INDEX IF NOT EXISTS idx_issues_identifier_nocase ON issues(identifier COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_issues_team_key ON issues(team_key);
    CREATE INDEX IF NOT EXISTS idx_issues_state_name ON issues(state_name);
    CREATE INDEX IF NOT EXISTS idx_issues_state_type ON issues(state_type);
    CREATE INDEX IF NOT EXISTS idx_issues_project_id ON issues(project_id);
    CREATE INDEX IF NOT EXISTS idx_issues_assignee_id ON issues(assignee_id);
    CREATE INDEX IF NOT EXISTS idx_issues_updated_at ON issues(updated_at);
    CREATE INDEX IF NOT EXISTS idx_issues_created_at ON issues(created_at);
    CREATE INDEX IF NOT EXISTS idx_issues_priority ON issues(priority);

    CREATE TABLE IF NOT EXISTS issue_relations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      issue_id TEXT NOT NULL,
      related_issue_id TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_issue_relations_issue ON issue_relations(issue_id);
    CREATE INDEX IF NOT EXISTS idx_issue_relations_related ON issue_relations(related_issue_id);

    CREATE TABLE IF NOT EXISTS cache_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    -- FTS5 Full-Text Search virtual table
    CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
      identifier,
      title,
      description,
      content='issues',
      content_rowid='rowid'
    );

    -- FTS triggers for automatic sync
    DROP TRIGGER IF EXISTS issues_ai;
    CREATE TRIGGER issues_ai AFTER INSERT ON issues BEGIN
      INSERT INTO issues_fts(rowid, identifier, title, description)
      VALUES (new.rowid, new.identifier, new.title, new.description);
    END;

    DROP TRIGGER IF EXISTS issues_ad;
    CREATE TRIGGER issues_ad AFTER DELETE ON issues BEGIN
      INSERT INTO issues_fts(issues_fts, rowid, identifier, title, description)
      VALUES ('delete', old.rowid, old.identifier, old.title, old.description);
    END;

    DROP TRIGGER IF EXISTS issues_au;
    CREATE TRIGGER issues_au AFTER UPDATE ON issues BEGIN
      INSERT INTO issues_fts(issues_fts, rowid, identifier, title, description)
      VALUES ('delete', old.rowid, old.identifier, old.title, old.description);
      INSERT INTO issues_fts(rowid, identifier, title, description)
      VALUES (new.rowid, new.identifier, new.title, new.description);
    END;
  `);
}

/**
 * Open or create the local SQLite cache database.
 */
export function openCacheDb(opts?: {
  dbPath?: string;
  orgSlug?: string;
  inMemory?: boolean;
}): CacheDbInstance {
  const path = opts?.inMemory ? ":memory:" : opts?.dbPath || getCacheDbPath(opts?.orgSlug);
  if (path !== ":memory:") {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  const sqlite = new Database(path);
  initTables(sqlite);

  const db = drizzle(sqlite, { schema });
  return {
    db,
    sqlite,
    path,
    close: () => {
      sqlite.close();
    },
  };
}
