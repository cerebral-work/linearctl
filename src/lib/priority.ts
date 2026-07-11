/**
 * Parse a `--priority` flag: `0`-`4` or `none` (→ 0). Shared by `file`,
 * `search`, and the MCP surface so the accepted grammar can't drift.
 */
export function parsePriority(value: string): number {
  const p = value === "none" ? 0 : Number(value);
  if (!Number.isInteger(p) || p < 0 || p > 4) {
    throw new Error(`--priority must be 0-4 or "none", got ${JSON.stringify(value)}.`);
  }
  return p;
}
