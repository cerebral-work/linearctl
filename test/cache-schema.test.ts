import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { openCacheDb, getCacheDbPath, initTables, type CacheDbInstance } from "../src/core/cache/db.js";
import {
  teams,
  users,
  workflowStates,
  issueLabels,
  projects,
  projectMilestones,
  cycles,
  issues,
  issueRelations,
  cacheMeta,
} from "../src/core/cache/schema.js";
import { eq } from "drizzle-orm";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync } from "node:fs";

describe("Cache Schema & DB Initialization", () => {
  let cache: CacheDbInstance;

  beforeEach(() => {
    cache = openCacheDb({ inMemory: true });
  });

  afterEach(() => {
    cache.close();
  });

  test("table initialization in in-memory SQLite creates all expected tables", () => {
    expect(cache.path).toBe(":memory:");
    expect(cache.sqlite).toBeDefined();
    expect(cache.db).toBeDefined();

    // Query sqlite_master to verify tables exist
    const rows = cache.sqlite
      .query("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = rows.map((r) => r.name);

    expect(tableNames).toContain("teams");
    expect(tableNames).toContain("users");
    expect(tableNames).toContain("workflow_states");
    expect(tableNames).toContain("issue_labels");
    expect(tableNames).toContain("projects");
    expect(tableNames).toContain("project_milestones");
    expect(tableNames).toContain("cycles");
    expect(tableNames).toContain("issues");
    expect(tableNames).toContain("issue_relations");
    expect(tableNames).toContain("cache_meta");
    expect(tableNames).toContain("issues_fts");
  });

  test("creates all expected indexes and triggers", () => {
    const indexes = cache.sqlite
      .query("SELECT name FROM sqlite_master WHERE type='index'")
      .all() as Array<{ name: string }>;
    const indexNames = indexes.map((r) => r.name);

    expect(indexNames).toContain("idx_teams_key");
    expect(indexNames).toContain("idx_users_email");
    expect(indexNames).toContain("idx_workflow_states_team");
    expect(indexNames).toContain("idx_workflow_states_type");
    expect(indexNames).toContain("idx_issue_labels_team");
    expect(indexNames).toContain("idx_projects_name");
    expect(indexNames).toContain("idx_issues_identifier");
    expect(indexNames).toContain("idx_issues_team_key");
    expect(indexNames).toContain("idx_issues_state_type");
    expect(indexNames).toContain("idx_issues_updated_at");

    const triggers = cache.sqlite
      .query("SELECT name FROM sqlite_master WHERE type='trigger'")
      .all() as Array<{ name: string }>;
    const triggerNames = triggers.map((r) => r.name);

    expect(triggerNames).toContain("issues_ai");
    expect(triggerNames).toContain("issues_au");
    expect(triggerNames).toContain("issues_ad");
  });

  test("openCacheDb respects getCacheDbPath and custom path", () => {
    const testPath = join(tmpdir(), `linearctl-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    try {
      const fileCache = openCacheDb({ dbPath: testPath });
      expect(fileCache.path).toBe(testPath);
      expect(existsSync(testPath)).toBe(true);
      fileCache.close();
    } finally {
      if (existsSync(testPath)) {
        rmSync(testPath, { force: true });
      }
    }
  });

  test("getCacheDbPath formats path based on orgSlug and environment", () => {
    const defaultPath = getCacheDbPath();
    expect(defaultPath).toContain(".cache");
    expect(defaultPath).toContain("cache.db");

    const orgPath = getCacheDbPath("cerebral");
    expect(orgPath).toContain("cerebral.db");
  });
});

describe("Entity CRUD Operations", () => {
  let cache: CacheDbInstance;

  beforeEach(() => {
    cache = openCacheDb({ inMemory: true });
  });

  afterEach(() => {
    cache.close();
  });

  test("insert and query teams", () => {
    const now = new Date().toISOString();
    cache.db.insert(teams).values({
      id: "team-1",
      key: "EST",
      name: "Estate Operations",
      displayName: "Estate",
      description: "Core cluster operations team",
      createdAt: now,
      updatedAt: now,
    }).run();

    const team = cache.db.select().from(teams).where(eq(teams.id, "team-1")).get();
    expect(team).toBeDefined();
    expect(team?.key).toBe("EST");
    expect(team?.name).toBe("Estate Operations");
    expect(team?.displayName).toBe("Estate");

    // Unique key constraint verification
    expect(() => {
      cache.db.insert(teams).values({
        id: "team-2",
        key: "EST", // duplicate key
        name: "Duplicate Team",
        updatedAt: now,
      }).run();
    }).toThrow();
  });

  test("insert and query workflow states", () => {
    const now = new Date().toISOString();
    cache.db.insert(workflowStates).values([
      {
        id: "state-1",
        teamId: "team-1",
        name: "Triage",
        type: "triage",
        color: "#f2c94c",
        position: 100,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "state-2",
        teamId: "team-1",
        name: "In Progress",
        type: "started",
        color: "#f2994a",
        position: 200,
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    const allStates = cache.db.select().from(workflowStates).all();
    expect(allStates).toHaveLength(2);

    const startedState = cache.db
      .select()
      .from(workflowStates)
      .where(eq(workflowStates.type, "started"))
      .get();
    expect(startedState?.name).toBe("In Progress");
    expect(startedState?.position).toBe(200);
  });

  test("insert and query issue labels", () => {
    const now = new Date().toISOString();
    cache.db.insert(issueLabels).values([
      {
        id: "label-1",
        teamId: "team-1",
        name: "bug",
        color: "#eb5757",
        description: "Something is broken",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "label-2",
        teamId: "team-1",
        name: "soma-ingest",
        color: "#27ae60",
        description: "Ingestion funnel label",
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    const bugLabel = cache.db.select().from(issueLabels).where(eq(issueLabels.name, "bug")).get();
    expect(bugLabel).toBeDefined();
    expect(bugLabel?.color).toBe("#eb5757");

    const ingestLabel = cache.db.select().from(issueLabels).where(eq(issueLabels.name, "soma-ingest")).get();
    expect(ingestLabel).toBeDefined();
    expect(ingestLabel?.description).toBe("Ingestion funnel label");
  });

  test("insert and query projects and project milestones", () => {
    const now = new Date().toISOString();
    cache.db.insert(projects).values({
      id: "proj-1",
      name: "Local Cache Refactor",
      slugId: "local-cache",
      state: "started",
      startDate: "2026-10-01",
      targetDate: "2026-10-31",
      createdAt: now,
      updatedAt: now,
    }).run();

    cache.db.insert(projectMilestones).values({
      id: "milestone-1",
      projectId: "proj-1",
      name: "Phase 1 - SQLite Integration",
      status: "completed",
      createdAt: now,
      updatedAt: now,
    }).run();

    const proj = cache.db.select().from(projects).where(eq(projects.id, "proj-1")).get();
    expect(proj).toBeDefined();
    expect(proj?.name).toBe("Local Cache Refactor");

    const ms = cache.db.select().from(projectMilestones).where(eq(projectMilestones.projectId, "proj-1")).get();
    expect(ms).toBeDefined();
    expect(ms?.name).toBe("Phase 1 - SQLite Integration");
    expect(ms?.status).toBe("completed");
  });

  test("insert and query cycles and users", () => {
    const now = new Date().toISOString();
    cache.db.insert(users).values({
      id: "usr-1",
      name: "Alice Operator",
      displayName: "alice",
      email: "alice@example.com",
      active: true,
      createdAt: now,
      updatedAt: now,
    }).run();

    cache.db.insert(cycles).values({
      id: "cycle-1",
      teamId: "team-1",
      number: 42,
      name: "Cycle 42",
      startsAt: "2026-10-01T00:00:00Z",
      endsAt: "2026-10-15T00:00:00Z",
      createdAt: now,
      updatedAt: now,
    }).run();

    const user = cache.db.select().from(users).where(eq(users.id, "usr-1")).get();
    expect(user?.email).toBe("alice@example.com");
    expect(user?.active).toBe(true);

    const cycle = cache.db.select().from(cycles).where(eq(cycles.number, 42)).get();
    expect(cycle?.name).toBe("Cycle 42");
  });

  test("insert, query, and update issues", () => {
    const now = new Date().toISOString();
    cache.db.insert(issues).values({
      id: "issue-1",
      identifier: "EST-83",
      number: 83,
      title: "soma smoke-test payload",
      description: "Full markdown body of the issue payload",
      priority: 3,
      priorityLabel: "Normal",
      teamId: "team-1",
      teamKey: "EST",
      stateId: "state-1",
      stateName: "Todo",
      stateType: "unstarted",
      url: "https://linear.app/cerebral-work/issue/EST-83",
      labelsJson: JSON.stringify(["soma-ingest", "test"]),
      labelIdsJson: JSON.stringify(["label-2"]),
      createdAt: now,
      updatedAt: now,
    }).run();

    const issue = cache.db.select().from(issues).where(eq(issues.identifier, "EST-83")).get();
    expect(issue).toBeDefined();
    expect(issue?.title).toBe("soma smoke-test payload");
    expect(issue?.priority).toBe(3);
    expect(issue?.stateName).toBe("Todo");
    expect(issue?.stateType).toBe("unstarted");
    expect(JSON.parse(issue?.labelsJson || "[]")).toEqual(["soma-ingest", "test"]);

    // Update issue state
    cache.db.update(issues).set({
      stateName: "In Progress",
      stateType: "started",
      updatedAt: new Date().toISOString(),
    }).where(eq(issues.id, "issue-1")).run();

    const updated = cache.db.select().from(issues).where(eq(issues.id, "issue-1")).get();
    expect(updated?.stateName).toBe("In Progress");
    expect(updated?.stateType).toBe("started");

    // Unique identifier constraint verification
    expect(() => {
      cache.db.insert(issues).values({
        id: "issue-2",
        identifier: "EST-83", // duplicate identifier
        number: 83,
        title: "Duplicate",
        stateName: "Todo",
        stateType: "unstarted",
        url: "https://linear.app/cerebral-work/issue/EST-83",
        createdAt: now,
        updatedAt: now,
      }).run();
    }).toThrow();
  });

  test("insert and query cacheMeta metadata key-values", () => {
    const now = new Date().toISOString();
    cache.db.insert(cacheMeta).values({
      key: "last_sync_timestamp",
      value: now,
      updatedAt: now,
    }).run();

    const meta = cache.db.select().from(cacheMeta).where(eq(cacheMeta.key, "last_sync_timestamp")).get();
    expect(meta?.value).toBe(now);

    cache.db.update(cacheMeta).set({
      value: "2026-10-07T20:00:00Z",
      updatedAt: new Date().toISOString(),
    }).where(eq(cacheMeta.key, "last_sync_timestamp")).run();

    const updatedMeta = cache.db.select().from(cacheMeta).where(eq(cacheMeta.key, "last_sync_timestamp")).get();
    expect(updatedMeta?.value).toBe("2026-10-07T20:00:00Z");
  });
});

describe("FTS5 Full-Text Search Trigger Synchronization", () => {
  let cache: CacheDbInstance;

  beforeEach(() => {
    cache = openCacheDb({ inMemory: true });
  });

  afterEach(() => {
    cache.close();
  });

  test("inserting into issues automatically synchronizes into issues_fts", () => {
    const now = new Date().toISOString();
    cache.db.insert(issues).values({
      id: "fts-1",
      identifier: "EST-101",
      number: 101,
      title: "Fix Kubernetes pod eviction deadlock",
      description: "Pod eviction enters an unrecoverable deadlock when memory pressure hits 95%",
      stateName: "Todo",
      stateType: "unstarted",
      url: "https://linear.app/issue/EST-101",
      createdAt: now,
      updatedAt: now,
    }).run();

    // Query FTS by title term
    const titleMatch = cache.sqlite
      .query("SELECT * FROM issues_fts WHERE issues_fts MATCH ?")
      .all("Kubernetes") as Array<{ identifier: string; title: string }>;
    expect(titleMatch).toHaveLength(1);
    expect(titleMatch[0].identifier).toBe("EST-101");

    // Query FTS by description term
    const descMatch = cache.sqlite
      .query("SELECT * FROM issues_fts WHERE issues_fts MATCH ?")
      .all("deadlock") as Array<{ identifier: string; title: string }>;
    expect(descMatch).toHaveLength(1);
    expect(descMatch[0].identifier).toBe("EST-101");

    // Query FTS by identifier (quoted for FTS5 syntax)
    const idMatch = cache.sqlite
      .query("SELECT * FROM issues_fts WHERE issues_fts MATCH ?")
      .all('"EST-101"') as Array<{ identifier: string; title: string }>;
    expect(idMatch).toHaveLength(1);
  });

  test("updating issues automatically updates issues_fts index", () => {
    const now = new Date().toISOString();
    cache.db.insert(issues).values({
      id: "fts-2",
      identifier: "EST-102",
      number: 102,
      title: "Initial title with alpha keyword",
      description: "Initial description with beta keyword",
      stateName: "Todo",
      stateType: "unstarted",
      url: "https://linear.app/issue/EST-102",
      createdAt: now,
      updatedAt: now,
    }).run();

    // Both initial keywords match
    expect(
      (cache.sqlite.query("SELECT COUNT(*) as cnt FROM issues_fts WHERE issues_fts MATCH ?").get("alpha") as { cnt: number }).cnt
    ).toBe(1);
    expect(
      (cache.sqlite.query("SELECT COUNT(*) as cnt FROM issues_fts WHERE issues_fts MATCH ?").get("beta") as { cnt: number }).cnt
    ).toBe(1);

    // Update title and description
    cache.db.update(issues).set({
      title: "Updated title with gamma keyword",
      description: "Updated description with delta keyword",
      updatedAt: new Date().toISOString(),
    }).where(eq(issues.id, "fts-2")).run();

    // Old keywords must NOT match
    expect(
      (cache.sqlite.query("SELECT COUNT(*) as cnt FROM issues_fts WHERE issues_fts MATCH ?").get("alpha") as { cnt: number }).cnt
    ).toBe(0);
    expect(
      (cache.sqlite.query("SELECT COUNT(*) as cnt FROM issues_fts WHERE issues_fts MATCH ?").get("beta") as { cnt: number }).cnt
    ).toBe(0);

    // New keywords MUST match
    expect(
      (cache.sqlite.query("SELECT COUNT(*) as cnt FROM issues_fts WHERE issues_fts MATCH ?").get("gamma") as { cnt: number }).cnt
    ).toBe(1);
    expect(
      (cache.sqlite.query("SELECT COUNT(*) as cnt FROM issues_fts WHERE issues_fts MATCH ?").get("delta") as { cnt: number }).cnt
    ).toBe(1);
  });

  test("deleting from issues automatically removes row from issues_fts", () => {
    const now = new Date().toISOString();
    cache.db.insert(issues).values({
      id: "fts-3",
      identifier: "EST-103",
      number: 103,
      title: "Ephemerality test payload",
      description: "This issue will be deleted to test FTS delete trigger",
      stateName: "Todo",
      stateType: "unstarted",
      url: "https://linear.app/issue/EST-103",
      createdAt: now,
      updatedAt: now,
    }).run();

    // Verify it exists in FTS
    expect(
      (cache.sqlite.query("SELECT COUNT(*) as cnt FROM issues_fts WHERE issues_fts MATCH ?").get("Ephemerality") as { cnt: number }).cnt
    ).toBe(1);

    // Delete issue
    cache.db.delete(issues).where(eq(issues.id, "fts-3")).run();

    // Verify removed from FTS
    expect(
      (cache.sqlite.query("SELECT COUNT(*) as cnt FROM issues_fts WHERE issues_fts MATCH ?").get("Ephemerality") as { cnt: number }).cnt
    ).toBe(0);
    expect(
      (cache.sqlite.query("SELECT COUNT(*) as cnt FROM issues_fts WHERE issues_fts MATCH ?").get('"EST-103"') as { cnt: number }).cnt
    ).toBe(0);
  });

  test("FTS5 handles prefix search, boolean queries, and multiple matching rows", () => {
    const now = new Date().toISOString();
    cache.db.insert(issues).values([
      {
        id: "fts-4",
        identifier: "EST-104",
        number: 104,
        title: "Frontend auth error in login modal",
        description: "Token expiration leads to 401 unhandled error",
        stateName: "Todo",
        stateType: "unstarted",
        url: "https://linear.app/issue/EST-104",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "fts-5",
        identifier: "EST-105",
        number: 105,
        title: "Backend auth token validation timeout",
        description: "JWT public key fetch takes longer than 2000ms",
        stateName: "In Progress",
        stateType: "started",
        url: "https://linear.app/issue/EST-105",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "fts-6",
        identifier: "SEC-10",
        number: 10,
        title: "Security audit compliance check",
        description: "Verify SOC2 compliance evidence",
        stateName: "Done",
        stateType: "completed",
        url: "https://linear.app/issue/SEC-10",
        createdAt: now,
        updatedAt: now,
      },
    ]).run();

    // Prefix search: "auth*" should match both EST-104 and EST-105
    const prefixResults = cache.sqlite
      .query("SELECT identifier FROM issues_fts WHERE issues_fts MATCH ? ORDER BY identifier")
      .all("auth*") as Array<{ identifier: string }>;
    expect(prefixResults.map((r) => r.identifier)).toEqual(["EST-104", "EST-105"]);

    // Boolean query: "auth AND modal" matches EST-104 only
    const boolResults = cache.sqlite
      .query("SELECT identifier FROM issues_fts WHERE issues_fts MATCH ?")
      .all("auth AND modal") as Array<{ identifier: string }>;
    expect(boolResults.map((r) => r.identifier)).toEqual(["EST-104"]);

    // Search for security: matches SEC-10 only
    const secResults = cache.sqlite
      .query("SELECT identifier FROM issues_fts WHERE issues_fts MATCH ?")
      .all("SOC2") as Array<{ identifier: string }>;
    expect(secResults.map((r) => r.identifier)).toEqual(["SEC-10"]);
  });
});
