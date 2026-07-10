import Table from "cli-table3";
import { isStyled, pc } from "./style.js";

/** Print as pretty JSON — for `--json` and piping to `jq`. */
export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

/**
 * Optional per-cell colorizer. Only consulted on the styled (TTY) path; the
 * plain path never sees it, so piped output stays free of ANSI codes.
 */
export type CellStyle = (
  value: string,
  column: string,
  row: Record<string, string>,
) => string;

/**
 * Minimal fixed-column table. `columns` selects and orders the keys; missing
 * cells render empty. Widths size to the longest cell per column. This is the
 * pipe-facing format — stable, `awk`-able, no ANSI.
 */
export function renderPlainTable(
  rows: Array<Record<string, string>>,
  columns: string[],
): string {
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => (r[c] ?? "").length)),
  );
  const render = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  const lines = [
    render(columns),
    columns.map((_, i) => "─".repeat(widths[i])).join("  "),
    ...rows.map((r) => render(columns.map((c) => r[c] ?? ""))),
  ];
  return lines.join("\n") + "\n";
}

/** Bordered, color-aware table for the human at the terminal. */
export function renderStyledTable(
  rows: Array<Record<string, string>>,
  columns: string[],
  style?: CellStyle,
): string {
  const table = new Table({
    head: columns.map((c) => pc.bold(c)),
    style: { head: [], border: [], "padding-left": 1, "padding-right": 1 },
    // no rule between body rows — header rule only, so long tables stay scannable
    chars: { mid: "", "left-mid": "", "mid-mid": "", "right-mid": "" },
    wordWrap: true,
  });
  for (const r of rows) {
    table.push(
      columns.map((c) => {
        const value = r[c] ?? "";
        return style ? style(value, c, r) : value;
      }),
    );
  }
  return table.toString() + "\n";
}

/**
 * Table for human output: bordered + styled when stdout is a TTY (and NO_COLOR
 * is unset), the original plain fixed-column format otherwise.
 */
export function printTable(
  rows: Array<Record<string, string>>,
  columns: string[],
  style?: CellStyle,
): void {
  if (rows.length === 0) {
    process.stdout.write("(none)\n");
    return;
  }
  process.stdout.write(
    isStyled()
      ? renderStyledTable(rows, columns, style)
      : renderPlainTable(rows, columns),
  );
}
