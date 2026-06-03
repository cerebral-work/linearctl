/** Print as pretty JSON — for `--json` and piping to `jq`. */
export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

/**
 * Minimal fixed-column table for human output. `columns` selects and orders the
 * keys; missing cells render empty. Widths size to the longest cell per column.
 */
export function printTable(
  rows: Array<Record<string, string>>,
  columns: string[],
): void {
  if (rows.length === 0) {
    process.stdout.write("(none)\n");
    return;
  }
  const widths = columns.map((c) =>
    Math.max(c.length, ...rows.map((r) => (r[c] ?? "").length)),
  );
  const render = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd();
  process.stdout.write(render(columns) + "\n");
  process.stdout.write(
    columns.map((_, i) => "─".repeat(widths[i])).join("  ") + "\n",
  );
  for (const r of rows) {
    process.stdout.write(render(columns.map((c) => r[c] ?? "")) + "\n");
  }
}
