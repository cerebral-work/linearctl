import { describe, expect, test } from "bun:test";
import { sinceToDate } from "../src/lib/time.js";

describe("sinceToDate", () => {
  const now = new Date("2026-06-03T12:00:00.000Z");

  test("a bare integer is days", () => {
    expect(sinceToDate("7", now).toISOString()).toBe("2026-05-27T12:00:00.000Z");
    expect(sinceToDate("7d", now).toISOString()).toBe("2026-05-27T12:00:00.000Z");
  });

  test("supports s / m / h / d / w units", () => {
    expect(sinceToDate("45s", now).toISOString()).toBe("2026-06-03T11:59:15.000Z");
    expect(sinceToDate("30m", now).toISOString()).toBe("2026-06-03T11:30:00.000Z");
    expect(sinceToDate("24h", now).toISOString()).toBe("2026-06-02T12:00:00.000Z");
    expect(sinceToDate("2w", now).toISOString()).toBe("2026-05-20T12:00:00.000Z");
  });

  test("trims surrounding whitespace", () => {
    expect(sinceToDate("  7d  ", now).toISOString()).toBe("2026-05-27T12:00:00.000Z");
  });

  test("throws on malformed input", () => {
    expect(() => sinceToDate("soon", now)).toThrow(/invalid --since/);
    expect(() => sinceToDate("7y", now)).toThrow(/invalid --since/);
    expect(() => sinceToDate("", now)).toThrow(/invalid --since/);
  });
});
