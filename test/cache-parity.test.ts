import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { openCacheDb, type CacheDbInstance } from "../src/core/cache/db.js";
import { patchIssueInCache } from "../src/core/cache/sync.js";
import { pullCachedIssues, searchCachedIssues, type PullIssue } from "../src/core/cache/query.js";

describe("Funnel Contract Parity & Schema Conformance", () => {
  let cache: CacheDbInstance;

  const fixtures = [
    {
      id: "10000000-0000-0000-0000-000000000001",
      identifier: "CER-201",
      number: 201,
      title: "Active bug in dispatch queue",
      description: "Dispatch queue worker fails on retry",
      priority: 1,
      priorityLabel: "Urgent",
      teamKey: "CER",
      stateName: "In Progress",
      stateType: "started",
      labels: ["backend", "bug"],
      url: "https://linear.app/cerebral-work/issue/CER-201",
      updatedAt: "2026-10-05T12:00:00.000Z",
      createdAt: "2026-10-01T10:00:00.000Z",
    },
    {
      id: "10000000-0000-0000-0000-000000000002",
      identifier: "CER-202",
      number: 202,
      title: "Feature request for offline mode",
      description: "Allow read caching for local CLI runs",
      priority: 2,
      priorityLabel: "High",
      teamKey: "CER",
      stateName: "Todo",
      stateType: "unstarted",
      labels: ["feature", "cache"],
      url: "https://linear.app/cerebral-work/issue/CER-202",
      updatedAt: "2026-10-04T12:00:00.000Z",
      createdAt: "2026-10-02T10:00:00.000Z",
    },
    {
      id: "10000000-0000-0000-0000-000000000003",
      identifier: "CER-203",
      number: 203,
      title: "Completed sprint retrospective",
      description: "Sprint 42 retrospective notes",
      priority: 3,
      priorityLabel: "Medium",
      teamKey: "CER",
      stateName: "Done",
      stateType: "completed",
      labels: ["ops"],
      url: "https://linear.app/cerebral-work/issue/CER-203",
      updatedAt: "2026-10-03T12:00:00.000Z",
      createdAt: "2026-10-01T10:00:00.000Z",
    },
    {
      id: "10000000-0000-0000-0000-000000000004",
      identifier: "CER-204",
      number: 204,
      title: "Cancelled exploratory spike",
      description: "",
      priority: 4,
      priorityLabel: "Low",
      teamKey: "CER",
      stateName: "Canceled",
      stateType: "canceled",
      labels: [],
      url: "https://linear.app/cerebral-work/issue/CER-204",
      updatedAt: "2026-10-02T12:00:00.000Z",
      createdAt: "2026-10-01T10:00:00.000Z",
    },
    {
      id: "10000000-0000-0000-0000-000000000005",
      identifier: "CER-205",
      number: 205,
      title: "Trashed issue that should be ignored",
      description: "Trashed test issue",
      priority: 0,
      teamKey: "CER",
      stateName: "Backlog",
      stateType: "backlog",
      trashed: true,
      url: "https://linear.app/cerebral-work/issue/CER-205",
      updatedAt: "2026-10-06T12:00:00.000Z",
      createdAt: "2026-10-01T10:00:00.000Z",
    },
  ];

  beforeEach(() => {
    cache = openCacheDb({ inMemory: true });
    for (const item of fixtures) {
      patchIssueInCache(cache, item);
    }
  });

  afterEach(() => {
    cache.close();
  });

  test("pullCachedIssues conforms exactly to the docs/funnel-contract.md PullIssue interface", async () => {
    const results = await pullCachedIssues(cache, { teamKey: "CER", state: "all" });

    // The 4 non-trashed issues should be returned
    expect(results.length).toBe(4);

    const requiredKeys: Array<keyof PullIssue & string> = [
      "id",
      "identifier",
      "title",
      "state",
      "stateType",
      "priority",
      "labels",
      "description",
      "url",
      "updatedAt",
    ];

    for (const issue of results) {
      for (const key of requiredKeys) {
        expect(issue).toHaveProperty(key);
      }

      // Assert types
      expect(typeof issue.id).toBe("string");
      expect(typeof issue.identifier).toBe("string");
      expect(typeof issue.title).toBe("string");
      expect(typeof issue.state).toBe("string");
      expect(typeof issue.stateType).toBe("string");
      expect(typeof issue.priority).toBe("number");
      expect(Array.isArray(issue.labels)).toBe(true);
      expect(typeof issue.description).toBe("string");
      expect(typeof issue.url).toBe("string");
      expect(typeof issue.updatedAt).toBe("string");

      // Verify URL formatting
      expect(issue.url).toStartWith("https://");

      // Verify ISO timestamp
      expect(new Date(issue.updatedAt).toISOString()).toBe(issue.updatedAt);
    }
  });

  test("active-only default excludes completed, canceled, and trashed issues", async () => {
    const active = await pullCachedIssues(cache, { teamKey: "CER" });
    const identifiers = active.map((i) => i.identifier);

    expect(identifiers).toContain("CER-201"); // In Progress
    expect(identifiers).toContain("CER-202"); // Todo
    expect(identifiers).not.toContain("CER-203"); // Done
    expect(identifiers).not.toContain("CER-204"); // Canceled
    expect(identifiers).not.toContain("CER-205"); // Trashed
  });

  test("state filters and aliases match expected workflow types", async () => {
    // Alias "in-progress" -> "started"
    const inProgress = await pullCachedIssues(cache, { teamKey: "CER", state: "in-progress" });
    expect(inProgress.map((i) => i.identifier)).toEqual(["CER-201"]);

    // Alias "todo" -> "unstarted"
    const todo = await pullCachedIssues(cache, { teamKey: "CER", state: "todo" });
    expect(todo.map((i) => i.identifier)).toEqual(["CER-202"]);

    // Literal state name "Done"
    const done = await pullCachedIssues(cache, { teamKey: "CER", state: "Done" });
    expect(done.map((i) => i.identifier)).toEqual(["CER-203"]);
  });

  test("multiple labels apply conjunction (AND) semantics", async () => {
    // Single label
    const backendOnly = await pullCachedIssues(cache, { teamKey: "CER", label: ["backend"], state: "all" });
    expect(backendOnly.map((i) => i.identifier)).toEqual(["CER-201"]);

    // Conjunction match
    const bothLabels = await pullCachedIssues(cache, { teamKey: "CER", label: ["backend", "bug"], state: "all" });
    expect(bothLabels.map((i) => i.identifier)).toEqual(["CER-201"]);

    // Conjunction miss
    const noMatch = await pullCachedIssues(cache, { teamKey: "CER", label: ["backend", "cache"], state: "all" });
    expect(noMatch.length).toBe(0);
  });

  test("results sort by updatedAt descending by default", async () => {
    const all = await pullCachedIssues(cache, { teamKey: "CER", state: "all" });
    const timestamps = all.map((i) => new Date(i.updatedAt).getTime());

    for (let i = 0; i < timestamps.length - 1; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i + 1]);
    }
  });

  test("searchCachedIssues conforms to SearchResult contract", async () => {
    const results = await searchCachedIssues(cache, { text: "offline" });
    expect(results.length).toBe(1);
    expect(results[0].identifier).toBe("CER-202");
    expect(results[0].title).toBe("Feature request for offline mode");
    expect(results[0].labels.sort()).toEqual(["cache", "feature"]);
  });
});
