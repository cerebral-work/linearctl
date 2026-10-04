import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LinearClient } from "@linear/sdk";
import { withRetry, type RetryOptions } from "../lib/retry.js";
import { renderIssueDetail, type IssueDetail } from "./issues.js";

/**
 * `linearctl backup` engine — a read-only, verifiable dump of a Linear
 * workspace to a local directory (JSON Lines per entity + manifest + one
 * markdown file per issue). It knows nothing about where the directory goes
 * afterwards; shipping it somewhere is the caller's job.
 *
 * Reads only. Attachments are metadata + URLs (never fetched). The API key is
 * never read here: the engine receives a ready {@link LinearClient}.
 */

export const MANIFEST_SCHEMA_VERSION = 1;

type Row = Record<string, unknown>;

/** How one entity is read. `rels` are emitted flat as `<rel>Id` (relations as ids only). */
export interface EntitySpec {
  name: string;
  root: string;
  kind: "connection" | "single" | "list";
  scalars: string[];
  rels?: string[];
  /** Raw extra selection, for relations that need a non-`id` projection. */
  extra?: string;
  /** Extra connection args, e.g. `includeDisabled: true`. */
  args?: string;
  /** Supports a server-side `updatedAt >= since` filter (for `--since`). */
  sinceFilter?: boolean;
  /** Server-side team scope: GraphQL filter fragment built from team keys. */
  teamFilter?: (keys: string) => string;
  /** Row dependent on an issue (scoped client-side by the issue id set). */
  issueRef?: "issueId";
}

