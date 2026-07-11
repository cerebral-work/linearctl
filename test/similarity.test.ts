import { describe, expect, test } from "bun:test";
import { tokenize, jaccard, scoreCandidates } from "../src/lib/similarity.js";

describe("tokenize", () => {
  test("lowercases, strips punctuation and stopwords", () => {
    expect(tokenize("Fix the Webhook — retry logic!")).toEqual(
      new Set(["fix", "webhook", "retry", "logic"]),
    );
  });
});

describe("jaccard", () => {
  test("identical sets score 1; disjoint score 0; empty-vs-empty is 0", () => {
    const a = tokenize("migrate voicenotes palette");
    expect(jaccard(a, tokenize("Migrate Voicenotes Palette"))).toBe(1);
    expect(jaccard(a, tokenize("unrelated gibberish xyz"))).toBe(0);
    expect(jaccard(new Set(), new Set())).toBe(0);
  });

  test("word order does not matter", () => {
    expect(
      jaccard(tokenize("voicenotes palette migrate"), tokenize("migrate voicenotes palette")),
    ).toBe(1);
  });
});

describe("scoreCandidates", () => {
  const items = [
    { title: "Migrate voicenotes off pre-seed palette" },
    { title: "Migrate voicenotes off the pre-seed palette onto living-terminal" },
    { title: "Ship the search command" },
  ];

  test("threshold filters, best-first, capped", () => {
    const r = scoreCandidates(
      "Migrate voicenotes off pre-seed palette",
      items,
      (i) => i.title,
      0.5,
      5,
    );
    expect(r[0].score).toBe(1);
    expect(r.map((c) => c.item.title)).not.toContain("Ship the search command");
  });

  test("limit caps results", () => {
    const many = Array.from({ length: 10 }, () => ({ title: "same title here" }));
    expect(scoreCandidates("same title here", many, (i) => i.title, 0.9, 3)).toHaveLength(3);
  });
});
