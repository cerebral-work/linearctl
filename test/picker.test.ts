import { describe, expect, test } from "bun:test";
import { issueChoices } from "../src/lib/prompts.js";

const items = [
  { identifier: "CER-1", title: "Fix webhook retry" },
  { identifier: "CER-22", title: "Refactor batch backoff" },
  { identifier: "OPS-9", title: "Retry queue drain" },
];

describe("issueChoices", () => {
  test("empty term lists everything (capped)", () => {
    expect(issueChoices(items, "").map((c) => c.value)).toEqual([
      "CER-1",
      "CER-22",
      "OPS-9",
    ]);
  });

  test("substring match spans identifier and title, case-insensitive", () => {
    expect(issueChoices(items, "retry").map((c) => c.value)).toEqual([
      "CER-1",
      "OPS-9",
    ]);
    // "cer-2" is also identifier-shaped: direct-use entry appends AFTER the
    // real match so Enter-on-first still selects CER-22.
    expect(issueChoices(items, "cer-2").map((c) => c.value)).toEqual([
      "CER-22",
      "CER-2",
    ]);
  });

  test("identifier-shaped term with no matches is offered directly (sole choice)", () => {
    expect(issueChoices(items, "cer-999")).toEqual([
      { name: "CER-999 (use directly)", value: "CER-999" },
    ]);
  });

  test("identifier-shaped term already matched is not duplicated", () => {
    const values = issueChoices(items, "ops-9").map((c) => c.value);
    expect(values).toEqual(["OPS-9"]);
  });

  test("caps at 25 choices", () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      identifier: `CER-${i}`,
      title: "x",
    }));
    expect(issueChoices(many, "").length).toBe(25);
  });
});
