import { describe, expect, test } from "bun:test";
import { escapeTableCell } from "../src/roles/intake-triage.js";

describe("escapeTableCell", () => {
  test("leaves ordinary titles unchanged", () => {
    expect(escapeTableCell("ordinary issue title")).toBe("ordinary issue title");
  });

  test("escapes every Markdown table delimiter", () => {
    expect(escapeTableCell("first | second | third")).toBe("first \\| second \\| third");
  });

  test("escapes backslashes before pipes so an input backslash cannot neutralize the pipe escape", () => {
    expect(escapeTableCell(String.raw`prefix\|injected`)).toBe(String.raw`prefix\\\|injected`);
  });

  test("bounds the source before escaping", () => {
    expect(escapeTableCell("x".repeat(80) + "|ignored")).toBe("x".repeat(80));
    expect(escapeTableCell("x".repeat(79) + "|")).toBe("x".repeat(79) + "\\|");
  });
});