// Heavy or sensitive fields are deliberately omitted: organization auth/SAML/
// SCIM settings, user calendar hashes, opaque editor-state blobs (the markdown
// fields carry the content), reaction blobs, and progress-history arrays.
export const ENTITIES: EntitySpec[] = [
  {
    name: "organization",
    root: "organization",
    kind: "single",
    scalars: ["id", "name", "urlKey", "createdAt", "updatedAt", "userCount", "createdIssueCount", "roadmapEnabled", "gitBranchFormat", "fiscalYearStartMonth", "workingDays", "previousUrlKeys"],
  },
  {
    name: "users",
    root: "users",
    kind: "connection",
    args: "includeDisabled: true",
    scalars: ["id", "name", "displayName", "email", "active", "admin", "owner", "guest", "app", "disableReason", "timezone", "createdAt", "updatedAt", "archivedAt", "lastSeen", "url", "description", "title"],
  },
  {
    name: "teams",
    root: "teams",
    kind: "connection",
    teamFilter: (k) => `{ key: { in: [${k}] } }`,
    scalars: ["id", "key", "name", "displayName", "description", "icon", "color", "createdAt", "updatedAt", "archivedAt", "retiredAt", "cyclesEnabled", "cycleStartDay", "cycleDuration", "triageEnabled", "requirePriorityToLeaveTriage", "issueCount", "timezone", "visibility", "inheritWorkflowStatuses", "autoArchivePeriod", "autoClosePeriod", "issueEstimationType"],
    rels: ["parent", "defaultIssueState", "triageIssueState"],
  },
  {
    name: "workflowStates",
    root: "workflowStates",
    kind: "connection",
    teamFilter: (k) => `{ team: { key: { in: [${k}] } } }`,
    scalars: ["id", "name", "type", "color", "description", "position", "createdAt", "updatedAt", "archivedAt"],
    rels: ["team"],
  },
  {
    name: "issueLabels",
    root: "issueLabels",
    kind: "connection",
    teamFilter: (k) => `{ team: { key: { in: [${k}] } } }`,
    scalars: ["id", "name", "description", "color", "isGroup", "retiredAt", "lastAppliedAt", "createdAt", "updatedAt", "archivedAt"],
    rels: ["team", "parent", "creator"],
  },
  {
    name: "issues",
    root: "issues",
    kind: "connection",
    sinceFilter: true,
    teamFilter: (k) => `{ team: { key: { in: [${k}] } } }`,
    scalars: ["id", "identifier", "number", "title", "description", "priority", "priorityLabel", "estimate", "url", "branchName", "dueDate", "sortOrder", "labelIds", "previousIdentifiers", "trashed", "createdAt", "updatedAt", "archivedAt", "startedAt", "completedAt", "canceledAt", "autoClosedAt", "autoArchivedAt", "triagedAt", "snoozedUntilAt", "addedToProjectAt", "addedToCycleAt", "addedToTeamAt"],
    rels: ["team", "state", "assignee", "creator", "delegate", "project", "projectMilestone", "cycle", "parent"],
  },
  {
    name: "comments",
    root: "comments",
    kind: "connection",
    sinceFilter: true,
    issueRef: "issueId",
    scalars: ["id", "body", "url", "issueId", "projectId", "initiativeId", "projectUpdateId", "initiativeUpdateId", "documentContentId", "parentId", "resolvedAt", "editedAt", "createdAt", "updatedAt", "archivedAt"],
    rels: ["user", "externalUser"],
  },
  {
    name: "attachments",
    root: "attachments",
    kind: "connection",
    issueRef: "issueId",
    scalars: ["id", "title", "subtitle", "url", "sourceType", "metadata", "createdAt", "updatedAt", "archivedAt"],
    rels: ["issue", "creator"],
  },
  {
    name: "issueRelations",
    root: "issueRelations",
    kind: "connection",
    issueRef: "issueId",
    scalars: ["id", "type", "createdAt", "updatedAt", "archivedAt"],
    rels: ["issue", "relatedIssue"],
  },
  {
    name: "projects",
    root: "projects",
    kind: "connection",
    sinceFilter: true,
    scalars: ["id", "name", "slugId", "description", "content", "icon", "color", "url", "priority", "startDate", "targetDate", "startedAt", "completedAt", "canceledAt", "health", "progress", "scope", "labelIds", "trashed", "sortOrder", "createdAt", "updatedAt", "archivedAt"],
    rels: ["status", "lead", "creator", "leadTeam"],
  },
  {
    name: "projectMilestones",
    root: "projectMilestones",
    kind: "connection",
    scalars: ["id", "name", "description", "targetDate", "status", "progress", "sortOrder", "createdAt", "updatedAt", "archivedAt"],
    rels: ["project"],
  },
  {
    name: "projectUpdates",
    root: "projectUpdates",
    kind: "connection",
    scalars: ["id", "body", "health", "url", "createdAt", "updatedAt", "editedAt", "archivedAt"],
    rels: ["project", "user"],
  },
  {
    name: "initiatives",
    root: "initiatives",
    kind: "connection",
    sinceFilter: true,
    scalars: ["id", "name", "description", "content", "status", "health", "icon", "color", "url", "targetDate", "startedAt", "completedAt", "canceledAt", "labelIds", "trashed", "sortOrder", "createdAt", "updatedAt", "archivedAt"],
    rels: ["owner", "creator", "parentInitiative", "leadTeam"],
  },
  {
    name: "initiativeToProjects",
    root: "initiativeToProjects",
    kind: "connection",
    scalars: ["id", "sortOrder", "createdAt", "updatedAt", "archivedAt"],
    rels: ["initiative", "project"],
  },
  {
    name: "documents",
    root: "documents",
    kind: "connection",
    sinceFilter: true,
    scalars: ["id", "title", "summary", "content", "slugId", "icon", "color", "url", "trashed", "hiddenAt", "sortOrder", "createdAt", "updatedAt", "archivedAt"],
    rels: ["creator", "updatedBy", "project", "initiative", "team", "issue"],
  },
  {
    name: "cycles",
    root: "cycles",
    kind: "connection",
    teamFilter: (k) => `{ team: { key: { in: [${k}] } } }`,
    scalars: ["id", "number", "name", "description", "startsAt", "endsAt", "completedAt", "progress", "createdAt", "updatedAt", "archivedAt"],
    rels: ["team"],
  },
  {
    name: "customViews",
    root: "customViews",
    kind: "connection",
    scalars: ["id", "name", "description", "icon", "color", "shared", "slugId", "modelName", "filterData", "projectFilterData", "initiativeFilterData", "createdAt", "updatedAt", "archivedAt"],
    rels: ["owner", "creator", "team"],
  },
  {
    name: "projectStatuses",
    root: "projectStatuses",
    kind: "connection",
    scalars: ["id", "name", "type", "color", "description", "position", "indefinite", "createdAt", "updatedAt", "archivedAt"],
  },
  {
    name: "projectLabels",
    root: "projectLabels",
    kind: "connection",
    scalars: ["id", "name", "description", "color", "isGroup", "retiredAt", "lastAppliedAt", "createdAt", "updatedAt", "archivedAt"],
    rels: ["parent", "creator"],
  },
  {
    name: "initiativeLabels",
    root: "initiativeLabels",
    kind: "connection",
    scalars: ["id", "name", "description", "color", "isGroup", "retiredAt", "lastAppliedAt", "createdAt", "updatedAt", "archivedAt"],
    rels: ["parent", "creator"],
  },
  {
    name: "templates",
    root: "templates",
    kind: "list",
    scalars: ["id", "type", "name", "description", "icon", "color", "templateData", "sortOrder", "createdAt", "updatedAt", "archivedAt"],
    rels: ["team", "creator"],
  },
  {
    name: "customers",
    root: "customers",
    kind: "connection",
    scalars: ["id", "name", "domains", "externalIds", "revenue", "size", "slugId", "url", "createdAt", "updatedAt", "archivedAt"],
    rels: ["owner", "status", "tier"],
  },
  {
    name: "customerNeeds",
    root: "customerNeeds",
    kind: "connection",
    scalars: ["id", "priority", "body", "url", "createdAt", "updatedAt", "archivedAt"],
    rels: ["customer", "issue", "project", "comment", "creator"],
  },
];

export const ENTITY_NAMES = ENTITIES.map((e) => e.name);
export const HISTORY_ENTITY = "issueHistory";
const HISTORY_FILE = "issueHistory.jsonl";

export interface ManifestEntity {
  count: number;
  file: string;
  sha256: string;
  bytes: number;
}

export interface Manifest {
  schemaVersion: number;
  linearctlVersion: string;
  workspace: { id: string | null; urlKey: string | null; name: string | null };
  startedAt: string;
  finishedAt: string;
  scope: {
    teams: string[] | null;
    entities: string[];
    limit: number | null;
    since: string | null;
    includeHistory: boolean;
    markdown: boolean;
  };
  partial: boolean;
  entities: Record<string, ManifestEntity>;
  markdown: { dir: string; count: number } | null;
  rateLimit: { minRequestsRemaining: number | null };
  /** Total GraphQL requests sent for this run (including resumed segments). */
  requests: number;
  /** Team ids referenced by dumped rows but not returned by `teams` (private/archived teams the key cannot list). */
  unresolved?: { teams: string[] };
  warnings: string[];
}

