import { describe, expect, test } from "bun:test";
import { parseFileBatchSpec } from "../src/core/file-batch.js";

describe("parseFileBatchSpec", () => {
  test("JSON array and NDJSON both parse", () => {
    expect(parseFileBatchSpec('[{"title":"a"},{"title":"b","team":"CER"}]')).toHaveLength(2);
    expect(parseFileBatchSpec('{"title":"a"}\n{"title":"b"}')).toHaveLength(2);
  });

  test("empty input → empty plan; missing title fails loud with index", () => {
    expect(parseFileBatchSpec("  ")).toEqual([]);
    expect(() => parseFileBatchSpec('[{"team":"CER"}]')).toThrow(/item 0/);
    expect(() => parseFileBatchSpec('{"title":"ok"}\n{"nope":1}')).toThrow(/item 1/);
  });
});
