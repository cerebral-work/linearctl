import { describe, expect, test } from "bun:test";
import {
  checkHold,
  MutationBudget,
  resolveMutationBudget,
  DEFAULT_HOLD_FILE,
  DEFAULT_MUTATION_BUDGET,
} from "../src/core/containment.js";
import {
  assertWithinGuardrails,
  denyLabels,
  partitionDeniedTargets,
  GuardrailError,
} from "../src/core/guardrails.js";

describe("checkHold", () => {
  test("not held with clean env and no hold file", () => {
    expect(checkHold({}, () => false)).toEqual({ held: false });
  });

  test("LINEARCTL_HOLD=1 engages the hold", () => {
    const state = checkHold({ LINEARCTL_HOLD: "1" }, () => false);
    expect(state.held).toBe(true);
    if (state.held) expect(state.reason).toContain("LINEARCTL_HOLD=1");
  });

  test("hold file at the default path engages the hold", () => {
    const state = checkHold({}, (p) => p === DEFAULT_HOLD_FILE);
    expect(state.held).toBe(true);
    if (state.held) expect(state.reason).toContain(DEFAULT_HOLD_FILE);
  });

  test("LINEARCTL_HOLD_FILE overrides the checked path", () => {
    const probed: string[] = [];
    const state = checkHold({ LINEARCTL_HOLD_FILE: "/tmp/custom-hold" }, (p) => {
      probed.push(p);
      return p === "/tmp/custom-hold";
    });
    expect(state.held).toBe(true);
    expect(probed).toEqual(["/tmp/custom-hold"]);
  });

  test("LINEARCTL_HOLD other than '1' does not hold", () => {
    expect(checkHold({ LINEARCTL_HOLD: "0" }, () => false).held).toBe(false);
  });
});

describe("resolveMutationBudget", () => {
  test("defaults to DEFAULT_MUTATION_BUDGET", () => {
    expect(resolveMutationBudget({})).toBe(DEFAULT_MUTATION_BUDGET);
  });

  test("reads LINEARCTL_MUTATION_BUDGET", () => {
    expect(resolveMutationBudget({ LINEARCTL_MUTATION_BUDGET: "3" })).toBe(3);
  });

  test("zero is a legal budget (write-freeze)", () => {
    expect(resolveMutationBudget({ LINEARCTL_MUTATION_BUDGET: "0" })).toBe(0);
  });

  test("garbage throws", () => {
    expect(() => resolveMutationBudget({ LINEARCTL_MUTATION_BUDGET: "many" })).toThrow(
      /non-negative integer/,
    );
    expect(() => resolveMutationBudget({ LINEARCTL_MUTATION_BUDGET: "-1" })).toThrow();
  });
});

describe("MutationBudget", () => {
  test("trySpend grants up to remaining and narrates the shortfall via count", () => {
    const b = new MutationBudget(10);
    expect(b.trySpend(4)).toBe(4);
    expect(b.remaining).toBe(6);
    expect(b.trySpend(10)).toBe(6);
    expect(b.remaining).toBe(0);
    expect(b.trySpend(1)).toBe(0);
  });

  test("spend throws past the cap", () => {
    const b = new MutationBudget(1);
    b.spend(1);
    expect(() => b.spend(1)).toThrow(/budget exhausted/);
  });
});

describe("deny labels (dual-writer split §2b2)", () => {
  test("default deny set is soma-ingest", () => {
    expect([...denyLabels({})]).toEqual(["soma-ingest"]);
  });

  test("LINEARCTL_DENY_LABELS replaces the set, case-insensitive", () => {
    const set = denyLabels({ LINEARCTL_DENY_LABELS: "Soma-Ingest, other-writer" });
    expect(set.has("soma-ingest")).toBe(true);
    expect(set.has("other-writer")).toBe(true);
  });

  test("assertWithinGuardrails throws on a deny-labeled target", () => {
    expect(() =>
      assertWithinGuardrails({
        kind: "comment",
        target: "EST-83",
        targetLabels: ["bug", "soma-ingest"],
      }),
    ).toThrow(GuardrailError);
  });

  test("deny match is case-insensitive on the issue's label", () => {
    expect(() =>
      assertWithinGuardrails({ kind: "label", target: "EST-83", targetLabels: ["Soma-Ingest"] }),
    ).toThrow(/deny label/);
  });

  test("clean labels pass; absent targetLabels is not checked here", () => {
    expect(() =>
      assertWithinGuardrails({ kind: "comment", target: "CER-1", targetLabels: ["bug"] }),
    ).not.toThrow();
    expect(() => assertWithinGuardrails({ kind: "comment", target: "CER-1" })).not.toThrow();
  });

  test("partitionDeniedTargets splits a batch by deny label", () => {
    const items = [
      { identifier: "CER-1", labels: ["bug"] },
      { identifier: "EST-83", labels: ["soma-ingest"] },
      { identifier: "CER-2", labels: [] },
    ];
    const { allowed, denied } = partitionDeniedTargets(items, {});
    expect(allowed.map((i) => i.identifier)).toEqual(["CER-1", "CER-2"]);
    expect(denied.map((i) => i.identifier)).toEqual(["EST-83"]);
  });
});
