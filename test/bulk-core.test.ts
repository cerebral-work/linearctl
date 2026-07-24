import { describe, expect, test } from "bun:test";
import { parseBulkSpec } from "../src/core/bulk.js";

describe("parseBulkSpec", () => {
  test("parses a JSON array of spec items", () => {
    const result = parseBulkSpec(
      JSON.stringify([
        { id: "OPS-1", priority: 1 },
        { id: "OPS-2", priority: 1 },
      ]),
    );

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("OPS-1");
    expect(result[1].id).toBe("OPS-2");
  });

  test("parses NDJSON (one object per line)", () => {
    const result = parseBulkSpec(
      '{"id":"CER-1","priority":1}\n{"id":"CER-2","priority":3}\n',
    );

    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("CER-1");
    expect(result[1].id).toBe("CER-2");
  });

  test("empty string returns empty array", () => {
    expect(parseBulkSpec("")).toEqual([]);
    expect(parseBulkSpec("   ")).toEqual([]);
  });

  test("single JSON object parsed as NDJSON (one item)", () => {
    const result = parseBulkSpec('{"id":"CER-1"}');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("CER-1");
  });

  test("throws when an item lacks string id", () => {
    expect(() => parseBulkSpec('[{"state":"Done"}]')).toThrow(/needs a string "id"/);
  });

  test("skips blank lines in NDJSON", () => {
    const result = parseBulkSpec(
      '{"id":"CER-1"}\n\n  \n{"id":"CER-2"}',
    );

    expect(result).toHaveLength(2);
  });

  test("preserves extra fields on spec items", () => {
    const result = parseBulkSpec(
      '[{"id":"OPS-1","labels":["bug"],"priority":2}]',
    );
    expect(result[0].labels).toEqual(["bug"]);
    expect(result[0].priority).toBe(2);
  });
});
