import { describe, expect, test } from "bun:test";
import { requireBody } from "../src/lib/io.js";

// CER-1872: `--desc -` with an empty stdin silently created title-only
// issues. `requireBody` is the guard every `-` body site now goes through.
describe("requireBody", () => {
  test("passes a non-empty body through unchanged", () => {
    expect(requireBody("--desc -", "hello **world**")).toBe("hello **world**");
  });

  test("throws on an empty body, naming the flag", () => {
    expect(() => requireBody("--desc -", "")).toThrow(/--desc -: stdin was empty/);
  });

  test("throws for --body - with an empty read", () => {
    expect(() => requireBody("--body -", "")).toThrow(/--body -: stdin was empty/);
  });

  test("preserves whitespace-bearing bodies (trimming is readStdin's job)", () => {
    expect(requireBody("--content -", "a\n\nb")).toBe("a\n\nb");
  });
});
