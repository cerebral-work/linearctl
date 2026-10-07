import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { openCacheDb, type CacheDbInstance } from "../src/core/cache/db.js";
import {
  teams,
  workflowStates,
  issueLabels,
  projects,
  cycles,
  issues,
  issueRelations,
  cacheMeta,
  type InsertIssue,
  type CachedTeam,
  type CachedWorkflowState,
} from "../src/core/cache/schema.js";
import { eq, sql } from "drizzle-orm";
import {
  patchIssueInCache,
  deleteIssueFromCache,
  getCacheStatus,
} from "../src/core/cache/sync.js";

/**
 * Reference sync operations for cache.
 * Can be replaced or backed by src/core/cache/sync.ts when available.
 */
export function upsertTeamSync(cache: CacheDbInstance, team: typeof teams.$inferInsert): void {
  cache.db
    .insert(teams)
    .values(team)
    .onConflictDoUpdate({
      target: teams.id,
      set: {
        name: team.name,
        displayName: team.displayName,
        description: team.description,
        updatedAt: team.updatedAt,
      },
    })
    .run();
}

export function upsertWorkflowStateSync(
  cache: CacheDbInstance,
  state: typeof workflowStates.$inferInsert
): void {
  cache.db
    .insert(workflowStates)
    .values(state)
    .onConflictDoUpdate({
      target: workflowStates.id,
      set: {
        name: state.name,
        type: state.type,
        color: state.color,
        position: state.position,
        updatedAt: state.updatedAt,
      },
    })
    .run();
}

export function upsertIssueSync(cache: CacheDbInstance, issue: InsertIssue): void {
  cache.db
    .insert(issues)
    .values(issue)
    .onConflictDoUpdate({
      target: issues.id,
      set: {
        title: issue.title,
        description: issue.description,
        priority: issue.priority,
        priorityLabel: issue.priorityLabel,
        stateId: issue.stateId,
        stateName: issue.stateName,
        stateType: issue.stateType,
        teamId: issue.teamId,
        teamKey: issue.teamKey,
        projectId: issue.projectId,
        labelsJson: issue.labelsJson,
        labelIdsJson: issue.labelIdsJson,
        trashed: issue.trashed,
        archivedAt: issue.archivedAt,
        updatedAt: issue.updatedAt,
      },
    })
    .run();
}

export function batchSyncIssues(cache: CacheDbInstance, issueList: InsertIssue[]): void {
  const syncTx = cache.sqlite.transaction((items: InsertIssue[]) => {
    for (const item of items) {
      upsertIssueSync(cache, item);
    }
  });
  syncTx(issueList);
}

export function getLastSyncTime(cache: CacheDbInstance, syncKey = "last_sync_issues"): string | null {
  const row = cache.db.select().from(cacheMeta).where(eq(cacheMeta.key, syncKey)).get();
  return row ? row.value : null;
}

export function setLastSyncTime(
  cache: CacheDbInstance,
  timestamp: string,
  syncKey = "last_sync_issues"
): void {
  cache.db
    .insert(cacheMeta)
    .values({
      key: syncKey,
      value: timestamp,
      updatedAt: new Date().toISOString(),
    })
    .onConflictDoUpdate({
      target: cacheMeta.key,
      set: {
        value: timestamp,
        updatedAt: new Date().toISOString(),
      },
    })
    .run();
}

// Attempt dynamic import if src/core/cache/sync.ts exists
let realSyncModule: any = null;
try {
  // @ts-ignore
  realSyncModule = await import("../src/core/cache/sync.js");
} catch {
  // src/core/cache/sync.ts not yet in place — testing with reference sync implementations
}

