import { usageError } from "./errors.js";

/**
 * Drain an SDK connection and return every node exactly once.
 *
 * The SDK's `fetchNext()` *appends* to the connection's own `nodes` array
 * (`_appendNodes`) and advances its `pageInfo` in place. Pushing
 * `connection.nodes` into a separate array on each iteration therefore
 * re-counts every page already fetched: with a 50-row page size and 91 rows,
 * `project list` returned 141 rows for 91 distinct projects. Counting with
 * `n += page.nodes.length` inflates the same way — 2500 for 1000 issues
 * after three extra pages.
 *
 * The correct shape is to drain first and read `nodes` once at the end. This
 * helper is that shape, in one place, so the idiom cannot be got wrong again.
 *
 * Termination matches the listing contract (docs/agent-facility.md): a
 * `hasNextPage` that never clears would otherwise spin forever, so a page
 * that adds no rows ends the scan.
 */
export interface PageConnection<T> {
  nodes: T[];
  pageInfo?: { hasNextPage?: boolean | null } | null;
  fetchNext(): Promise<unknown>;
}

export async function drainConnection<T>(connection: PageConnection<T>): Promise<T[]> {
  // Guard against a connection whose hasNextPage never clears: each fetch must
  // add rows, otherwise the scan is not advancing and would loop forever.
  while (connection.pageInfo?.hasNextPage) {
    const before = connection.nodes.length;
    await connection.fetchNext();
    if (connection.nodes.length <= before) break;
  }
  return connection.nodes;
}

/**
 * Drain a connection and return each entity once, keeping first-seen order.
 *
 * Cursor pagination can repeat a row across a page boundary when the row is
 * modified mid-scan, so a listing de-duplicates by id (listing contract rule
 * 2). Nodes without a usable id are kept as-is rather than silently dropped.
 */
export async function drainUnique<T extends { id?: string }>(
  connection: PageConnection<T>,
): Promise<T[]> {
  const nodes = await drainConnection(connection);
  const byId = new Map<string, T>();
  const unkeyed: T[] = [];
  for (const node of nodes) {
    if (typeof node?.id === "string") {
      if (!byId.has(node.id)) byId.set(node.id, node);
    } else {
      unkeyed.push(node);
    }
  }
  return [...byId.values(), ...unkeyed];
}

/** Count every node in a connection, each counted once. */
export async function countConnection(connection: PageConnection<unknown>): Promise<number> {
  return (await drainConnection(connection)).length;
}

/**
 * Validate a `--limit`, then apply it to an already-ordered listing.
 *
 * The cap is a prefix of the WHOLE listing, so callers sort before calling.
 * `partial` is true only when the cap actually dropped rows, so an uncapped
 * listing is never partial (listing contract rules 3–5).
 */
export function applyLimit<T>(
  rows: T[],
  limit: number | undefined,
): { rows: T[]; partial: boolean } {
  if (limit === undefined) return { rows, partial: false };
  if (!Number.isInteger(limit) || limit < 1) {
    throw usageError("--limit must be a positive integer.");
  }
  return { rows: rows.slice(0, limit), partial: rows.length > limit };
}
