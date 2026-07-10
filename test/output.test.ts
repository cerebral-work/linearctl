import { describe, expect, test } from "bun:test";
import { renderPlainTable, renderStyledTable } from "../src/lib/output.js";

const rows: Array<Record<string, string>> = [
  { id: "CER-1", state: "Todo", title: "First thing" },
  { id: "CER-22", state: "In Progress", title: "Second" },
];
const columns = ["id", "state", "title"];

const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

describe("renderPlainTable", () => {
  test("fixed-column layout, byte-stable for pipes", () => {
    expect(renderPlainTable(rows, columns)).toBe(
      [
        "id      state        title",
        "──────  ───────────  ───────────",
        "CER-1   Todo         First thing",
        "CER-22  In Progress  Second",
        "",
      ].join("\n"),
    );
  });

  test("contains no ANSI escapes", () => {
    const out = renderPlainTable(rows, columns);
    expect(stripAnsi(out)).toBe(out);
  });

  test("missing cells render empty", () => {
    const out = renderPlainTable([{ id: "CER-3" }], columns);
    expect(out).toContain("CER-3");
    expect(out.split("\n")).toHaveLength(4); // header, rule, row, trailing
  });
});

describe("renderStyledTable", () => {
  test("bordered table carries every cell value", () => {
    const out = stripAnsi(renderStyledTable(rows, columns));
    expect(out).toContain("┌");
    expect(out).toContain("┘");
    for (const r of rows) {
      for (const c of columns) expect(out).toContain(r[c]!);
    }
  });

  test("cell styler is applied per column", () => {
    const out = renderStyledTable(rows, columns, (v, col) =>
      col === "id" ? `<${v}>` : v,
    );
    expect(stripAnsi(out)).toContain("<CER-1>");
    expect(stripAnsi(out)).toContain("<CER-22>");
    expect(stripAnsi(out)).not.toContain("<Todo>");
  });
});