export interface BackupOptions {
  /** Parent directory; the run lands in `<out>/linear-<UTC>/`. */
  out: string;
  entities?: string[];
  teams?: string[];
  limit?: number;
  /** ISO timestamp (already resolved from a window by the caller). */
  since?: string;
  includeHistory?: boolean;
  resume?: boolean;
  markdown?: boolean;
  version: string;
  retry?: RetryOptions;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  /** Sleep when `x-ratelimit-requests-remaining` drops below this (history pass). */
  rateFloor?: number;
}

export class BackupUsageError extends Error {}

/* ------------------------------------------------------------------ helpers */

const sha256 = (buf: string | Uint8Array): string =>
  createHash("sha256").update(buf).digest("hex");

const lineCount = (text: string): number =>
  text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

/** Compact UTC stamp for directory names: 20261004T123456Z. */
export function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Resolve `7d` / `24h` / `2w` windows or an ISO date to an ISO timestamp. */
export function resolveSince(raw: string, now: Date = new Date()): string {
  const m = /^(\d+)([hdw])$/.exec(raw.trim());
  if (m) {
    const unit = { h: 3_600_000, d: 86_400_000, w: 604_800_000 }[m[2] as "h" | "d" | "w"];
    return new Date(now.getTime() - Number(m[1]) * unit).toISOString();
  }
  const t = Date.parse(raw);
  if (Number.isNaN(t)) throw new BackupUsageError(`--since: cannot parse "${raw}" (use 7d, 24h, 2w or an ISO date)`);
  return new Date(t).toISOString();
}

/** Selection set for one entity; relations select only `id` and are flattened later. */
export function selection(spec: EntitySpec): string {
  const rels = (spec.rels ?? []).map((r) => `${r} { id }`);
  return [...spec.scalars, ...rels, ...(spec.extra ? [spec.extra] : [])].join(" ");
}

export function buildQuery(spec: EntitySpec, filter?: string): string {
  const sel = selection(spec);
  if (spec.kind === "single") return `query Backup_${spec.name} { ${spec.root} { ${sel} } }`;
  if (spec.kind === "list") return `query Backup_${spec.name} { ${spec.root} { ${sel} } }`;
  const args = [
    "first: $first",
    "after: $after",
    "includeArchived: true",
    ...(spec.args ? [spec.args] : []),
    ...(filter ? [`filter: ${filter}`] : []),
  ].join(", ");
  return `query Backup_${spec.name}($first: Int!, $after: String) {
  ${spec.root}(${args}) {
    nodes { ${sel} }
    pageInfo { hasNextPage endCursor }
  }
}`;
}

/** Flatten a raw node: scalars as-is, each relation `{id}` → `<rel>Id`. */
export function flattenNode(spec: EntitySpec, node: Row): Row {
  const out: Row = {};
  for (const s of spec.scalars) out[s] = node[s] ?? null;
  for (const r of spec.rels ?? []) {
    const v = node[r] as { id?: string } | null | undefined;
    out[`${r}Id`] = v?.id ?? null;
  }
  return out;
}

const idOf = (r: Row): string => String(r.id ?? "");
const sortById = (rows: Row[]): Row[] => [...rows].sort((a, b) => (idOf(a) < idOf(b) ? -1 : idOf(a) > idOf(b) ? 1 : 0));
const toJsonl = (rows: Row[]): string => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
const parseJsonl = (text: string): Row[] =>
  text.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l) as Row);

/* --------------------------------------------------------------- transport */

interface RawResponse {
  data?: unknown;
  headers?: { get(name: string): string | null } | Headers;
}

class Gql {
  minRemaining: number | null = null;
  lastRemaining: number | null = null;
  requests = 0;
  constructor(
    private client: LinearClient,
    private retry: RetryOptions,
  ) {}

  async run<T>(query: string, vars?: Record<string, unknown>): Promise<T> {
    const res = (await withRetry(
      () =>
        (this.client.client.rawRequest as unknown as (q: string, v?: Record<string, unknown>) => Promise<RawResponse>)(
          query,
          vars,
        ),
      this.retry,
    )) as RawResponse;
    this.requests += 1;
    const raw = res.headers?.get("x-ratelimit-requests-remaining") ?? null;
    const n = raw === null ? NaN : Number(raw);
    if (Number.isFinite(n)) {
      this.lastRemaining = n;
      this.minRemaining = this.minRemaining === null ? n : Math.min(this.minRemaining, n);
    }
    if (res.data === undefined || res.data === null) throw new Error("Linear returned no data");
    return res.data as T;
  }
}

/* ------------------------------------------------------------------- state */

interface BackupState {
  startedAt: string;
  runDir: string;
  scopeKey: string;
  entities: Record<string, ManifestEntity>;
  warnings: string[];
  minRequestsRemaining: number | null;
  requests?: number;
  workspace: Manifest["workspace"];
}

const STATE_FILE = ".state.json";

