import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { openCacheDb, type CacheDbInstance } from "../src/core/cache/db.js";
import { patchIssueInCache, deleteIssueFromCache } from "../src/core/cache/sync.js";
import { getCachedIssue, pullCachedIssues, searchCachedIssues } from "../src/core/cache/query.js";
import { issueRelations } from "../src/core/cache/schema.js";

describe("Cache Write-Through Mutations & Invalidation", () => {
  let cache: CacheDbInstance;

  beforeEach(() => {
    cache = openCacheDb({ inMemory: true });
  });

  afterEach(() => {
    cache.close();
  });

  test("patchIssueInCache creates a new issue record (file simulation)", async () => {
    const newIssue = {
      id: "11111111-2222-3333-4444-555555555555",
      identifier: "CER-101",
      number: 101,
      title: "Write-through creation test",
      description: "Initial markdown description of created issue",
      priority: 2,
      priorityLabel: "High",
      teamKey: "CER",
      stateName: "Todo",
      stateType: "unstarted",
      labels: ["cache", "test"],
      url: "https://linear.app/cerebral-work/issue/CER-101",
    };

    patchIssueInCache(cache, newIssue);

    const fetched = await getCachedIssue(cache, "CER-101");
    expect(fetched).not.toBeNull();
    expect(fetched?.identifier).toBe("CER-101");
    expect(fetched?.title).toBe("Write-through creation test");
    expect(fetched?.priority).toBe(2);
    expect(fetched?.stateName).toBe("Todo");
    expect(fetched?.stateType).toBe("unstarted");
    const parsedLabels = JSON.parse(fetched?.labelsJson || "[]");
    expect(parsedLabels).toEqual(["cache", "test"]);

    // Verify it is immediately visible via FTS5
    const searchRes = await searchCachedIssues(cache, { text: "creation" });
    expect(searchRes.length).toBe(1);
    expect(searchRes[0].identifier).toBe("CER-101");
  });

  test("patchIssueInCache partially updates existing issue fields (update simulation)", async () => {
    // 1. Initial insert
    patchIssueInCache(cache, {
      id: "22222222-3333-4444-5555-666666666666",
      identifier: "CER-102",
      title: "UniqueOldTitleToBeReplaced",
      description: "Description preserved across edits",
      priority: 3,
      teamKey: "CER",
      stateName: "Todo",
      stateType: "unstarted",
      labels: ["v1"],
      createdAt: "2026-10-01T12:00:00.000Z",
    });

    // 2. Partial update: change title, priority, state, and labels
    patchIssueInCache(cache, {
      identifier: "CER-102",
      title: "BrandNewTitleAfterReview",
      priority: 1,
      stateName: "In Progress",
      stateType: "started",
      labels: ["v1", "urgent"],
    });

    const updated = await getCachedIssue(cache, "CER-102");
    expect(updated).not.toBeNull();
    expect(updated?.title).toBe("BrandNewTitleAfterReview");
    // Ensure description and createdAt are preserved
    expect(updated?.description).toBe("Description preserved across edits");
    expect(updated?.createdAt).toBe("2026-10-01T12:00:00.000Z");
    expect(updated?.priority).toBe(1);
    expect(updated?.stateName).toBe("In Progress");
    expect(updated?.stateType).toBe("started");
    const parsedLabels = JSON.parse(updated?.labelsJson || "[]");
    expect(parsedLabels).toEqual(["v1", "urgent"]);

    // Verify FTS5 reflects the updated title
    const searchOld = await searchCachedIssues(cache, { text: "UniqueOldTitleToBeReplaced" });
    expect(searchOld.length).toBe(0);
    const searchNew = await searchCachedIssues(cache, { text: "BrandNewTitleAfterReview" });
    expect(searchNew.length).toBe(1);
    expect(searchNew[0].identifier).toBe("CER-102");
  });

  test("patchIssueInCache marks issue completed with completedAt (close simulation)", async () => {
    patchIssueInCache(cache, {
      id: "33333333-4444-5555-6666-777777777777",
      identifier: "CER-103",
      title: "Task to be closed",
      stateName: "In Progress",
      stateType: "started",
      teamKey: "CER",
    });

    // Close issue
    const nowIso = new Date().toISOString();
    patchIssueInCache(cache, {
      identifier: "CER-103",
      stateName: "Done",
      stateType: "completed",
      completedAt: nowIso,
    });

    const closed = await getCachedIssue(cache, "CER-103");
    expect(closed?.stateName).toBe("Done");
    expect(closed?.stateType).toBe("completed");
    expect(closed?.completedAt).toBe(nowIso);

    // Active-only pull should exclude it
    const activeIssues = await pullCachedIssues(cache, { teamKey: "CER" });
    expect(activeIssues.map((i) => i.identifier)).not.toContain("CER-103");

    // All states pull should include it
    const allIssues = await pullCachedIssues(cache, { teamKey: "CER", state: "all" });
    expect(allIssues.map((i) => i.identifier)).toContain("CER-103");
  });

  test("deleteIssueFromCache removes issue and associated relations", async () => {
    patchIssueInCache(cache, {
      id: "44444444-5555-6666-7777-888888888888",
      identifier: "CER-104",
      title: "Issue to delete",
      teamKey: "CER",
    });
    patchIssueInCache(cache, {
      id: "55555555-6666-7777-8888-999999999999",
      identifier: "CER-105",
      title: "Related issue",
      teamKey: "CER",
    });

    // Insert a relation
    cache.db
      .insert(issueRelations)
      .values({
        id: "rel-1",
        issueId: "44444444-5555-6666-7777-888888888888",
        relatedIssueId: "55555555-6666-7777-8888-999999999999",
        type: "related",
      })
      .run();

    expect(await getCachedIssue(cache, "CER-104")).not.toBeNull();

    // Delete case-insensitively by identifier
    deleteIssueFromCache(cache, "cer-104");

    expect(await getCachedIssue(cache, "CER-104")).toBeNull();
    // Related issue should still exist
    expect(await getCachedIssue(cache, "CER-105")).not.toBeNull();

    // Relation should have been removed
    const remainingRelations = cache.db.select().from(issueRelations).all();
    expect(remainingRelations.length).toBe(0);

    // FTS search should also return 0 hits for deleted issue keyword
    const searchRes = await searchCachedIssues(cache, { text: "delete" });
    expect(searchRes.length).toBe(0);
  });
});
