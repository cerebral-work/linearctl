import { describe, expect, test } from "bun:test";
import { gateFixPlan } from "../src/commands/xref.js";
import type { XrefFixAction } from "../src/core/xref.js";

const plan: XrefFixAction[] = [
  { ref: "CER-1", action: "close", reason: "closing ref in merged PR" },
  { ref: "CER-2", action: "start", reason: "bare ref on never-started ticket" },
  { ref: "CER-3", action: "close", reason: "closing ref in merged PR" },
];

const script = (answers: string[]) => {
  let i = 0;
  return async () => answers[i++];
};

describe("gateFixPlan", () => {
  test("yes to each confirms all", async () => {
    const r = await gateFixPlan(plan, script(["yes", "yes", "yes"]));
    expect(r.confirmed.map((a) => a.ref)).toEqual(["CER-1", "CER-2", "CER-3"]);
    expect(r.skipped).toEqual([]);
  });

  test("no skips just that action", async () => {
    const r = await gateFixPlan(plan, script(["yes", "no", "yes"]));
    expect(r.confirmed.map((a) => a.ref)).toEqual(["CER-1", "CER-3"]);
    expect(r.skipped.map((s) => s.ref)).toEqual(["CER-2"]);
    expect(r.skipped[0].error).toBe("skipped (declined)");
  });

  test("all fast-tracks the remainder without further prompts", async () => {
    let asks = 0;
    const r = await gateFixPlan(plan, async () => (asks++, "all"));
    expect(asks).toBe(1);
    expect(r.confirmed.map((a) => a.ref)).toEqual(["CER-1", "CER-2", "CER-3"]);
  });

  test("abort skips everything remaining, including the current action", async () => {
    const r = await gateFixPlan(plan, script(["yes", "abort"]));
    expect(r.confirmed.map((a) => a.ref)).toEqual(["CER-1"]);
    expect(r.skipped.map((s) => s.ref)).toEqual(["CER-2", "CER-3"]);
    expect(r.skipped.every((s) => s.error === "skipped (aborted)")).toBe(true);
  });
});
