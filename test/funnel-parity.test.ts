import { describe, expect, test } from "bun:test";
import { buildSearchFilter } from "../src/core/search.js";
import { updateIssue } from "../src/core/issues.js";
import type { LinearClient } from "@linear/sdk";

const NOW = new Date("2026-07-24T00:00:00Z");
const clauses = (f: ReturnType<typeof buildSearchFilter>) =>
  (f as { and?: Record<string, unknown>[] }).and ?? [];

describe("buildSearchFilter — stateSet (multi-state OR)", () => {
  test("stateSet with two state-type aliases ORs them", () => {
    const and = clauses(buildSearchFilter({ stateSet: ["Todo", "Backlog"] }, undefined, NOW));
    // Should contain an `or` clause with two state-type eq filters
    const orClause = and.find((c) => "or" in c) as { or: unknown[] } | undefined;
    expect(orClause).toBeDefined();
    expect(orClause!.or).toContainEqual({ state: { type: { eq: "unstarted" } } });
    expect(orClause!.or).toContainEqual({ state: { type: { eq: "backlog" } } });
  });

  test("stateSet with a single value does not wrap in or (direct clause)", () => {
    const and = clauses(buildSearchFilter({ stateSet: ["Todo"] }, undefined, NOW));
    expect(and).toContainEqual({ state: { type: { eq: "unstarted" } } });
    expect(and.some((c) => "or" in c)).toBe(false);
  });

  test("stateSet with a state name (not a type alias) uses eqIgnoreCase", () => {
    const and = clauses(buildSearchFilter({ stateSet: ["In Review", "In Progress"] }, undefined, NOW));
    const orClause = and.find((c) => "or" in c) as { or: unknown[] } | undefined;
    expect(orClause).toBeDefined();
    expect(orClause!.or).toContainEqual({ state: { name: { eqIgnoreCase: "In Review" } } });
    expect(orClause!.or).toContainEqual({ state: { name: { eqIgnoreCase: "In Progress" } } });
  });

  test("stateSet takes precedence over --state; default active-only filter NOT applied", () => {
    const and = clauses(
      buildSearchFilter({ state: "done", stateSet: ["Todo", "Backlog"] }, undefined, NOW),
    );
    // Should NOT contain the done-type filter (stateSet wins)
    expect(and).not.toContainEqual({ state: { type: { eq: "completed" } } });
    // Should contain the stateSet OR
    expect(and.some((c) => "or" in c)).toBe(true);
    // Should NOT contain the default nin completed/canceled
    expect(and).not.toContainEqual({ state: { type: { nin: ["completed", "canceled"] } } });
  });

  test("stateSet mixed: one type alias + one state name", () => {
    const and = clauses(buildSearchFilter({ stateSet: ["Todo", "In Review"] }, undefined, NOW));
    const orClause = and.find((c) => "or" in c) as { or: unknown[] } | undefined;
    expect(orClause).toBeDefined();
    expect(orClause!.or).toContainEqual({ state: { type: { eq: "unstarted" } } });
    expect(orClause!.or).toContainEqual({ state: { name: { eqIgnoreCase: "In Review" } } });
  });
});

/**
 * The description-clobber bug (SEC tickets, EST-83 reproduction): some Linear
 * automation wiped a ticket's description to "# bulk-file-spec: skip" on a
 * state-only transition. The funnel contract REQUIRES that `update --state`
 * never round-trips the description — read state, write state, leave the body
 * alone. This test proves `updateIssue` with only `state` in the params does
 * NOT include `description` in the mutation input it sends to the SDK.
 */
describe("updateIssue — description-clobber guard", () => {
  test("state-only update does NOT send description in the mutation input", async () => {
    const capturedInputs: Record<string, unknown>[] = [];

    const team = { id: "team-est", key: "EST" };
    const client = {
      issue: () =>
        Promise.resolve({
          id: "issue-uuid-83",
          identifier: "EST-83",
          title: "smoke-test payload",
          url: "https://linear.app/x/EST-83",
          team: Promise.resolve(team),
        }),
      workflowStates: () =>
        Promise.resolve({
          nodes: [
            { id: "state-todo", name: "Todo", type: "unstarted" },
            { id: "state-backlog", name: "Backlog", type: "backlog" },
            { id: "state-ip", name: "In Progress", type: "started" },
            { id: "state-done", name: "Done", type: "completed" },
          ],
        }),
      updateIssue: (issueId: string, input: Record<string, unknown>) => {
        capturedInputs.push({ issueId, ...input });
        return Promise.resolve({
          success: true,
          issue: Promise.resolve({
            id: issueId,
            identifier: "EST-83",
            title: "smoke-test payload",
            url: "https://linear.app/x/EST-83",
            state: Promise.resolve({ name: "In Progress", type: "started" }),
            assignee: Promise.resolve(undefined),
          }),
        });
      },
    } as unknown as LinearClient;

    await updateIssue(client, "EST-83", { state: "In Progress" });

    expect(capturedInputs).toHaveLength(1);
    const input = capturedInputs[0];
    // The invariant: a state-only transition sends ONLY stateId, never description.
    expect(input).toHaveProperty("stateId");
    expect(input).not.toHaveProperty("description");
    expect(input).not.toHaveProperty("title");
  });

  test("state-only update sends ONLY stateId — no other field leaks", async () => {
    const capturedInputs: Record<string, unknown>[] = [];

    const team = { id: "team-est", key: "EST" };
    const client = {
      issue: () =>
        Promise.resolve({
          id: "issue-uuid-83",
          identifier: "EST-83",
          title: "smoke-test payload",
          url: "https://linear.app/x/EST-83",
          team: Promise.resolve(team),
        }),
      workflowStates: () =>
        Promise.resolve({
          nodes: [{ id: "state-ip", name: "In Progress", type: "started" }],
        }),
      updateIssue: (_issueId: string, input: Record<string, unknown>) => {
        capturedInputs.push(input);
        return Promise.resolve({
          success: true,
          issue: Promise.resolve({
            id: "issue-uuid-83",
            identifier: "EST-83",
            title: "smoke-test payload",
            url: "https://linear.app/x/EST-83",
            state: Promise.resolve({ name: "In Progress", type: "started" }),
            assignee: Promise.resolve(undefined),
          }),
        });
      },
    } as unknown as LinearClient;

    await updateIssue(client, "EST-83", { state: "In Progress" });

    // The only key in the mutation input should be stateId.
    expect(Object.keys(capturedInputs[0])).toEqual(["stateId"]);
  });
});
