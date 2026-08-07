import { describe, expect, test } from "bun:test";
import { buildSearchFilter } from "../src/core/search.js";

const NOW = new Date("2026-07-11T00:00:00Z");
const clauses = (f: ReturnType<typeof buildSearchFilter>) =>
  (f as { and?: Record<string, unknown>[] }).and ?? [];

describe("buildSearchFilter", () => {
  test("default scope excludes completed/canceled/duplicate", () => {
    expect(clauses(buildSearchFilter({}))).toContainEqual({
      state: { type: { nin: ["completed", "canceled", "duplicate"] } },
    });
  });

  test("--state duplicate maps to the duplicate type (CER-1930 sweep leak)", () => {
    expect(clauses(buildSearchFilter({ state: "duplicate" }))).toContainEqual({
      state: { type: { eq: "duplicate" } },
    });
  });

  test("--state all lifts the default scope entirely", () => {
    const and = clauses(buildSearchFilter({ state: "all" }));
    expect(and.some((c) => "state" in c)).toBe(false);
  });

  test("--state done maps to the completed type; todo → unstarted", () => {
    expect(clauses(buildSearchFilter({ state: "done" }))).toContainEqual({
      state: { type: { eq: "completed" } },
    });
    expect(clauses(buildSearchFilter({ state: "todo" }))).toContainEqual({
      state: { type: { eq: "unstarted" } },
    });
  });

  test("unknown --state falls back to a name match", () => {
    expect(clauses(buildSearchFilter({ state: "In Review" }))).toContainEqual({
      state: { name: { eqIgnoreCase: "In Review" } },
    });
  });

  test("multiple labels AND together", () => {
    const and = clauses(buildSearchFilter({ labels: ["bug", "mesh"] }));
    expect(and).toContainEqual({ labels: { some: { name: { eqIgnoreCase: "bug" } } } });
    expect(and).toContainEqual({ labels: { some: { name: { eqIgnoreCase: "mesh" } } } });
  });

  test("--assignee none filters unassigned; resolved id filters by id", () => {
    expect(clauses(buildSearchFilter({ assignee: "none" }))).toContainEqual({
      assignee: { null: true },
    });
    expect(clauses(buildSearchFilter({ assignee: "me" }, "uuid-1"))).toContainEqual({
      assignee: { id: { eq: "uuid-1" } },
    });
  });

  test("--priority none → 0; out-of-range throws", () => {
    expect(clauses(buildSearchFilter({ priority: "none" }))).toContainEqual({
      priority: { eq: 0 },
    });
    expect(() => buildSearchFilter({ priority: "9" })).toThrow(/--priority/);
    expect(() => buildSearchFilter({ priority: "high" })).toThrow(/--priority/);
  });

  test("--text ORs title and description contains", () => {
    expect(clauses(buildSearchFilter({ text: "rate limit" }))).toContainEqual({
      or: [
        { title: { containsIgnoreCase: "rate limit" } },
        { description: { containsIgnoreCase: "rate limit" } },
      ],
    });
  });

  test("windows convert to gte dates", () => {
    const and = clauses(buildSearchFilter({ updatedSince: "7d" }, undefined, NOW));
    const clause = and.find((c) => "updatedAt" in c) as {
      updatedAt: { gte: Date };
    };
    expect(clause.updatedAt.gte.toISOString()).toBe("2026-07-04T00:00:00.000Z");
  });

  test("team scoping lands outside and-clauses; 'all' unscopes", () => {
    expect(buildSearchFilter({ teamKeys: ["CER"] })).toMatchObject({
      team: { key: { in: ["CER"] } },
    });
    expect("team" in buildSearchFilter({ teamKeys: ["all"] })).toBe(false);
  });
});
