import { eq, or, sql } from "drizzle-orm";
import type { CacheDbInstance } from "./db.js";
import * as schema from "./schema.js";
import type {
  CachedIssue,
  CachedTeam,
  CachedWorkflowState,
  CachedIssueLabel,
  CachedProject,
} from "./schema.js";
import type { PullIssue } from "../pull.js";
import type { SearchOptions } from "../search.js";

/**
 * Friendly state aliases matching Linear workflow-state types.
 */
export const STATE_TYPE_ALIASES: Record<string, string> = {
  triage: "triage",
  backlog: "backlog",
  todo: "unstarted",
  unstarted: "unstarted",
  started: "started",
  "in-progress": "started",
  done: "completed",
  completed: "completed",
  canceled: "canceled",
  cancelled: "canceled",
  duplicate: "duplicate",
};

/**
 * Extended search options for querying the local SQLite cache.
 */
export interface CacheSearchOptions extends Omit<SearchOptions, "priority"> {
  priority?: string | number;
  team?: string;
  teamKey?: string;
  teams?: string[];
  includeTrashed?: boolean;
}

/**
 * Enriched search result conforming to the machine-consumable PullIssue contract
 * while optionally surfacing relational context like assignee, project, and team.
 */
export interface SearchResult extends PullIssue {
  assignee?: string | null;
  project?: string | null;
  milestone?: string | null;
  teamKey?: string | null;
  createdAt?: string;
}

interface RawIssueRow {
  id: string;
  identifier: string;
  title: string;
  state_name: string;
  state_type: string;
  priority: number | null;
  labels_json: string | null;
  description: string | null;
  url: string;
  updated_at: string;
  assignee_name?: string | null;
  project_name?: string | null;
  team_key?: string | null;
  created_at?: string;
}

/**
 * Parse a priority value (number 0-4 or string alias: urgent, high, medium, normal, low, none).
 */
export function parsePriorityOption(priority: string | number): number | undefined {
  if (typeof priority === "number") {
    if (priority >= 0 && priority <= 4) return priority;
    return undefined;
  }
  const pStr = String(priority).toLowerCase().trim();
  if (pStr === "urgent" || pStr === "1") return 1;
  if (pStr === "high" || pStr === "2") return 2;
  if (pStr === "medium" || pStr === "normal" || pStr === "med" || pStr === "3") return 3;
  if (pStr === "low" || pStr === "4") return 4;
  if (pStr === "none" || pStr === "0") return 0;
  return undefined;
}

/**
 * Parse relative duration (e.g. 7d, 24h) or ISO timestamp into an ISO string.
 */
export function resolveSinceTimestamp(val: string): string {
  const trimmed = val.trim();
  const m = /^(\d+)\s*([smhdw]?)$/.exec(trimmed);
  if (m) {
    const n = Number(m[1]);
    const unit = m[2] || "d";
    const ms: Record<string, number> = {
      s: 1_000,
      m: 60_000,
      h: 3_600_000,
      d: 86_400_000,
      w: 604_800_000,
    };
    return new Date(Date.now() - n * ms[unit]).toISOString();
  }
  const parsed = Date.parse(trimmed);
  if (!Number.isNaN(parsed)) {
    return new Date(parsed).toISOString();
  }
  return trimmed;
}

/**
 * Convert a raw SQLite issue row to a strict PullIssue conforming exactly to
 * the 10 fields defined in docs/funnel-contract.md.
 */
export function toPullIssue(row: RawIssueRow): PullIssue {
  let labels: string[] = [];
  if (row.labels_json) {
    try {
      const parsed = JSON.parse(row.labels_json);
      if (Array.isArray(parsed)) {
        labels = parsed.map(String).sort();
      }
    } catch {
      labels = [];
    }
  }

  return {
    id: row.id,
    identifier: row.identifier,
    title: row.title,
    state: row.state_name,
    stateType: row.state_type,
    priority: row.priority ?? 0,
    labels,
    description: row.description ?? "",
    url: row.url,
    updatedAt: row.updated_at,
  };
}

/**
 * Convert a raw SQLite issue row to an enriched SearchResult.
 */
export function toSearchResult(row: RawIssueRow): SearchResult {
  const pull = toPullIssue(row);
  return {
    ...pull,
    assignee: row.assignee_name ?? null,
    project: row.project_name ?? null,
    teamKey: row.team_key ?? null,
    createdAt: row.created_at,
  };
}

/**
 * Build SQL conditions and parameterized values for issue queries.
 */
