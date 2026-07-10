import { describe, expect, test } from "bun:test";
import { isInteractive } from "../src/lib/interactive.js";

const tty = { stdinIsTTY: true, stdoutIsTTY: true };

describe("isInteractive", () => {
  test("true only when both streams are TTYs and --json absent", () => {
    expect(isInteractive(undefined, tty)).toBe(true);
    expect(isInteractive(false, tty)).toBe(true);
  });

  test("--json always wins", () => {
    expect(isInteractive(true, tty)).toBe(false);
  });

  test("piped stdout disables prompts", () => {
    expect(isInteractive(undefined, { ...tty, stdoutIsTTY: false })).toBe(false);
  });

  test("piped stdin disables prompts (echo '' | linearctl file)", () => {
    expect(isInteractive(undefined, { ...tty, stdinIsTTY: false })).toBe(false);
  });
});
