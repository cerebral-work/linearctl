import { describe, expect, test } from "bun:test";
import { pickLabelIds } from "../src/lib/labels.js";

const available = [
  { id: "id-bug", name: "Bug" },
  { id: "id-mesh", name: "mesh" },
  { id: "id-m2", name: "M2" },
];

describe("pickLabelIds", () => {
  test("empty request resolves to no ids", () => {
    expect(pickLabelIds(available, [])).toEqual([]);
  });

  test("matches case-insensitively and preserves request order", () => {
    expect(pickLabelIds(available, ["bug", "M2"])).toEqual(["id-bug", "id-m2"]);
    expect(pickLabelIds(available, ["MESH"])).toEqual(["id-mesh"]);
  });

  test("trims surrounding whitespace", () => {
    expect(pickLabelIds(available, ["  bug  "])).toEqual(["id-bug"]);
  });

  test("throws listing every unmatched name", () => {
    expect(() => pickLabelIds(available, ["bug", "nope", "missing"])).toThrow(
      /unknown label\(s\): "nope", "missing"/,
    );
  });
});
