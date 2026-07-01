import type { LinearClient } from "@linear/sdk";
import { pickLabelIds } from "../lib/labels.js";
import { withRetry } from "../lib/retry.js";
import { resolveMilestoneId } from "./milestones.js";
import { resolveIssueUuids, batchUpdateIssues, type BatchResult } from "./batch.js";

/**
 * Bulk issue update from a machine-readable spec — the remediation-sweep verb.
 *
 * Backs `linearctl update --stdin`: read a plan (JSON array or NDJSON of
 * `{ id, labels?, addLabels?, priority?, project?, assignee? }`), resolve all
 * names ONCE (labels/assignee/project — not per issue), resolve identifiers to
 * UUIDs in batched lookups, then dispatch the updates via {@link batchUpdateIssues}.
 *
 * Dry-run by default (mirrors `stale`): returns the resolved plan and writes
 * nothing unless `apply` is set. State-by-name is intentionally out of scope here
 * (workflow states are per-team — use the single-issue `update <id> --state` path).
 */
export interface BulkSpecItem {
  id: string;
  labels?: string[];
  addLabels?: string[];
  priority?: number;
  project?: string;
  assignee?: string;
  milestone?: string;
}

/** Team keys (e.g. OPS) inferred from identifier-style ids — scopes label resolution. */
function inferTeamKeys(ids: string[]): string[] {
  const keys = new Set<string>();
  for (const id of ids) {
    const m = /^([A-Za-z][A-Za-z0-9]*)-\d+$/.exec(id.trim());
    if (m) keys.add(m[1].toUpperCase());
  }
  return [...keys];
}

export interface BulkPlanRow {
  ref: string;
  uuid: string | null;
  input: Record<string, unknown>;
  skipped?: string;
}

export interface BulkPlan {
  apply: boolean;
  rows: BulkPlanRow[];
  unresolved: string[];
  result?: BatchResult;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parse a bulk spec from a JSON array or newline-delimited JSON objects. */
export function parseBulkSpec(raw: string): BulkSpecItem[] {
  const text = raw.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    const arr = JSON.parse(text) as unknown;
    if (!Array.isArray(arr)) throw new Error("bulk spec must be a JSON array or NDJSON of objects.");
    return arr.map((x, i) => coerce(x, i));
  }
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l, i) => coerce(JSON.parse(l), i));
}

function coerce(x: unknown, i: number): BulkSpecItem {
  const o = x as Record<string, unknown>;
  if (!o || typeof o !== "object" || typeof o.id !== "string") {
    throw new Error(`bulk spec item ${i} needs a string "id".`);
  }
  return o as unknown as BulkSpecItem;
}

/** Resolve distinct label names (case-insensitive) to IDs in one query. */
async function resolveLabelMap(
  client: LinearClient,
  names: string[],
  teamKeys: string[],
): Promise<Map<string, string>> {
  const distinct = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  if (distinct.length === 0) return new Map();
  const nameOr = { or: distinct.map((n) => ({ name: { eqIgnoreCase: n } })) };
  // Scope to the involved teams (+ workspace-global labels) so a name can't
  // resolve to another team's label and get rejected ("LabelIds for incorrect team").
  const filter = teamKeys.length
    ? { and: [{ or: [{ team: { key: { in: teamKeys } } }, { team: { null: true } }] }, nameOr] }
    : nameOr;
  const labels = await withRetry(() => client.issueLabels({ filter }));
  // pickLabelIds throws (listing every miss) if any requested name is unmatched.
  const ids = pickLabelIds(labels.nodes, distinct);
  return new Map(distinct.map((n, idx) => [n.toLowerCase(), ids[idx]]));
}

/** Resolve distinct milestone refs (id or name) to ids. */
async function resolveMilestoneMap(client: LinearClient, refs: string[]): Promise<Map<string, string>> {
  const distinct = [...new Set(refs.filter(Boolean))];
  const map = new Map<string, string>();
  for (const r of distinct) map.set(r, await resolveMilestoneId(client, r));
  return map;
}

