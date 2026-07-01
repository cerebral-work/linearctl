import { describe, expect, test } from "bun:test";
import { extractRefs, planXrefFixes, type XrefFinding } from "../src/core/xref.js";

const pr = (over: Partial<{ headRefName: string; title: string; body: string | null }>) => ({
  number: 1,
  title: "",
  body: null,
  headRefName: "",
  url: "https://g/1",
  ...over,
});

describe("extractRefs closing classification", () => {
  test("Closes/Fixes/Resolves body refs are closing; Refs/branch/title are not", () => {
    const { refs, closing } = extractRefs(
      pr({
        headRefName: "feat/cer-3-things",
        title: "feat: stuff (CER-4)",
        body: "Closes CER-1. Refs CER-2.",
      }),
    );
    expect(refs.sort()).toEqual(["CER-1", "CER-2", "CER-3", "CER-4"]);
    expect(closing).toEqual(["CER-1"]);
  });

  test("markdown-wrapped closing refs still classify", () => {
    const { closing } = extractRefs(pr({ body: "fixes **CER-7**" }));
    expect(closing).toEqual(["CER-7"]);
  });
});

function finding(over: Partial<XrefFinding>): XrefFinding {
  return {
    kind: "merged-pr-ticket-not-done",
    pr: 10,
    prTitle: "t",
    prUrl: "u",
    refs: ["CER-1"],
    detail: "d",
    ...over,
  };
}

describe("planXrefFixes", () => {
  test("closing ref → close, regardless of started state", () => {
    expect(
      planXrefFixes([
        finding({ refs: ["CER-1"], closing: true, stateType: "unstarted" }),
        finding({ refs: ["CER-2"], closing: true, stateType: "started" }),
      ]).map((a) => [a.ref, a.action]),
    ).toEqual([
      ["CER-1", "close"],
      ["CER-2", "close"],
    ]);
  });

  test("non-closing ref on an unstarted/backlog/triage ticket → start", () => {
    expect(
      planXrefFixes([
        finding({ refs: ["CER-3"], closing: false, stateType: "unstarted" }),
        finding({ refs: ["CER-4"], closing: false, stateType: "backlog" }),
        finding({ refs: ["CER-5"], closing: false, stateType: "triage" }),
      ]).map((a) => [a.ref, a.action]),
    ).toEqual([
      ["CER-3", "start"],
      ["CER-4", "start"],
      ["CER-5", "start"],
    ]);
  });

  test("non-closing ref on an already-started ticket → no action", () => {
    expect(planXrefFixes([finding({ closing: false, stateType: "started" })])).toEqual([]);
  });

  test("canceled tickets are never touched", () => {
    expect(planXrefFixes([finding({ closing: true, stateType: "canceled" })])).toEqual([]);
  });

  test("same ref across findings dedupes; closing wins over start", () => {
    const plan = planXrefFixes([
      finding({ pr: 11, refs: ["CER-6"], closing: false, stateType: "unstarted" }),
      finding({ pr: 12, refs: ["CER-6"], closing: true, stateType: "unstarted" }),
    ]);
    expect(plan.map((a) => [a.ref, a.action])).toEqual([["CER-6", "close"]]);
  });

  test("non-remediable finding kinds are ignored", () => {
    expect(
      planXrefFixes([finding({ kind: "open-pr-no-ticket", refs: [] })]),
    ).toEqual([]);
  });
});

import { startIssue } from "../src/core/issues.js";

describe("startIssue", () => {
  test("moves the issue to the team's started state, preferring 'In Progress'", async () => {
    let captured: { id?: string; input?: Record<string, unknown> } = {};
    const client = {
      issue: () =>
        Promise.resolve({
          id: "uuid-9",
          identifier: "CER-9",
          title: "T",
          url: "u",
          team: Promise.resolve({ id: "team-1" }),
          state: Promise.resolve({ name: "Todo", type: "unstarted" }),
          assignee: Promise.resolve(undefined),
        }),
      workflowStates: () =>
        Promise.resolve({
          nodes: [
            { id: "s-doing", name: "Doing", type: "started" },
            { id: "s-inprog", name: "In Progress", type: "started" },
            { id: "s-done", name: "Done", type: "completed" },
          ],
        }),
      updateIssue: (id: string, input: Record<string, unknown>) => {
        captured = { id, input };
        return Promise.resolve({
          success: true,
          issue: Promise.resolve({
            id: "uuid-9",
            identifier: "CER-9",
            title: "T",
            url: "u",
            state: Promise.resolve({ name: "In Progress", type: "started" }),
            assignee: Promise.resolve(undefined),
          }),
        });
      },
    } as unknown as import("@linear/sdk").LinearClient;

    const res = await startIssue(client, "CER-9");
    expect(captured.input).toEqual({ stateId: "s-inprog" });
    expect(res.state).toBe("In Progress");
  });
});
