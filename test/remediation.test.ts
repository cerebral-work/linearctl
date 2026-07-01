import { expect, test, describe } from "bun:test";
import { classifyError } from "../src/lib/retry.js";
import { parseBulkSpec } from "../src/core/bulk.js";

describe("classifyError", () => {
  test("treats Linear RATELIMITED (HTTP 400 + extensions) as transient", () => {
    const err = { status: 400, errors: [{ extensions: { code: "RATELIMITED" } }] };
    expect(classifyError(err)).toEqual({ transient: true, reason: "ratelimited" });
  });

  test("treats extensions.type RATELIMITED as transient", () => {
    const err = { status: 400, type: "Ratelimited" };
    expect(classifyError(err).transient).toBe(true);
  });

  test("treats 5xx as transient", () => {
    expect(classifyError({ status: 503 })).toEqual({ transient: true, reason: "http-503" });
    expect(classifyError({ status: 500 }).transient).toBe(true);
  });

  test("treats connection/upstream timeouts as transient", () => {
    expect(classifyError({ message: "upstream connect error or disconnect" }).transient).toBe(true);
    expect(classifyError({ message: "ETIMEDOUT" }).transient).toBe(true);
  });

  test("does NOT retry ordinary errors (e.g. bad input, 404)", () => {
    expect(classifyError({ status: 404, message: "not found" }).transient).toBe(false);
    expect(classifyError(new Error("unknown label")).transient).toBe(false);
  });
});

describe("parseBulkSpec", () => {
  test("parses a JSON array", () => {
    const items = parseBulkSpec('[{"id":"OPS-1","priority":2},{"id":"OPS-2","labels":["infra"]}]');
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({ id: "OPS-1", priority: 2 });
    expect(items[1].labels).toEqual(["infra"]);
  });

  test("parses NDJSON (one object per line)", () => {
    const items = parseBulkSpec('{"id":"OPS-1","addLabels":["security"]}\n{"id":"OPS-2","priority":4}');
    expect(items).toHaveLength(2);
    expect(items[0].addLabels).toEqual(["security"]);
    expect(items[1]).toEqual({ id: "OPS-2", priority: 4 });
  });

  test("empty input yields no items", () => {
    expect(parseBulkSpec("   ")).toEqual([]);
  });

  test("throws when an item lacks a string id", () => {
    expect(() => parseBulkSpec('[{"priority":2}]')).toThrow(/needs a string "id"/);
  });
});
