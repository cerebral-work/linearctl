import { describe, expect, test } from "bun:test";
import { parsePriority } from "../src/lib/priority.js";

describe("parsePriority", () => {
  test("0-4 pass through; none → 0", () => {
    expect(parsePriority("0")).toBe(0);
    expect(parsePriority("4")).toBe(4);
    expect(parsePriority("none")).toBe(0);
  });

  test("out-of-range, fractional, and words throw", () => {
    expect(() => parsePriority("5")).toThrow(/--priority/);
    expect(() => parsePriority("-1")).toThrow(/--priority/);
    expect(() => parsePriority("2.5")).toThrow(/--priority/);
    expect(() => parsePriority("high")).toThrow(/--priority/);
  });
});
