import type { LinearClient } from "@linear/sdk";
import { sql, eq, or, and } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import type { SQLiteTableWithColumns } from "drizzle-orm/sqlite-core";
import { existsSync, statSync } from "node:fs";
import { withRetry } from "../../lib/retry.js";
import { openCacheDb, type CacheDbInstance } from "./db.js";
import * as schema from "./schema.js";
import type {
  CachedIssue,
  InsertIssue,
  CachedTeam,
  CachedWorkflowState,
  CachedIssueLabel,
  CachedProject,
  CachedCycle,
  CachedProjectMilestone,
} from "./schema.js";

export interface SyncOptions {
  teams?: string[];
  since?: string;
  full?: boolean;
  log?: (msg: string) => void;
  orgSlug?: string;
  dbPath?: string;
  dbInstance?: CacheDbInstance;
}

export interface SyncResult {
  syncedAt: string;
  isFullSync: boolean;
  counts: {
    teams: number;
    workflowStates: number;
    issueLabels: number;
    projects: number;
    cycles: number;
    projectMilestones: number;
    issues: number;
    issueRelations: number;
    users?: number;
    [key: string]: number | undefined;
  };
  durationMs: number;
  dbPath?: string;
}

export interface CacheStatusReport {
  lastSyncAt: string | null;
  lastSyncEntityCounts: Record<string, number> | null;
  counts: {
    teams: number;
    workflowStates: number;
    issueLabels: number;
    projects: number;
    cycles: number;
    projectMilestones: number;
    issues: number;
    issueRelations: number;
    users?: number;
    [key: string]: number | undefined;
  };
  dbPath: string;
  sizeBytes: number;
}

/* ------------------------------------------------------------------ helpers */

