import type { LinearClient } from "@linear/sdk";
import { withRetry } from "../lib/retry.js";
import { mapPool } from "../lib/pool.js";

/**
 * Batched issue mutations — collapse N updates into a handful of HTTP calls.
 *
 * The single-issue path (`core/issues.ts`) costs one round-trip per issue; a
 * bulk relabel/retag/reprioritize sweep of ~80 issues is then ~80 sequential
 * mutations (slow, and a `RATELIMITED` foot-gun). This module batches them using
 * GraphQL's aliased-field support through `@linear/sdk`'s raw escape hatch
 * (`client.client.rawRequest`), so one request carries many `issueUpdate`s.
 *
 * Linear hard-rejects any single query above 10,000 complexity points, so we
 * chunk; each chunk runs through {@link withRetry} with bounded concurrency.
 * (spec §10 — the bulk-mutation N+1 fix.)
 */

/** Aliased `issueUpdate`s per request. Conservative — well under Linear's 10k-point cap. */
const MUTATION_CHUNK = 25;
/** Aliased `issue` lookups per resolution request. */
const RESOLVE_CHUNK = 50;
/** Concurrent in-flight requests. */
const CONCURRENCY = 4;

export interface BatchUpdateItem {
  /** Issue UUID (NOT an identifier — resolve identifiers first via {@link resolveIssueUuids}). */
  uuid: string;
  /** A label for reporting (typically the human identifier, e.g. `OPS-123`). */
  ref: string;
  /** A resolved Linear `IssueUpdateInput` (stateId / labelIds / priority / …). */
  input: Record<string, unknown>;
}

export interface BatchResult {
  total: number;
  succeeded: number;
  failed: { ref: string; error: string }[];
}

/**
 * Resolve issue identifiers/UUIDs to UUIDs in batched `issue(id){id}` queries.
 *
 * `issue(id)` accepts a human identifier (e.g. `OPS-123`) or a UUID, so this is
 * how a remediation plan keyed by identifiers becomes UUIDs in O(N/RESOLVE_CHUNK)
 * round-trips instead of N. Returns ref → `{ uuid, identifier }`; refs that don't
 * resolve are simply absent from the map (caller decides how to report them).
 */
export async function resolveIssueUuids(
  client: LinearClient,
  refs: string[],
): Promise<Map<string, { uuid: string; identifier: string }>> {
  const unique = [...new Set(refs)];
  const out = new Map<string, { uuid: string; identifier: string }>();
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += RESOLVE_CHUNK) {
    chunks.push(unique.slice(i, i + RESOLVE_CHUNK));
  }

  await mapPool(chunks, CONCURRENCY, async (chunk) => {
    const vars: Record<string, unknown> = {};
    const decls: string[] = [];
    const fields: string[] = [];
    chunk.forEach((ref, i) => {
      decls.push(`$r${i}: String!`);
      fields.push(`r${i}: issue(id: $r${i}) { id identifier }`);
      vars[`r${i}`] = ref;
    });
    const query = `query Resolve(${decls.join(", ")}) {\n  ${fields.join("\n  ")}\n}`;
    const res = await withRetry(() =>
      client.client.rawRequest<Record<string, { id: string; identifier: string } | null>, typeof vars>(
        query,
        vars,
      ),
    );
    const data = res.data ?? {};
    chunk.forEach((ref, i) => {
      const node = data[`r${i}`];
      if (node?.id) out.set(ref, { uuid: node.id, identifier: node.identifier });
    });
  });

  return out;
}

/**
 * Apply many `issueUpdate`s in batched, retried, bounded-concurrency requests.
 *
 * Each chunk becomes one `mutation { m0: issueUpdate(...) m1: issueUpdate(...) … }`
 * dispatched via `rawRequest`. A whole-chunk transport failure is attributed to
 * every item in that chunk; a per-item `success:false` is attributed to that item.
 */
export async function batchUpdateIssues(
  client: LinearClient,
  items: BatchUpdateItem[],
): Promise<BatchResult> {
  const chunks: BatchUpdateItem[][] = [];
  for (let i = 0; i < items.length; i += MUTATION_CHUNK) {
    chunks.push(items.slice(i, i + MUTATION_CHUNK));
  }

  const failed: { ref: string; error: string }[] = [];
  let succeeded = 0;

  await mapPool(chunks, CONCURRENCY, async (chunk) => {
    const vars: Record<string, unknown> = {};
    const decls: string[] = [];
    const fields: string[] = [];
    chunk.forEach((it, i) => {
      decls.push(`$id${i}: String!`, `$in${i}: IssueUpdateInput!`);
      fields.push(`m${i}: issueUpdate(id: $id${i}, input: $in${i}) { success }`);
      vars[`id${i}`] = it.uuid;
      vars[`in${i}`] = it.input;
    });
    const query = `mutation Batch(${decls.join(", ")}) {\n  ${fields.join("\n  ")}\n}`;
    try {
      const res = await withRetry(() =>
        client.client.rawRequest<Record<string, { success: boolean }>, typeof vars>(query, vars),
      );
      const data = res.data ?? {};
      chunk.forEach((it, i) => {
        if (data[`m${i}`]?.success) succeeded += 1;
        else failed.push({ ref: it.ref, error: "issueUpdate returned success=false" });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      for (const it of chunk) failed.push({ ref: it.ref, error: msg });
    }
  });

  return { total: items.length, succeeded, failed };
}
