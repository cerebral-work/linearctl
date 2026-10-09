import type { LinearClient } from "@linear/sdk";
import { makeClient } from "../client.js";
import { addRelations, type AddedRelationsResult } from "../core/issues.js";
import { markDuplicate, type DuplicateResult } from "../core/duplicate.js";
import { printJson } from "../lib/output.js";
import { usageError } from "../lib/errors.js";
import { withSpinner } from "../lib/spinner.js";
import { getCacheDbPath, openCacheDb } from "../core/cache/db.js";
import { insertRelationInCache } from "../core/cache/sync.js";
import { existsSync } from "node:fs";

export interface RelateCommandOptions {
  blockedBy?: string[];
  blocking?: string[];
  relatedTo?: string[];
  duplicateOf?: string;
  json?: boolean;
}

function flattenRefs(refs?: string[]): string[] {
  if (!refs) return [];
  return refs
    .flatMap((r) => r.split(","))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * `linearctl relate <id> [options]`
 * Wire issue relations: blockedBy, blocking, relatedTo, duplicateOf.
 */
export async function relate(
  id: string,
  opts: RelateCommandOptions,
  client?: LinearClient,
): Promise<void> {
  if (!id || !id.trim()) {
    throw usageError("issue ID or identifier is required.");
  }
  const issueRef = id.trim();

  const blockedBy = flattenRefs(opts.blockedBy);
  const blocking = flattenRefs(opts.blocking);
  const relatedTo = flattenRefs(opts.relatedTo);
  const duplicateOf = opts.duplicateOf?.trim();

  if (blockedBy.length === 0 && blocking.length === 0 && relatedTo.length === 0 && !duplicateOf) {
    throw usageError(
      "at least one relation flag (--blocked-by, --blocking, --related-to, --duplicate-of) is required.",
    );
  }

  const linear = client ?? makeClient();

  let duplicate: DuplicateResult | undefined;
  if (duplicateOf) {
    duplicate = await withSpinner("Wiring duplicate relation…", () =>
      markDuplicate(linear, issueRef, duplicateOf, false),
    );
  }

  let relations: AddedRelationsResult | undefined;
  if (blockedBy.length > 0 || blocking.length > 0 || relatedTo.length > 0) {
    relations = await withSpinner("Wiring relations…", () =>
      addRelations(linear, issueRef, { blockedBy, blocking, relatedTo }),
    );
  }

  // Non-blocking write-through to local cache if present
  try {
    const dbPath = getCacheDbPath();
    if (existsSync(dbPath)) {
      const cache = openCacheDb({ dbPath });
      try {
        if (duplicate) {
          insertRelationInCache(cache, {
            type: "duplicate",
            issueId: duplicate.id,
            relatedIssueId: duplicate.duplicateOf.id,
          });
        }
        if (relations?.relations) {
          for (const rel of relations.relations) {
            insertRelationInCache(cache, rel);
          }
        }
      } finally {
        cache.close();
      }
    }
  } catch {
    // Non-blocking write-through
  }

  if (opts.json) {
    printJson({
      identifier: issueRef,
      ...(relations
        ? {
            relations: {
              blockedBy: relations.blockedBy,
              blocking: relations.blocking,
              relatedTo: relations.relatedTo,
            },
          }
        : {}),
      ...(duplicate ? { duplicateOf: duplicate.duplicateOf } : {}),
    });
    return;
  }

  const parts: string[] = [];
  if (relations?.blockedBy.length) {
    parts.push(...relations.blockedBy.map((r) => `blocked-by ${r}`));
  }
  if (relations?.blocking.length) {
    parts.push(...relations.blocking.map((r) => `blocking ${r}`));
  }
  if (relations?.relatedTo.length) {
    parts.push(...relations.relatedTo.map((r) => `related-to ${r}`));
  }
  if (duplicate) {
    parts.push(`duplicate-of ${duplicate.duplicateOf.identifier}`);
  }

  process.stdout.write(`${issueRef}: ${parts.join(", ")}\n`);
}