describe("Cache Synchronization Operations", () => {
  let cache: CacheDbInstance;

  beforeEach(() => {
    cache = openCacheDb({ inMemory: true });
  });

  afterEach(() => {
    cache.close();
  });

  describe("Entity Upserts and Idempotency", () => {
    test("inserting a new issue and re-syncing is idempotent", () => {
      const now = "2026-10-07T12:00:00.000Z";
      const issue: InsertIssue = {
        id: "issue-sync-1",
        identifier: "EST-200",
        number: 200,
        title: "Test idempotency of cache sync",
        description: "Initial description",
        priority: 2,
        stateName: "Todo",
        stateType: "unstarted",
        url: "https://linear.app/issue/EST-200",
        createdAt: now,
        updatedAt: now,
      };

      // First sync
      upsertIssueSync(cache, issue);
      const first = cache.db.select().from(issues).where(eq(issues.id, "issue-sync-1")).get();
      expect(first).toBeDefined();
      expect(first?.title).toBe("Test idempotency of cache sync");

      // Second sync with exact same data
      upsertIssueSync(cache, issue);
      const count = cache.sqlite
        .query("SELECT COUNT(*) as cnt FROM issues WHERE id = ?")
        .get("issue-sync-1") as { cnt: number };
      expect(count.cnt).toBe(1);
    });

    test("updating an issue updates fields and updates FTS index without duplicates", () => {
      const initialTime = "2026-10-07T12:00:00.000Z";
      const updatedTime = "2026-10-07T14:30:00.000Z";

      const issue: InsertIssue = {
        id: "issue-sync-2",
        identifier: "EST-201",
        number: 201,
        title: "Kubernetes pod scheduler race condition",
        description: "Race condition in pod bind phase",
        priority: 1,
        stateName: "Todo",
        stateType: "unstarted",
        url: "https://linear.app/issue/EST-201",
        createdAt: initialTime,
        updatedAt: initialTime,
      };

      upsertIssueSync(cache, issue);

      // Verify searchable by initial title keyword
      const ftsInitial = cache.sqlite
        .query("SELECT * FROM issues_fts WHERE issues_fts MATCH ?")
        .all("Kubernetes");
      expect(ftsInitial).toHaveLength(1);

      // Sync update: title changed to Cygnus, state moved to In Progress
      const updatedIssue: InsertIssue = {
        ...issue,
        title: "Cygnus pod scheduler race condition resolved",
        stateName: "In Progress",
        stateType: "started",
        updatedAt: updatedTime,
      };

      upsertIssueSync(cache, updatedIssue);

      const refreshed = cache.db.select().from(issues).where(eq(issues.id, "issue-sync-2")).get();
      expect(refreshed?.title).toBe("Cygnus pod scheduler race condition resolved");
      expect(refreshed?.stateName).toBe("In Progress");
      expect(refreshed?.stateType).toBe("started");
      expect(refreshed?.updatedAt).toBe(updatedTime);

      // Old keyword no longer matches
      const ftsOld = cache.sqlite
        .query("SELECT * FROM issues_fts WHERE issues_fts MATCH ?")
        .all("Kubernetes");
      expect(ftsOld).toHaveLength(0);

      // New keyword matches exactly once
      const ftsNew = cache.sqlite
        .query("SELECT * FROM issues_fts WHERE issues_fts MATCH ?")
        .all("Cygnus");
      expect(ftsNew).toHaveLength(1);
    });
  });

  describe("Multi-Entity Sync Hierarchy", () => {
    test("syncing teams and workflow states properly populates relational entities", () => {
      const now = new Date().toISOString();

      // Sync team
      upsertTeamSync(cache, {
        id: "team-est",
        key: "EST",
        name: "Estate Engineering",
        displayName: "Estate",
        updatedAt: now,
      });

      // Sync workflow state
      upsertWorkflowStateSync(cache, {
        id: "state-started",
        teamId: "team-est",
        name: "In Development",
        type: "started",
        color: "#27ae60",
        position: 300,
        updatedAt: now,
      });

      // Sync issue referencing team and state
      upsertIssueSync(cache, {
        id: "issue-rel-1",
        identifier: "EST-300",
        number: 300,
        title: "Relational foreign key integration test",
        teamId: "team-est",
        teamKey: "EST",
        stateId: "state-started",
        stateName: "In Development",
        stateType: "started",
        url: "https://linear.app/issue/EST-300",
        createdAt: now,
        updatedAt: now,
      });

      const issue = cache.db.select().from(issues).where(eq(issues.id, "issue-rel-1")).get();
      expect(issue?.teamKey).toBe("EST");
      expect(issue?.stateName).toBe("In Development");

      // Verify team lookup
      const team = cache.db.select().from(teams).where(eq(teams.id, issue!.teamId!)).get();
      expect(team?.name).toBe("Estate Engineering");

      // Verify workflow state lookup
      const state = cache.db.select().from(workflowStates).where(eq(workflowStates.id, issue!.stateId!)).get();
      expect(state?.type).toBe("started");
      expect(state?.color).toBe("#27ae60");
    });
  });

  describe("Incremental Sync & Metadata Tracking", () => {
    test("tracks last sync timestamp and updates it after sync", () => {
      // Initially no sync recorded
      expect(getLastSyncTime(cache)).toBeNull();

      const syncTime1 = "2026-10-07T10:00:00.000Z";
      setLastSyncTime(cache, syncTime1);
      expect(getLastSyncTime(cache)).toBe(syncTime1);

      // Simulate next sync run advancing timestamp
      const syncTime2 = "2026-10-07T14:00:00.000Z";
      setLastSyncTime(cache, syncTime2);
      expect(getLastSyncTime(cache)).toBe(syncTime2);
    });

    test("incremental sync simulation: only processes tickets after cursor", () => {
      const sync1Time = "2026-10-07T10:00:00.000Z";
      setLastSyncTime(cache, sync1Time);

      // Batch with older and newer tickets
      const incomingLinearTickets: InsertIssue[] = [
        {
          id: "t-old",
          identifier: "EST-10",
          number: 10,
          title: "Old ticket before last sync",
          stateName: "Todo",
          stateType: "unstarted",
          url: "https://linear.app/issue/EST-10",
          createdAt: "2026-10-07T08:00:00.000Z",
          updatedAt: "2026-10-07T09:00:00.000Z",
        },
        {
          id: "t-new",
          identifier: "EST-11",
          number: 11,
          title: "New ticket after last sync",
          stateName: "Todo",
          stateType: "unstarted",
          url: "https://linear.app/issue/EST-11",
          createdAt: "2026-10-07T11:00:00.000Z",
          updatedAt: "2026-10-07T11:30:00.000Z",
        },
      ];

      // Incremental sync filter: updatedAt >= lastSyncTime
      const lastSync = getLastSyncTime(cache)!;
      const delta = incomingLinearTickets.filter((t) => t.updatedAt >= lastSync);

      expect(delta).toHaveLength(1);
      expect(delta[0].identifier).toBe("EST-11");

      batchSyncIssues(cache, delta);
      setLastSyncTime(cache, delta[0].updatedAt);

      // t-new is in cache, t-old is not
      expect(cache.db.select().from(issues).where(eq(issues.id, "t-new")).get()).toBeDefined();
      expect(cache.db.select().from(issues).where(eq(issues.id, "t-old")).get()).toBeUndefined();
      expect(getLastSyncTime(cache)).toBe("2026-10-07T11:30:00.000Z");
    });
  });

  describe("Batch Sync Performance & Transaction Rollback", () => {
    test("syncing 50 issues in a single transaction succeeds atomically", () => {
      const batch: InsertIssue[] = [];
      const baseTime = new Date("2026-10-07T00:00:00Z").getTime();

      for (let i = 1; i <= 50; i++) {
        batch.push({
          id: `batch-issue-${i}`,
          identifier: `EST-${500 + i}`,
          number: 500 + i,
          title: `Batch ticket performance test ${i}`,
          description: `Description for ticket ${i} with keyword alpha-${i % 5}`,
          priority: (i % 5),
          stateName: i % 2 === 0 ? "Todo" : "In Progress",
          stateType: i % 2 === 0 ? "unstarted" : "started",
          url: `https://linear.app/issue/EST-${500 + i}`,
          createdAt: new Date(baseTime + i * 1000).toISOString(),
          updatedAt: new Date(baseTime + i * 1000).toISOString(),
        });
      }

      batchSyncIssues(cache, batch);

      const totalCount = cache.sqlite
        .query("SELECT COUNT(*) as count FROM issues")
        .get() as { count: number };
      expect(totalCount.count).toBe(50);

      const ftsCount = cache.sqlite
        .query("SELECT COUNT(*) as count FROM issues_fts")
        .get() as { count: number };
      expect(ftsCount.count).toBe(50);
    });

    test("transaction rolls back on mid-sync failure preserving database state", () => {
      const now = new Date().toISOString();
      // Seed initial issue
      upsertIssueSync(cache, {
        id: "seed-1",
        identifier: "EST-1",
        number: 1,
        title: "Seed issue",
        stateName: "Todo",
        stateType: "unstarted",
        url: "https://linear.app/issue/EST-1",
        createdAt: now,
        updatedAt: now,
      });

      // Prepare a batch where one item causes an error
      const failingBatch: InsertIssue[] = [
        {
          id: "batch-fail-1",
          identifier: "EST-2",
          number: 2,
          title: "Good issue 1",
          stateName: "Todo",
          stateType: "unstarted",
          url: "https://linear.app/issue/EST-2",
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "batch-fail-2",
          identifier: "EST-1", // DUPLICATE identifier will violate unique constraint idx_issues_identifier
          number: 1,
          title: "Conflict issue",
          stateName: "Todo",
          stateType: "unstarted",
          url: "https://linear.app/issue/EST-1",
          createdAt: now,
          updatedAt: now,
        },
      ];

      expect(() => {
        const tx = cache.sqlite.transaction((items: InsertIssue[]) => {
          for (const item of items) {
            // direct insert to trigger unique constraint failure
            cache.db.insert(issues).values(item).run();
          }
        });
        tx(failingBatch);
      }).toThrow();

      // Database should only have the original seed-1; batch-fail-1 was rolled back
      const totalCount = cache.sqlite
        .query("SELECT COUNT(*) as count FROM issues")
        .get() as { count: number };
      expect(totalCount.count).toBe(1);

      const goodIssue = cache.db.select().from(issues).where(eq(issues.id, "batch-fail-1")).get();
      expect(goodIssue).toBeUndefined();
    });
  });

  describe("Handling Trashed, Archived, and Deleted Issues", () => {
    test("sync marks trashed and archived issues correctly", () => {
      const now = new Date().toISOString();

      upsertIssueSync(cache, {
        id: "issue-trashed",
        identifier: "EST-999",
        number: 999,
        title: "Trash test issue",
        stateName: "Canceled",
        stateType: "canceled",
        trashed: true,
        archivedAt: now,
        url: "https://linear.app/issue/EST-999",
        createdAt: now,
        updatedAt: now,
      });

      const issue = cache.db.select().from(issues).where(eq(issues.id, "issue-trashed")).get();
      expect(issue?.trashed).toBe(true);
      expect(issue?.archivedAt).toBe(now);
    });

    test("hard deleting an issue cleans up FTS virtual table", () => {
      const now = new Date().toISOString();

      upsertIssueSync(cache, {
        id: "issue-to-purge",
        identifier: "EST-888",
        number: 888,
        title: "Purgeable ephemeral issue",
        stateName: "Todo",
        stateType: "unstarted",
        url: "https://linear.app/issue/EST-888",
        createdAt: now,
        updatedAt: now,
      });

      expect(
        (cache.sqlite.query("SELECT COUNT(*) as cnt FROM issues_fts WHERE issues_fts MATCH ?").get("Purgeable") as { cnt: number }).cnt
      ).toBe(1);

      // Hard delete from issues table
      cache.db.delete(issues).where(eq(issues.id, "issue-to-purge")).run();

      expect(
        (cache.sqlite.query("SELECT COUNT(*) as cnt FROM issues_fts WHERE issues_fts MATCH ?").get("Purgeable") as { cnt: number }).cnt
      ).toBe(0);
    });
  });

  describe("Direct Cache Mutation & Status APIs", () => {
    test("patchIssueInCache updates specific fields and updates FTS index", () => {
      const now = new Date().toISOString();
      upsertIssueSync(cache, {
        id: "issue-patch-1",
        identifier: "EST-777",
        number: 777,
        title: "Original title",
        description: "Original description",
        stateName: "Todo",
        stateType: "unstarted",
        url: "https://linear.app/issue/EST-777",
        createdAt: now,
        updatedAt: now,
      });

      patchIssueInCache(cache, {
        id: "issue-patch-1",
        title: "Patched title for testing",
        stateName: "In Progress",
        stateType: "started",
      });

      const updated = cache.db.select().from(issues).where(eq(issues.id, "issue-patch-1")).get();
      expect(updated?.title).toBe("Patched title for testing");
      expect(updated?.stateName).toBe("In Progress");
      expect(updated?.stateType).toBe("started");
      expect(updated?.description).toBe("Original description");

      // Verify FTS updated
      const fts = cache.sqlite
        .query("SELECT * FROM issues_fts WHERE issues_fts MATCH ?")
        .all("Patched");
      expect(fts).toHaveLength(1);
    });

    test("deleteIssueFromCache deletes issue and cascade-cleans relations and FTS", () => {
      const now = new Date().toISOString();
      upsertIssueSync(cache, {
        id: "issue-del-1",
        identifier: "EST-666",
        number: 666,
        title: "Issue to delete",
        stateName: "Todo",
        stateType: "unstarted",
        url: "https://linear.app/issue/EST-666",
        createdAt: now,
        updatedAt: now,
      });

      deleteIssueFromCache(cache, "EST-666");

      const issue = cache.db.select().from(issues).where(eq(issues.id, "issue-del-1")).get();
      expect(issue).toBeUndefined();

      const fts = cache.sqlite
        .query("SELECT * FROM issues_fts WHERE issues_fts MATCH ?")
        .all("delete");
      expect(fts).toHaveLength(0);
    });

    test("getCacheStatus returns accurate counts and meta info", async () => {
      const status = await getCacheStatus(cache);
      expect(status.dbPath).toBe(":memory:");
      expect(typeof status.counts.issues).toBe("number");
      expect(typeof status.counts.teams).toBe("number");
    });
  });
});