function parseSinceCutoff(since: string): string {
  const trimmed = since.trim();
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
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid since timestamp or duration: "${since}"`);
  }
  return new Date(parsed).toISOString();
}

export function setCacheMeta(
  db: BunSQLiteDatabase<typeof schema>,
  key: string,
  value: string,
  nowIso = new Date().toISOString(),
): void {
  db.insert(schema.cacheMeta)
    .values({
      key,
      value,
      updatedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: schema.cacheMeta.key,
      set: {
        value: sql.raw("excluded.value"),
        updatedAt: sql.raw("excluded.updated_at"),
      },
    })
    .run();
}

export function getCacheMeta(
  db: BunSQLiteDatabase<typeof schema>,
  key: string,
): string | null {
  const row = db
    .select({ value: schema.cacheMeta.value })
    .from(schema.cacheMeta)
    .where(eq(schema.cacheMeta.key, key))
    .get();
  return row ? row.value : null;
}

function upsertRows<TTable extends SQLiteTableWithColumns<any>>(
  db: BunSQLiteDatabase<typeof schema> | any,
  table: TTable,
  rows: any[],
  idColumn: any,
  chunkSize = 50,
): void {
  if (rows.length === 0) return;
  const sample = rows[0];
  const updateCols: Record<string, any> = {};
  for (const key of Object.keys(sample)) {
    if (key !== "id" && (table as any)[key]) {
      const colName = (table as any)[key].name;
      updateCols[key] = sql.raw(`excluded.${colName}`);
    }
  }

  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    db.insert(table)
      .values(chunk)
      .onConflictDoUpdate({
        target: idColumn,
        set: updateCols,
      })
      .run();
  }
}

async function fetchConnectionNodes<TNode>(
  client: LinearClient,
  query: string,
  rootField: string,
  variables: Record<string, unknown> = {},
): Promise<TNode[]> {
  const nodes: TNode[] = [];
  let after: string | null = null;
  type RawResponse = {
    data?: Record<
      string,
      { nodes: TNode[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } | null
    >;
  };
  do {
    const vars: Record<string, unknown> = { ...variables, first: 100, after };
    const res: RawResponse = await withRetry<RawResponse>(() =>
      (
        client.client.rawRequest as unknown as (
          q: string,
          v?: Record<string, unknown>,
        ) => Promise<RawResponse>
      )(query, vars),
    );
    const conn = res.data?.[rootField];
    if (!conn) break;
    for (const node of conn.nodes) {
      nodes.push(node);
    }
    after = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  } while (after);
  return nodes;
}

/* ------------------------------------------------------------- GraphQL queries */

const TEAMS_QUERY = /* GraphQL */ `
  query SyncTeams($first: Int!, $after: String, $filter: TeamFilter) {
    teams(first: $first, after: $after, filter: $filter) {
      nodes {
        id
        key
        name
        displayName
        description
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const WORKFLOW_STATES_QUERY = /* GraphQL */ `
  query SyncWorkflowStates($first: Int!, $after: String, $filter: WorkflowStateFilter) {
    workflowStates(first: $first, after: $after, filter: $filter) {
      nodes {
        id
        team {
          id
        }
        name
        type
        color
        position
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ISSUE_LABELS_QUERY = /* GraphQL */ `
  query SyncIssueLabels($first: Int!, $after: String, $filter: IssueLabelFilter) {
    issueLabels(first: $first, after: $after, filter: $filter) {
      nodes {
        id
        team {
          id
        }
        name
        color
        description
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const PROJECTS_QUERY = /* GraphQL */ `
  query SyncProjects($first: Int!, $after: String) {
    projects(first: $first, after: $after) {
      nodes {
        id
        name
        slugId
        state
        lead {
          id
        }
        startDate
        targetDate
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const CYCLES_QUERY = /* GraphQL */ `
  query SyncCycles($first: Int!, $after: String, $filter: CycleFilter) {
    cycles(first: $first, after: $after, filter: $filter) {
      nodes {
        id
        team {
          id
        }
        number
        name
        startsAt
        endsAt
        completedAt
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const PROJECT_MILESTONES_QUERY = /* GraphQL */ `
  query SyncProjectMilestones($first: Int!, $after: String) {
    projectMilestones(first: $first, after: $after) {
      nodes {
        id
        project {
          id
        }
        name
        description
        targetDate
        status
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const USERS_QUERY = /* GraphQL */ `
  query SyncUsers($first: Int!, $after: String) {
    users(first: $first, after: $after, includeDisabled: true) {
      nodes {
        id
        name
        displayName
        email
        active
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ISSUES_QUERY = /* GraphQL */ `
  query SyncIssues($first: Int!, $after: String, $filter: IssueFilter) {
    issues(first: $first, after: $after, filter: $filter, includeArchived: true) {
      nodes {
        id
        identifier
        number
        title
        description
        priority
        priorityLabel
        estimate
        team {
          id
          key
        }
        state {
          id
          name
          type
        }
        project {
          id
          name
        }
        projectMilestone {
          id
        }
        cycle {
          id
          number
        }
        assignee {
          id
          name
          displayName
        }
        creator {
          id
        }
        parent {
          id
        }
        url
        branchName
        dueDate
        labels {
          nodes {
            id
            name
          }
        }
        trashed
        createdAt
        updatedAt
        archivedAt
        startedAt
        completedAt
        canceledAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

const ISSUE_RELATIONS_QUERY = /* GraphQL */ `
  query SyncIssueRelations($first: Int!, $after: String) {
    issueRelations(first: $first, after: $after, includeArchived: true) {
      nodes {
        id
        type
        issue {
          id
        }
        relatedIssue {
          id
        }
        createdAt
        updatedAt
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

/* ------------------------------------------------------------- syncCache */

export async function syncCache(
  client: LinearClient,
  options?: SyncOptions,
): Promise<SyncResult> {
  const startTime = Date.now();
  const nowIso = new Date().toISOString();
  const log = options?.log ?? (() => {});

  const shouldCloseDb = !options?.dbInstance;
  const dbInstance =
    options?.dbInstance ??
    openCacheDb({
      dbPath: options?.dbPath,
      orgSlug: options?.orgSlug,
    });

  try {
    const teamKeys =
      options?.teams?.length && !options.teams.some((t) => t.toLowerCase() === "all")
        ? options.teams.map((t) => t.toUpperCase())
        : undefined;

    let isFullSync = options?.full === true;
    let sinceCutoff: string | undefined = undefined;

    if (!isFullSync) {
      if (options?.since) {
        sinceCutoff = parseSinceCutoff(options.since);
      } else {
        const lastSyncAt = getCacheMeta(dbInstance.db, "last_sync_at");
        if (lastSyncAt) {
          sinceCutoff = lastSyncAt;
        } else {
          isFullSync = true;
        }
      }
    }

    log(`sync: starting ${isFullSync ? "full" : "delta"} sync (cutoff: ${sinceCutoff ?? "none"})...`);

    // 0. Viewer identity
    log("sync: fetching viewer identity...");
    let viewerData: { id: string; name?: string; displayName?: string; email?: string } | null = null;
    try {
      const viewer = await client.viewer;
      if (viewer?.id) {
        viewerData = {
          id: viewer.id,
          name: viewer.name,
          displayName: viewer.displayName,
          email: viewer.email,
        };
      }
    } catch {
      // Non-fatal if viewer cannot be fetched
    }

    // 1. Teams
    log("sync: fetching teams...");
    const teamFilter = teamKeys ? { key: { in: teamKeys } } : undefined;
    const rawTeams = await fetchConnectionNodes<any>(client, TEAMS_QUERY, "teams", {
      filter: teamFilter,
    });
    const teamRows = rawTeams.map((t) => ({
      id: t.id,
      key: t.key,
      name: t.name,
      displayName: t.displayName ?? null,
      description: t.description ?? null,
      createdAt: t.createdAt ?? null,
      updatedAt: t.updatedAt,
    }));

    // 2. Workflow states
    log("sync: fetching workflow states...");
    const stateFilter = teamKeys ? { team: { key: { in: teamKeys } } } : undefined;
    const rawStates = await fetchConnectionNodes<any>(
      client,
      WORKFLOW_STATES_QUERY,
      "workflowStates",
      { filter: stateFilter },
    );
    const stateRows = rawStates.map((s) => ({
      id: s.id,
      teamId: s.team?.id ?? null,
      name: s.name,
      type: s.type,
      color: s.color ?? null,
      position: s.position ?? 0,
      createdAt: s.createdAt ?? null,
      updatedAt: s.updatedAt,
    }));

    // 3. Issue labels
    log("sync: fetching issue labels...");
    const labelFilter = teamKeys
      ? { or: [{ team: { null: true } }, { team: { key: { in: teamKeys } } }] }
      : undefined;
    const rawLabels = await fetchConnectionNodes<any>(
      client,
      ISSUE_LABELS_QUERY,
      "issueLabels",
      { filter: labelFilter },
    );
    const labelRows = rawLabels.map((l) => ({
      id: l.id,
      teamId: l.team?.id ?? null,
      name: l.name,
      color: l.color ?? null,
      description: l.description ?? null,
      createdAt: l.createdAt ?? null,
      updatedAt: l.updatedAt,
    }));

    // 4. Projects
    log("sync: fetching projects...");
    const rawProjects = await fetchConnectionNodes<any>(client, PROJECTS_QUERY, "projects");
    const projectRows = rawProjects.map((p) => ({
      id: p.id,
      name: p.name,
      slugId: p.slugId ?? null,
      state: p.state ?? null,
      leadId: p.lead?.id ?? null,
      startDate: p.startDate ?? null,
      targetDate: p.targetDate ?? null,
      createdAt: p.createdAt ?? null,
      updatedAt: p.updatedAt,
    }));

    // 5. Cycles
    log("sync: fetching cycles...");
    const cycleFilter = teamKeys ? { team: { key: { in: teamKeys } } } : undefined;
    const rawCycles = await fetchConnectionNodes<any>(client, CYCLES_QUERY, "cycles", {
      filter: cycleFilter,
    });
    const cycleRows = rawCycles.map((c) => ({
      id: c.id,
      teamId: c.team?.id ?? null,
      number: c.number ?? null,
      name: c.name ?? null,
      startsAt: c.startsAt ?? null,
      endsAt: c.endsAt ?? null,
      completedAt: c.completedAt ?? null,
      createdAt: c.createdAt ?? null,
      updatedAt: c.updatedAt,
    }));

    // 6. Project milestones
    log("sync: fetching project milestones...");
    const rawMilestones = await fetchConnectionNodes<any>(
      client,
      PROJECT_MILESTONES_QUERY,
      "projectMilestones",
    );
    const milestoneRows = rawMilestones.map((m) => ({
      id: m.id,
      projectId: m.project?.id ?? null,
      name: m.name,
      description: m.description ?? null,
      targetDate: m.targetDate ?? null,
      status: m.status ?? null,
      createdAt: m.createdAt ?? null,
      updatedAt: m.updatedAt,
    }));

    // 7. Users
    log("sync: fetching users...");
    const rawUsers = await fetchConnectionNodes<any>(client, USERS_QUERY, "users");
    const userRows = rawUsers.map((u) => ({
      id: u.id,
      name: u.name,
      displayName: u.displayName ?? null,
      email: u.email ?? null,
      active: u.active ?? true,
      createdAt: u.createdAt ?? null,
      updatedAt: u.updatedAt ?? null,
    }));
    if (viewerData && !userRows.some((u) => u.id === viewerData!.id)) {
      userRows.push({
        id: viewerData.id,
        name: viewerData.name ?? "Viewer",
        displayName: viewerData.displayName ?? null,
        email: viewerData.email ?? null,
        active: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      });
    }

    // 8. Issues
    log("sync: fetching issues...");
    const issueFilter: Record<string, unknown> = {};
    if (teamKeys && teamKeys.length > 0) {
      issueFilter.team = { key: { in: teamKeys } };
    }
    if (sinceCutoff) {
      issueFilter.updatedAt = { gte: sinceCutoff };
    }

    const rawIssues = await fetchConnectionNodes<any>(client, ISSUES_QUERY, "issues", {
      filter: Object.keys(issueFilter).length > 0 ? issueFilter : undefined,
    });

    const issueRows: schema.InsertIssue[] = rawIssues.map((n) => {
      const labels = (n.labels?.nodes ?? []).map((l: any) => l.name);
      const labelIds = (n.labels?.nodes ?? []).map((l: any) => l.id);
      return {
        id: n.id,
        identifier: n.identifier,
        number: n.number,
        title: n.title,
        description: n.description ?? "",
        priority: n.priority ?? 0,
        priorityLabel: n.priorityLabel ?? null,
        estimate: n.estimate != null ? Number(n.estimate) : null,
        teamId: n.team?.id ?? null,
        teamKey: n.team?.key ?? null,
        stateId: n.state?.id ?? null,
        stateName: n.state?.name ?? "",
        stateType: n.state?.type ?? "",
        projectId: n.project?.id ?? null,
        projectName: n.project?.name ?? null,
        projectMilestoneId: n.projectMilestone?.id ?? null,
        cycleId: n.cycle?.id ?? null,
        cycleNumber: n.cycle?.number ?? null,
        assigneeId: n.assignee?.id ?? null,
        assigneeName: n.assignee?.displayName || n.assignee?.name || null,
        creatorId: n.creator?.id ?? null,
        parentId: n.parent?.id ?? null,
        url: n.url,
        branchName: n.branchName ?? null,
        dueDate: n.dueDate ?? null,
        labelsJson: JSON.stringify(labels),
        labelIdsJson: JSON.stringify(labelIds),
        trashed: Boolean(n.trashed),
        createdAt: n.createdAt,
        updatedAt: n.updatedAt,
        archivedAt: n.archivedAt ?? null,
        startedAt: n.startedAt ?? null,
        completedAt: n.completedAt ?? null,
        canceledAt: n.canceledAt ?? null,
      };
    });

    // 9. Issue relations
    log("sync: fetching issue relations...");
    const rawRelations = await fetchConnectionNodes<any>(
      client,
      ISSUE_RELATIONS_QUERY,
      "issueRelations",
    );
    const relationRows = rawRelations
      .filter((r) => r.issue?.id && r.relatedIssue?.id)
      .map((r) => ({
        id: r.id,
        type: r.type,
        issueId: r.issue.id,
        relatedIssueId: r.relatedIssue.id,
        createdAt: r.createdAt ?? null,
        updatedAt: r.updatedAt ?? null,
      }));

    // Commit to SQLite within transaction
    log("sync: persisting changes to SQLite...");
    const counts = {
      teams: teamRows.length,
      workflowStates: stateRows.length,
      issueLabels: labelRows.length,
      projects: projectRows.length,
      cycles: cycleRows.length,
      projectMilestones: milestoneRows.length,
      users: userRows.length,
      issues: issueRows.length,
      issueRelations: relationRows.length,
    };

    dbInstance.db.transaction((tx) => {
      upsertRows(tx, schema.teams, teamRows, schema.teams.id);
      upsertRows(tx, schema.workflowStates, stateRows, schema.workflowStates.id);
      upsertRows(tx, schema.issueLabels, labelRows, schema.issueLabels.id);
      upsertRows(tx, schema.projects, projectRows, schema.projects.id);
      upsertRows(tx, schema.cycles, cycleRows, schema.cycles.id);
      upsertRows(tx, schema.projectMilestones, milestoneRows, schema.projectMilestones.id);
      upsertRows(tx, schema.users, userRows, schema.users.id);
      upsertRows(tx, schema.issues, issueRows, schema.issues.id);
      upsertRows(tx, schema.issueRelations, relationRows, schema.issueRelations.id);

      setCacheMeta(tx, "last_sync_at", nowIso, nowIso);
      setCacheMeta(tx, "last_sync_entity_counts", JSON.stringify(counts), nowIso);

      if (viewerData) {
        setCacheMeta(tx, "viewer_id", viewerData.id, nowIso);
        if (viewerData.name) setCacheMeta(tx, "viewer_name", viewerData.name, nowIso);
        if (viewerData.displayName) setCacheMeta(tx, "viewer_display_name", viewerData.displayName, nowIso);
        if (viewerData.email) setCacheMeta(tx, "viewer_email", viewerData.email, nowIso);
      }
    });

    const durationMs = Date.now() - startTime;
    log(`sync: finished in ${durationMs}ms`);

    return {
      syncedAt: nowIso,
      isFullSync,
      counts,
      durationMs,
      dbPath: dbInstance.path,
    };
  } finally {
    if (shouldCloseDb) {
      dbInstance.close();
    }
  }
}

/* -------------------------------------------------------- write-through helpers */

export function patchIssueInCache(dbInstance: CacheDbInstance, issue: any): void {
  if (!issue || (!issue.id && !issue.identifier)) {
    return;
  }

  const existing = dbInstance.db
    .select()
    .from(schema.issues)
    .where(
      or(
        issue.id ? eq(schema.issues.id, issue.id) : undefined,
        issue.identifier ? eq(schema.issues.identifier, issue.identifier) : undefined,
        issue.identifier
          ? eq(sql`UPPER(${schema.issues.identifier})`, issue.identifier.toUpperCase())
          : undefined,
      ),
    )
    .get();

  const nowIso = new Date().toISOString();

  let labelsJson: string | undefined = undefined;
  if (Array.isArray(issue.labels)) {
    labelsJson = JSON.stringify(
      issue.labels.map((l: any) => (typeof l === "string" ? l : l?.name ?? String(l))),
    );
  } else if (issue.labels?.nodes && Array.isArray(issue.labels.nodes)) {
    labelsJson = JSON.stringify(
      issue.labels.nodes.map((l: any) => (typeof l === "string" ? l : l?.name ?? String(l))),
    );
  } else if (typeof issue.labelsJson === "string") {
    labelsJson = issue.labelsJson;
  }

  let labelIdsJson: string | undefined = undefined;
  if (Array.isArray(issue.labelIds)) {
    labelIdsJson = JSON.stringify(issue.labelIds);
  } else if (issue.labels?.nodes && Array.isArray(issue.labels.nodes)) {
    labelIdsJson = JSON.stringify(
      issue.labels.nodes.map((l: any) => l?.id).filter(Boolean),
    );
  } else if (typeof issue.labelIdsJson === "string") {
    labelIdsJson = issue.labelIdsJson;
  }

  const stateName =
    issue.stateName ??
    (typeof issue.state === "string" ? issue.state : issue.state?.name);
  const stateType = issue.stateType ?? issue.state?.type;
  const stateId = issue.stateId ?? issue.state?.id;

  const assigneeName =
    issue.assigneeName ??
    (typeof issue.assignee === "string"
      ? issue.assignee
      : issue.assignee?.displayName || issue.assignee?.name);
  const assigneeId = issue.assigneeId ?? issue.assignee?.id;

  const teamKey = issue.teamKey ?? issue.team?.key;
  const teamId = issue.teamId ?? issue.team?.id;

  const projectName =
    issue.projectName ??
    (typeof issue.project === "string" ? issue.project : issue.project?.name);
  const projectId = issue.projectId ?? issue.project?.id;

  if (existing) {
    const updateValues: Partial<InsertIssue> = {
      title: issue.title !== undefined ? issue.title : existing.title,
      description: issue.description !== undefined ? issue.description : existing.description,
      priority: issue.priority !== undefined ? issue.priority : existing.priority,
      priorityLabel: issue.priorityLabel !== undefined ? issue.priorityLabel : existing.priorityLabel,
      estimate:
        issue.estimate !== undefined
          ? issue.estimate == null
            ? null
            : Number(issue.estimate)
          : existing.estimate,
      teamId: teamId !== undefined ? teamId : existing.teamId,
      teamKey: teamKey !== undefined ? teamKey : existing.teamKey,
      stateId: stateId !== undefined ? stateId : existing.stateId,
      stateName: stateName !== undefined ? stateName : existing.stateName,
      stateType: stateType !== undefined ? stateType : existing.stateType,
      projectId: projectId !== undefined ? projectId : existing.projectId,
      projectName: projectName !== undefined ? projectName : existing.projectName,
      projectMilestoneId:
        issue.projectMilestoneId !== undefined
          ? issue.projectMilestoneId
          : issue.projectMilestone?.id !== undefined
            ? issue.projectMilestone.id
            : existing.projectMilestoneId,
      cycleId:
        issue.cycleId !== undefined
          ? issue.cycleId
          : issue.cycle?.id !== undefined
            ? issue.cycle.id
            : existing.cycleId,
      cycleNumber:
        issue.cycleNumber !== undefined
          ? issue.cycleNumber
          : issue.cycle?.number !== undefined
            ? issue.cycle.number
            : existing.cycleNumber,
      assigneeId: assigneeId !== undefined ? assigneeId : existing.assigneeId,
      assigneeName: assigneeName !== undefined ? assigneeName : existing.assigneeName,
      branchName: issue.branchName !== undefined ? issue.branchName : existing.branchName,
      dueDate: issue.dueDate !== undefined ? issue.dueDate : existing.dueDate,
      url: issue.url !== undefined ? issue.url : existing.url,
      labelsJson: labelsJson !== undefined ? labelsJson : existing.labelsJson,
      labelIdsJson: labelIdsJson !== undefined ? labelIdsJson : existing.labelIdsJson,
      trashed: issue.trashed !== undefined ? Boolean(issue.trashed) : existing.trashed,
      updatedAt: issue.updatedAt || nowIso,
      archivedAt: issue.archivedAt !== undefined ? issue.archivedAt : existing.archivedAt,
      startedAt: issue.startedAt !== undefined ? issue.startedAt : existing.startedAt,
      completedAt: issue.completedAt !== undefined ? issue.completedAt : existing.completedAt,
      canceledAt: issue.canceledAt !== undefined ? issue.canceledAt : existing.canceledAt,
    };

    dbInstance.db
      .update(schema.issues)
      .set(updateValues)
      .where(eq(schema.issues.id, existing.id))
      .run();
  } else {
    const id = issue.id || crypto.randomUUID();
    const identifier = issue.identifier || id;
    const number =
      typeof issue.number === "number"
        ? issue.number
        : parseInt(identifier.split("-")[1], 10) || 0;

    const newIssue: InsertIssue = {
      id,
      identifier,
      number,
      title: issue.title || "",
      description: issue.description || "",
      priority: typeof issue.priority === "number" ? issue.priority : 0,
      priorityLabel: issue.priorityLabel || null,
      estimate: issue.estimate != null ? Number(issue.estimate) : null,
      teamId: teamId || null,
      teamKey: teamKey || null,
      stateId: stateId || null,
      stateName: stateName || "Triage",
      stateType: stateType || "triage",
      projectId: projectId || null,
      projectName: projectName || null,
      projectMilestoneId: issue.projectMilestoneId || issue.projectMilestone?.id || null,
      cycleId: issue.cycleId || issue.cycle?.id || null,
      cycleNumber: issue.cycleNumber ?? issue.cycle?.number ?? null,
      assigneeId: assigneeId || null,
      assigneeName: assigneeName || null,
      creatorId: issue.creatorId || issue.creator?.id || null,
      parentId: issue.parentId || issue.parent?.id || null,
      url: issue.url || `https://linear.app/issue/${identifier}`,
      branchName: issue.branchName || null,
      dueDate: issue.dueDate || null,
      labelsJson: labelsJson || "[]",
      labelIdsJson: labelIdsJson || "[]",
      trashed: Boolean(issue.trashed),
      createdAt: issue.createdAt || nowIso,
      updatedAt: issue.updatedAt || nowIso,
      archivedAt: issue.archivedAt || null,
      startedAt: issue.startedAt || null,
      completedAt: issue.completedAt || null,
      canceledAt: issue.canceledAt || null,
    };

    dbInstance.db.insert(schema.issues).values(newIssue).run();
  }
}

export function deleteIssueFromCache(
  dbInstance: CacheDbInstance,
  issueIdOrIdentifier: string,
): void {
  const existing = dbInstance.db
    .select({ id: schema.issues.id, identifier: schema.issues.identifier })
    .from(schema.issues)
    .where(
      or(
        eq(schema.issues.id, issueIdOrIdentifier),
        eq(schema.issues.identifier, issueIdOrIdentifier),
        eq(sql`UPPER(${schema.issues.identifier})`, issueIdOrIdentifier.toUpperCase()),
      ),
    )
    .get();

  const id = existing?.id || issueIdOrIdentifier;

  dbInstance.db.transaction((tx) => {
    tx.delete(schema.issueRelations)
      .where(
        or(
          eq(schema.issueRelations.issueId, id),
          eq(schema.issueRelations.relatedIssueId, id),
        ),
      )
      .run();

    tx.delete(schema.issues)
      .where(
        or(
          eq(schema.issues.id, id),
          eq(schema.issues.identifier, issueIdOrIdentifier),
          eq(sql`UPPER(${schema.issues.identifier})`, issueIdOrIdentifier.toUpperCase()),
        ),
      )
      .run();
  });
}

export async function getCacheStatus(
  dbInstance: CacheDbInstance,
): Promise<CacheStatusReport> {
  const getCount = (tableName: string): number => {
    try {
      const res = dbInstance.sqlite
        .query<{ count: number }, []>(`SELECT count(*) as count FROM ${tableName}`)
        .get();
      return res?.count ?? 0;
    } catch {
      return 0;
    }
  };

  const lastSyncAtRow = dbInstance.sqlite
    .query<{ value: string }, [string]>("SELECT value FROM cache_meta WHERE key = ?")
    .get("last_sync_at");

  const lastSyncCountsRow = dbInstance.sqlite
    .query<{ value: string }, [string]>("SELECT value FROM cache_meta WHERE key = ?")
    .get("last_sync_entity_counts");

  let lastSyncEntityCounts: Record<string, number> | null = null;
  if (lastSyncCountsRow?.value) {
    try {
      lastSyncEntityCounts = JSON.parse(lastSyncCountsRow.value);
    } catch {
      lastSyncEntityCounts = null;
    }
  }

  let sizeBytes = 0;
  if (dbInstance.path !== ":memory:" && existsSync(dbInstance.path)) {
    try {
      sizeBytes = statSync(dbInstance.path).size;
    } catch {
      sizeBytes = 0;
    }
  }

  return {
    lastSyncAt: lastSyncAtRow?.value ?? null,
    lastSyncEntityCounts,
    counts: {
      teams: getCount("teams"),
      workflowStates: getCount("workflow_states"),
      issueLabels: getCount("issue_labels"),
      projects: getCount("projects"),
      cycles: getCount("cycles"),
      projectMilestones: getCount("project_milestones"),
      issues: getCount("issues"),
      issueRelations: getCount("issue_relations"),
      users: getCount("users"),
    },
    dbPath: dbInstance.path,
    sizeBytes,
  };
}

export function insertRelationInCache(
  dbInstance: CacheDbInstance,
  rel: {
    id?: string;
    type: string;
    issueId: string;
    relatedIssueId: string;
    createdAt?: string;
    updatedAt?: string;
  },
): void {
  const resolveId = (ref: string): string => {
    const row = dbInstance.db
      .select({ id: schema.issues.id })
      .from(schema.issues)
      .where(
        or(
          eq(schema.issues.id, ref),
          eq(schema.issues.identifier, ref),
          eq(sql`UPPER(${schema.issues.identifier})`, ref.toUpperCase()),
        ),
      )
      .get();
    return row?.id ?? ref;
  };

  const issueId = resolveId(rel.issueId);
  const relatedIssueId = resolveId(rel.relatedIssueId);
  const nowIso = new Date().toISOString();

  let id = rel.id;
  if (!id) {
    const existing = dbInstance.db
      .select({ id: schema.issueRelations.id })
      .from(schema.issueRelations)
      .where(
        and(
          eq(schema.issueRelations.type, rel.type),
          eq(schema.issueRelations.issueId, issueId),
          eq(schema.issueRelations.relatedIssueId, relatedIssueId),
        ),
      )
      .get();
    id = existing?.id || crypto.randomUUID();
  }

  dbInstance.db
    .insert(schema.issueRelations)
    .values({
      id,
      type: rel.type,
      issueId,
      relatedIssueId,
      createdAt: rel.createdAt || nowIso,
      updatedAt: rel.updatedAt || nowIso,
    })
    .onConflictDoUpdate({
      target: schema.issueRelations.id,
      set: {
        type: rel.type,
        issueId,
        relatedIssueId,
        updatedAt: rel.updatedAt || nowIso,
      },
    })
    .run();
}