/** Resolve distinct assignees ('me' / email / name / uuid) to user IDs in one query. */
async function resolveAssigneeMap(client: LinearClient, whos: string[]): Promise<Map<string, string>> {
  const distinct = [...new Set(whos.filter(Boolean))];
  if (distinct.length === 0) return new Map();
  const map = new Map<string, string>();
  const lookup: string[] = [];
  for (const who of distinct) {
    if (who === "me") map.set(who, (await client.viewer).id);
    else if (UUID_RE.test(who)) map.set(who, who);
    else lookup.push(who);
  }
  if (lookup.length) {
    const users = await client.users({
      filter: {
        or: lookup.flatMap((w) => [
          { email: { eqIgnoreCase: w } },
          { displayName: { eqIgnoreCase: w } },
          { name: { eqIgnoreCase: w } },
        ]),
      },
    });
    for (const w of lookup) {
      const lc = w.toLowerCase();
      const u = users.nodes.find(
        (n) => n.email?.toLowerCase() === lc || n.displayName.toLowerCase() === lc || n.name.toLowerCase() === lc,
      );
      if (!u) throw new Error(`no user matching ${JSON.stringify(w)} — try "me", an email, or a display name.`);
      map.set(w, u.id);
    }
  }
  return map;
}

/** Resolve distinct project refs (id / name) to project IDs (one projects fetch). */
async function resolveProjectMap(client: LinearClient, refs: string[]): Promise<Map<string, string>> {
  const distinct = [...new Set(refs.filter(Boolean))];
  if (distinct.length === 0) return new Map();
  const map = new Map<string, string>();
  const needName = distinct.filter((r) => !UUID_RE.test(r));
  for (const r of distinct) if (UUID_RE.test(r)) map.set(r, r);
  if (needName.length) {
    const projects = await client.projects();
    for (const r of needName) {
      const lc = r.toLowerCase();
      const p = projects.nodes.find((n) => n.name.toLowerCase() === lc || n.slugId === r);
      if (!p) throw new Error(`no project matching ${JSON.stringify(r)} — pass a project id, name, or slug.`);
      map.set(r, p.id);
    }
  }
  return map;
}

/** Build the resolved plan and, when `apply`, dispatch it in batched mutations. */
export async function bulkUpdate(
  client: LinearClient,
  items: BulkSpecItem[],
  apply: boolean,
): Promise<BulkPlan> {
  const labelMap = await resolveLabelMap(
    client,
    items.flatMap((i) => [...(i.labels ?? []), ...(i.addLabels ?? [])]),
    inferTeamKeys(items.map((i) => i.id)),
  );
  const assigneeMap = await resolveAssigneeMap(client, items.map((i) => i.assignee).filter((x): x is string => !!x));
  const projectMap = await resolveProjectMap(client, items.map((i) => i.project).filter((x): x is string => !!x));
  const milestoneMap = await resolveMilestoneMap(client, items.map((i) => i.milestone).filter((x): x is string => !!x));
  const uuidMap = await resolveIssueUuids(client, items.map((i) => i.id));

  const rows: BulkPlanRow[] = [];
  const unresolved: string[] = [];
  for (const it of items) {
    const resolved = uuidMap.get(it.id);
    const input: Record<string, unknown> = {};
    if (it.labels) input.labelIds = it.labels.map((n) => labelMap.get(n.trim().toLowerCase())!);
    if (it.addLabels) input.addedLabelIds = it.addLabels.map((n) => labelMap.get(n.trim().toLowerCase())!);
    if (it.priority !== undefined) input.priority = it.priority;
    if (it.assignee) input.assigneeId = assigneeMap.get(it.assignee);
    if (it.project) input.projectId = projectMap.get(it.project);
    if (it.milestone) input.projectMilestoneId = milestoneMap.get(it.milestone);
    if (Object.keys(input).length === 0) {
      rows.push({ ref: it.id, uuid: resolved?.uuid ?? null, input, skipped: "no fields to update" });
      continue;
    }
    if (!resolved) {
      unresolved.push(it.id);
      rows.push({ ref: it.id, uuid: null, input, skipped: "issue not found" });
      continue;
    }
    rows.push({ ref: resolved.identifier, uuid: resolved.uuid, input });
  }

  if (!apply) return { apply: false, rows, unresolved };

  const actionable = rows.filter((r) => r.uuid && !r.skipped);
  const result = await batchUpdateIssues(
    client,
    actionable.map((r) => ({ uuid: r.uuid as string, ref: r.ref, input: r.input })),
  );
  return { apply: true, rows, unresolved, result };
}
