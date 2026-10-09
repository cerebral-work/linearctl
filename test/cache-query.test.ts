import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { openCacheDb, type CacheDbInstance } from "../src/core/cache/db.js";
import { issues, users, cacheMeta, type InsertIssue } from "../src/core/cache/schema.js";
import type { PullIssue } from "../src/core/pull.js";
import type { CacheSearchOptions } from "../src/core/cache/query.js";
import {
  pullCachedIssues,
  searchCachedIssues,
  getCachedIssue,
  STATE_TYPE_ALIASES,
} from "../src/core/cache/query.js";

describe("Cached Issue Queries & Funnel Contract Conformance", () => {
  let cache: CacheDbInstance;

  const sampleIssues: InsertIssue[] = [
    {
      id: "7b638a93-cc26-48e0-b6cf-98e890165809",
      identifier: "EST-83",
      number: 83,
      title: "soma smoke-test payload",
      description: "Full markdown body of the issue payload",
      priority: 3,
      priorityLabel: "Normal",
      teamKey: "EST",
      stateName: "Todo",
      stateType: "unstarted",
      url: "https://linear.app/cerebral-work/issue/EST-83/soma-smoke-test-payload",
      labelsJson: JSON.stringify(["soma-ingest"]),
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-24T16:52:01.638Z",
    },
    {
      id: "b213949e-d36c-4861-a083-d56691656b27",
      identifier: "EST-84",
      number: 84,
      title: "High priority memory leak in agent supervisor",
      description: "Supervisor process leaks 50MB per reconcile cycle",
      priority: 2,
      priorityLabel: "High",
      teamKey: "EST",
      stateName: "In Progress",
      stateType: "started",
      url: "https://linear.app/cerebral-work/issue/EST-84",
      labelsJson: JSON.stringify(["soma-ingest", "bug"]),
      createdAt: "2026-07-24T11:00:00.000Z",
      updatedAt: "2026-07-24T18:00:00.000Z",
    },
    {
      id: "d9e8324a-253c-4ef7-b249-114457788990",
      identifier: "EST-85",
      number: 85,
      title: "Completed migration ticket",
      description: "Old cluster migration completed successfully",
      priority: 4,
      priorityLabel: "Low",
      teamKey: "EST",
      stateName: "Done",
      stateType: "completed",
      url: "https://linear.app/cerebral-work/issue/EST-85",
      labelsJson: JSON.stringify(["ops"]),
      createdAt: "2026-07-20T10:00:00.000Z",
      updatedAt: "2026-07-24T19:00:00.000Z",
    },
    {
      id: "a12b34cd-56ef-7890-abcd-ef1234567890",
      identifier: "EST-86",
      number: 86,
      title: "Canceled experimental probe",
      description: "",
      priority: 0,
      priorityLabel: "None",
      teamKey: "EST",
      stateName: "Canceled",
      stateType: "canceled",
      url: "https://linear.app/cerebral-work/issue/EST-86",
      labelsJson: JSON.stringify([]),
      createdAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-24T15:00:00.000Z",
    },
    {
      id: "e44d55cc-66bb-77aa-8899-001122334455",
      identifier: "CORE-12",
      number: 12,
      title: "Database schema migration runner",
      description: "Automate schema migrations in CI",
      priority: 1,
      priorityLabel: "Urgent",
      teamKey: "CORE",
      stateName: "Todo",
      stateType: "unstarted",
      url: "https://linear.app/cerebral-work/issue/CORE-12",
      labelsJson: JSON.stringify(["infra"]),
      createdAt: "2026-07-24T12:00:00.000Z",
      updatedAt: "2026-07-24T17:30:00.000Z",
    },
  ];

  beforeEach(() => {
    cache = openCacheDb({ inMemory: true });
    for (const issue of sampleIssues) {
      cache.db.insert(issues).values(issue).run();
    }
  });

  afterEach(() => {
    cache.close();
  });

  describe("PullIssue schema conformance (docs/funnel-contract.md)", () => {
    test("every pulled issue conforms exactly to the PullIssue schema contract", () => {
      const results = pullCachedIssues(cache, { state: "all" });
      expect(results.length).toBeGreaterThan(0);

      for (const item of results) {
        // 1. id: UUID string
        expect(typeof item.id).toBe("string");
        expect(item.id.length).toBeGreaterThan(0);

        // 2. identifier: human ref (TEAM-N)
        expect(typeof item.identifier).toBe("string");
        expect(item.identifier).toMatch(/^[A-Z]+-\d+$/);

        // 3. title: non-empty string
        expect(typeof item.title).toBe("string");

        // 4. state: workflow state name
        expect(typeof item.state).toBe("string");
        expect(item.state.length).toBeGreaterThan(0);

        // 5. stateType: category enum
        expect(typeof item.stateType).toBe("string");
        expect([
          "triage",
          "backlog",
          "unstarted",
          "started",
          "completed",
          "canceled",
          "duplicate",
        ]).toContain(item.stateType);

        // 6. priority: integer 0-4
        expect(typeof item.priority).toBe("number");
        expect(item.priority).toBeGreaterThanOrEqual(0);
        expect(item.priority).toBeLessThanOrEqual(4);

        // 7. labels: sorted array, NEVER null
        expect(Array.isArray(item.labels)).toBe(true);
        expect(item.labels).not.toBeNull();
        const sortedLabels = [...item.labels].sort();
        expect(item.labels).toEqual(sortedLabels);

        // 8. description: string, NEVER null (default "")
        expect(typeof item.description).toBe("string");
        expect(item.description).not.toBeNull();

        // 9. url: canonical Linear URL
        expect(typeof item.url).toBe("string");
        expect(item.url.startsWith("https://linear.app/")).toBe(true);

        // 10. updatedAt: ISO-8601 UTC timestamp
        expect(typeof item.updatedAt).toBe("string");
        expect(new Date(item.updatedAt).toISOString()).toBe(item.updatedAt);
      }
    });

    test("specific EST-83 payload matches exact funnel contract example", () => {
      const results = pullCachedIssues(cache, { stateSet: ["Todo"] });
      const est83 = results.find((i) => i.identifier === "EST-83");

      expect(est83).toBeDefined();
      expect(est83).toEqual({
        id: "7b638a93-cc26-48e0-b6cf-98e890165809",
        identifier: "EST-83",
        title: "soma smoke-test payload",
        state: "Todo",
        stateType: "unstarted",
        priority: 3,
        labels: ["soma-ingest"],
        description: "Full markdown body of the issue payload",
        url: "https://linear.app/cerebral-work/issue/EST-83/soma-smoke-test-payload",
        updatedAt: "2026-07-24T16:52:01.638Z",
      });
    });
  });

  describe("Query filtering logic", () => {
    test("default scope is active only (completed and canceled excluded)", () => {
      const results = pullCachedIssues(cache);
      const identifiers = results.map((r) => r.identifier);

      // Should include unstarted and started issues
      expect(identifiers).toContain("EST-83");
      expect(identifiers).toContain("EST-84");
      expect(identifiers).toContain("CORE-12");

      // Should exclude completed and canceled
      expect(identifiers).not.toContain("EST-85"); // Done
      expect(identifiers).not.toContain("EST-86"); // Canceled
    });

    test("--state all lifts default active filter and returns all issues", () => {
      const results = pullCachedIssues(cache, { state: "all" });
      const identifiers = results.map((r) => r.identifier);

      expect(identifiers).toContain("EST-83");
      expect(identifiers).toContain("EST-84");
      expect(identifiers).toContain("EST-85");
      expect(identifiers).toContain("EST-86");
      expect(identifiers).toContain("CORE-12");
      expect(results).toHaveLength(5);
    });

    test("filter by team key scopes to specified team only", () => {
      const estResults = pullCachedIssues(cache, { teamKeys: ["EST"] });
      expect(estResults.every((r) => r.identifier.startsWith("EST-"))).toBe(true);
      expect(estResults.some((r) => r.identifier === "CORE-12")).toBe(false);

      const coreResults = pullCachedIssues(cache, { teamKeys: ["CORE"] });
      expect(coreResults).toHaveLength(1);
      expect(coreResults[0].identifier).toBe("CORE-12");
    });

    test("filter by state alias (e.g. todo -> unstarted)", () => {
      const results = pullCachedIssues(cache, { state: "todo" });
      expect(results.every((r) => r.stateType === "unstarted")).toBe(true);
      expect(results.map((r) => r.identifier).sort()).toEqual(["CORE-12", "EST-83"]);
    });

    test("filter by stateSet with multiple states (OR logic)", () => {
      const results = pullCachedIssues(cache, { stateSet: ["Todo", "In Progress"] });
      const identifiers = results.map((r) => r.identifier).sort();

      expect(identifiers).toEqual(["CORE-12", "EST-83", "EST-84"]);
    });

    test("filter by labels (AND logic: all specified labels must match)", () => {
      // Single label: "soma-ingest" matches EST-83 and EST-84
      const singleLabel = pullCachedIssues(cache, { labels: ["soma-ingest"] });
      expect(singleLabel.map((r) => r.identifier).sort()).toEqual(["EST-83", "EST-84"]);

      // Multiple labels: "soma-ingest" AND "bug" matches EST-84 only
      const multiLabel = pullCachedIssues(cache, { labels: ["soma-ingest", "bug"] });
      expect(multiLabel.map((r) => r.identifier)).toEqual(["EST-84"]);

      // Non-matching label combination returns empty
      const emptyLabel = pullCachedIssues(cache, { labels: ["soma-ingest", "nonexistent"] });
      expect(emptyLabel).toHaveLength(0);
    });

    test("filter by priority", () => {
      const urgentResults = pullCachedIssues(cache, { priority: "1" });
      expect(urgentResults).toHaveLength(1);
      expect(urgentResults[0].identifier).toBe("CORE-12");

      const highResults = pullCachedIssues(cache, { priority: 2 });
      expect(highResults).toHaveLength(1);
      expect(highResults[0].identifier).toBe("EST-84");
    });

    test("filter by full-text query (text)", () => {
      // Search in description
      const leakResults = searchCachedIssues(cache, { text: "reconcile" });
      expect(leakResults.map((r) => r.identifier)).toEqual(["EST-84"]);

      // Search in title
      const dbResults = searchCachedIssues(cache, { text: "migration" });
      expect(dbResults.map((r) => r.identifier)).toEqual(["CORE-12"]);
    });

    test("ordering is strictly updatedAt descending (sliding window invariant)", () => {
      const results = pullCachedIssues(cache, { state: "all" });
      for (let i = 0; i < results.length - 1; i++) {
        const current = new Date(results[i].updatedAt).getTime();
        const next = new Date(results[i + 1].updatedAt).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }
    });

    test("limit caps returned issues according to sliding window", () => {
      const limited = pullCachedIssues(cache, { state: "all", limit: 2 });
      expect(limited).toHaveLength(2);
      // The 2 most recently updated issues in sampleIssues are EST-85 (19:00) and EST-84 (18:00)
      expect(limited[0].identifier).toBe("EST-85");
      expect(limited[1].identifier).toBe("EST-84");
    });
  });

  describe("getCachedIssue lookup", () => {
    test("retrieves issue by UUID", () => {
      const issue = getCachedIssue(cache, "7b638a93-cc26-48e0-b6cf-98e890165809");
      expect(issue).not.toBeNull();
      expect(issue?.identifier).toBe("EST-83");
      expect(issue?.title).toBe("soma smoke-test payload");
    });

    test("retrieves issue by identifier case-insensitively", () => {
      const upper = getCachedIssue(cache, "EST-84");
      expect(upper).not.toBeNull();
      expect(upper?.id).toBe("b213949e-d36c-4861-a083-d56691656b27");

      const lower = getCachedIssue(cache, "est-84");
      expect(lower).not.toBeNull();
      expect(lower?.id).toBe("b213949e-d36c-4861-a083-d56691656b27");
    });

    test("returns null for non-existent issue or empty query", () => {
      expect(getCachedIssue(cache, "NONEXISTENT-999")).toBeNull();
      expect(getCachedIssue(cache, "")).toBeNull();
      expect(getCachedIssue(cache, "   ")).toBeNull();
    });
  });

  describe("LIKE search and fallback behavior", () => {
    test("wildcard text query triggers LIKE matching", () => {
      const results = searchCachedIssues(cache, { text: "%leak%" });
      expect(results).toHaveLength(1);
      expect(results[0].identifier).toBe("EST-84");
    });

    test("wildcard text query matches case-insensitively across title or description", () => {
      const results = searchCachedIssues(cache, { text: "%SMOKE%" });
      expect(results).toHaveLength(1);
      expect(results[0].identifier).toBe("EST-83");
    });
  });

  describe("Assignee filtering and offline viewer resolution", () => {
    beforeEach(() => {
      const now = new Date().toISOString();
      cache.db
        .insert(cacheMeta)
        .values([
          { key: "viewer_id", value: "usr-viewer-123", updatedAt: now },
          { key: "viewer_name", value: "Chris Todie", updatedAt: now },
          { key: "viewer_display_name", value: "ctodie", updatedAt: now },
          { key: "viewer_email", value: "chris@todie.io", updatedAt: now },
        ])
        .run();

      cache.db
        .insert(users)
        .values([
          {
            id: "usr-viewer-123",
            name: "Chris Todie",
            displayName: "ctodie",
            email: "chris@todie.io",
            active: true,
          },
          {
            id: "usr-alice-456",
            name: "Alice Engineer",
            displayName: "alice",
            email: "alice@example.com",
            active: true,
          },
        ])
        .run();

      // Update sample issues with assignees
      cache.sqlite
        .query(
          "UPDATE issues SET assignee_id = 'usr-viewer-123', assignee_name = 'Chris Todie' WHERE identifier = 'EST-83'"
        )
        .run();
      cache.sqlite
        .query(
          "UPDATE issues SET assignee_id = 'usr-alice-456', assignee_name = 'Alice Engineer' WHERE identifier = 'EST-84'"
        )
        .run();
      cache.sqlite
        .query(
          "UPDATE issues SET assignee_id = NULL, assignee_name = NULL WHERE identifier IN ('EST-85', 'EST-86', 'CORE-12')"
        )
        .run();
    });

    test("--assignee me resolves offline via cache_meta viewer attributes", () => {
      const results = pullCachedIssues(cache, { assignee: "me" });
      expect(results).toHaveLength(1);
      expect(results[0].identifier).toBe("EST-83");
    });

    test("--assignee me matches via user email link when assignee_id differs but email matches", () => {
      cache.db
        .insert(users)
        .values({
          id: "usr-alt-789",
          name: "Alternate Account",
          displayName: "alt",
          email: "chris@todie.io",
          active: true,
        })
        .run();
      cache.sqlite
        .query(
          "UPDATE issues SET assignee_id = 'usr-alt-789', assignee_name = 'Alternate Account' WHERE identifier = 'CORE-12'"
        )
        .run();

      const results = pullCachedIssues(cache, { assignee: "me" });
      const ids = results.map((r) => r.identifier).sort();
      expect(ids).toEqual(["CORE-12", "EST-83"]);
    });

    test("--assignee none / unassigned filters for unassigned issues", () => {
      const noneResults = pullCachedIssues(cache, { assignee: "none" });
      expect(noneResults.map((r) => r.identifier)).toContain("CORE-12");
      expect(noneResults.map((r) => r.identifier)).not.toContain("EST-83");
      expect(noneResults.map((r) => r.identifier)).not.toContain("EST-84");

      const unassignedResults = pullCachedIssues(cache, { assignee: "unassigned" });
      expect(unassignedResults.map((r) => r.identifier)).toEqual(noneResults.map((r) => r.identifier));
    });

    test("filter by specific assignee username or display name", () => {
      const results = pullCachedIssues(cache, { assignee: "alice" });
      expect(results).toHaveLength(1);
      expect(results[0].identifier).toBe("EST-84");
    });

    test("searchCachedIssues also respects --assignee me", () => {
      const results = searchCachedIssues(cache, { assignee: "me" });
      expect(results).toHaveLength(1);
      expect(results[0].identifier).toBe("EST-83");
    });
  });
});