function writeState(dir: string, s: BackupState): void {
  writeFileSync(join(dir, STATE_FILE), JSON.stringify(s, null, 2) + "\n");
}

function writeEntityFile(dir: string, name: string, rows: Row[]): ManifestEntity {
  const sorted = sortById(rows);
  const body = toJsonl(sorted);
  const file = `${name}.jsonl`;
  writeFileSync(join(dir, file), body);
  return { count: sorted.length, file, sha256: sha256(body), bytes: Buffer.byteLength(body) };
}

/* ----------------------------------------------------------------- schema */

/** Root query fields actually exposed by the API (one introspection call). */
async function rootFields(gql: Gql): Promise<Set<string>> {
  const data = await gql.run<{ __type: { fields: Array<{ name: string }> } | null }>(
    `{ __type(name: "Query") { fields { name } } }`,
  );
  return new Set((data.__type?.fields ?? []).map((f) => f.name));
}

/* -------------------------------------------------------------- the engine */

export interface BackupResult {
  dir: string;
  manifest: Manifest;
}

export async function runBackup(client: LinearClient, opts: BackupOptions): Promise<BackupResult> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? (() => {});
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const markdown = opts.markdown ?? true;
  const requested = opts.entities?.length ? opts.entities : ENTITY_NAMES;
  const unknown = requested.filter((e) => !ENTITY_NAMES.includes(e));
  if (unknown.length) throw new BackupUsageError(`unknown entities: ${unknown.join(", ")} (valid: ${ENTITY_NAMES.join(", ")})`);
  if (opts.limit !== undefined && (!Number.isInteger(opts.limit) || opts.limit < 1)) throw new BackupUsageError("--limit must be a positive integer");
  const teams = opts.teams?.length && !opts.teams.some((t) => t.toLowerCase() === "all") ? opts.teams.map((t) => t.toUpperCase()) : null;
  const teamKeys = teams ? teams.map((t) => JSON.stringify(t)).join(", ") : "";

  const scopeKey = JSON.stringify({ requested, teams, limit: opts.limit ?? null, since: opts.since ?? null, history: !!opts.includeHistory });
  let runDir: string;
  let state: BackupState;
  if (opts.resume) {
    const found = existsSync(opts.out)
      ? readdirSync(opts.out).filter((d) => d.startsWith("linear-") && existsSync(join(opts.out, d, STATE_FILE))).sort()
      : [];
    if (!found.length) throw new BackupUsageError(`--resume: no unfinished run (no .state.json) under ${opts.out}`);
    runDir = join(opts.out, found[found.length - 1]);
    state = JSON.parse(readFileSync(join(runDir, STATE_FILE), "utf8")) as BackupState;
    if (state.scopeKey !== scopeKey) throw new BackupUsageError("--resume: flags differ from the interrupted run; re-run with the original flags");
    log(`resuming ${runDir}`);
  } else {
    const started = now();
    runDir = join(opts.out, `linear-${utcStamp(started)}`);
    if (existsSync(runDir)) throw new BackupUsageError(`${runDir} already exists`);
    mkdirSync(runDir, { recursive: true });
    state = { startedAt: started.toISOString(), runDir, scopeKey, entities: {}, warnings: [], minRequestsRemaining: null, workspace: { id: null, urlKey: null, name: null } };
    writeState(runDir, state);
  }

  const gql = new Gql(client, opts.retry ?? {});
  const priorRequests = state.requests ?? 0;
  const warn = (w: string) => {
    if (!state.warnings.includes(w)) state.warnings.push(w);
  };

  // One-shot schema check: every root connection we plan to read must exist.
  const roots = await rootFields(gql);
  const plan = ENTITIES.filter((e) => requested.includes(e.name));
  const readable: EntitySpec[] = [];
  for (const spec of plan) {
    if (roots.has(spec.root)) readable.push(spec);
    else warn(`entity "${spec.name}" skipped: root field "${spec.root}" not exposed by this API/plan`);
  }

  const data: Record<string, Row[]> = {};
  let issueIdScope: Set<string> | null = null;
  const scopedByIssues = !!(teams || opts.limit) && !opts.since;

  // Issues first, so dependent entities can be scoped to the dumped issue set.
  const ordered = [...readable].sort((a, b) => (a.name === "issues" ? -1 : b.name === "issues" ? 1 : 0));

  for (const spec of ordered) {
    const done = state.entities[spec.name];
    if (done && existsSync(join(runDir, done.file))) {
      data[spec.name] = parseJsonl(readFileSync(join(runDir, done.file), "utf8"));
      if (spec.name === "issues" && scopedByIssues) issueIdScope = new Set(data.issues.map(idOf));
      log(`${spec.name}: resumed (${done.count})`);
      continue;
    }

    const filters: string[] = [];
    if (opts.since && spec.sinceFilter) filters.push(`updatedAt: { gte: ${JSON.stringify(opts.since)} }`);
    if (teams && spec.teamFilter) {
      const f = spec.teamFilter(teamKeys);
      filters.push(f.slice(1, -1).trim());
    }
    if (opts.since && !spec.sinceFilter && spec.name !== "organization") warn(`entity "${spec.name}" has no updatedAt filter; dumped in full under --since`);
    if (teams && !spec.teamFilter && !spec.issueRef && !["organization", "users"].includes(spec.name) && spec.root !== "issues")
      warn(`entity "${spec.name}" is not team-scoped; dumped in full under --team`);
    if (teams && opts.since && spec.issueRef) warn(`entity "${spec.name}" is not team-scoped under --since`);
    const filter = filters.length ? `{ ${filters.join(", ")} }` : undefined;

    const query = buildQuery(spec, filter);
    const byId = new Map<string, Row>();
    let truncated = false;

    if (spec.kind === "single") {
      const d = await gql.run<Record<string, Row>>(query);
      const node = d[spec.root];
      if (node) byId.set(idOf(node), flattenNode(spec, node));
      if (spec.name === "organization" && node) {
        state.workspace = { id: String(node.id), urlKey: String(node.urlKey), name: String(node.name) };
      }
    } else if (spec.kind === "list") {
      const d = await gql.run<Record<string, Row[]>>(query);
      for (const n of d[spec.root] ?? []) byId.set(idOf(n), flattenNode(spec, n));
    } else {
      let after: string | null = null;
      for (;;) {
        const d: Record<string, { nodes: Row[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }> =
          await gql.run(query, { first: 100, after });
        const page = d[spec.root];
        if (!page) throw new Error(`${spec.name}: query returned no data`);
        for (const n of page.nodes) {
          const row = flattenNode(spec, n);
          if (spec.issueRef && issueIdScope && !issueIdScope.has(String(row[spec.issueRef] ?? ""))) continue;
          byId.set(idOf(row), row); // dedupe: cursors can repeat rows across pages
        }
        after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
        if (opts.limit && byId.size >= opts.limit) {
          truncated = after !== null || byId.size > opts.limit;
          break;
        }
        if (!after) break;
      }
    }

    let rows = [...byId.values()];
    if (opts.limit && rows.length > opts.limit) rows = sortById(rows).slice(0, opts.limit);
    if (truncated) warn(`entity "${spec.name}" truncated at --limit ${opts.limit}`);
    data[spec.name] = rows;
    if (spec.name === "issues" && scopedByIssues) issueIdScope = new Set(rows.map(idOf));

    state.entities[spec.name] = writeEntityFile(runDir, spec.name, rows);
    state.minRequestsRemaining = gql.minRemaining;
    state.requests = priorRequests + gql.requests;
    writeState(runDir, state);
    log(`${spec.name}: ${rows.length}`);
  }

  // Optional second pass: per-issue history, resumable at issue granularity.
  if (opts.includeHistory) {
    if (!data.issues) throw new BackupUsageError("--include-history needs the issues entity");
    await historyPass(gql, runDir, data.issues, state, {
      floor: opts.rateFloor ?? 100,
      sleep,
      log,
      warn,
    });
    state.minRequestsRemaining = gql.minRemaining;
    state.requests = priorRequests + gql.requests;
    writeState(runDir, state);
  }

  // Markdown: one file per issue under issues-md/<TEAM>/<identifier>.md.
  let markdownInfo: Manifest["markdown"] = null;
  if (markdown && data.issues) {
    const lookups = buildLookups(data);
    let count = 0;
    for (const rec of data.issues) {
      const team = lookups.teamKey(rec.teamId as string | null) || "_";
      const dir = join(runDir, "issues-md", team);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${String(rec.identifier)}.md`), renderIssueMd(rec, lookups));
      count += 1;
    }
    markdownInfo = { dir: "issues-md", count };
  }

  const skipUnresolved = !!(teams || opts.limit || opts.since);
  const unresolvedTeams = skipUnresolved ? [] : findUnresolvedTeams(data);
  if (skipUnresolved && (opts.limit || opts.since) && data.teams) warn("unresolved-team check skipped: dump is truncated or incremental");
  if (unresolvedTeams.length)
    warn(`${unresolvedTeams.length} team id(s) referenced by dumped rows are not returned by the teams query (private or archived teams this key cannot list)`);

  const partial = !!(teams || opts.limit || opts.since) || requested.length < ENTITY_NAMES.length || state.warnings.some((w) => w.includes("skipped"));
  const manifest: Manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    linearctlVersion: opts.version,
    workspace: state.workspace,
    startedAt: state.startedAt,
    finishedAt: now().toISOString(),
    scope: {
      teams,
      entities: requested,
      limit: opts.limit ?? null,
      since: opts.since ?? null,
      includeHistory: !!opts.includeHistory,
      markdown,
    },
    partial,
    entities: sortKeys(state.entities),
    markdown: markdownInfo,
    rateLimit: { minRequestsRemaining: gql.minRemaining ?? state.minRequestsRemaining },
    requests: priorRequests + gql.requests,
    ...(unresolvedTeams.length ? { unresolved: { teams: unresolvedTeams } } : {}),
    warnings: state.warnings,
  };
  writeFileSync(join(runDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  // The run is complete: drop the resume checkpoint so --resume never picks it up.
  try {
    unlinkSync(join(runDir, STATE_FILE));
  } catch {
    /* already gone */
  }
  return { dir: runDir, manifest };
}

/** Team ids that rows point at but the `teams` entity lacks (only when `teams` was dumped in full). */
export function findUnresolvedTeams(data: Record<string, Row[]>): string[] {
  if (!data.teams) return [];
  const known = new Set(data.teams.map(idOf));
  const missing = new Set<string>();
  for (const spec of ENTITIES) {
    if (spec.name === "teams" || !(spec.rels ?? []).includes("team")) continue;
    for (const r of data[spec.name] ?? []) {
      const t = r.teamId as string | null | undefined;
      if (t && !known.has(t)) missing.add(t);
    }
  }
  return [...missing].sort();
}

function sortKeys<T>(o: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/* ----------------------------------------------------------------- history */

const HISTORY_QUERY = `query BackupHistory($id: String!, $first: Int!, $after: String) {
  issue(id: $id) {
    history(first: $first, after: $after, includeArchived: true) {
      nodes {
        id createdAt updatedAt archivedAt actorId updatedDescription fromTitle toTitle
        fromAssigneeId toAssigneeId fromPriority toPriority fromTeamId toTeamId
        fromParentId toParentId fromStateId toStateId fromCycleId toCycleId
        fromProjectId toProjectId fromEstimate toEstimate archived trashed
        addedLabelIds removedLabelIds autoClosed autoArchived fromDueDate toDueDate
      }
      pageInfo { hasNextPage endCursor }
    }
  }
}`;

async function historyPass(
  gql: Gql,
  runDir: string,
  issues: Row[],
  state: BackupState,
  o: { floor: number; sleep: (ms: number) => Promise<void>; log: (s: string) => void; warn: (w: string) => void },
): Promise<void> {
  const path = join(runDir, HISTORY_FILE);
  const progressPath = join(runDir, ".history-done.json");
  // A finished pass (state survived a later crash) is reused when its file still hashes to the record.
  const prior = state.entities[HISTORY_ENTITY];
  if (prior && existsSync(join(runDir, prior.file)) && sha256(readFileSync(join(runDir, prior.file))) === prior.sha256) {
    o.log(`history: resumed (${prior.count} rows)`);
    return;
  }
  const done = new Set<string>(existsSync(progressPath) ? (JSON.parse(readFileSync(progressPath, "utf8")) as string[]) : []);
  // Rows for fully-processed issues only; rows appended after the last done-list write are dropped and re-fetched.
  let kept: Row[] = [];
  if (existsSync(path)) {
    const all = parseJsonl(readFileSync(path, "utf8"));
    kept = all.filter((r) => done.has(String(r.issueId)));
    if (kept.length !== all.length) writeFileSync(path, toJsonl(kept));
  }

  const CHECKPOINT_EVERY = 50;
  let pending: Row[] = [];
  const flush = () => {
    // Rows first (append), done-list second: a crash re-fetches, never skips.
    if (pending.length) appendFileSync(path, toJsonl(pending));
    writeFileSync(progressPath, JSON.stringify([...done]));
    pending = [];
  };

  const ids = issues.map(idOf).sort();
  let n = 0;
  let sinceFlush = 0;
  for (const issueId of ids) {
    n += 1;
    if (done.has(issueId)) continue;
    // Proactive throttle: sleep out the window when the budget is nearly spent.
    if (gql.lastRemaining !== null && gql.lastRemaining < o.floor) {
      o.log(`rate budget low (${gql.lastRemaining} left); sleeping 60s`);
      await o.sleep(60_000);
      gql.lastRemaining = null;
    }
    const rows: Row[] = [];
    let after: string | null = null;
    for (;;) {
      const d: { issue: { history: { nodes: Row[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } | null } =
        await gql.run(HISTORY_QUERY, { id: issueId, first: 100, after });
      const h = d.issue?.history;
      if (!h) {
        o.warn(`history: issue ${issueId} not readable`);
        break;
      }
      for (const node of h.nodes) rows.push({ issueId, ...node });
      after = h.pageInfo.hasNextPage ? h.pageInfo.endCursor : null;
      if (!after) break;
    }
    kept.push(...rows);
    pending.push(...rows);
    done.add(issueId);
    sinceFlush += 1;
    if (sinceFlush >= CHECKPOINT_EVERY) {
      flush();
      sinceFlush = 0;
    }
    if (n % 100 === 0) o.log(`history: ${n}/${ids.length}`);
  }
  flush();

  kept = [...kept].sort((a, b) => {
    const ka = `${a.issueId}|${a.createdAt}|${a.id}`;
    const kb = `${b.issueId}|${b.createdAt}|${b.id}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const body = toJsonl(kept);
  writeFileSync(path, body);
  state.entities[HISTORY_ENTITY] = { count: kept.length, file: HISTORY_FILE, sha256: sha256(body), bytes: Buffer.byteLength(body) };
  try {
    unlinkSync(progressPath);
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------------- markdown */

const isoOrRaw = (v: unknown): string => {
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? String(v ?? "") : new Date(t).toISOString();
};

export interface Lookups {
  teamKey(id: string | null): string;
  stateName(id: string | null): string;
  stateType(id: string | null): string;
  userName(id: string | null): string | null;
  projectName(id: string | null): string | null;
  labelName(id: string): string;
  issueIdentifier(id: string | null): string | null;
  commentsByIssue: Map<string, Row[]>;
}

export function buildLookups(data: Record<string, Row[]>): Lookups {
  const by = (name: string): Map<string, Row> => new Map((data[name] ?? []).map((r) => [idOf(r), r]));
  const teams = by("teams");
  const states = by("workflowStates");
  const users = by("users");
  const projects = by("projects");
  const labels = by("issueLabels");
  const issues = by("issues");
  const commentsByIssue = new Map<string, Row[]>();
  for (const c of data.comments ?? []) {
    const k = c.issueId as string | null;
    if (!k) continue;
    const list = commentsByIssue.get(k) ?? [];
    list.push(c);
    commentsByIssue.set(k, list);
  }
  return {
    teamKey: (id) => (id ? String(teams.get(id)?.key ?? "") : ""),
    stateName: (id) => (id ? String(states.get(id)?.name ?? "") : ""),
    stateType: (id) => (id ? String(states.get(id)?.type ?? "") : ""),
    userName: (id) => (id ? ((users.get(id)?.displayName as string | undefined) ?? null) : null),
    projectName: (id) => (id ? ((projects.get(id)?.name as string | undefined) ?? null) : null),
    labelName: (id) => String(labels.get(id)?.name ?? id),
    issueIdentifier: (id) => (id ? ((issues.get(id)?.identifier as string | undefined) ?? null) : null),
    commentsByIssue,
  };
}

/** Build the same {@link IssueDetail} that `show` renders, from a dumped record. */
export function recordToDetail(rec: Row, lk: Lookups): IssueDetail {
  const labelIds = (rec.labelIds as string[] | null) ?? [];
  return {
    id: String(rec.id),
    identifier: String(rec.identifier),
    title: String(rec.title ?? ""),
    url: String(rec.url ?? ""),
    state: lk.stateName(rec.stateId as string | null),
    stateType: lk.stateType(rec.stateId as string | null),
    assignee: lk.userName(rec.assigneeId as string | null),
    priority: String(rec.priorityLabel ?? ""),
    project: lk.projectName(rec.projectId as string | null),
    labels: labelIds.map((id) => lk.labelName(id)),
    parent: lk.issueIdentifier(rec.parentId as string | null),
    description: (rec.description as string | null) ?? null,
    createdAt: isoOrRaw(rec.createdAt),
    updatedAt: isoOrRaw(rec.updatedAt),
  };
}

/**
 * Pure renderer for `issues-md/`. The header block is `renderIssueDetail`
 * itself (so it cannot drift from `show`); comments follow the body.
 */
export function renderIssueMd(rec: Row, lk: Lookups): string {
  let out = renderIssueDetail(recordToDetail(rec, lk));
  const comments = [...(lk.commentsByIssue.get(String(rec.id)) ?? [])].sort((a, b) =>
    String(a.createdAt) < String(b.createdAt) ? -1 : 1,
  );
  if (comments.length) {
    out += `\n---\n\n## Comments (${comments.length})\n`;
    for (const c of comments) {
      const who = lk.userName(c.userId as string | null) ?? "unknown";
      out += `\n### ${who} — ${isoOrRaw(c.createdAt)}\n\n${String(c.body ?? "").trim() || "(empty)"}\n`;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ verify */

export interface VerifyOptions {
  client?: LinearClient;
  /** Fractional live drift allowed per entity (0.02 = 2%). */
  tolerance?: number;
  sample?: number;
  rand?: () => number;
  retry?: RetryOptions;
}

export interface VerifyResult {
  exitCode: 0 | 1 | 2;
  hashMismatches: string[];
  countMismatches: string[];
  integrity: string[];
  drift: string[];
  sampleMismatches: string[];
  notes: string[];
}

export async function verifyBackup(dir: string, opts: VerifyOptions = {}): Promise<VerifyResult> {
  const mpath = join(dir, "manifest.json");
  if (!existsSync(mpath)) throw new BackupUsageError(`no manifest.json in ${dir}`);
  const manifest = JSON.parse(readFileSync(mpath, "utf8")) as Manifest;
  const res: VerifyResult = { exitCode: 0, hashMismatches: [], countMismatches: [], integrity: [], drift: [], sampleMismatches: [], notes: [] };
  const data: Record<string, Row[]> = {};

  for (const [name, m] of Object.entries(manifest.entities)) {
    const p = join(dir, m.file);
    if (!existsSync(p)) {
      res.hashMismatches.push(`${name}: file ${m.file} missing`);
      continue;
    }
    const buf = readFileSync(p);
    if (sha256(buf) !== m.sha256) res.hashMismatches.push(`${name}: sha256 differs from manifest`);
    if (buf.length !== m.bytes) res.hashMismatches.push(`${name}: ${buf.length} bytes, manifest says ${m.bytes}`);
    const text = buf.toString("utf8");
    const lines = lineCount(text);
    if (lines !== m.count) res.countMismatches.push(`${name}: ${lines} lines, manifest says ${m.count}`);
    try {
      data[name] = parseJsonl(text);
    } catch {
      res.hashMismatches.push(`${name}: unparseable JSON line`);
    }
  }

  // Referential integrity: every foreign id resolves inside the dump.
  const ids = (n: string): Set<string> | null => (data[n] ? new Set(data[n].map(idOf)) : null);
  const checks: Array<[string, string, string]> = [
    ["issues", "stateId", "workflowStates"],
    ["issues", "teamId", "teams"],
    ["issues", "projectId", "projects"],
    ["issues", "assigneeId", "users"],
    ["issues", "parentId", "issues"],
    ["workflowStates", "teamId", "teams"],
    ["comments", "issueId", "issues"],
    ["attachments", "issueId", "issues"],
    ["issueRelations", "issueId", "issues"],
    ["issueRelations", "relatedIssueId", "issues"],
    ["projectMilestones", "projectId", "projects"],
    ["initiativeToProjects", "projectId", "projects"],
    ["initiativeToProjects", "initiativeId", "initiatives"],
  ];
  const allowedTeams = new Set(manifest.unresolved?.teams ?? []);
  for (const [from, field, to] of checks) {
    const target = ids(to);
    if (!data[from] || !target) continue;
    let dangling = 0;
    for (const r of data[from]) {
      const v = r[field] as string | null | undefined;
      if (v && !target.has(v) && !(to === "teams" && allowedTeams.has(v))) dangling += 1;
    }
    if (dangling) res.integrity.push(`${from}.${field}: ${dangling} id(s) not found in ${to}`);
  }
  if (manifest.partial && res.integrity.length) {
    res.notes.push("partial dump: dangling references reported but not counted as failures");
  }
  const integrityFails = manifest.partial ? [] : res.integrity;

  if (res.hashMismatches.length || res.countMismatches.length || integrityFails.length) {
    res.exitCode = 1;
    return res;
  }

  // Live comparison needs a client; offline verify stops here.
  if (!opts.client) {
    res.notes.push("offline: live drift and issue sampling skipped");
    return res;
  }
  const gql = new Gql(opts.client, opts.retry ?? {});
  const tol = opts.tolerance ?? 0.02;
  if (manifest.partial) {
    res.notes.push("partial dump: per-entity live counts skipped");
  } else {
    for (const [name, m] of Object.entries(manifest.entities)) {
      const spec = ENTITIES.find((e) => e.name === name);
      if (!spec || spec.kind !== "connection") continue;
      const live = await liveCount(gql, spec);
      const diff = Math.abs(live - m.count);
      if (diff / Math.max(live, 1) > tol) res.drift.push(`${name}: live ${live}, backup ${m.count}`);
    }
  }

  // Spot-check a few issues against the live API.
  const issues = data.issues ?? [];
  const k = Math.min(opts.sample ?? 5, issues.length);
  const rand = opts.rand ?? Math.random;
  // Partial Fisher-Yates: k distinct indices, terminates for any rand().
  const order = issues.map((_, i) => i);
  for (let i = 0; i < k; i++) {
    const j = i + Math.min(order.length - i - 1, Math.floor(rand() * (order.length - i)));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const picked = order.slice(0, k);
  const lk = buildLookups(data);
  for (const i of picked) {
    const rec = issues[i];
    const d = await gql.run<{ issue: { identifier: string; title: string; description: string | null; priorityLabel: string; createdAt: string; updatedAt: string; team: { id: string } | null; state: { name: string } | null } | null }>(
      `query($id: String!) { issue(id: $id) { identifier title description priorityLabel createdAt updatedAt team { id } state { name } } }`,
      { id: String(rec.id) },
    );
    const live = d.issue;
    const ident = String(rec.identifier);
    if (!live) {
      res.sampleMismatches.push(`${ident}: not found live`);
      continue;
    }
    const want = recordToDetail(rec, lk);
    // Stable fields must always match. Mutable fields may differ only if the issue
    // was edited after the dump (live updatedAt newer); that is expected drift, noted not failed.
    const stable: string[] = [];
    if (live.identifier !== ident) stable.push("identifier");
    if (Date.parse(live.createdAt) !== Date.parse(String(rec.createdAt))) stable.push("createdAt");
    if ((live.team?.id ?? null) !== ((rec.teamId as string | null) ?? null)) stable.push("team");
    const mutable: string[] = [];
    if (live.title !== want.title) mutable.push("title");
    if ((live.description ?? null) !== want.description) mutable.push("description");
    if (live.priorityLabel !== want.priority) mutable.push("priority");
    if ((live.state?.name ?? "") !== want.state) mutable.push("state");
    const edited = Date.parse(live.updatedAt) > Date.parse(String(rec.updatedAt));
    if (stable.length) res.sampleMismatches.push(`${ident}: ${stable.join(", ")} differ`);
    if (mutable.length && edited) res.notes.push(`${ident}: edited since the dump (${mutable.join(", ")}); not counted as drift`);
    else if (mutable.length) res.sampleMismatches.push(`${ident}: ${mutable.join(", ")} differ with no newer live updatedAt`);
  }
  if (res.drift.length || res.sampleMismatches.length) res.exitCode = 2;
  return res;
}

async function liveCount(gql: Gql, spec: EntitySpec): Promise<number> {
  const q = `query Count($first: Int!, $after: String) {
  ${spec.root}(first: $first, after: $after, includeArchived: true${spec.args ? ", " + spec.args : ""}) {
    nodes { id }
    pageInfo { hasNextPage endCursor }
  }
}`;
  let n = 0;
  let after: string | null = null;
  const seen = new Set<string>();
  for (;;) {
    const d: Record<string, { nodes: Array<{ id: string }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } }> =
      await gql.run(q, { first: 250, after });
    const page = d[spec.root];
    for (const node of page.nodes) seen.add(node.id);
    n = seen.size;
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
    if (!after) break;
  }
  return n;
}