export function buildQueryConditions(
  opts: CacheSearchOptions,
  forceLike = false,
): { conditions: string[]; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  // 1. Team filter
  const rawTeams = [
    ...(opts.teamKeys ?? []),
    ...(opts.teams ?? []),
    ...(opts.teamKey ? [opts.teamKey] : []),
    ...(opts.team ? [opts.team] : []),
  ];
  const teamKeys = Array.from(new Set(rawTeams)).filter(Boolean);
  if (teamKeys.length > 0 && !teamKeys.some((t) => t.toLowerCase() === "all")) {
    const placeholders = teamKeys.map(() => "?").join(", ");
    conditions.push(`team_key IN (${placeholders})`);
    params.push(...teamKeys);
  }

  // 2. State / StateSet filter
  if (opts.stateSet && opts.stateSet.length > 0) {
    const orParts: string[] = [];
    for (const s of opts.stateSet) {
      const alias = STATE_TYPE_ALIASES[s.toLowerCase()];
      if (alias) {
        orParts.push(`state_type = ?`);
        params.push(alias);
      } else {
        orParts.push(`LOWER(state_name) = LOWER(?)`);
        params.push(s);
      }
    }
    conditions.push(`(${orParts.join(" OR ")})`);
  } else if (opts.state) {
    if (opts.state.toLowerCase() !== "all") {
      const alias = STATE_TYPE_ALIASES[opts.state.toLowerCase()];
      if (alias) {
        conditions.push(`state_type = ?`);
        params.push(alias);
      } else {
        conditions.push(`LOWER(state_name) = LOWER(?)`);
        params.push(opts.state);
      }
    }
  } else {
    // Default active only: completed and canceled excluded
    conditions.push(`state_type NOT IN ('completed', 'canceled')`);
  }

  // 3. Label filter (AND logic: all specified labels must match)
  if (opts.labels && opts.labels.length > 0) {
    for (const label of opts.labels) {
      conditions.push(
        `EXISTS (SELECT 1 FROM json_each(COALESCE(issues.labels_json, '[]')) WHERE LOWER(value) = LOWER(?))`,
      );
      params.push(label);
    }
  }

  // 4. Priority filter
  if (opts.priority !== undefined && opts.priority !== null) {
    const pNum = parsePriorityOption(opts.priority);
    if (pNum !== undefined) {
      conditions.push(`priority = ?`);
      params.push(pNum);
    }
  }

  // 5. Assignee filter
  if (opts.assignee !== undefined && opts.assignee !== null) {
    const a = opts.assignee.trim();
    if (a.toLowerCase() === "none" || a.toLowerCase() === "unassigned") {
      conditions.push(`assignee_id IS NULL`);
    } else {
      conditions.push(
        `(assignee_id = ? OR LOWER(assignee_name) = LOWER(?) OR assignee_id IN (SELECT id FROM users WHERE LOWER(email) = LOWER(?) OR LOWER(name) = LOWER(?) OR LOWER(display_name) = LOWER(?)))`,
      );
      params.push(a, a, a, a, a);
    }
  }

  // 6. Project filter
  if (opts.project !== undefined && opts.project !== null) {
    const p = opts.project.trim();
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (UUID_RE.test(p)) {
      conditions.push(`project_id = ?`);
      params.push(p);
    } else {
      conditions.push(
        `(project_id = ? OR LOWER(project_name) = LOWER(?) OR project_id IN (SELECT id FROM projects WHERE LOWER(name) = LOWER(?) OR slug_id = ?))`,
      );
      params.push(p, p, p, p);
    }
  }

  // 7. Milestone filter
  if (opts.milestone !== undefined && opts.milestone !== null) {
    const m = opts.milestone.trim();
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (UUID_RE.test(m)) {
      conditions.push(`project_milestone_id = ?`);
      params.push(m);
    } else {
      conditions.push(
        `(project_milestone_id = ? OR project_milestone_id IN (SELECT id FROM project_milestones WHERE LOWER(name) = LOWER(?)))`,
      );
      params.push(m, m);
    }
  }

  // 8. Text search filter (FTS5 or LIKE fallback)
  if (opts.text && opts.text.trim()) {
    const rawText = opts.text.trim();
    const hasWildcards = rawText.includes("%") || rawText.includes("_");
    if (forceLike || hasWildcards) {
      const pattern = hasWildcards ? rawText : `%${rawText}%`;
      conditions.push(
        `(LOWER(title) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?) OR LOWER(identifier) LIKE LOWER(?))`,
      );
      params.push(pattern, pattern, pattern);
    } else {
      const sanitized = rawText.replace(/["*]/g, "").trim();
      conditions.push(
        `rowid IN (SELECT rowid FROM issues_fts WHERE issues_fts MATCH ?)`,
      );
      params.push(`"${sanitized}"*`);
    }
  }

  // 9. UpdatedSince
  if (opts.updatedSince) {
    conditions.push(`updated_at >= ?`);
    params.push(resolveSinceTimestamp(opts.updatedSince));
  }

  // 10. CreatedSince
  if (opts.createdSince) {
    conditions.push(`created_at >= ?`);
    params.push(resolveSinceTimestamp(opts.createdSince));
  }

  // 11. Trashed filter
  if (!opts.includeTrashed) {
    conditions.push(`COALESCE(trashed, 0) = 0`);
  }

  return { conditions, params };
}

/**
 * Execute issue query against cache database, falling back from FTS5 to LIKE if necessary.
 */
function executeIssueQuery(
  cache: CacheDbInstance,
  opts: CacheSearchOptions,
): RawIssueRow[] {
  const run = (forceLike: boolean): RawIssueRow[] => {
    const { conditions, params } = buildQueryConditions(opts, forceLike);
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limitClause = opts.limit ? `LIMIT ${Number(opts.limit)}` : "";

    const querySql = `
      SELECT
        id,
        identifier,
        title,
        state_name,
        state_type,
        priority,
        labels_json,
        description,
        url,
        updated_at,
        assignee_name,
        project_name,
        team_key,
        created_at
      FROM issues
      ${whereClause}
      ORDER BY updated_at DESC
      ${limitClause}
    `;

    return cache.sqlite.query(querySql).all(...(params as any[])) as RawIssueRow[];
  };

  try {
    return run(false);
  } catch (err) {
    // If text search was requested and FTS query failed (e.g. syntax error), retry with LIKE fallback
    if (opts.text && opts.text.trim()) {
      return run(true);
    }
    throw err;
  }
}

/**
 * Search cached issues with full filtering and text search.
 * Returns enriched SearchResult items.
 */
export function searchCachedIssues(
  cache: CacheDbInstance,
  opts: CacheSearchOptions = {},
): SearchResult[] {
  const rows = executeIssueQuery(cache, opts);
  return rows.map(toSearchResult);
}

/**
 * Headless pull of cached issues matching docs/funnel-contract.md.
 * Returns an array of PullIssue items ordered by updatedAt DESC.
 */
export function pullCachedIssues(
  cache: CacheDbInstance,
  opts: CacheSearchOptions = {},
): PullIssue[] {
  const rows = executeIssueQuery(cache, opts);
  return rows.map(toPullIssue);
}

/**
 * Retrieve a single cached issue by UUID or human identifier (e.g. EST-83).
 */
export function getCachedIssue(
  cache: CacheDbInstance,
  idOrIdentifier: string,
): CachedIssue | null {
  if (!idOrIdentifier || !idOrIdentifier.trim()) {
    return null;
  }
  const ref = idOrIdentifier.trim();
  const row = cache.db
    .select()
    .from(schema.issues)
    .where(
      or(
        eq(schema.issues.id, ref),
        eq(schema.issues.identifier, ref),
        eq(sql`UPPER(${schema.issues.identifier})`, ref.toUpperCase()),
      ),
    )
    .get();

  return row ?? null;
}

/**
 * Retrieve a cached team by UUID or key.
 */
export function getCachedTeam(
  cache: CacheDbInstance,
  idOrKey: string,
): CachedTeam | null {
  if (!idOrKey || !idOrKey.trim()) {
    return null;
  }
  const ref = idOrKey.trim();
  const row = cache.db
    .select()
    .from(schema.teams)
    .where(
      or(
        eq(schema.teams.id, ref),
        eq(schema.teams.key, ref),
        eq(sql`UPPER(${schema.teams.key})`, ref.toUpperCase()),
      ),
    )
    .get();

  return row ?? null;
}

/**
 * Retrieve cached workflow states, optionally filtered by teamId.
 */
export function getCachedWorkflowStates(
  cache: CacheDbInstance,
  teamId?: string,
): CachedWorkflowState[] {
  if (teamId) {
    return cache.db
      .select()
      .from(schema.workflowStates)
      .where(eq(schema.workflowStates.teamId, teamId))
      .all();
  }
  return cache.db.select().from(schema.workflowStates).all();
}

/**
 * Retrieve cached issue labels, optionally filtered by teamId.
 */
export function getCachedLabels(
  cache: CacheDbInstance,
  teamId?: string,
): CachedIssueLabel[] {
  if (teamId) {
    return cache.db
      .select()
      .from(schema.issueLabels)
      .where(eq(schema.issueLabels.teamId, teamId))
      .all();
  }
  return cache.db.select().from(schema.issueLabels).all();
}

/**
 * Retrieve all cached projects.
 */
export function getCachedProjects(
  cache: CacheDbInstance,
): CachedProject[] {
  return cache.db.select().from(schema.projects).all();
}
