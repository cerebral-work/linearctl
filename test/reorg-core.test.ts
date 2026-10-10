import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearClient } from "@linear/sdk";
import { buildSchema, parse, typeFromAST, validateInputValue } from "graphql";
import {
  OP_REGISTRY,
  RateTracker,
  ReorgMismatch,
  RollbackRefused,
  TokenBucket,
  assertFreshBackup,
  assertFromAnchors,
  assertMovePreconditions,
  batchGroups,
  mixedBatchGroups,
  moveAccessLost,
  moveVisibilityChange,
  projectTeamAddVisibilityChange,
  census,
  estimateRequests,
  journalAppend,
  journalOkSeqs,
  journalPhaseVerified,
  journalPhaseVerifiedAcross,
  journalRead,
  parsePlanFile,
  projectStatusPosition,
  rollbackPhase,
  runPlan,
  verifyPhase,
  type JournalRecord,
  type ReorgOp,
  type ReorgPlan,
} from "../src/core/reorg.js";

// ---------------------------------------------------------------------------
// Fake Linear backend — every entity type the engine reads or writes,
// routed by the query/mutation marker names in src/core/reorg.ts.
// ---------------------------------------------------------------------------

interface FakeIssue {
  id: string;
  identifier: string;
  stateId: string;
  labelIds: string[];
  projectId: string | null;
  cycleId: string | null;
  teamId: string;
  teamKey: string;
  archived: boolean;
}
interface FakeLabel { id: string; name: string; retiredAt: string | null; teamId: string | null; teamKey: string | null; inheritedFrom?: string | null }

/** Inherited labels mirror the owner's name (Linear propagates a parent rename). */
function labelName(be: FakeBackend, l: FakeLabel): string {
  return l.inheritedFrom ? (be.labels.get(l.inheritedFrom)?.name ?? l.name) : l.name;
}

/** …and its retirement (retiring an owner hides its inherited views too). */
function labelRetired(be: FakeBackend, l: FakeLabel): string | null {
  if (l.retiredAt) return l.retiredAt;
  if (l.inheritedFrom) return be.labels.get(l.inheritedFrom)?.retiredAt ?? null;
  return null;
}
interface FakeState { id: string; name: string; type: string; archivedAt: string | null; inheritedFrom?: string | null; teamKey?: string }
interface FakeProject { id: string; name: string; statusId: string; leadId: string | null; targetDate: string | null; archived?: boolean; trashed: boolean; teamIds: string[]; initiativeIds: string[] }
interface FakeInitiative { id: string; name: string; archivedAt: string | null; ownerId: string | null }
interface FakeTeam { id: string; key: string; triageEnabled: boolean; deleted: boolean; parentId?: string | null; private?: boolean | null; memberIds?: string[]; membersFail?: boolean; membersStuck?: boolean }

interface FakeBackend {
  issues: Map<string, FakeIssue>;
  labels: Map<string, FakeLabel>;
  states: Map<string, FakeState>;
  projects: Map<string, FakeProject>;
  initiatives: Map<string, FakeInitiative>;
  teams: Map<string, FakeTeam>;
  projectStatuses: Map<string, { id: string; name: string; type?: string; position?: number }>;
  /** Test hook: the LabelsByNameCI read explodes (refusal failure path). */
  failLabelsByNameCI?: boolean;
  /** Mutation names whose variables were validated against the vendored schema. */
  validatedMutations: Set<string>;
  swallowWrites: boolean;
  /** Test hook: every mutation throws `message`; the write is applied first when `land`. */
  writeError?: { message: string; land: boolean };
  /** ids the batch mutation deliberately skips (mid-batch mismatch testing). */
  batchSkip: Set<string>;
  /** When set, the projects probe answers in two pages: the blocking project
   *  arrives on page two — an engine that drops the pagination loop misses it. */
  forceProjectPagination: boolean;
  /** Page-2 delivery of team labels / a cursor that never advances (init joins, labels). */
  forceLabelPagination?: boolean;
  stuckCursor?: boolean;
  mutationCalls: string[];
  projectArchiveTrashes?: boolean;
  readCalls: number;
  /** ReorgTeamProjects calls — the pagination test asserts the second page. */
  projectProbeCalls: number;
  /** Invoked after each ReorgProjectState read — tests mutate state between
   *  the drift pre-read and the apply-time live read. */
  projectReadHook?: (projectId: string) => void;
  createdLabelSeq: number;
}

const LINEAR_SCHEMA = buildSchema(
  readFileSync(join(import.meta.dir, "fixtures", "linear-schema.graphql"), "utf8"),
);

/** Validate a mutation's variable VALUES against the vendored schema's input
 *  types (missing required fields, wrong types) — what Linear would reject. */
function assertVariablesValid(be: FakeBackend, query: string, vars: Record<string, unknown>): void {
  const doc = parse(query);
  for (const def of doc.definitions) {
    if (def.kind !== "OperationDefinition" || def.operation !== "mutation") continue;
    for (const v of def.variableDefinitions ?? []) {
      const type = typeFromAST(LINEAR_SCHEMA, v.type);
      if (!type) throw new Error(`unknown variable type for $${v.variable.name.value}`);
      const errors: string[] = [];
      validateInputValue(vars[v.variable.name.value], type as never, (err, path) => {
        errors.push(`${path.join(".") || "(root)"}: ${err.message}`);
      });
      if (errors.length)
        throw new Error(`Variable "$${v.variable.name.value}" invalid: ${errors.join("; ")}`);
    }
    for (const sel of def.selectionSet.selections)
      if (sel.kind === "Field") be.validatedMutations.add(sel.name.value);
  }
}

function fakeClient(be: FakeBackend): LinearClient {
  const ok = (payload: Record<string, unknown>) => ({ data: payload, headers: undefined });
  const rawRequest = async (
    query: string,
    vars: Record<string, unknown>,
  ): Promise<{ data: unknown; headers: undefined }> => {
    assertVariablesValid(be, query, vars);
    // ---- reads -----------------------------------------------------------
    if (query.includes("ReorgIssueState")) {
      be.readCalls++;
      const i = be.issues.get(vars.id as string);
      return ok({
        issue: i
          ? {
              id: i.id, identifier: i.identifier,
              state: { id: i.stateId, name: "S", type: "unstarted" },
              labels: { nodes: i.labelIds.map((id) => ({ id })) },
              project: i.projectId ? { id: i.projectId } : null,
              cycle: i.cycleId ? { id: i.cycleId } : null,
              team: { id: i.teamId, key: i.teamKey },
              archivedAt: i.archived ? "2026-01-01T00:00:00Z" : null,
              trashed: false,
            }
          : null,
      });
    }
    if (query.includes("ReorgLabelState")) {
      be.readCalls++;
      const l = be.labels.get(vars.id as string);
      return ok({
        issueLabel: l
          ? {
              id: l.id, name: labelName(be, l), retiredAt: labelRetired(be, l),
              team: l.teamId ? { id: l.teamId, key: l.teamKey } : null,
              inheritedFrom: l.inheritedFrom ? { id: l.inheritedFrom } : null,
            }
          : null,
      });
    }
    if (query.includes("ReorgStateState")) {
      be.readCalls++;
      const s = be.states.get(vars.id as string);
      return ok({ workflowState: s ? { id: s.id, name: s.name, type: s.type, archivedAt: s.archivedAt, inheritedFrom: s.inheritedFrom ? { id: s.inheritedFrom } : null } : null });
    }
    if (query.includes("ReorgStateViews")) {
      be.readCalls++;
      return ok({
        workflowStates: {
          nodes: [...be.states.values()].map((s) => ({
            id: s.id, name: s.name, archivedAt: s.archivedAt,
            inheritedFrom: s.inheritedFrom ? { id: s.inheritedFrom } : null,
            team: s.teamKey ? { id: `t-${s.teamKey}`, key: s.teamKey } : null,
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    }
    if (query.includes("ReorgProjectState")) {
      be.readCalls++;
      const p = be.projects.get(vars.id as string);
      const resp = ok({
        project: p
          ? {
              id: p.id, name: p.name,
              status: { id: p.statusId, name: "Started" },
              lead: p.leadId ? { id: p.leadId } : null,
              targetDate: p.targetDate, archivedAt: p.archived ? "2026-01-01T00:00:00Z" : null, trashed: p.trashed,
              teams: { nodes: p.teamIds.map((id) => ({ id, key: be.teams.get(id)?.key ?? id })) },
              initiatives: { nodes: p.initiativeIds.map((id) => ({ id })) },
            }
          : null,
      });
      // after the response is fixed — a mutation here lands on the NEXT read
      be.projectReadHook?.(vars.id as string);
      return resp;
    }
    if (query.includes("ReorgInitiativeState")) {
      be.readCalls++;
      const it = be.initiatives.get(vars.id as string);
      return ok({ initiative: it ? { id: it.id, name: it.name, archivedAt: it.archivedAt, owner: it.ownerId ? { id: it.ownerId } : null } : null });
    }
    if (query.includes("ReorgProjectStatuses")) {
      be.readCalls++;
      // Linear's projectStatuses takes no filter argument — the engine reads
      // them all and matches by name in code
      return ok({ projectStatuses: { nodes: [...be.projectStatuses.values()], pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    if (query.includes("ReorgTeamPrivacy")) {
      // unknown teams read as public: most tests never declare privacy
      const t = be.teams.get(vars.id as string);
      if (t?.deleted) return ok({ team: null });
      return ok({ team: { id: vars.id, key: t?.key ?? String(vars.id), private: t && "private" in t ? t.private : false } });
    }
    if (query.includes("ReorgTeamMembers")) {
      const t = be.teams.get(vars.id as string);
      if (t?.membersFail) throw new Error("members read failed");
      if (t?.membersStuck) return ok({ team: { members: { nodes: [{ id: "u1" }], pageInfo: { hasNextPage: true, endCursor: "same" } } } });
      return ok({ team: { members: { nodes: (t?.memberIds ?? []).map((id) => ({ id })), pageInfo: { hasNextPage: false, endCursor: null } } } });
    }
    if (query.includes("ReorgTeamState")) {
      be.readCalls++;
      const t = be.teams.get(vars.id as string);
      return ok({ team: t && !t.deleted ? { id: t.id, key: t.key, triageEnabled: t.triageEnabled } : null });
    }
    if (query.includes("ReorgLabelsRetired")) {
      be.readCalls++;
      const ids = vars.ids as string[];
      return ok({ issueLabels: { nodes: ids.map((id) => be.labels.get(id)).filter(Boolean).map((l) => ({ id: l!.id, name: labelName(be, l!), retiredAt: labelRetired(be, l!) })) } });
    }
    if (query.includes("ReorgTeamFamily")) {
      be.readCalls++;
      const t = be.teams.get(vars.id as string);
      return ok({
        team: t
          ? {
              id: t.id, key: t.key,
              parent: t.parentId ? { id: t.parentId } : null,
              children: [...be.teams.values()].filter((c) => c.parentId === t.id).map((c) => ({ id: c.id })),
            }
          : null,
      });
    }
    if (query.includes("ReorgLabelsByNameCI")) {
      be.readCalls++;
      if (be.failLabelsByNameCI) throw new Error("conflict re-read exploded");
      // Honour the comparator the query ACTUALLY carries: eq is exact,
      // eqIgnoreCase is case-folded (critic round 1: reverting the query to
      // eq must turn a test red).
      const ci = query.includes("eqIgnoreCase");
      const want = String(vars.name);
      const nodes = [...be.labels.values()].filter((l) =>
        ci ? labelName(be, l).toLowerCase() === want.toLowerCase()
           : labelName(be, l) === want);
      return ok({ issueLabels: { nodes: nodes.map((l) => ({ id: l.id, name: labelName(be, l), team: l.teamId ? { id: l.teamId, key: l.teamKey } : null, inheritedFrom: l.inheritedFrom ? { id: l.inheritedFrom } : null })) } });
    }
    if (query.includes("ReorgFindWsLabel")) {
      be.readCalls++;
      // Honour the comparator the query carries (same rule as above).
      const ci = query.includes("eqIgnoreCase");
      const want = String(vars.name);
      const nodes = [...be.labels.values()].filter((l) =>
        (ci ? labelName(be, l).toLowerCase() === want.toLowerCase()
            : labelName(be, l) === want) && l.teamId == null);
      return ok({ issueLabels: { nodes } });
    }
    if (query.includes("ReorgLabelScopes")) {
      be.readCalls++;
      const ids = vars.ids as string[];
      // Linear's id filter validates UUIDs — a name: ref arriving raw is a
      // 400 Argument Validation Error, not an empty page
      const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (ids.some((id) => !UUID.test(id)))
        throw new Error("Argument Validation Error");
      return ok({
        issueLabels: {
          nodes: ids.map((id) => be.labels.get(id)).filter(Boolean).map((l) => ({
            id: l!.id, name: labelName(be, l!), team: l!.teamId ? { id: l!.teamId, key: l!.teamKey } : null,
            inheritedFrom: l!.inheritedFrom ? { id: l!.inheritedFrom } : null,
          })),
        },
      });
    }
    if (query.includes("ReorgIssuesInState")) {
      be.readCalls++;
      const withArchived = query.includes("includeArchived: true");
      return ok({ issues: { nodes: [...be.issues.values()].filter((i) => i.stateId === vars.id && (withArchived || !i.archived)).map((i) => ({ id: i.id, identifier: i.identifier, archivedAt: i.archived ? "2026-01-01T00:00:00Z" : null })) } });
    }
    // The fake honours includeArchived EXACTLY like Linear: archived rows are
    // hidden unless the query carries the flag. An engine that drops the flag
    // sees a truncated world (the tests pin this).
    const inclArchived = query.includes("includeArchived: true");
    if (query.includes("ReorgTeamIssues")) {
      be.readCalls++;
      return ok({ issues: { nodes: [...be.issues.values()].filter((i) => (inclArchived || !i.archived) && i.teamId === vars.id).map((i) => ({ id: i.id })) } });
    }
    if (query.includes("ReorgProjectIssues")) {
      be.readCalls++;
      const nodes = [...be.issues.values()]
        .filter((i) => i.projectId === vars.id && (inclArchived || !i.archived))
        .map((i) => ({ id: i.id, identifier: i.identifier, archivedAt: i.archived ? "2026-01-01T00:00:00Z" : null }));
      return ok({ issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    if (query.includes("ReorgTeamLabels")) {
      be.readCalls++;
      const nodes = [...be.labels.values()].filter((l) => l.teamId === vars.id).map((l) => ({ id: l.id, retiredAt: l.retiredAt }));
      if (be.stuckCursor) return ok({ issueLabels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } });
      if (be.forceLabelPagination && !vars.after)
        return ok({ issueLabels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "l2" } } });
      return ok({ issueLabels: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    if (query.includes("ReorgTeamProjects")) {
      be.readCalls++;
      be.projectProbeCalls++;
      const all = [...be.projects.values()]
        .filter((p) => inclArchived || !p.trashed)
        .map((p) => ({ id: p.id, teams: { nodes: p.teamIds.map((id) => ({ id })) } }));
      if (be.forceProjectPagination && !vars.after) {
        // page 1 withholds the blocking project; page 2 delivers it
        return ok({ projects: { nodes: all.filter((p) => !p.teams.nodes.length), pageInfo: { hasNextPage: true, endCursor: "p2" } } });
      }
      const nodes = be.forceProjectPagination ? all.filter((p) => p.teams.nodes.length) : all;
      return ok({ projects: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } });
    }
    if (query.includes("ReorgBatchVerify")) {
      be.readCalls++;
      const ids = vars.ids as string[];
      return ok({
        issues: {
          nodes: ids.map((id) => be.issues.get(id)).filter(Boolean)
            .filter((i) => inclArchived || !i!.archived)
            .map((i) => ({
              id: i!.id, state: { id: i!.stateId }, labels: { nodes: i!.labelIds.map((x) => ({ id: x })) },
            })),
        },
      });
    }
    // ---- writes ----------------------------------------------------------
    const W = (name: string, fn: () => void) => {
      be.mutationCalls.push(name);
      if (!be.swallowWrites && (!be.writeError || be.writeError.land)) fn();
      if (be.writeError) throw new Error(be.writeError.message);
      return ok({ [name]: { success: true } });
    };
    if (query.includes("ReorgBatchUpdate"))
      return W("issueBatchUpdate", () => {
        const input = (vars.input ?? {}) as { stateId?: string; addedLabelIds?: string[]; removedLabelIds?: string[] };
        for (const id of vars.ids as string[]) {
          if (be.batchSkip.has(id)) continue;
          const i = be.issues.get(id);
          if (!i) continue;
          if (input.stateId) i.stateId = input.stateId;
          for (const l of input.addedLabelIds ?? []) if (!i.labelIds.includes(l)) i.labelIds.push(l);
          i.labelIds = i.labelIds.filter((x) => !(input.removedLabelIds ?? []).includes(x));
        }
      });
    if (query.includes("ReorgIssueUpdate"))
      return W("issueUpdate", () => {
        const i = be.issues.get(vars.id as string);
        if (!i) return;
        const input = (vars.input ?? {}) as { stateId?: string; teamId?: string; labelIds?: string[]; addedLabelIds?: string[]; removedLabelIds?: string[] };
        if (input.teamId && input.labelIds) {
          // Linear semantics: labels sent in the move input must be usable in
          // the destination (workspace, the team's own, or its parent's)
          const dest = be.teams.get(input.teamId);
          for (const id of input.labelIds) {
            const l = be.labels.get(id);
            if (!l) throw new Error(`label ${id} not found`);
            if (l.teamId != null && l.teamId !== input.teamId && l.teamId !== dest?.parentId)
              throw new Error(`label ${l.name} does not belong to the destination team`);
          }
          i.teamId = input.teamId;
          i.teamKey = dest?.key ?? i.teamKey;
          i.labelIds = [...input.labelIds];
          if (input.stateId) { /* ignored on a team move, as in the real API */ }
        } else if (input.teamId) {
          // Linear semantics: team move DROPS team-scoped labels; and the
          // paired stateId is IGNORED here (closest-state mapping) — the
          // canary case the post-move destination-state correction exists for
          i.teamId = input.teamId;
          i.labelIds = i.labelIds.filter((id) => be.labels.get(id)?.teamId == null);
        } else if (input.stateId) {
          i.stateId = input.stateId;
        }
        for (const l of input.addedLabelIds ?? []) if (!i.labelIds.includes(l)) i.labelIds.push(l);
        i.labelIds = i.labelIds.filter((x) => !(input.removedLabelIds ?? []).includes(x));
      });
    if (query.includes("ReorgIssueArchive"))
      return W("issueArchive", () => { be.issues.get(vars.id as string)!.archived = true; });
    if (query.includes("ReorgIssueUnarchive"))
      return W("issueUnarchive", () => { be.issues.get(vars.id as string)!.archived = false; });
    if (query.includes("ReorgLabelCreate"))
      return W("issueLabelCreate", () => {
        const input = vars.input as { name: string; description?: string; teamId?: string };
        const id = `22222222-2222-4222-8222-${String(++be.createdLabelSeq).padStart(12, "0")}`;
        if (input.teamId) {
          // team create: unique (case-insensitively) across the workspace, the
          // team itself, its parent and its sub-teams; unrelated teams may share
          const t = be.teams.get(input.teamId)!;
          const fam = new Set([t.id, ...(t.parentId ? [t.parentId] : []), ...[...be.teams.values()].filter((c) => c.parentId === t.id).map((c) => c.id)]);
          if ([...be.labels.values()].some((l) => labelName(be, l).toLowerCase() === input.name.toLowerCase() && (l.teamId == null || fam.has(l.teamId))))
            throw new Error(`Duplicate label name - Label "${input.name}" already exists`);
          be.labels.set(id, { id, name: input.name, retiredAt: null, teamId: t.id, teamKey: t.key });
          return;
        }
        // Linear enforces label-name uniqueness ACROSS workspace + team scope,
        // CASE-INSENSITIVELY (probe: workspace 'blocked' refused by TOD 'Blocked')
        if ([...be.labels.values()].some((l) => labelName(be, l).toLowerCase() === input.name.toLowerCase()))
          throw new Error(`Duplicate label name - Label "${input.name}" already exists`);
        be.labels.set(id, { id, name: input.name, retiredAt: null, teamId: null, teamKey: null });
      });
    if (query.includes("ReorgLabelUpdate"))
      return W("issueLabelUpdate", () => {
        const l = be.labels.get(vars.id as string)!;
        // Linear refuses writes on inherited (sub-team) labels outright
        if (l.inheritedFrom)
          throw new Error("Cannot update inherited labels, please update the parent label instead.");
        const input = vars.input as { retiredAt?: string | null; name?: string };
        if ("retiredAt" in input) l.retiredAt = input.retiredAt ?? null;
        if (typeof input.name === "string") l.name = input.name;
      });
    if (query.includes("ReorgLabelRestore"))
      return W("issueLabelRestore", () => { be.labels.get(vars.id as string)!.retiredAt = null; });
    if (query.includes("ReorgLabelDelete"))
      return W("issueLabelDelete", () => { be.labels.delete(vars.id as string); });
    if (query.includes("ReorgStateArchive"))
      return W("workflowStateArchive", () => { be.states.get(vars.id as string)!.archivedAt = "2026-01-02T00:00:00Z"; });
    if (query.includes("ReorgTeamUpdate"))
      return W("teamUpdate", () => {
        const t = be.teams.get(vars.id as string)!;
        const input = vars.input as { triageEnabled?: boolean };
        if (typeof input.triageEnabled === "boolean") t.triageEnabled = input.triageEnabled;
      });
    if (query.includes("ReorgTeamDelete"))
      return W("teamDelete", () => { be.teams.get(vars.id as string)!.deleted = true; });
    if (query.includes("ReorgProjectUpdate"))
      return W("projectUpdate", () => {
        const p = be.projects.get(vars.id as string)!;
        const input = vars.input as { statusId?: string; leadId?: string | null; targetDate?: string | null; teamIds?: string[] };
        if (input.statusId) p.statusId = input.statusId;
        if ("leadId" in input) p.leadId = input.leadId ?? null;
        if ("targetDate" in input) p.targetDate = input.targetDate ?? null;
        if (input.teamIds) p.teamIds = [...input.teamIds].sort();
      });
    if (query.includes("ReorgProjectArchive"))
      return W("projectArchive", () => {
        const p = be.projects.get(vars.id as string)!;
        p.archived = true;
        // The server trashes unless told otherwise; projectArchiveTrashes
        // simulates a live response that trashed anyway.
        p.trashed = !!be.projectArchiveTrashes || !query.includes("trash: false");
      });
    if (query.includes("ReorgProjectUnarchive"))
      return W("projectUnarchive", () => { const p = be.projects.get(vars.id as string)!; p.archived = false; p.trashed = false; });
    if (query.includes("ReorgInitiativeArchive"))
      return W("initiativeArchive", () => { be.initiatives.get(vars.id as string)!.archivedAt = "2026-01-02T00:00:00Z"; });
    if (query.includes("ReorgInitiativeUnarchive"))
      return W("initiativeUnarchive", () => { be.initiatives.get(vars.id as string)!.archivedAt = null; });
    if (query.includes("ReorgInitiativeUpdate"))
      return W("initiativeUpdate", () => {
        const it = be.initiatives.get(vars.id as string)!;
        const input = vars.input as { ownerId?: string | null };
        if ("ownerId" in input) it.ownerId = input.ownerId ?? null;
      });
    if (query.includes("ReorgProjectStatusCreate"))
      return W("projectStatusCreate", () => {
        const input = vars.input as { name: string; type?: string; position: number };
        const id = `ps-${be.projectStatuses.size + 1}`;
        be.projectStatuses.set(id, { id, name: input.name, type: input.type, position: input.position });
      });
    if (query.includes("ReorgProjectInitJoins")) {
      be.readCalls++;
      // fake join-row id convention: "<initiativeId>:<projectId>"
      const p = be.projects.get(vars.projectId as string);
      const nodes = (p?.initiativeIds ?? []).map((initId) => ({ id: `${initId}:${p!.id}`, initiative: { id: initId } }));
      if (be.stuckCursor) return ok({ project: { initiativeToProjects: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } } } });
      return ok({ project: p ? { initiativeToProjects: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } : null });
    }
    if (query.includes("ReorgInitToProjDelete"))
      return W("initiativeToProjectDelete", () => {
        // join id convention in the fake: "<initiativeId>:<projectId>"
        const [initId, projId] = (vars.id as string).split(":");
        const p = be.projects.get(projId);
        if (p) p.initiativeIds = p.initiativeIds.filter((x) => x !== initId);
      });
    if (query.includes("ReorgInitToProjCreate"))
      return W("initiativeToProjectCreate", () => {
        const input = vars.input as { initiativeId: string; projectId: string };
        const p = be.projects.get(input.projectId)!;
        if (!p.initiativeIds.includes(input.initiativeId)) p.initiativeIds.push(input.initiativeId);
        p.initiativeIds.sort();
      });
    throw new Error(`fake backend: unhandled query: ${query.slice(0, 80)}`);
  };
  return { client: { rawRequest } } as unknown as LinearClient;
}

function freshBackend(): FakeBackend {
  return {
    issues: new Map(), labels: new Map(), states: new Map(),
    projects: new Map(), initiatives: new Map(), teams: new Map(),
    projectStatuses: new Map(), validatedMutations: new Set(),
    swallowWrites: false, batchSkip: new Set(), forceProjectPagination: false,
    mutationCalls: [], readCalls: 0, projectProbeCalls: 0,
    createdLabelSeq: 0,
  };
}

function fastPace() {
  return { bucket: new TokenBucket(1e9, 200), tracker: new RateTracker() };
}

function baseOp(over: Partial<ReorgOp>): ReorgOp {
  return {
    seq: 1, phase: 1, op: "set-state",
    target: { type: "issue", id: "i-1", identifier: "EX-1" },
    from: {}, to: {}, evidence: "test", reversible: true,
    ...over,
  };
}

function planWith(ops: ReorgOp[]): ReorgPlan {
  return {
    meta: { generated: "2026-10-04T00:00:00Z", censusHash: "c", workspaceId: "w", rulesHash: "r" },
    ops,
    warnings: [],
  };
}

const ISSUE_1: FakeIssue = {
  id: "i-1", identifier: "EX-1", stateId: "s-todo", labelIds: ["11111111-1111-4111-8111-11111111110a"],
  projectId: "p-1", cycleId: null, teamId: "t-1", teamKey: "EX", archived: false,
};

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reorg-test-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function freshBackup(): string {
  const p = join(dir, "backup.verified.json");
  writeFileSync(p, JSON.stringify({ verifiedAt: new Date().toISOString() }));
  return p;
}

async function applyPlan(be: FakeBackend, ops: ReorgOp[], journalPath: string, extra: Partial<Parameters<typeof runPlan>[2]> = {}) {
  return runPlan(fakeClient(be), planWith(ops), {
    apply: true, resume: false, allowIrreversible: false,
    journalPath, backupRecordPath: freshBackup(), pace: fastPace(),
    verifyDelaysMs: [0, 0, 0, 0], sleep: async () => {}, ...extra,
  });
}

// ---------------------------------------------------------------------------
// Schema / journal / gates (unchanged semantics)
// ---------------------------------------------------------------------------

describe("parsePlanFile", () => {
  test("round-trips a valid plan and sorts by seq", () => {
    const p = join(dir, "plan.jsonl");
    const ops = [baseOp({ seq: 2 }), baseOp({ seq: 1 })];
    writeFileSync(p, JSON.stringify({ _meta: planWith(ops).meta }) + "\n" + ops.map((o) => JSON.stringify(o)).join("\n") + "\n");
    const plan = parsePlanFile(p);
    expect(plan.ops.map((o) => o.seq)).toEqual([1, 2]);
  });

  test("rejects the invalid shapes", () => {
    const p = join(dir, "plan.jsonl");
    const write = (ops: unknown[]) =>
      writeFileSync(p, JSON.stringify({ _meta: planWith([]).meta }) + "\n" + ops.map((o) => JSON.stringify(o)).join("\n") + "\n");
    write([baseOp({ seq: 1 }), baseOp({ seq: 1 })]);
    expect(() => parsePlanFile(p)).toThrow("duplicate seq");
    write([baseOp({ op: "nonsense" as never })]);
    expect(() => parsePlanFile(p)).toThrow("unknown op");
    write([baseOp({ reversible: false, phase: 6, op: "delete-team" })]);
    expect(() => parsePlanFile(p)).toThrow("needs an approval id");
    write([baseOp({ reversible: false, phase: 6, approval: "d", op: "set-state" })]);
    expect(() => parsePlanFile(p)).toThrow("no irreversible form");
    write([baseOp({ reversible: false, phase: 2, approval: "d", op: "delete-team" })]);
    expect(() => parsePlanFile(p)).toThrow("out of its allowed phase");
  });
});

describe("journal", () => {
  test("append + read round-trip, ok seqs, phase verify markers", () => {
    const j = join(dir, "applied.jsonl");
    journalAppend(j, { seq: 1, phase: 1, op: "set-state", at: "a", ok: true });
    journalAppend(j, { seq: 2, phase: 1, op: "set-state", at: "b", ok: false, error: "x" });
    journalAppend(j, { seq: "verify", phase: 1, at: "c", ok: true });
    const recs = journalRead(j);
    expect(recs).toHaveLength(3);
    expect([...journalOkSeqs(recs)]).toEqual([1]);
    expect(journalPhaseVerified(recs, 1)).toBe(true);
    expect(readFileSync(j, "utf8").trim().split("\n")).toHaveLength(3);
  });
});

describe("backup freshness gate", () => {
  test("fresh passes; missing, stale, malformed fail closed", () => {
    expect(() => assertFreshBackup(freshBackup())).not.toThrow();
    expect(() => assertFreshBackup(join(dir, "nope.json"))).toThrow("requires a fresh backup");
    const stale = join(dir, "stale.json");
    writeFileSync(stale, JSON.stringify({ verifiedAt: "2026-10-03T00:00:00Z" }));
    expect(() => assertFreshBackup(stale, new Date("2026-10-04T12:00:00Z"))).toThrow("stale");
  });
});

// ---------------------------------------------------------------------------
// Executor modes: dry-run / --check / apply
// ---------------------------------------------------------------------------

describe("runPlan modes", () => {
  test("dry-run default: zero API calls", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [...ISSUE_1.labelIds] });
    const events: string[] = [];
    const result = await runPlan(fakeClient(be), planWith([baseOp({ from: { stateId: "s-todo" }, to: { stateId: "s-done" } })]), {
      apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
      onEvent: (e) => events.push(e.kind),
    });
    expect(result.dryRun).toBe(true);
    expect(be.readCalls).toBe(0);
    expect(be.mutationCalls).toEqual([]);
    expect(events).toContain("budget");
  });

  test("--check: live pre-read, no writes; drift reported; aligned plan reports none", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [...ISSUE_1.labelIds] });
    const op = baseOp({ from: { stateId: "s-todo" }, to: { stateId: "s-done" } });
    const aligned = await runPlan(fakeClient(be), planWith([op]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
    });
    expect(aligned.drifted).toEqual([]);
    expect(be.readCalls).toBe(1);
    expect(be.mutationCalls).toEqual([]);

    be.issues.get("i-1")!.stateId = "s-progress"; // drift
    const drifted = await runPlan(fakeClient(be), planWith([op]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
    });
    expect(drifted.drifted).toEqual([1]);
    expect(be.mutationCalls).toEqual([]);
  });

  test("drift abort on apply: live ≠ from, no mutation attempted", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, stateId: "s-progress", labelIds: [...ISSUE_1.labelIds] });
    await expect(
      applyPlan(be, [baseOp({ from: { stateId: "s-todo" }, to: { stateId: "s-done" } })], join(dir, "j.jsonl")),
    ).rejects.toBeInstanceOf(ReorgMismatch);
    expect(be.mutationCalls).toEqual([]);
  });

  test("first-mismatch stop: swallowed write → later ops never attempted, nothing journaled ok", async () => {
    const be = freshBackend();
    be.swallowWrites = true;
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [...ISSUE_1.labelIds] });
    be.issues.set("i-2", { ...ISSUE_1, id: "i-2", identifier: "EX-2", labelIds: ["11111111-1111-4111-8111-11111111110a"] });
    const j = join(dir, "j.jsonl");
    await expect(
      applyPlan(be, [
        baseOp({ from: { stateId: "s-todo" }, to: { stateId: "s-done" } }),
        baseOp({ seq: 2, target: { type: "issue", id: "i-2", identifier: "EX-2" }, from: { stateId: "s-todo" }, to: { stateId: "s-done" } }),
      ], j),
    ).rejects.toBeInstanceOf(ReorgMismatch);
    expect(be.mutationCalls).toEqual(["issueUpdate"]);
    expect(journalRead(j)).toHaveLength(0);
  });

  test("--resume skips journaled-ok seqs BEFORE --max-ops slices (capped resume advances)", async () => {
    const be = freshBackend();
    for (const n of [1, 2, 3, 4]) {
      const id = `i-${n}`;
      be.issues.set(id, { ...ISSUE_1, id, identifier: `EX-${n}`, labelIds: ["11111111-1111-4111-8111-11111111110a"] });
    }
    const ops = [1, 2, 3, 4].map((n) => baseOp({
      seq: n, target: { type: "issue", id: `i-${n}`, identifier: `EX-${n}` },
      from: { stateId: "s-todo" }, to: { stateId: "s-done" },
    }));
    const j = join(dir, "j.jsonl");
    journalAppend(j, { seq: 1, phase: 1, op: "set-state", at: "a", ok: true });
    journalAppend(j, { seq: 2, phase: 1, op: "set-state", at: "b", ok: true });
    const first = await applyPlan(be, ops, j, { resume: true, maxOps: 1 });
    expect(first.applied).toBe(1); // seq 3, not seq 1 again
    expect(first.skipped).toBe(2);
    expect(be.issues.get("i-3")!.stateId).toBe("s-done");
    expect(be.issues.get("i-4")!.stateId).toBe("s-todo");
    const second = await applyPlan(be, ops, j, { resume: true, maxOps: 1 });
    expect(second.applied).toBe(1);
    expect(be.issues.get("i-4")!.stateId).toBe("s-done");
  });
});

// ---------------------------------------------------------------------------
// Per-op-kind apply → verify → rollback triples
// ---------------------------------------------------------------------------

describe("op triples (apply → verify → rollback)", () => {
  async function triple(
    be: FakeBackend,
    op: ReorgOp,
    assert: { afterApply: () => void; afterRollback: () => void },
  ) {
    // own journal per triple — sharing one would chain rollbacks together
    const tdir = mkdtempSync(join(tmpdir(), "reorg-triple-"));
    const j = join(tdir, "j.jsonl");
    const applied = await applyPlan(be, [op], j);
    expect(applied.applied).toBe(1);
    assert.afterApply();
    const v = await verifyPhase(fakeClient(be), planWith([op]), 1, { journalPath: j, pace: fastPace() });
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    const rb = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true });
    expect(rb.rolledBack).toBe(1);
    assert.afterRollback();
  }

  test("set-state", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [...ISSUE_1.labelIds] });
    await triple(be, baseOp({ from: { stateId: "s-todo" }, to: { stateId: "s-done" } }), {
      afterApply: () => expect(be.issues.get("i-1")!.stateId).toBe("s-done"),
      afterRollback: () => expect(be.issues.get("i-1")!.stateId).toBe("s-todo"),
    });
  });

  test("relabel (expected post-state is the computed label set)", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["11111111-1111-4111-8111-11111111110a", "11111111-1111-4111-8111-11111111110b"] });
    be.labels.set("11111111-1111-4111-8111-11111111110a", { id: "11111111-1111-4111-8111-11111111110a", name: "a", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    be.labels.set("11111111-1111-4111-8111-11111111110b", { id: "11111111-1111-4111-8111-11111111110b", name: "b", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    be.labels.set("11111111-1111-4111-8111-1111111110c5", { id: "11111111-1111-4111-8111-1111111110c5", name: "bug", retiredAt: null, teamId: null, teamKey: null });
    await triple(be, baseOp({
      op: "relabel",
      from: { labelIds: ["11111111-1111-4111-8111-11111111110a", "11111111-1111-4111-8111-11111111110b"] },
      to: { add: ["11111111-1111-4111-8111-1111111110c5"], remove: ["11111111-1111-4111-8111-11111111110a"] },
    }), {
      afterApply: () => expect([...be.issues.get("i-1")!.labelIds].sort()).toEqual(["11111111-1111-4111-8111-11111111110b", "11111111-1111-4111-8111-1111111110c5"].sort()),
      afterRollback: () => expect([...be.issues.get("i-1")!.labelIds].sort()).toEqual(["11111111-1111-4111-8111-11111111110a", "11111111-1111-4111-8111-11111111110b"].sort()),
    });
  });

  test("enable-triage", async () => {
    const be = freshBackend();
    be.teams.set("t-1", { id: "t-1", key: "EX", triageEnabled: false, deleted: false });
    await triple(be, baseOp({
      op: "enable-triage", target: { type: "team", id: "t-1", identifier: "EX" },
      from: { triageEnabled: false }, to: { triageEnabled: true },
    }), {
      afterApply: () => expect(be.teams.get("t-1")!.triageEnabled).toBe(true),
      afterRollback: () => expect(be.teams.get("t-1")!.triageEnabled).toBe(false),
    });
  });

  test("archive-issue", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [...ISSUE_1.labelIds] });
    await triple(be, baseOp({
      op: "archive-issue", from: { archived: false }, to: { archived: true },
    }), {
      afterApply: () => expect(be.issues.get("i-1")!.archived).toBe(true),
      afterRollback: () => expect(be.issues.get("i-1")!.archived).toBe(false),
    });
  });

  const P1 = { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1"], initiativeIds: [] };
  const archiveOp = () => baseOp({
    op: "archive-project", target: { type: "project", id: "p-1", identifier: "P" },
    from: { archived: false, trashed: false }, to: { archived: true },
  });

  test("archive-project archives without trashing, rollback unarchives", async () => {
    const be = freshBackend();
    be.projects.set("p-1", { ...P1 });
    await triple(be, archiveOp(), {
      afterApply: () => {
        expect(be.projects.get("p-1")!.archived).toBe(true);
        expect(be.projects.get("p-1")!.trashed).toBe(false);
      },
      afterRollback: () => {
        expect(be.projects.get("p-1")!.archived).toBe(false);
        expect(be.mutationCalls).toContain("projectUnarchive");
      },
    });
  });

  test("archive-project post-apply check FAILS when the live project came back trashed", async () => {
    const be = freshBackend();
    be.projectArchiveTrashes = true;
    be.projects.set("p-1", { ...P1 });
    const j = join(mkdtempSync(join(tmpdir(), "reorg-trash-")), "j.jsonl");
    await expect(applyPlan(be, [archiveOp()], j)).rejects.toThrow('"trashed":true');
  });

  test("parsePlanFile refuses archive-project with to.trashed:true", () => {
    const p = join(dir, "plan.jsonl");
    const op = { ...archiveOp(), to: { trashed: true } };
    writeFileSync(p, JSON.stringify({ _meta: planWith([]).meta }) + "\n" + JSON.stringify(op) + "\n");
    expect(() => parsePlanFile(p)).toThrow("delayed permanent delete");
  });

  test("archive-initiative", async () => {
    const be = freshBackend();
    be.initiatives.set("in-1", { id: "in-1", name: "I", archivedAt: null, ownerId: null });
    await triple(be, baseOp({
      op: "archive-initiative", target: { type: "initiative", id: "in-1", identifier: "I" },
      from: { archived: false }, to: { archived: true },
    }), {
      afterApply: () => expect(be.initiatives.get("in-1")!.archivedAt).not.toBeNull(),
      afterRollback: () => expect(be.initiatives.get("in-1")!.archivedAt).toBeNull(),
    });
  });

  test("set-project-status / lead / target", async () => {
    const be = freshBackend();
    be.projects.set("p-1", { id: "p-1", name: "P", statusId: "st-1", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1"], initiativeIds: [] });
    await triple(be, baseOp({
      op: "set-project-status", target: { type: "project", id: "p-1", identifier: "P" },
      from: { statusId: "st-1" }, to: { statusId: "st-2" },
    }), {
      afterApply: () => expect(be.projects.get("p-1")!.statusId).toBe("st-2"),
      afterRollback: () => expect(be.projects.get("p-1")!.statusId).toBe("st-1"),
    });
    await triple(be, baseOp({
      op: "set-project-lead", target: { type: "project", id: "p-1", identifier: "P" },
      from: { leadId: null }, to: { leadId: "u-1" },
    }), {
      afterApply: () => expect(be.projects.get("p-1")!.leadId).toBe("u-1"),
      afterRollback: () => expect(be.projects.get("p-1")!.leadId).toBeNull(),
    });
    await triple(be, baseOp({
      op: "set-project-target", target: { type: "project", id: "p-1", identifier: "P" },
      from: { targetDate: null }, to: { targetDate: "2026-12-31" },
    }), {
      afterApply: () => expect(be.projects.get("p-1")!.targetDate).toBe("2026-12-31"),
      afterRollback: () => expect(be.projects.get("p-1")!.targetDate).toBeNull(),
    });
  });

  test("add-project-team (full-membership semantics; inverse restores exactly)", async () => {
    const be = freshBackend();
    be.projects.set("p-1", { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1"], initiativeIds: [] });
    await triple(be, baseOp({
      op: "add-project-team", target: { type: "project", id: "p-1", identifier: "P" },
      from: { teamIds: ["t-1"] }, to: { teamId: "t-2", teamIds: ["t-1", "t-2"] },
    }), {
      afterApply: () => expect(be.projects.get("p-1")!.teamIds).toEqual(["t-1", "t-2"]),
      afterRollback: () => expect(be.projects.get("p-1")!.teamIds).toEqual(["t-1"]),
    });
  });

  test("move-project-initiative (full computed initiativeIds compared)", async () => {
    const be = freshBackend();
    be.projects.set("p-1", { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1"], initiativeIds: ["in-old"] });
    await triple(be, baseOp({
      op: "move-project-initiative", target: { type: "project", id: "p-1", identifier: "P" },
      from: { initiativeIds: ["in-old"], initiativeId: "in-old" },
      to: { fromInitiativeToProjectId: "in-old:p-1", fromInitiativeId: "in-old", toInitiativeId: "in-new" },
    }), {
      afterApply: () => expect(be.projects.get("p-1")!.initiativeIds).toEqual(["in-new"]),
      afterRollback: () => expect(be.projects.get("p-1")!.initiativeIds).toEqual(["in-old"]),
    });
  });

  test("retire-or-delete-label: retire → verify → restore", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111010", { id: "11111111-1111-4111-8111-111111111010", name: "teambug", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    await triple(be, baseOp({
      op: "retire-or-delete-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111010", identifier: "EX/teambug" },
      from: { retired: false }, to: { retired: true },
    }), {
      afterApply: () => expect(be.labels.get("11111111-1111-4111-8111-111111111010")!.retiredAt).not.toBeNull(),
      afterRollback: () => expect(be.labels.get("11111111-1111-4111-8111-111111111010")!.retiredAt).toBeNull(),
    });
  });

  test("create-workspace-label: creates, verifies; a rerun drift-aborts (no duplicate)", async () => {
    const be = freshBackend();
    const op = baseOp({
      op: "create-workspace-label", target: { type: "label", id: "new:bug", identifier: "bug" },
      from: { labelId: null }, to: { name: "bug", color: "#e5484d" },
    });
    const j = join(dir, "j.jsonl");
    const applied = await applyPlan(be, [op], j);
    expect(applied.applied).toBe(1);
    const created = [...be.labels.values()].find((l) => l.name === "bug" && l.teamId == null);
    expect(created).toBeDefined();
    expect(journalRead(j)[0].after).toMatchObject({ labelId: created!.id });

    // rerun: the live lookup finds the label — drift abort, no second create
    const before = be.mutationCalls.length;
    await expect(applyPlan(be, [op], join(dir, "j2.jsonl"))).rejects.toBeInstanceOf(ReorgMismatch);
    expect(be.mutationCalls.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Swallowed-write discipline — verify must catch a write that never landed
// ---------------------------------------------------------------------------

describe("swallowed writes fail loudly", () => {
  test.each(["relabel", "add-project-team", "move-issue-team"] as const)("%s", async (kind) => {
    const be = freshBackend();
    be.swallowWrites = true;
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["11111111-1111-4111-8111-11111111110a"] });
    // seeded WITHOUT the destination team: the drift check passes and the
    // swallowed write (not the drift abort) is what the verify catches
    be.projects.set("p-1", { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1"], initiativeIds: [] });
    let op: ReorgOp;
    if (kind === "relabel") {
      op = baseOp({ op: kind, from: { labelIds: ["11111111-1111-4111-8111-11111111110a"] }, to: { add: ["11111111-1111-4111-8111-1111111110c5"], remove: [] } });
    } else if (kind === "add-project-team") {
      op = baseOp({
        op: kind, target: { type: "project", id: "p-1", identifier: "P" },
        from: { teamIds: ["t-1"] }, to: { teamId: "t-2", teamIds: ["t-1", "t-2"] },
      });
    } else {
      // swallowWrites → the move's live pre-read of (b) sees t-2 in teamIds… but
      // the write never lands, so expected teamId t-2 must mismatch
      op = baseOp({
        op: kind,
        from: { teamId: "t-1", projectId: "p-1", cycleId: null, labelIds: ["11111111-1111-4111-8111-11111111110a"] },
        to: { teamId: "t-2", reapplyLabelIds: [], stateId: "s-todo" },
      });
      // preconditions must pass so the swallowed WRITE is what's tested
      be.projects.get("p-1")!.teamIds = ["t-1", "t-2"]; // (b) live membership ok
      journalAppend(join(dir, "j.jsonl"), { seq: "verify", phase: 1, at: "a", ok: true });
      journalAppend(join(dir, "j.jsonl"), { seq: "verify", phase: 2, at: "b", ok: true });
    }
    await expect(applyPlan(be, [op], join(dir, "j.jsonl"))).rejects.toBeInstanceOf(ReorgMismatch);
    expect(journalRead(join(dir, "j.jsonl")).filter((r) => typeof r.seq === "number")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Batching
// ---------------------------------------------------------------------------

describe("batching", () => {
  test("51 same-batchKey ops → one batchUpdate (50) + one single write; every member journaled", async () => {
    const be = freshBackend();
    const ops: ReorgOp[] = [];
    for (let n = 1; n <= 51; n++) {
      const id = `i-${n}`;
      be.issues.set(id, { ...ISSUE_1, id, identifier: `EX-${n}`, labelIds: ["11111111-1111-4111-8111-11111111110a"] });
      ops.push(baseOp({
        seq: n, op: "relabel", target: { type: "issue", id, identifier: `EX-${n}` },
        from: { labelIds: ["11111111-1111-4111-8111-11111111110a"] }, to: { add: ["11111111-1111-4111-8111-11111111110b"], remove: [] }, batchKey: "k",
      }));
    }
    const j = join(dir, "j.jsonl");
    const result = await applyPlan(be, ops, j);
    expect(result.applied).toBe(51);
    expect(be.mutationCalls.filter((c) => c === "issueBatchUpdate")).toHaveLength(1);
    expect(be.mutationCalls.filter((c) => c === "issueUpdate")).toHaveLength(1);
    expect(journalRead(j).filter((r) => r.ok)).toHaveLength(51);
  });

  test("batch with an ARCHIVED member verifies (verify read must carry includeArchived)", async () => {
    // Without includeArchived in the verify read the archived member is
    // "missing from verify read" and the batch stops — red without the flag.
    const be = freshBackend();
    const ops: ReorgOp[] = [];
    for (const n of [1, 2]) {
      const id = `i-${n}`;
      be.issues.set(id, { ...ISSUE_1, id, identifier: `EX-${n}`, labelIds: ["11111111-1111-4111-8111-11111111110a"], archived: n === 2 });
      ops.push(baseOp({
        seq: n, op: "relabel", target: { type: "issue", id, identifier: `EX-${n}` },
        from: { labelIds: ["11111111-1111-4111-8111-11111111110a"] }, to: { add: ["11111111-1111-4111-8111-11111111110b"], remove: [] }, batchKey: "k",
      }));
    }
    const result = await applyPlan(be, ops, join(dir, "j.jsonl"));
    expect(result.applied).toBe(2);
    expect(be.mutationCalls.filter((c) => c === "issueBatchUpdate")).toHaveLength(1);
    expect(be.issues.get("i-2")!.labelIds).toContain("11111111-1111-4111-8111-11111111110b"); // archived member relabeled
  });

  test("mid-batch mismatch: good members journaled ok, bad one marked ok:false, then stop", async () => {
    const be = freshBackend();
    const ops: ReorgOp[] = [];
    for (const n of [1, 2, 3]) {
      const id = `i-${n}`;
      be.issues.set(id, { ...ISSUE_1, id, identifier: `EX-${n}`, labelIds: ["11111111-1111-4111-8111-11111111110a"] });
      ops.push(baseOp({
        seq: n, op: "relabel", target: { type: "issue", id, identifier: `EX-${n}` },
        from: { labelIds: ["11111111-1111-4111-8111-11111111110a"] }, to: { add: ["11111111-1111-4111-8111-11111111110b"], remove: [] }, batchKey: "k",
      }));
    }
    be.batchSkip.add("i-2"); // the batch write lands for i-1/i-3 only
    const j = join(dir, "j.jsonl");
    await expect(applyPlan(be, ops, j)).rejects.toBeInstanceOf(ReorgMismatch);
    const recs = journalRead(j);
    expect(recs).toHaveLength(3); // EVERY member journaled before the stop
    expect(recs.filter((r) => r.ok).map((r) => r.seq).sort()).toEqual([1, 3]);
    const bad = recs.find((r) => !r.ok);
    expect(bad?.seq).toBe(2);
    expect(bad?.error).toContain("labelIds");
    // resume continues from the failed member only
    be.batchSkip.clear();
    const resumed = await applyPlan(be, ops, j, { resume: true });
    expect(resumed.applied).toBe(1);
    expect(resumed.skipped).toBe(2);
  });

  describe("batch write error then re-read (CER-2612)", () => {
    const MSG = "Linear returned an error after the batch landed.";
    const LA = "11111111-1111-4111-8111-11111111110a";
    const LB = "11111111-1111-4111-8111-11111111110b";
    const seedBatch = (ns: number[]) => {
      const be = freshBackend();
      const ops: ReorgOp[] = [];
      for (const n of ns) {
        const id = `i-${n}`;
        be.issues.set(id, { ...ISSUE_1, id, identifier: `EX-${n}`, labelIds: [LA] });
        ops.push(baseOp({
          seq: n, op: "relabel", target: { type: "issue", id, identifier: `EX-${n}` },
          from: { labelIds: [LA] }, to: { add: [LB], remove: [] }, batchKey: "k",
        }));
      }
      return { be, ops };
    };

    test("write throws after ALL members landed: all journaled ok/writeErrorButApplied, run continues", async () => {
      const { be, ops } = seedBatch([1, 2, 3]);
      be.writeError = { message: MSG, land: true };
      const events: string[] = [];
      const j = join(dir, "j.jsonl");
      const r = await applyPlan(be, ops, j, { onEvent: (e) => events.push(e.kind) });
      expect(r.applied).toBe(3);
      const recs = journalRead(j);
      expect(recs).toHaveLength(3);
      for (const rec of recs) expect(rec).toMatchObject({ ok: true, writeErrorButApplied: true, writeError: MSG });
      expect(events).toContain("write-error-applied");
    });

    test("write throws after only SOME members landed: landed ok/writeErrorButApplied, rest ok:false, then stop", async () => {
      const { be, ops } = seedBatch([1, 2, 3]);
      be.writeError = { message: MSG, land: true };
      be.batchSkip.add("i-2");
      const j = join(dir, "j.jsonl");
      await expect(applyPlan(be, ops, j)).rejects.toBeInstanceOf(ReorgMismatch);
      const recs = journalRead(j);
      expect(recs).toHaveLength(3);
      expect(recs.filter((r) => r.ok).map((r) => r.seq).sort()).toEqual([1, 3]);
      for (const rec of recs.filter((r) => r.ok)) expect(rec).toMatchObject({ writeErrorButApplied: true, writeError: MSG });
      const bad = recs.find((r) => !r.ok);
      expect(bad?.seq).toBe(2);
      expect(bad?.error).toContain("labelIds");
    });

    test("write throws and NOTHING landed: the original error propagates, nothing journaled", async () => {
      const { be, ops } = seedBatch([1, 2]);
      be.writeError = { message: MSG, land: false };
      const j = join(dir, "j.jsonl");
      await expect(applyPlan(be, ops, j)).rejects.toThrow(MSG);
      expect(journalRead(j)).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// CER-2385: --check / dry run / apply all see mixed batch groups
// ---------------------------------------------------------------------------

describe("mixed batch groups (CER-2385)", () => {
  const LA = "11111111-1111-4111-8111-11111111110a";
  const LB = "11111111-1111-4111-8111-11111111110b";
  const LC = "11111111-1111-4111-8111-1111111110c5";
  const mk = (n: number, add: string[], batchKey = "k", op: ReorgOp["op"] = "relabel") =>
    baseOp({
      seq: n, op, target: { type: "issue", id: `i-${n}`, identifier: `EX-${n}` },
      from: { labelIds: [LA] }, to: { add, remove: [] }, batchKey,
    });
  const seed = (be: FakeBackend, n: number) => {
    for (let k = 1; k <= n; k++)
      be.issues.set(`i-${k}`, { ...ISSUE_1, id: `i-${k}`, identifier: `EX-${k}`, labelIds: [LA] });
  };
  const checkOpts = (extra: Record<string, unknown> = {}) => ({
    check: true, apply: false, resume: false, allowIrreversible: false,
    journalPath: join(dir, "j.jsonl"), pace: fastPace(), ...extra,
  });

  test("batchGroups mirrors apply: consecutive, same key+kind, batchable only, cap 50, singletons kept", () => {
    const ops = [mk(1, [LB]), mk(2, [LB]), mk(3, [LB], "k", "set-state"), mk(4, [LB], "other"), baseOp({ seq: 5, op: "rename-label", batchKey: "k" })];
    expect(batchGroups(ops).map((g) => g.map((o) => o.seq))).toEqual([[1, 2], [3], [4], [5]]);
    const many = Array.from({ length: 51 }, (_, i) => mk(i + 1, [LB]));
    expect(batchGroups(many).map((g) => g.length)).toEqual([50, 1]);
  });

  test("mixed pair: --check refuses both seqs, apply throws before any write, dry run refuses", async () => {
    const be = freshBackend();
    seed(be, 2);
    const ops = [mk(1, [LB]), mk(2, [LC])];
    const lines: string[] = [];
    const chk = await runPlan(fakeClient(be), planWith(ops), checkOpts({ onEvent: (e: { detail: string }) => lines.push(e.detail) }));
    expect(chk.refused).toEqual([1, 2]);
    expect(lines.some((l) => l.includes("REFUSE seq 1..2 batchKey k: non-identical input at seq(s) 2"))).toBe(true);
    await expect(applyPlan(be, ops, join(dir, "ja.jsonl"))).rejects.toThrow(/refused before any write: seq 1\.\.2 batchKey k.*seq\(s\) 2/);
    expect(be.mutationCalls).toEqual([]);
    const dry = await runPlan(fakeClient(be), planWith(ops), checkOpts({ check: false }));
    expect(dry.refused).toEqual([1, 2]);
    expect(dry.dryRun).toBe(true);
  });

  test("uniform group is not refused (control)", async () => {
    const be = freshBackend();
    seed(be, 2);
    const chk = await runPlan(fakeClient(be), planWith([mk(1, [LB]), mk(2, [LB])]), checkOpts());
    expect(chk.refused).toEqual([]);
    expect(mixedBatchGroups([mk(1, [LB]), mk(2, [LB])])).toEqual([]);
  });

  test("parity: 51-run where only member 51 differs is NOT refused (51st is a singleton group)", async () => {
    const be = freshBackend();
    seed(be, 51);
    const ops = Array.from({ length: 51 }, (_, i) => mk(i + 1, [i === 50 ? LC : LB]));
    const chk = await runPlan(fakeClient(be), planWith(ops), checkOpts());
    expect(chk.refused).toEqual([]);
    const r = await applyPlan(be, ops, join(dir, "j2.jsonl"));
    expect(r.applied).toBe(51);
    expect(be.mutationCalls.filter((c) => c === "issueBatchUpdate")).toHaveLength(1);
  });

  test("resume slicing: a journaled separator makes the pair consecutive; without resume it is not", async () => {
    const be = freshBackend();
    seed(be, 3);
    // seq 2 shares the key but is a different kind, so it separates the pair
    const ops = [mk(1, [LB]), mk(2, [LB], "k", "set-state"), mk(3, [LC])];
    const none = await runPlan(fakeClient(be), planWith(ops), checkOpts());
    expect(none.refused).toEqual([]);
    const j = join(dir, "jr.jsonl");
    journalAppend(j, { seq: 2, phase: 1, op: "set-state", at: "a", ok: true });
    const resumed = await runPlan(fakeClient(be), planWith(ops), checkOpts({ resume: true, journalPath: j }));
    expect(resumed.refused).toEqual([1, 3]);
  });
});

// ---------------------------------------------------------------------------
// move-issue-team — preconditions live, destination state correction
// ---------------------------------------------------------------------------

describe("move-issue-team", () => {
  function moveBackend(): FakeBackend {
    const be = freshBackend();
    be.teams.set("t-1", { id: "t-1", key: "EX", triageEnabled: true, deleted: false });
    be.teams.set("t-2", { id: "t-2", key: "NEW", triageEnabled: true, deleted: false });
    be.projects.set("p-1", { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1", "t-2"], initiativeIds: [] });
    be.labels.set("11111111-1111-4111-8111-1111111110e4", { id: "11111111-1111-4111-8111-1111111110e4", name: "teambug", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    be.labels.set("11111111-1111-4111-8111-1111111110c5", { id: "11111111-1111-4111-8111-1111111110c5", name: "bug", retiredAt: null, teamId: null, teamKey: null });
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["11111111-1111-4111-8111-1111111110c5"], stateId: "s-todo" });
    return be;
  }
  const moveOp = baseOp({
    seq: 5, op: "move-issue-team",
    from: { teamId: "t-1", projectId: "p-1", cycleId: null, labelIds: ["11111111-1111-4111-8111-1111111110c5"] },
    to: { teamId: "t-2", reapplyLabelIds: ["11111111-1111-4111-8111-1111111110c5"], stateId: "s-new-todo" },
  });

  test("full path: labels re-sent, project preserved, state corrected to the DESTINATION", async () => {
    const be = moveBackend();
    const j = join(dir, "j.jsonl");
    journalAppend(j, { seq: "verify", phase: 1, at: "a", ok: true });
    journalAppend(j, { seq: "verify", phase: 2, at: "b", ok: true });
    const result = await applyPlan(be, [moveOp], j);
    expect(result.applied).toBe(1);
    const i = be.issues.get("i-1")!;
    expect(i.teamId).toBe("t-2");
    expect(i.labelIds).toContain("11111111-1111-4111-8111-1111111110c5");
    expect(i.projectId).toBe("p-1");
    // the fake ignored the paired stateId (closest-state mapping); the engine
    // corrected to the DESTINATION state with a separate verified set-state —
    // never back to the source team's from.stateId
    expect(i.stateId).toBe("s-new-todo");
    expect(be.mutationCalls.filter((c) => c === "issueUpdate").length).toBe(2);
  });

  test("(b) reads the project LIVE: destination not in teamIds → refuse, no write", async () => {
    const be = moveBackend();
    be.projects.get("p-1")!.teamIds = ["t-1"]; // t-2 NOT a member
    const j = join(dir, "j.jsonl");
    journalAppend(j, { seq: "verify", phase: 1, at: "a", ok: true });
    journalAppend(j, { seq: "verify", phase: 2, at: "b", ok: true });
    await expect(applyPlan(be, [moveOp], j)).rejects.toThrow("(b)");
    expect(be.mutationCalls).toEqual([]);
  });

  test("(a) a live team-scoped label without a journaled swap refuses the move", async () => {
    const be = moveBackend();
    be.issues.get("i-1")!.labelIds = ["11111111-1111-4111-8111-1111111110c5", "11111111-1111-4111-8111-1111111110e4"]; // team label still on it
    const j = join(dir, "j.jsonl");
    journalAppend(j, { seq: "verify", phase: 1, at: "a", ok: true });
    journalAppend(j, { seq: "verify", phase: 2, at: "b", ok: true });
    await expect(applyPlan(be, [moveOp], j)).rejects.toThrow("(a)");
    expect(be.mutationCalls).toEqual([]);
  });

  test("(a) passes when the team label's swap is journaled into reapplyLabelIds", async () => {
    const be = moveBackend();
    be.issues.get("i-1")!.labelIds = ["11111111-1111-4111-8111-1111111110c5", "11111111-1111-4111-8111-1111111110e4"];
    const j = join(dir, "j.jsonl");
    journalAppend(j, { seq: "verify", phase: 1, at: "a", ok: true });
    journalAppend(j, { seq: "verify", phase: 2, at: "b", ok: true });
    journalAppend(j, {
      seq: 2, phase: 1, op: "relabel", at: "c", ok: true,
      original: baseOp({
        seq: 2, op: "relabel", target: { type: "issue", id: "i-1", identifier: "EX-1" },
        from: { labelIds: ["11111111-1111-4111-8111-1111111110e4"] }, to: { add: ["11111111-1111-4111-8111-1111111110c5"], remove: ["11111111-1111-4111-8111-1111111110e4"] },
      }),
    });
    const result = await applyPlan(be, [moveOp], j);
    expect(result.applied).toBe(1);
    const i = be.issues.get("i-1")!;
    expect(i.teamId).toBe("t-2");
    expect(i.labelIds).not.toContain("11111111-1111-4111-8111-1111111110e4"); // dropped by the move, as designed
    expect(i.labelIds).toContain("11111111-1111-4111-8111-1111111110c5");
  });
});

// ---------------------------------------------------------------------------
// delete-team / archive-state — live emptiness pre-reads
// ---------------------------------------------------------------------------

describe("emptiness pre-reads", () => {
  test("delete-team refuses when a project is still attached (guard must fail the write)", async () => {
    const be = freshBackend();
    be.teams.set("t-9", { id: "t-9", key: "OLD", triageEnabled: false, deleted: false });
    be.projects.set("p-9", { id: "p-9", name: "Leftover", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-9"], initiativeIds: [] });
    const del = baseOp({
      seq: 9, phase: 6, op: "delete-team", reversible: false, approval: "deck-1",
      target: { type: "team", id: "t-9", identifier: "OLD" }, from: {}, to: {},
    });
    await expect(
      applyPlan(be, [del], join(dir, "j.jsonl"), { allowIrreversible: true }),
    ).rejects.toThrow("project(s) still attached");
    expect(be.mutationCalls).toEqual([]);
    expect(be.teams.get("t-9")!.deleted).toBe(false);
  });

  test("delete-team blocked by an ARCHIVED project attachment (probe must carry includeArchived)", async () => {
    // Without includeArchived the probe's world excludes trashed projects, the
    // team looks unattached, and the delete proceeds — this test is red then.
    const be = freshBackend();
    be.teams.set("t-9", { id: "t-9", key: "OLD", triageEnabled: false, deleted: false });
    be.projects.set("p-arc", { id: "p-arc", name: "Archived", statusId: "st", leadId: null, targetDate: null, trashed: true, teamIds: ["t-9"], initiativeIds: [] });
    const del = baseOp({
      seq: 9, phase: 6, op: "delete-team", reversible: false, approval: "deck-1",
      target: { type: "team", id: "t-9", identifier: "OLD" }, from: {}, to: {},
    });
    await expect(
      applyPlan(be, [del], join(dir, "j.jsonl"), { allowIrreversible: true }),
    ).rejects.toThrow("project(s) still attached");
    expect(be.teams.get("t-9")!.deleted).toBe(false);
  });

  test("delete-team whose write did not land stops the run (post-check must not be vacuous)", async () => {
    // The re-read still finds the team: apply must stop, not journal ok.
    const be = freshBackend();
    be.teams.set("t-9", { id: "t-9", key: "OLD", triageEnabled: false, deleted: false });
    be.swallowWrites = true;
    const del = baseOp({
      seq: 9, phase: 6, op: "delete-team", reversible: false, approval: "deck-1",
      target: { type: "team", id: "t-9", identifier: "OLD" }, from: {}, to: {},
    });
    const j = join(dir, "j.jsonl");
    await expect(
      applyPlan(be, [del], j, { allowIrreversible: true }),
    ).rejects.toBeInstanceOf(ReorgMismatch);
    expect(be.teams.get("t-9")!.deleted).toBe(false);
    expect(journalRead(j).filter((r) => r.ok)).toHaveLength(0);
  });

  test("delete-team probe paginates (blocking project on page two)", async () => {
    // forceProjectPagination withholds member projects to page two; an engine
    // that drops the pagination loop sees page one only and deletes — red.
    const be = freshBackend();
    be.forceProjectPagination = true;
    be.teams.set("t-9", { id: "t-9", key: "OLD", triageEnabled: false, deleted: false });
    be.projects.set("p-late", { id: "p-late", name: "PageTwo", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-9"], initiativeIds: [] });
    const del = baseOp({
      seq: 9, phase: 6, op: "delete-team", reversible: false, approval: "deck-1",
      target: { type: "team", id: "t-9", identifier: "OLD" }, from: {}, to: {},
    });
    await expect(
      applyPlan(be, [del], join(dir, "j.jsonl"), { allowIrreversible: true }),
    ).rejects.toThrow("project(s) still attached");
    expect(be.teams.get("t-9")!.deleted).toBe(false);
    expect(be.projectProbeCalls).toBe(2); // the probe paged to the second page
  });

  test("delete-team refuses with live issues / labels / projects; deletes when empty", async () => {
    const be = freshBackend();
    be.teams.set("t-9", { id: "t-9", key: "OLD", triageEnabled: false, deleted: false });
    be.issues.set("i-7", { ...ISSUE_1, id: "i-7", identifier: "OLD-7", teamId: "t-9", teamKey: "OLD", labelIds: [] });
    const del = baseOp({
      seq: 9, phase: 6, op: "delete-team", reversible: false, approval: "deck-1",
      target: { type: "team", id: "t-9", identifier: "OLD" }, from: {}, to: {},
    });
    await expect(
      applyPlan(be, [del], join(dir, "j.jsonl"), { allowIrreversible: true }),
    ).rejects.toThrow("issues remain");
    expect(be.mutationCalls).toEqual([]);

    be.issues.delete("i-7"); // now empty
    const j = join(dir, "j2.jsonl");
    const result = await applyPlan(be, [del], j, { allowIrreversible: true });
    expect(result.applied).toBe(1);
    expect(be.teams.get("t-9")!.deleted).toBe(true);
    // verify: absent IS the expected end state
    const v = await verifyPhase(fakeClient(be), planWith([del]), 6, { journalPath: j, pace: fastPace() });
    expect(v.ok).toBe(true);
  });

  test("archive-state refuses while issues sit in the state", async () => {
    const be = freshBackend();
    be.states.set("s-ready", { id: "s-ready", name: "Ready", type: "unstarted", archivedAt: null });
    be.issues.set("i-1", { ...ISSUE_1, stateId: "s-ready", labelIds: [] });
    const op = baseOp({
      op: "archive-state", target: { type: "state", id: "s-ready", identifier: "EX/Ready" },
      from: { archived: false }, to: { archived: true },
    });
    await expect(applyPlan(be, [op], join(dir, "j.jsonl"))).rejects.toThrow("still in the state");
    be.issues.get("i-1")!.stateId = "s-todo";
    const result = await applyPlan(be, [op], join(dir, "j2.jsonl"));
    expect(result.applied).toBe(1);
    expect(be.states.get("s-ready")!.archivedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// verifyPhase + rollback discipline
// ---------------------------------------------------------------------------

describe("verifyPhase supersede", () => {
  const P = { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["d"], initiativeIds: [] };
  const addOp = baseOp({
    seq: 1, phase: 5, op: "add-project-team",
    target: { type: "project", id: "p-1", identifier: "P" },
    from: { teamIds: ["s"] }, to: { teamIds: ["d", "s"] },
  });
  const rmOp = baseOp({
    seq: 2, phase: 6, op: "remove-project-team",
    target: { type: "project", id: "p-1", identifier: "P" },
    from: { teamIds: ["d", "s"] }, to: { teamIds: ["d"] },
  });
  const rec = (o: ReorgOp, ok = true) => ({ seq: o.seq, phase: o.phase, op: o.op, original: o, at: "a", ok });
  const mark = (phase: number, ok: boolean) => ({ seq: "verify" as const, phase, ok, at: "a" });

  test("add then remove on the same project verifies green, add listed superseded", async () => {
    const be = freshBackend();
    be.projects.set("p-1", { ...P });
    const j = join(dir, "j.jsonl");
    journalAppend(j, rec(addOp)); journalAppend(j, rec(rmOp));
    journalAppend(j, mark(6, true));
    const v = await verifyPhase(fakeClient(be), planWith([addOp, rmOp]), 5, { journalPath: j, pace: fastPace() });
    expect(v.failures).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.superseded).toHaveLength(1);
    expect(v.superseded[0]).toContain("superseded by seq 2");
  });

  test("later remove not journaled still checks the add (red)", async () => {
    const be = freshBackend();
    be.projects.set("p-1", { ...P });
    const j = join(dir, "j.jsonl");
    journalAppend(j, rec(addOp));
    const v = await verifyPhase(fakeClient(be), planWith([addOp, rmOp]), 5, { journalPath: j, pace: fastPace() });
    expect(v.ok).toBe(false);
    expect(v.failures[0]).toContain("teamIds");
    expect(v.superseded).toEqual([]);
    // a journaled-but-failed later op supersedes nothing either
    journalAppend(j, rec(rmOp, false));
    const v2 = await verifyPhase(fakeClient(be), planWith([addOp, rmOp]), 5, { journalPath: j, pace: fastPace() });
    expect(v2.ok).toBe(false);
  });

  test("move then archive on the same issue: both still checked (archive sets only archived)", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [...ISSUE_1.labelIds], teamId: "t-9", archived: true });
    const mv = baseOp({
      seq: 1, phase: 5, op: "move-issue-team",
      from: { teamId: "t-1", projectId: "p-1", stateId: "s-todo" },
      to: { teamId: "t-2", projectId: "p-1", stateId: "s-todo" },
    });
    const ar = baseOp({ seq: 2, phase: 5, op: "archive-issue", from: { archived: false }, to: { archived: true } });
    const j = join(dir, "j.jsonl");
    journalAppend(j, rec(mv)); journalAppend(j, rec(ar));
    const v = await verifyPhase(fakeClient(be), planWith([mv, ar]), 5, { journalPath: j, pace: fastPace() });
    expect(v.ok).toBe(false);
    expect(v.failures.some((f) => f.startsWith("seq 1") && f.includes("teamId"))).toBe(true);
    expect(v.superseded).toEqual([]);
    be.issues.get("i-1")!.teamId = "t-2";
    const v2 = await verifyPhase(fakeClient(be), planWith([mv, ar]), 5, { journalPath: j, pace: fastPace() });
    expect(v2.ok).toBe(true);
    be.issues.get("i-1")!.archived = false;
    const v3 = await verifyPhase(fakeClient(be), planWith([mv, ar]), 5, { journalPath: j, pace: fastPace() });
    expect(v3.failures.some((f) => f.startsWith("seq 2") && f.includes("archived"))).toBe(true);
  });

  test("remove-project-team then archive-project: teamIds still checked", async () => {
    const be = freshBackend();
    be.projects.set("p-1", { ...P, teamIds: ["d", "x"], archived: true });
    const ar = baseOp({
      seq: 3, phase: 5, op: "archive-project",
      target: { type: "project", id: "p-1", identifier: "P" },
      from: { archived: false }, to: { archived: true },
    });
    const rm = { ...rmOp, phase: 5, from: { teamIds: ["d", "x"] }, to: { teamId: "x", teamIds: ["d"] } };
    const j = join(dir, "j.jsonl");
    journalAppend(j, rec(rm)); journalAppend(j, rec(ar));
    const v = await verifyPhase(fakeClient(be), planWith([rm, ar]), 5, { journalPath: j, pace: fastPace() });
    expect(v.ok).toBe(false);
    expect(v.failures.some((f) => f.startsWith("seq 2") && f.includes("teamIds"))).toBe(true);
    be.projects.get("p-1")!.teamIds = ["d"];
    const v2 = await verifyPhase(fakeClient(be), planWith([rm, ar]), 5, { journalPath: j, pace: fastPace() });
    expect(v2.failures).toEqual([]);
  });

  test("archive, unarchive, re-archive: only the last archive is checked", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [...ISSUE_1.labelIds], archived: true });
    const mk = (seq: number, archived: boolean) =>
      baseOp({ seq, phase: 5, op: "archive-issue", from: { archived: !archived }, to: { archived } });
    const ops = [mk(1, true), mk(2, false), mk(3, true)];
    const j = join(dir, "j.jsonl");
    for (const o of ops) journalAppend(j, rec(o));
    const v = await verifyPhase(fakeClient(be), planWith(ops), 5, { journalPath: j, pace: fastPace() });
    expect(v.failures).toEqual([]);
    expect(v.superseded).toHaveLength(2);
    be.issues.get("i-1")!.archived = false;
    const v2 = await verifyPhase(fakeClient(be), planWith(ops), 5, { journalPath: j, pace: fastPace() });
    expect(v2.failures).toHaveLength(1);
    expect(v2.failures[0]).toContain("seq 3");
  });

  test("creates of different labels in one team never supersede each other", async () => {
    const be = freshBackend();
    const T = { type: "team" as const, id: "t-1", identifier: "EX" };
    const mkc = (seq: number, name: string) =>
      baseOp({ seq, phase: 5, op: "create-team-label", target: T, from: { labelId: null }, to: { name, labelId: `l-${name}` } });
    const ops = [mkc(1, "a"), mkc(2, "b"), mkc(3, "c")];
    for (const n of ["a", "b", "c"])
      be.labels.set(`l-${n}`, { id: `l-${n}`, name: n, retiredAt: null, teamId: "t-1", teamKey: "EX" });
    const j = join(dir, "j.jsonl");
    for (const o of ops) journalAppend(j, rec(o));
    const v = await verifyPhase(fakeClient(be), planWith(ops), 5, { journalPath: j, pace: fastPace() });
    expect(v.failures).toEqual([]);
    expect(v.superseded).toEqual([]);
    be.labels.delete("l-a");
    const v2 = await verifyPhase(fakeClient(be), planWith(ops), 5, { journalPath: j, pace: fastPace() });
    expect(v2.failures.some((f) => f.startsWith("seq 1"))).toBe(true);
    // a later retire of THAT label supersedes its create
    const ret = baseOp({
      seq: 4, phase: 5, op: "retire-or-delete-label",
      target: { type: "label", id: "l-a", identifier: "EX/a" }, from: { retired: false }, to: { retired: true },
    });
    journalAppend(j, rec(ret));
    be.labels.set("l-a", { id: "l-a", name: "a", retiredAt: "x", teamId: "t-1", teamKey: "EX" });
    const v3 = await verifyPhase(fakeClient(be), planWith([...ops, ret]), 5, { journalPath: j, pace: fastPace() });
    expect(v3.failures).toEqual([]);
    expect(v3.superseded).toHaveLength(1);
    expect(v3.superseded[0]).toContain("seq 1");
  });

  test("a later op journaled from another plan supersedes; a plan op without an ok row still fails", async () => {
    const be = freshBackend();
    be.projects.set("p-1", { ...P });
    const j = join(dir, "j.jsonl");
    const rm5 = { ...rmOp, phase: 5 };
    journalAppend(j, rec(addOp)); journalAppend(j, rec(rm5));
    const v = await verifyPhase(fakeClient(be), planWith([addOp]), 5, { journalPath: j, pace: fastPace() });
    expect(v.failures).toEqual([]);
    expect(v.superseded[0]).toContain("superseded by seq 2");
    const missing = baseOp({ seq: 9, phase: 5, from: { stateId: "s-todo" }, to: { stateId: "s-done" } });
    const v2 = await verifyPhase(fakeClient(be), planWith([addOp, missing]), 5, { journalPath: j, pace: fastPace() });
    expect(v2.failures.some((f) => f.startsWith("seq 9") && f.includes("no ok journal entry"))).toBe(true);
  });

  test("a later op in an unverified phase supersedes nothing; green marker enables it", async () => {
    const be = freshBackend();
    be.projects.set("p-1", { ...P });
    const j = join(dir, "j.jsonl");
    journalAppend(j, rec(addOp)); journalAppend(j, rec(rmOp));
    const plan = planWith([addOp, rmOp]);
    const v = await verifyPhase(fakeClient(be), plan, 5, { journalPath: j, pace: fastPace() });
    expect(v.ok).toBe(false);
    expect(v.superseded).toEqual([]);
    journalAppend(j, mark(6, true));
    const v2 = await verifyPhase(fakeClient(be), plan, 5, { journalPath: j, pace: fastPace() });
    expect(v2.ok).toBe(true);
    journalAppend(j, mark(6, false));
    const v3 = await verifyPhase(fakeClient(be), plan, 5, { journalPath: j, pace: fastPace() });
    expect(v3.ok).toBe(false);
  });

  test("partial overlap: only the non-superseded key is checked", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [...ISSUE_1.labelIds], teamId: "t-2", stateId: "s-other" });
    const mv = baseOp({
      seq: 1, phase: 1, op: "move-issue-team",
      from: { teamId: "t-1", projectId: "p-1", stateId: "s-todo" },
      to: { teamId: "t-2", projectId: "p-1", stateId: "s-todo" },
    });
    const st = baseOp({ seq: 2, phase: 1, op: "set-state", from: { stateId: "s-todo" }, to: { stateId: "s-other" } });
    const j = join(dir, "j.jsonl");
    journalAppend(j, rec(mv)); journalAppend(j, rec(st));
    const v = await verifyPhase(fakeClient(be), planWith([mv, st]), 1, { journalPath: j, pace: fastPace() });
    expect(v.failures.filter((f) => f.startsWith("seq 1"))).toEqual([]);
    expect(v.superseded[0]).toContain("stateId");
    be.issues.get("i-1")!.teamId = "t-1"; // teamId is still checked
    const v2 = await verifyPhase(fakeClient(be), planWith([mv, st]), 1, { journalPath: j, pace: fastPace() });
    expect(v2.failures.some((f) => f.startsWith("seq 1") && f.includes("teamId"))).toBe(true);
  });
});

describe("verifyPhase", () => {
  test("red without journal ok; green after apply; red on later live drift", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [...ISSUE_1.labelIds] });
    const op = baseOp({ from: { stateId: "s-todo" }, to: { stateId: "s-done" } });
    const j = join(dir, "j.jsonl");
    const missing = await verifyPhase(fakeClient(be), planWith([op]), 1, { journalPath: j, pace: fastPace() });
    expect(missing.ok).toBe(false);
    await applyPlan(be, [op], j);
    const green = await verifyPhase(fakeClient(be), planWith([op]), 1, { journalPath: j, pace: fastPace() });
    expect(green.ok).toBe(true);
    be.issues.get("i-1")!.stateId = "s-todo";
    const red = await verifyPhase(fakeClient(be), planWith([op]), 1, { journalPath: j, pace: fastPace() });
    expect(red.ok).toBe(false);
    expect(red.failures[0]).toContain("stateId");
  });
});

describe("write error then re-read (CER-2391)", () => {
  const MSG = "Project already related to a parent or child initiative.";
  const setStateOp = () => baseOp({ from: { stateId: "s-todo" }, to: { stateId: "s-done" } });
  const seed = () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [...ISSUE_1.labelIds] });
    return be;
  };

  test("write throws but the state landed: accepted, journaled with writeErrorButApplied", async () => {
    const be = seed();
    be.writeError = { message: MSG, land: true };
    const events: string[] = [];
    const j = join(dir, "j.jsonl");
    const r = await applyPlan(be, [setStateOp(), baseOp({ seq: 2, from: { stateId: "s-done" }, to: { stateId: "s-todo" } })], j, {
      onEvent: (e) => events.push(`${e.kind}:${e.detail}`),
    });
    expect(r.applied).toBe(2);
    const rec = journalRead(j)[0];
    expect(rec).toMatchObject({ ok: true, writeErrorButApplied: true, writeError: MSG });
    expect(events.some((e) => e.startsWith("write-error-applied:") && e.includes("seq 1") && e.includes(MSG))).toBe(true);
  });

  test("write throws and the state did NOT land: original error propagates, no ok row", async () => {
    const be = seed();
    be.writeError = { message: MSG, land: false };
    const j = join(dir, "j.jsonl");
    await expect(applyPlan(be, [setStateOp()], j)).rejects.toThrow(MSG);
    expect(journalRead(j).filter((r) => r.ok)).toHaveLength(0);
  });

  test("create op whose write lands then throws: the ORIGINAL error propagates, no ok row", async () => {
    // No same-named label beforehand, so the pre-read passes and the write
    // runs; a create's end state needs the id the write returns, so the
    // error is never accepted.
    const be = seed();
    be.writeError = { message: MSG, land: true };
    const op = baseOp({
      op: "create-workspace-label", target: { type: "label", id: "new:bug", identifier: "bug" },
      from: { labelId: null }, to: { name: "bug", color: "#e5484d" },
    });
    const j = join(dir, "j.jsonl");
    await expect(applyPlan(be, [op], j)).rejects.toThrow(MSG); // the ORIGINAL error
    expect(journalRead(j).filter((r) => r.ok)).toHaveLength(0);
  });

  test("an accepted row stays rollback-eligible (unlike alreadyApplied)", async () => {
    const be = seed();
    be.writeError = { message: MSG, land: true };
    const j = join(dir, "j.jsonl");
    await applyPlan(be, [setStateOp()], j);
    be.writeError = undefined;
    const rb = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true });
    expect(rb.rolledBack).toBe(1);
    expect(rb.skipped).toEqual([]);
    expect(be.issues.get("i-1")!.stateId).toBe("s-todo");
  });
});

describe("rollbackPhase", () => {
  test("no-inverse ops are named and skipped, not silently dropped", async () => {
    const be = freshBackend();
    be.states.set("s-9", { id: "s-9", name: "Ready", type: "unstarted", archivedAt: "x" });
    const j = join(dir, "applied.jsonl");
    journalAppend(j, {
      seq: 2, phase: 2, op: "archive-state", at: "b", ok: true,
      original: baseOp({
        seq: 2, op: "archive-state", target: { type: "state", id: "s-9", identifier: "EX/Ready" },
        from: { archived: false }, to: { archived: true },
      }),
    });
    const { rolledBack, skipped } = await rollbackPhase(fakeClient(be), j, 2, { pace: fastPace(), apply: true });
    expect(rolledBack).toBe(0);
    expect(skipped[0]).toContain("no inverse");
  });
});

// ---------------------------------------------------------------------------
// Planner-gaps unit: labelRef, new ops, archive-state gating
// ---------------------------------------------------------------------------

describe("labelRef name:<n> resolution", () => {
  test("relabel resolves a label created earlier in the same plan (journal)", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["11111111-1111-4111-8111-11111111110a"] });
    const j = join(dir, "j.jsonl");
    const ops = [
      baseOp({
        seq: 1, op: "create-workspace-label",
        target: { type: "label", id: "new:bug", identifier: "bug" },
        from: { labelId: null }, to: { name: "bug", color: "#e5484d" },
      }),
      baseOp({
        seq: 2, op: "relabel",
        from: { labelIds: ["11111111-1111-4111-8111-11111111110a"] },
        to: { add: ["name:bug"], remove: [] },
      }),
    ];
    const result = await applyPlan(be, ops, j);
    expect(result.applied).toBe(2);
    const created = [...be.labels.values()].find((l) => l.name === "bug");
    expect(created).toBeDefined();
    expect(be.issues.get("i-1")!.labelIds).toContain(created!.id);
    // the journal's relabel carries the RESOLVED id (rollback works on ids)
    const rel = journalRead(j).find((r) => r.seq === 2);
    expect(rel?.original?.to.add).toEqual([created!.id]);
  });

  test("live fallback: resolves an existing workspace label by name", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-1111111110c5", { id: "11111111-1111-4111-8111-1111111110c5", name: "bug", retiredAt: null, teamId: null, teamKey: null });
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["11111111-1111-4111-8111-11111111110a"] });
    const result = await applyPlan(be, [baseOp({
      op: "relabel", from: { labelIds: ["11111111-1111-4111-8111-11111111110a"] }, to: { add: ["name:bug"], remove: [] },
    })], join(dir, "j.jsonl"));
    expect(result.applied).toBe(1);
    expect(be.issues.get("i-1")!.labelIds).toContain("11111111-1111-4111-8111-1111111110c5");
  });

  test("ambiguity and zero hits both refuse", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111101", { id: "11111111-1111-4111-8111-111111111101", name: "dup", retiredAt: null, teamId: null, teamKey: null });
    be.labels.set("11111111-1111-4111-8111-111111111102", { id: "11111111-1111-4111-8111-111111111102", name: "dup", retiredAt: null, teamId: null, teamKey: null });
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["11111111-1111-4111-8111-11111111110a"] });
    await expect(applyPlan(be, [baseOp({
      op: "relabel", from: { labelIds: ["11111111-1111-4111-8111-11111111110a"] }, to: { add: ["name:dup"], remove: [] },
    })], join(dir, "j.jsonl"))).rejects.toThrow("ambiguous");
    await expect(applyPlan(be, [baseOp({
      op: "relabel", from: { labelIds: ["11111111-1111-4111-8111-11111111110a"] }, to: { add: ["name:ghost"], remove: [] },
    })], join(dir, "j2.jsonl"))).rejects.toThrow("resolves to nothing");
  });
});

describe("new ops", () => {
  test("remove-project-team: live-computed membership, never a blind replace", async () => {
    const be = freshBackend();
    // census said [t-1, t-2]; t-3 was added SINCE — a blind from-replace would drop it
    be.projects.set("p-1", { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1", "t-2", "t-3"], initiativeIds: [] });
    const op = baseOp({
      op: "remove-project-team", target: { type: "project", id: "p-1", identifier: "P" },
      from: { teamIds: ["t-1", "t-2"] }, to: { teamId: "t-2" },
    });
    // from.teamIds drifts (t-3 added) — drift is checked on compareKeys teamIds...
    // from.teamIds ["t-1","t-2"] vs live ["t-1","t-2","t-3"] → drift abort (by design:
    // the plan is stale). Re-seed from to the live set for the live-computed check:
    op.from = { teamIds: ["t-1", "t-2", "t-3"] };
    const j = join(dir, "j.jsonl");
    const result = await applyPlan(be, [op], j);
    expect(result.applied).toBe(1);
    expect(be.projects.get("p-1")!.teamIds).toEqual(["t-1", "t-3"]); // t-3 preserved
    const rb = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true });
    expect(rb.rolledBack).toBe(1);
    expect(be.projects.get("p-1")!.teamIds).toEqual(["t-1", "t-2", "t-3"]);
  });

  test("set-initiative-owner triple", async () => {
    const be = freshBackend();
    be.initiatives.set("in-1", { id: "in-1", name: "I", archivedAt: null, ownerId: null });
    await (async () => {
      const j = join(dir, "owner.jsonl");
      const op = baseOp({
        op: "set-initiative-owner", target: { type: "initiative", id: "in-1", identifier: "I" },
        from: { ownerId: null }, to: { ownerId: "u-9" },
      });
      await applyPlan(be, [op], j);
      expect(be.initiatives.get("in-1")!.ownerId).toBe("u-9");
      const v = await verifyPhase(fakeClient(be), planWith([op]), 1, { journalPath: j, pace: fastPace() });
      expect(v.ok).toBe(true);
      const rb = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true });
      expect(rb.rolledBack).toBe(1);
      expect(be.initiatives.get("in-1")!.ownerId).toBeNull();
    })();
  });

  test("create-project-status places the new status by lifecycle: after same/earlier types, before later ones", async () => {
    const be = freshBackend();
    be.projectStatuses.set("a", { id: "a", name: "Backlog", type: "backlog", position: 0 });
    be.projectStatuses.set("b", { id: "b", name: "In Progress", type: "started", position: 2 });
    be.projectStatuses.set("c", { id: "c", name: "Done", type: "completed", position: 4 });
    const j = join(dir, "pos.jsonl");
    await applyPlan(be, [baseOp({
      op: "create-project-status", target: { type: "project", id: "new:Paused", identifier: "Paused" },
      from: { statusId: null }, to: { name: "Paused", color: "#f59e0b", type: "paused" },
    })], j);
    const created = [...be.projectStatuses.values()].find((x) => x.name === "Paused")!;
    expect(created.position).toBe(3); // midpoint of started(2) and completed(4)
    expect(journalRead(j)[0].original!.to.position).toBe(3);
    expect(projectStatusPosition([], "paused")).toBe(0);
    expect(projectStatusPosition([{ id: "x", name: "x", type: "started", position: 5 }], "completed")).toBe(6);
  });

  test("every mutation input built by the engine validates against the vendored schema", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [...ISSUE_1.labelIds] });
    be.projects.set("p-1", { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1"], initiativeIds: [] });
    be.initiatives.set("in-1", { id: "in-1", name: "I", archivedAt: null, ownerId: null });
    be.teams.set("t-1", { id: "t-1", key: "EX", triageEnabled: false, deleted: false });
    be.labels.set("11111111-1111-4111-8111-11111111110a", { id: "11111111-1111-4111-8111-11111111110a", name: "a", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    const ops: ReorgOp[] = [
      baseOp({ seq: 1, op: "create-project-status", target: { type: "project", id: "new:Paused", identifier: "Paused" }, from: { statusId: null }, to: { name: "Paused", color: "#f59e0b", type: "paused" } }),
      baseOp({ seq: 2, op: "create-workspace-label", target: { type: "label", id: "new:bug", identifier: "bug" }, from: { labelId: null }, to: { name: "bug", color: "#ff0000" } }),
      baseOp({ seq: 3, op: "set-state", from: { stateId: "s-todo" }, to: { stateId: "s-done" } }),
      baseOp({ seq: 4, op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-11111111110a", identifier: "a" }, from: { name: "a", retired: false }, to: { name: "a2" } }),
      baseOp({ seq: 5, op: "enable-triage", target: { type: "team", id: "t-1", identifier: "EX" }, from: { triageEnabled: false }, to: { triageEnabled: true } }),
      baseOp({ seq: 6, op: "set-project-lead", target: { type: "project", id: "p-1", identifier: "P" }, from: { leadId: null }, to: { leadId: "u-1" } }),
      baseOp({ seq: 7, op: "set-initiative-owner", target: { type: "initiative", id: "in-1", identifier: "I" }, from: { ownerId: null }, to: { ownerId: "u-1" } }),
      baseOp({ seq: 8, op: "move-project-initiative", target: { type: "project", id: "p-1", identifier: "P" }, from: { initiativeIds: ["in-old"], initiativeId: "in-old" }, to: { fromInitiativeToProjectId: "in-old:p-1", fromInitiativeId: "in-old", toInitiativeId: "in-1" } }),
    ];
    be.projects.get("p-1")!.initiativeIds = ["in-old"];
    for (const n of [2, 3]) be.issues.set(`i-${n}`, { ...ISSUE_1, id: `i-${n}`, identifier: `EX-${n}`, labelIds: [...ISSUE_1.labelIds] });
    be.states.set("s-ready", { id: "s-ready", name: "Ready", type: "unstarted", archivedAt: null });
    be.projects.set("p-2", { id: "p-2", name: "P2", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1"], initiativeIds: [] });
    be.initiatives.set("in-2", { id: "in-2", name: "I2", archivedAt: null, ownerId: null });
    ops.push(
      baseOp({ seq: 9, op: "archive-project", target: { type: "project", id: "p-2", identifier: "P2" }, from: { archived: false, trashed: false }, to: { archived: true } }),
      baseOp({ seq: 10, op: "archive-initiative", target: { type: "initiative", id: "in-2", identifier: "I2" }, from: { archived: false }, to: { archived: true } }),
      baseOp({ seq: 11, phase: 2, op: "archive-state", reversible: false, approval: "deck-1", target: { type: "state", id: "s-ready", identifier: "EX/Ready" }, from: { archived: false }, to: { archived: true } }),
      baseOp({ seq: 12, op: "archive-issue", from: { archived: false }, to: { archived: true } }),
    );
    const batch = [2, 3].map((n) => baseOp({
      seq: 20 + n, op: "set-state", target: { type: "issue", id: `i-${n}`, identifier: `EX-${n}` },
      from: { stateId: "s-todo" }, to: { stateId: "s-done" }, batchKey: "b",
    }));
    const j = join(dir, "schema.jsonl");
    for (const op of ops) await applyPlan(be, [op], j + op.seq, { allowIrreversible: true });
    await applyPlan(be, batch, j + "batch");
    for (const name of [
      "issueBatchUpdate", "projectArchive", "initiativeArchive", "workflowStateArchive", "issueArchive",
      "projectStatusCreate", "issueLabelCreate", "issueUpdate", "issueLabelUpdate",
      "teamUpdate", "projectUpdate", "initiativeUpdate", "initiativeToProjectCreate",
    ])
      expect([...be.validatedMutations]).toContain(name);
  });

  test("create-project-status: creates, journals the id; rerun drift-aborts", async () => {
    const be = freshBackend();
    const op = baseOp({
      op: "create-project-status", target: { type: "project", id: "new:Paused", identifier: "Paused" },
      from: { statusId: null }, to: { name: "Paused", color: "#f59e0b", type: "started" },
    });
    const j = join(dir, "j.jsonl");
    const result = await applyPlan(be, [op], j);
    expect(result.applied).toBe(1);
    const created = [...be.projectStatuses.values()].find((s) => s.name === "Paused");
    expect(created).toBeDefined();
    expect(journalRead(j)[0].after).toMatchObject({ statusId: created!.id });
    const before = be.mutationCalls.length;
    await expect(applyPlan(be, [op], join(dir, "j2.jsonl"))).rejects.toBeInstanceOf(ReorgMismatch);
    expect(be.mutationCalls.length).toBe(before);
  });
});

describe("archive-state gating (bug fix)", () => {
  test("parsePlanFile rejects reversible:true archive-state", () => {
    const p = join(dir, "plan.jsonl");
    const op = baseOp({
      op: "archive-state", target: { type: "state", id: "s-1", identifier: "EX/Ready" },
      from: { archived: false }, to: { archived: true }, reversible: true,
    });
    writeFileSync(p, JSON.stringify({ _meta: planWith([]).meta }) + "\n" + JSON.stringify(op) + "\n");
    expect(() => parsePlanFile(p)).toThrow("never reversible");
  });

  test("phase-2 archive-state with approval runs only with --allow-irreversible", async () => {
    const be = freshBackend();
    be.states.set("s-ready", { id: "s-ready", name: "Ready", type: "unstarted", archivedAt: null });
    const op = baseOp({
      seq: 7, phase: 2, op: "archive-state", reversible: false, approval: "deck-1",
      target: { type: "state", id: "s-ready", identifier: "EX/Ready" },
      from: { archived: false }, to: { archived: true },
    });
    await expect(
      applyPlan(be, [op], join(dir, "j.jsonl"), { allowIrreversible: false }),
    ).rejects.toThrow("--allow-irreversible");
    const result = await applyPlan(be, [op], join(dir, "j2.jsonl"), { allowIrreversible: true });
    expect(result.applied).toBe(1);
    expect(be.states.get("s-ready")!.archivedAt).not.toBeNull();
  });

  test("phase-6-only enforcement for other irreversible forms is unchanged", () => {
    const p = join(dir, "plan.jsonl");
    const op = baseOp({
      seq: 8, phase: 2, op: "delete-team", reversible: false, approval: "deck-1",
      target: { type: "team", id: "t-9", identifier: "OLD" }, from: {}, to: {},
    });
    writeFileSync(p, JSON.stringify({ _meta: planWith([]).meta }) + "\n" + JSON.stringify(op) + "\n");
    expect(() => parsePlanFile(p)).toThrow("out of its allowed phase");
  });
});

describe("rename-label + cross-scope uniqueness (planner addition)", () => {
  test("rename-label triple: apply renames, verify green, rollback restores the name", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111010", { id: "11111111-1111-4111-8111-111111111010", name: "bug", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    const j = join(dir, "j.jsonl");
    const op = baseOp({
      op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111010", identifier: "EX/bug" },
      from: { name: "bug" }, to: { name: "bug·old-EX" },
    });
    await applyPlan(be, [op], j);
    expect(be.labels.get("11111111-1111-4111-8111-111111111010")!.name).toBe("bug·old-EX");
    const v = await verifyPhase(fakeClient(be), planWith([op]), 1, { journalPath: j, pace: fastPace() });
    expect(v.ok).toBe(true);
    const rb = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true });
    expect(rb.rolledBack).toBe(1);
    expect(be.labels.get("11111111-1111-4111-8111-111111111010")!.name).toBe("bug");
  });

  describe("rollback gate + planner-shaped rename journal", () => {
    // Planner-shaped row: `from` carries {retired} but NOT the old name; the old
    // name lives only in the journaled live read (`before`).
    function seedRename(be: FakeBackend, liveName: string): string {
      be.labels.set("11111111-1111-4111-8111-111111111010", { id: "11111111-1111-4111-8111-111111111010", name: liveName, retiredAt: null, teamId: "t-1", teamKey: "EX" });
      const j = join(dir, "rb.jsonl");
      journalAppend(j, {
        seq: 6, phase: 1, op: "rename-label", at: "t", ok: true,
        original: baseOp({
          seq: 6, op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111010", identifier: "EX/ci" },
          from: { retired: false }, to: { name: "ci·old-EX" },
        }),
        before: { retired: false, name: "ci" },
        after: { retired: false, name: "ci·old-EX" },
      });
      return j;
    }

    test("default is a dry-run: lists the inverse op, makes zero mutation calls", async () => {
      const be = freshBackend();
      const j = seedRename(be, "ci·old-EX");
      const events: string[] = [];
      const r = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), onEvent: (e) => events.push(e.detail) });
      expect(r.dryRun).toBe(true);
      expect(r.planned).toBe(1);
      expect(r.rolledBack).toBe(0);
      expect(be.mutationCalls).toEqual([]);
      expect(be.readCalls).toBe(0);
      expect(be.labels.get("11111111-1111-4111-8111-111111111010")!.name).toBe("ci·old-EX");
      expect(events[0]).toContain("would revert");
      expect(events[0]).toContain('"name":"ci"');
    });

    test("--apply restores the name when live equals the journaled after-state", async () => {
      const be = freshBackend();
      const j = seedRename(be, "ci·old-EX");
      const r = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true });
      expect(r.rolledBack).toBe(1);
      expect(be.labels.get("11111111-1111-4111-8111-111111111010")!.name).toBe("ci");
    });

    test("real drift fails, names field + both values, and writes nothing", async () => {
      const be = freshBackend();
      const j = seedRename(be, "someone-renamed-it");
      let err: unknown;
      try {
        await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ReorgMismatch);
      const m = err as ReorgMismatch;
      expect(m.diff.expected).toEqual({ name: "ci·old-EX" });
      expect(m.diff.actual).toEqual({ name: "someone-renamed-it" });
      expect(m.message).toContain("ci·old-EX");
      expect(m.message).toContain("someone-renamed-it");
      expect(be.mutationCalls).toEqual([]);
      expect(be.labels.get("11111111-1111-4111-8111-111111111010")!.name).toBe("someone-renamed-it");
    });

    test("--check reports drift without writing", async () => {
      const be = freshBackend();
      const j = seedRename(be, "someone-renamed-it");
      const r = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), check: true });
      expect(r.dryRun).toBe(true);
      expect(r.drifted).toHaveLength(1);
      expect(r.drifted[0]).toContain("name");
      expect(r.drifted[0]).toContain("someone-renamed-it");
      expect(be.mutationCalls).toEqual([]);
      expect(be.readCalls).toBeGreaterThan(0);
    });

    test("refuses before any write when neither plan nor journal recorded the needed field", async () => {
      const be = freshBackend();
      be.labels.set("11111111-1111-4111-8111-111111111010", { id: "11111111-1111-4111-8111-111111111010", name: "ci·old-EX", retiredAt: null, teamId: "t-1", teamKey: "EX" });
      const j = join(dir, "nofield.jsonl");
      journalAppend(j, {
        seq: 6, phase: 1, op: "rename-label", at: "t", ok: true,
        original: baseOp({
          seq: 6, op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111010", identifier: "EX/ci" },
          from: { retired: false }, to: { name: "ci·old-EX" },
        }),
        before: { retired: false },
        after: { retired: false, name: "ci·old-EX" },
      });
      for (const mode of [{ apply: true }, { check: true }, {}]) {
        let err: unknown;
        try {
          await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), ...mode });
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(RollbackRefused);
        expect((err as RollbackRefused).message).toContain("seq 6");
        expect((err as RollbackRefused).message).toContain('"name"');
        expect((err as RollbackRefused).message).toContain("neither the plan nor the journal");
      }
      expect(be.mutationCalls).toEqual([]);
      expect(be.labels.get("11111111-1111-4111-8111-111111111010")!.name).toBe("ci·old-EX");
    });

    test("an unreadable target is drift under --check and refused before any write under --apply", async () => {
      const be = freshBackend();
      const j = seedRename(be, "ci·old-EX");
      be.labels.delete("11111111-1111-4111-8111-111111111010");
      const chk = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), check: true });
      expect(chk.drifted).toHaveLength(1);
      expect(chk.drifted[0]).toContain("unreadable");
      expect(be.mutationCalls).toEqual([]);
      let err: unknown;
      try {
        await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RollbackRefused);
      expect((err as RollbackRefused).message).toContain("could not be read");
      expect(be.mutationCalls).toEqual([]);
    });

    test("--apply reads every target first: an unreadable second-processed target means zero writes", async () => {
      const be = freshBackend();
      be.labels.set("11111111-1111-4111-8111-11111111110a", { id: "11111111-1111-4111-8111-11111111110a", name: "a·old-EX", retiredAt: null, teamId: "t-1", teamKey: "EX" });
      const j = join(dir, "two.jsonl");
      // seq 2 is processed first (reverse order); seq 1's label does not exist
      for (const [seq, id, name] of [[1, "11111111-1111-4111-8111-111111111060", "g"], [2, "11111111-1111-4111-8111-11111111110a", "a"]] as const) {
        journalAppend(j, {
          seq, phase: 1, op: "rename-label", at: "t", ok: true,
          original: baseOp({
            seq, op: "rename-label", target: { type: "label", id, identifier: `EX/${name}` },
            from: { retired: false }, to: { name: `${name}·old-EX` },
          }),
          before: { retired: false, name },
          after: { retired: false, name: `${name}·old-EX` },
        });
      }
      let err: unknown;
      try {
        await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RollbackRefused);
      expect((err as RollbackRefused).message).toContain("seq 1");
      expect(be.mutationCalls).toEqual([]);
      expect(be.labels.get("11111111-1111-4111-8111-11111111110a")!.name).toBe("a·old-EX");
    });

    test("--check on a clean journal reports no drift", async () => {
      const be = freshBackend();
      const j = seedRename(be, "ci·old-EX");
      const r = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), check: true });
      expect(r.drifted).toEqual([]);
      expect(be.mutationCalls).toEqual([]);
    });
  });

  test("the fake enforces cross-scope uniqueness like Linear (create fails on any copy)", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111010", { id: "11111111-1111-4111-8111-111111111010", name: "bug", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    await expect(applyPlan(be, [baseOp({
      op: "create-workspace-label", target: { type: "label", id: "new:bug", identifier: "bug" },
      from: { labelId: null }, to: { name: "bug" },
    })], join(dir, "j.jsonl"))).rejects.toThrow("Duplicate label name");
  });

  test("--check flags the name conflict as drift; a planned rename clears it", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111010", { id: "11111111-1111-4111-8111-111111111010", name: "bug", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    const create = baseOp({
      seq: 2, op: "create-workspace-label", target: { type: "label", id: "new:bug", identifier: "bug" },
      from: { labelId: null }, to: { name: "bug" },
    });
    const conflicted = await runPlan(fakeClient(be), planWith([create]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
    });
    expect(conflicted.drifted).toContain(2);

    const rename = baseOp({
      seq: 1, op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111010", identifier: "EX/bug" },
      from: { name: "bug" }, to: { name: "bug·old-EX" },
    });
    const cleared = await runPlan(fakeClient(be), planWith([rename, create]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j2.jsonl"), pace: fastPace(),
    });
    expect(cleared.drifted).toEqual([]);
  });
});

describe("round-1 review test pins", () => {
  test("labelRef prefers the journal-created id over a live same-name label", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["11111111-1111-4111-8111-11111111110a"] });
    be.labels.set("11111111-1111-4111-8111-1111111110e2", { id: "11111111-1111-4111-8111-1111111110e2", name: "bug", retiredAt: null, teamId: null, teamKey: null });
    const j = join(dir, "j.jsonl");
    // a create landed earlier in THIS plan (journal carries the created id)
    journalAppend(j, {
      seq: 1, phase: 1, op: "create-workspace-label", at: "a", ok: true,
      original: baseOp({
        seq: 1, op: "create-workspace-label",
        target: { type: "label", id: "new:bug", identifier: "bug" },
        from: { labelId: null }, to: { name: "bug", labelId: "11111111-1111-4111-8111-1111111110e1" },
      }),
    });
    const result = await applyPlan(be, [baseOp({
      seq: 2, op: "relabel", from: { labelIds: ["11111111-1111-4111-8111-11111111110a"] }, to: { add: ["name:bug"], remove: [] },
    })], j);
    expect(result.applied).toBe(1);
    expect(be.issues.get("i-1")!.labelIds).toContain("11111111-1111-4111-8111-1111111110e1");
    expect(be.issues.get("i-1")!.labelIds).not.toContain("11111111-1111-4111-8111-1111111110e2");
  });

  test("rename-label drift anchor: refuses when the live name differs from from.name", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111010", { id: "11111111-1111-4111-8111-111111111010", name: "renamed-elsewhere", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    await expect(applyPlan(be, [baseOp({
      op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111010", identifier: "EX/bug" },
      from: { name: "bug" }, to: { name: "bug·old-EX" },
    })], join(dir, "j.jsonl"))).rejects.toBeInstanceOf(ReorgMismatch);
    expect(be.mutationCalls).toEqual([]);
  });

  test("remove-project-team reads membership LIVE at apply (a post-drift addition survives)", async () => {
    const be = freshBackend();
    be.projects.set("p-1", { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1", "t-2"], initiativeIds: [] });
    // after the drift pre-read, t-4 joins the project (a teammate's action);
    // the apply-time live read must see it and keep it
    let reads = 0;
    be.projectReadHook = (id) => {
      if (id === "p-1" && ++reads === 1)
        be.projects.get("p-1")!.teamIds = ["t-1", "t-2", "t-4"];
    };
    const op = baseOp({
      op: "remove-project-team", target: { type: "project", id: "p-1", identifier: "P" },
      from: { teamIds: ["t-1", "t-2"] }, to: { teamId: "t-2" },
    });
    const result = await applyPlan(be, [op], join(dir, "j.jsonl"));
    expect(result.applied).toBe(1);
    expect(be.projects.get("p-1")!.teamIds).toEqual(["t-1", "t-4"]); // t-2 out, t-4 kept
  });

  test("swallowed set-initiative-owner write fails via expectedPost", async () => {
    const be = freshBackend();
    be.swallowWrites = true;
    be.initiatives.set("in-1", { id: "in-1", name: "I", archivedAt: null, ownerId: null });
    await expect(applyPlan(be, [baseOp({
      op: "set-initiative-owner", target: { type: "initiative", id: "in-1", identifier: "I" },
      from: { ownerId: null }, to: { ownerId: "u-9" },
    })], join(dir, "j.jsonl"))).rejects.toBeInstanceOf(ReorgMismatch);
  });
});

describe("inherited labels (CER-2353)", () => {
  const OWNER = { id: "11111111-1111-4111-8111-111111111001", name: "security", retiredAt: null, teamId: "t-1", teamKey: "EX" };
  const CHILD = { id: "11111111-1111-4111-8111-111111111002", name: "security", retiredAt: null, teamId: "t-sub", teamKey: "SUB", inheritedFrom: "11111111-1111-4111-8111-111111111001" };

  test("fake models Linear: a write to an inherited label is refused (guard first, API as backstop)", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { ...OWNER });
    be.labels.set("11111111-1111-4111-8111-111111111002", { ...CHILD });
    // a direct executor path (drift passes: name matches) — the API refusal is the backstop
    const op = baseOp({
      op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111002", identifier: "SUB/security" },
      from: { name: "security" }, to: { name: "security·old-SUB" },
    });
    await expect(applyPlan(be, [op], join(dir, "j.jsonl"))).rejects.toThrow(/inherited label/i);
    expect(be.mutationCalls).toEqual([]);
  });

  test("apply refuses an inherited target BEFORE any write (executor guard)", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { ...OWNER });
    be.labels.set("11111111-1111-4111-8111-111111111002", { ...CHILD });
    const op = baseOp({
      op: "retire-or-delete-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111002", identifier: "SUB/security" },
      from: { retired: false }, to: { retired: true },
    });
    await expect(applyPlan(be, [op], join(dir, "j.jsonl"))).rejects.toThrow(/inherited label.*target the owner/s);
    expect(be.mutationCalls).toEqual([]);
  });

  test("--check flags an inherited target as drift", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { ...OWNER });
    be.labels.set("11111111-1111-4111-8111-111111111002", { ...CHILD });
    const op = baseOp({
      op: "retire-or-delete-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111002", identifier: "SUB/security" },
      from: { retired: false }, to: { retired: true },
    });
    const result = await runPlan(fakeClient(be), planWith([op]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
    });
    expect(result.drifted).toEqual([1]);
    expect(be.mutationCalls).toEqual([]);
  });

  test("parent rename propagates to the child's reflected name", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { ...OWNER });
    be.labels.set("11111111-1111-4111-8111-111111111002", { ...CHILD });
    await applyPlan(be, [baseOp({
      op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111001", identifier: "EX/security" },
      from: { name: "security" }, to: { name: "security·old-EX" },
    })], join(dir, "j.jsonl"));
    // child reads now reflect the parent's new name (Linear propagation)
    expect(labelName(be, be.labels.get("11111111-1111-4111-8111-111111111002")!)).toBe("security·old-EX");
  });
  test("relabel removes the CHILD id from a sub-team issue and adds the workspace label", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { ...OWNER });
    be.labels.set("11111111-1111-4111-8111-111111111002", { ...CHILD });
    be.labels.set("11111111-1111-4111-8111-1111111110c5", { id: "11111111-1111-4111-8111-1111111110c5", name: "security", retiredAt: null, teamId: null, teamKey: null });
    be.issues.set("i-sub", { ...ISSUE_1, id: "i-sub", identifier: "SUB-1", teamId: "t-sub", teamKey: "SUB", labelIds: ["11111111-1111-4111-8111-111111111002"] });
    const op = baseOp({
      op: "relabel", target: { type: "issue", id: "i-sub", identifier: "SUB-1" },
      from: { labelIds: ["11111111-1111-4111-8111-111111111002"] }, to: { add: ["11111111-1111-4111-8111-1111111110c5"], remove: ["11111111-1111-4111-8111-111111111002"] },
    });
    const j = join(dir, "j.jsonl");
    const result = await applyPlan(be, [op], j);
    expect(result.applied).toBe(1);
    expect(be.issues.get("i-sub")!.labelIds).toEqual(["11111111-1111-4111-8111-1111111110c5"]);
    // the written-labels guard let a child-id REMOVE through (only adds are refused)
    expect(be.mutationCalls).toEqual(["issueUpdate"]);
    const v = await verifyPhase(fakeClient(be), planWith([op]), 1, { journalPath: j, pace: fastPace() });
    expect(v.ok).toBe(true);
  });

  test("retiring an owner hides its inherited views (child reads retired)", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { ...OWNER });
    be.labels.set("11111111-1111-4111-8111-111111111002", { ...CHILD });
    await applyPlan(be, [baseOp({
      op: "retire-or-delete-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111001", identifier: "EX/security" },
      from: { retired: false }, to: { retired: true },
    })], join(dir, "j.jsonl"));
    expect(labelRetired(be, be.labels.get("11111111-1111-4111-8111-111111111002")!)).not.toBeNull();
  });
});

describe("from-completeness invariant", () => {
  test("fails when a to-changed field has no from counterpart (rename-label without from.name)", () => {
    const bad = baseOp({
      op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111101", identifier: "EX/x" },
      from: { retired: false }, to: { name: "y" }, // from.name missing
    });
    expect(() => assertFromAnchors([bad])).toThrow(/from is missing name/);
    const good = baseOp({
      op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111101", identifier: "EX/x" },
      from: { retired: false, name: "x", inheritedFromId: null }, to: { name: "y" },
    });
    expect(() => assertFromAnchors([good])).not.toThrow();
  });
});

describe("census capture (CER-2353 round 1)", () => {
  /** Minimal census stub: one page per connection, canned rows. Records queries. */
  function censusStub(seen: string[]): LinearClient {
    const rawRequest = async (query: string) => {
      seen.push(query);
      const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
      if (query.includes("ReorgCensusTeams"))
        return { data: { teams: page([{ id: "t-ex", key: "EX", name: "Example", triageEnabled: false, private: false, archivedAt: null, issueCount: 2, parent: { id: "t-parent", key: "PAR" }, states: page([
          { id: "s-owner", name: "Review", type: "started", position: 1, archivedAt: null, inheritedFrom: null },
          { id: "s-view", name: "Review", type: "started", position: 1, archivedAt: null, inheritedFrom: { id: "s-owner" } },
        ]) }]) } };
      if (query.includes("ReorgCensusLabels"))
        return { data: { issueLabels: page([
          { id: "11111111-1111-4111-8111-111111111001", name: "security", retiredAt: null, team: { id: "t-par", key: "PAR" }, inheritedFrom: null },
          { id: "11111111-1111-4111-8111-111111111002", name: "security", retiredAt: null, team: { id: "t-ex", key: "EX" }, inheritedFrom: { id: "11111111-1111-4111-8111-111111111001" } },
        ]) } };
      if (query.includes("ReorgCensusIssues")) return { data: { issues: page([]) } };
      if (query.includes("ReorgCensusProjects")) return { data: { projects: page([]) } };
      if (query.includes("ReorgCensusInitiatives")) return { data: { initiatives: page([]) } };
      if (query.includes("ReorgOrg")) return { data: { organization: { id: "w", urlKey: "toy" } } };
      throw new Error("unhandled " + query.slice(0, 60));
    };
    return { client: { rawRequest } } as unknown as LinearClient;
  }

  test("a team with no boolean private flag fails the census", async () => {
    const stub = {
      client: {
        rawRequest: async (query: string) => {
          if (query.includes("ReorgCensusTeams"))
            return { data: { teams: { nodes: [{ id: "t-x", key: "XXX", name: "X", private: null, states: { nodes: [] } }], pageInfo: { hasNextPage: false, endCursor: null } } } };
          throw new Error("unexpected " + query.slice(0, 40));
        },
      },
    } as unknown as LinearClient;
    await expect(census(stub, {}, fastPace())).rejects.toThrow("no boolean private flag");
  });

  test("a stuck members cursor fails the census", async () => {
    const stub = {
      client: {
        rawRequest: async (query: string) => {
          if (query.includes("ReorgCensusTeams"))
            return { data: { teams: { nodes: [{ id: "t-x", key: "XXX", name: "X", private: true, states: { nodes: [] } }], pageInfo: { hasNextPage: false, endCursor: null } } } };
          if (query.includes("ReorgTeamMembers"))
            return { data: { team: { members: { nodes: [{ id: "u" }], pageInfo: { hasNextPage: true, endCursor: "same" } } } } };
          throw new Error("unexpected " + query.slice(0, 40));
        },
      },
    } as unknown as LinearClient;
    await expect(census(stub, {}, fastPace())).rejects.toThrow("did not advance");
  });

  test("records Team.private, and the members of private teams only", async () => {
    const seen: string[] = [];
    const base = censusStub(seen);
    const stub = {
      client: {
        rawRequest: async (query: string, vars: Record<string, unknown>) => {
          if (query.includes("ReorgCensusTeams")) seen.push(query);
          if (query.includes("ReorgCensusTeams"))
            return { data: { teams: { nodes: [
              { id: "t-pub", key: "PUB", name: "P", private: false, states: { nodes: [] } },
              { id: "t-priv", key: "PRV", name: "Q", private: true, states: { nodes: [] } },
            ], pageInfo: { hasNextPage: false, endCursor: null } } } };
          if (query.includes("ReorgTeamMembers"))
            return { data: { team: { members: { nodes: vars.id === "t-priv" ? [{ id: "u2" }, { id: "u1" }] : [], pageInfo: { hasNextPage: false, endCursor: null } } } } };
          return (base as unknown as { client: { rawRequest: (q: string) => Promise<unknown> } }).client.rawRequest(query);
        },
      },
    } as unknown as LinearClient;
    const d = await census(stub, {}, fastPace());
    expect(d.teams.map((t) => [t.key, t.private, t.memberIds])).toEqual([["PUB", false, undefined], ["PRV", true, ["u1", "u2"]]]);
    expect(seen.find((q) => q.includes("ReorgCensusTeams"))).toContain("private");
  });

  test("captures inheritedFrom on labels and parent on teams", async () => {
    const seen: string[] = [];
    const d = await census(censusStub(seen), {}, fastPace());
    expect(d.teams[0].parent).toEqual({ id: "t-parent", key: "PAR" });
    const child = d.teamLabels.find((l) => l.id === "11111111-1111-4111-8111-111111111002");
    expect(child?.inheritedFromId).toBe("11111111-1111-4111-8111-111111111001");
    // the QUERY TEXT asks for the fields (a dropped selection would pass silently)
    expect(seen.find((q) => q.includes("ReorgCensusTeams"))).toContain("parent { id key }");
    expect(seen.find((q) => q.includes("ReorgCensusLabels"))).toContain("inheritedFrom { id }");
  });

  test("captures inheritedFrom on workflow states (CER-2390)", async () => {
    const seen: string[] = [];
    const d = await census(censusStub(seen), {}, fastPace());
    const states = d.teams[0].states?.nodes ?? [];
    expect(states.find((s) => s.id === "s-view")?.inheritedFrom?.id).toBe("s-owner");
    expect(states.find((s) => s.id === "s-owner")?.inheritedFrom ?? null).toBeNull();
    const q = seen.find((x) => x.includes("ReorgCensusTeams")) ?? "";
    expect(q).toContain("position archivedAt inheritedFrom { id }");
  });

  test("--team scope still includes the owners of in-scope inherited labels", async () => {
    // EX has the inherited child; its owner sits in PAR (outside the filter)
    const d = await census(censusStub([]), { teamKeys: ["EX"] }, fastPace());
    const ids = d.teamLabels.map((l) => l.id).sort();
    expect(ids).toEqual(["11111111-1111-4111-8111-111111111002", "11111111-1111-4111-8111-111111111001"].sort());
  });
});

describe("check-mode ref handling (found by the v4 phase-1 check)", () => {
  test("a name: ref in to.add does NOT trip the inherited-write guard in --check", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["11111111-1111-4111-8111-11111111110a"] });
    const result = await runPlan(fakeClient(be), planWith([baseOp({
      op: "relabel", from: { labelIds: ["11111111-1111-4111-8111-11111111110a"] }, to: { add: ["name:security"], remove: [] },
    })]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
    });
    // refs resolve workspace-scoped only; nothing inherited can arrive via name:
    expect(result.drifted).toEqual([]);
  });

  test("create preflight excludes inherited children of renamed owners (rename propagates)", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { id: "11111111-1111-4111-8111-111111111001", name: "security", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    // the inherited views still hold the name until the owner rename propagates
    be.labels.set("11111111-1111-4111-8111-1111111110c1", { id: "11111111-1111-4111-8111-1111111110c1", name: "security", retiredAt: null, teamId: "t-sub", teamKey: "SUB", inheritedFrom: "11111111-1111-4111-8111-111111111001" });
    be.labels.set("11111111-1111-4111-8111-1111111110c2", { id: "11111111-1111-4111-8111-1111111110c2", name: "security", retiredAt: null, teamId: "t-sub2", teamKey: "SB2", inheritedFrom: "11111111-1111-4111-8111-111111111001" });
    const rename = baseOp({
      seq: 1, op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111001", identifier: "EX/security" },
      from: { name: "security", retired: false }, to: { name: "security·old-EX" },
    });
    const create = baseOp({
      seq: 2, op: "create-workspace-label", target: { type: "label", id: "new:security", identifier: "security" },
      from: { labelId: null }, to: { name: "security" },
    });
    const result = await runPlan(fakeClient(be), planWith([rename, create]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
    });
    expect(result.drifted).toEqual([]); // children of the renamed owner are not conflicts
  });

  test("negative: an owner NOT renamed in the plan leaves its child flagging the create", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { id: "11111111-1111-4111-8111-111111111001", name: "security", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    be.labels.set("11111111-1111-4111-8111-1111111110c1", { id: "11111111-1111-4111-8111-1111111110c1", name: "security", retiredAt: null, teamId: "t-sub", teamKey: "SUB", inheritedFrom: "11111111-1111-4111-8111-111111111001" });
    const create = baseOp({
      seq: 2, op: "create-workspace-label", target: { type: "label", id: "new:security", identifier: "security" },
      from: { labelId: null }, to: { name: "security" },
    });
    const events: string[] = [];
    const result = await runPlan(fakeClient(be), planWith([create]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
      onEvent: (e) => events.push(e.detail),
    });
    expect(result.drifted).toContain(2);
    // the conflict detail must NAME the child id — an over-broad exclusion
    // (drop any inherited label) would leave only the owner listed
    const line = events.find((d) => d.includes("DRIFT seq 2"));
    expect(line).toBeDefined();
    expect(line).toContain("11111111-1111-4111-8111-1111111110c1");
  });

  test("case-insensitive preflight: TOD 'Security' blocks the 'security' create (red when case-sensitive)", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { id: "11111111-1111-4111-8111-111111111001", name: "Security", retiredAt: null, teamId: "t-1", teamKey: "TOD" });
    const create = baseOp({
      seq: 2, op: "create-workspace-label", target: { type: "label", id: "new:security", identifier: "security" },
      from: { labelId: null }, to: { name: "security" },
    });
    const result = await runPlan(fakeClient(be), planWith([create]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
    });
    expect(result.drifted).toContain(2); // Linear's uniqueness is case-insensitive
  });

  test("apply refusal on a case-variant names the case-insensitivity in the error", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { id: "11111111-1111-4111-8111-111111111001", name: "Security", retiredAt: null, teamId: "t-1", teamKey: "TOD" });
    await expect(applyPlan(be, [baseOp({
      op: "create-workspace-label", target: { type: "label", id: "new:security", identifier: "security" },
      from: { labelId: null }, to: { name: "security" },
    })], join(dir, "j.jsonl"))).rejects.toThrow(/case-insensitive/);
    // The refusal names BOTH spellings (critic round 1).
    await expect(applyPlan(be, [baseOp({
      op: "create-workspace-label", target: { type: "label", id: "new:security", identifier: "security" },
      from: { labelId: null }, to: { name: "security" },
    })], join(dir, "j.jsonl"))).rejects.toThrow(/"Security"/);
  });

  test("apply refusal survives a failing conflict re-read", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { id: "11111111-1111-4111-8111-111111111001", name: "Security", retiredAt: null, teamId: "t-1", teamKey: "TOD" });
    be.failLabelsByNameCI = true;
    const err = await applyPlan(be, [baseOp({
      op: "create-workspace-label", target: { type: "label", id: "new:security", identifier: "security" },
      from: { labelId: null }, to: { name: "security" },
    })], join(dir, "j.jsonl")).catch((e) => e);
    expect(String(err)).toContain("refused by Linear");
    expect(String(err)).toContain("already exists"); // Linear's original text survives
    expect(String(err)).toContain('"security"'); // the requested name is named
    expect(String(err)).not.toContain("conflict re-read exploded");
  });

  test("absence anchor is case-insensitive: workspace 'Security' is found for a 'security' create", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111002", { id: "11111111-1111-4111-8111-111111111002", name: "Security", retiredAt: null, teamId: null, teamKey: null });
    const op = baseOp({
      op: "create-workspace-label", target: { type: "label", id: "new:security", identifier: "security" },
      from: { labelId: null }, to: { name: "security" },
    });
    // readState runs FIND_WS_LABEL_Q: red when that query reverts to eq
    // (the fake honours the comparator the query carries).
    const state = await OP_REGISTRY["create-workspace-label"].readState(
      { client: fakeClient(be), pace: fastPace() }, op,
    );
    expect(state.labelId).toBe("11111111-1111-4111-8111-111111111002");
  });

  test("a HIGHER-seq rename does not free the name", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { id: "11111111-1111-4111-8111-111111111001", name: "Security", retiredAt: null, teamId: "t-1", teamKey: "TOD" });
    const create = baseOp({
      seq: 2, op: "create-workspace-label", target: { type: "label", id: "new:security", identifier: "security" },
      from: { labelId: null }, to: { name: "security" },
    });
    const lateRename = baseOp({
      seq: 5, op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111001", identifier: "TOD/Security" },
      from: { name: "Security" }, to: { name: "blocking" },
    });
    const result = await runPlan(fakeClient(be), planWith([create, lateRename]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
    });
    expect(result.drifted).toContain(2);
  });

  test("a lower-seq rename to a CASE-VARIANT of the same name does not free it", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { id: "11111111-1111-4111-8111-111111111001", name: "Security", retiredAt: null, teamId: "t-1", teamKey: "TOD" });
    const rename = baseOp({
      seq: 1, op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111001", identifier: "TOD/Security" },
      from: { name: "Security" }, to: { name: "SECURITY" },
    });
    const create = baseOp({
      seq: 2, op: "create-workspace-label", target: { type: "label", id: "new:security", identifier: "security" },
      from: { labelId: null }, to: { name: "security" },
    });
    const result = await runPlan(fakeClient(be), planWith([rename, create]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
    });
    expect(result.drifted).toContain(2);
  });

  test("a lower-seq rename to a DIFFERENT name frees it", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { id: "11111111-1111-4111-8111-111111111001", name: "Security", retiredAt: null, teamId: "t-1", teamKey: "TOD" });
    const rename = baseOp({
      seq: 1, op: "rename-label", target: { type: "label", id: "11111111-1111-4111-8111-111111111001", identifier: "TOD/Security" },
      from: { name: "Security" }, to: { name: "blocking" },
    });
    const create = baseOp({
      seq: 2, op: "create-workspace-label", target: { type: "label", id: "new:security", identifier: "security" },
      from: { labelId: null }, to: { name: "security" },
    });
    const result = await runPlan(fakeClient(be), planWith([rename, create]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
    });
    expect(result.drifted).not.toContain(2);
  });
});

describe("written-label guard + team-aware child mapping (round 1)", () => {
  test("relabel ADDING an inherited child id is refused before the write", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { id: "11111111-1111-4111-8111-111111111001", name: "security", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    be.labels.set("11111111-1111-4111-8111-111111111002", { id: "11111111-1111-4111-8111-111111111002", name: "security", retiredAt: null, teamId: "t-sub", teamKey: "SUB", inheritedFrom: "11111111-1111-4111-8111-111111111001" });
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["11111111-1111-4111-8111-11111111110a"] });
    await expect(applyPlan(be, [baseOp({
      op: "relabel", from: { labelIds: ["11111111-1111-4111-8111-11111111110a"] }, to: { add: ["11111111-1111-4111-8111-111111111002"], remove: [] },
    })], join(dir, "j.jsonl"))).rejects.toThrow(/write inherited label/);
    expect(be.mutationCalls).toEqual([]);
  });

  test("--check reports an add of an inherited child id as a refusal (no write)", async () => {
    const be = freshBackend();
    be.labels.set("11111111-1111-4111-8111-111111111001", { id: "11111111-1111-4111-8111-111111111001", name: "security", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    be.labels.set("11111111-1111-4111-8111-111111111002", { id: "11111111-1111-4111-8111-111111111002", name: "security", retiredAt: null, teamId: "t-sub", teamKey: "SUB", inheritedFrom: "11111111-1111-4111-8111-111111111001" });
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["11111111-1111-4111-8111-11111111110a"] });
    const result = await runPlan(fakeClient(be), planWith([baseOp({
      op: "relabel", from: { labelIds: ["11111111-1111-4111-8111-11111111110a"] }, to: { add: ["11111111-1111-4111-8111-111111111002"], remove: [] },
    })]), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(),
    });
    // a precondition refusal (apply would throw), not drift
    expect(result.drifted).toEqual([]);
    expect(result.refused).toEqual([1]);
    expect(be.mutationCalls).toEqual([]);
  });
});

describe("--check and name: label refs (CER-2387)", () => {
  const LA = "11111111-1111-4111-8111-11111111110a";
  const LX = "11111111-1111-4111-8111-1111111110c5";
  const checkOpts = (onEvent: (e: { kind: string; detail: string }) => void) => ({
    check: true, apply: false, resume: false, allowIrreversible: false,
    journalPath: join(dir, "j.jsonl"), pace: fastPace(), onEvent,
  });
  const relabel = () => baseOp({
    seq: 2, op: "relabel", from: { labelIds: [LA] }, to: { add: ["name:fresh"], remove: [LA] },
  });

  test("target already in the end state via a name: add is 'already applied', not drift", async () => {
    const be = freshBackend();
    be.labels.set(LX, { id: LX, name: "fresh", retiredAt: null, teamId: null, teamKey: null });
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [LX] });
    const lines: string[] = [];
    const r = await runPlan(fakeClient(be), planWith([relabel()]), checkOpts((e) => lines.push(e.detail)));
    expect(r.drifted).toEqual([]);
    expect(lines.some((l) => l.includes("already applied seq 2"))).toBe(true);
  });

  test("name: ref whose create is planned at a lower seq and has not run is drift, with that stated", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [LX] }); // differs from `from`, so the ref is resolved
    const create = baseOp({
      seq: 1, op: "create-workspace-label", target: { type: "label", id: "new:fresh", identifier: "fresh" },
      from: { labelId: null }, to: { name: "fresh", color: "#e5484d" },
    });
    const lines: string[] = [];
    const r = await runPlan(fakeClient(be), planWith([create, relabel()]), checkOpts((e) => lines.push(e.detail)));
    expect(r.drifted).toContain(2);
    expect(lines.some((l) => l.includes("DRIFT seq 2") && l.includes("planned create-workspace-label at seq 1 has not run yet"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------

describe("pacing", () => {
  test("TokenBucket sleeps when empty", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const bucket = new TokenBucket(0.001, 1, () => now, async (ms) => { sleeps.push(ms); now += ms; });
    await bucket.acquire();
    await bucket.acquire();
    expect(sleeps.length).toBeGreaterThan(0);
  });

  test("RateTracker sleeps to reset under 10% remaining", async () => {
    const now0 = 1_000_000;
    let now = now0;
    const sleeps: number[] = [];
    const tracker = new RateTracker(() => now, async (ms) => { sleeps.push(ms); now += ms; });
    tracker.recordHeaders(new Headers({
      "x-ratelimit-requests-limit": "2500",
      "x-ratelimit-requests-remaining": "100",
      "x-ratelimit-requests-reset": String(now0 + 60_000),
    }));
    await tracker.throttleIfLow();
    expect(sleeps[0]).toBe(61_000);
  });

  test("estimateRequests: 3/op solo, batching amortizes the verify read", () => {
    expect(estimateRequests([baseOp({})])).toBe(3);
    const batched = [0, 1, 2, 3].map((n) => baseOp({ seq: n + 1, batchKey: "k" }));
    expect(estimateRequests(batched)).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// move preconditions (sync-level assertions retained for the journal parts)
// ---------------------------------------------------------------------------

describe("assertMovePreconditions (journal-level)", () => {
  const ctx = { client: fakeClient(freshBackend()), pace: fastPace() };
  const move = baseOp({
    seq: 5, op: "move-issue-team",
    from: { teamId: "t-1", projectId: "p-1", cycleId: null, labelIds: [] },
    to: { teamId: "t-2", reapplyLabelIds: [] },
  });
  test("missing phase markers fail fast", async () => {
    await expect(assertMovePreconditions(ctx, move, [])).rejects.toThrow("phase-1 verify");
    const j1: JournalRecord[] = [{ seq: "verify", phase: 1, at: "a", ok: true }];
    await expect(assertMovePreconditions(ctx, move, j1)).rejects.toThrow("phase-2 verify");
  });
});

// ---------------------------------------------------------------------------
// Read-after-write lag + already-applied detection
// ---------------------------------------------------------------------------

describe("verify retry and already-applied", () => {
  const LA = "11111111-1111-4111-8111-11111111110a";
  const LB = "11111111-1111-4111-8111-11111111110b";
  const LC = "11111111-1111-4111-8111-1111111110c5";

  function relabelBackend(labelIds = [LA, LB]): FakeBackend {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [...labelIds] });
    be.labels.set(LA, { id: LA, name: "a", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    be.labels.set(LB, { id: LB, name: "b", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    be.labels.set(LC, { id: LC, name: "bug", retiredAt: null, teamId: null, teamKey: null });
    return be;
  }
  const relabelOp = () =>
    baseOp({
      op: "relabel",
      from: { labelIds: [LA, LB] },
      to: { add: [LC], remove: [LA] },
    });

  /** A client whose issue reads keep returning the pre-write state for the
   *  next `lag` reads after any mutation. */
  function lagClient(be: FakeBackend, lag: number): LinearClient {
    const inner = (fakeClient(be) as unknown as {
      client: { rawRequest: (q: string, v: Record<string, unknown>) => Promise<unknown> };
    }).client;
    let snapshot: FakeIssue | null = null;
    let left = 0;
    const rawRequest = async (q: string, v: Record<string, unknown>) => {
      if (q.includes("ReorgIssueState") && left > 0 && snapshot) {
        left--;
        const live = be.issues.get(snapshot.id)!;
        be.issues.set(snapshot.id, snapshot);
        try {
          return await inner.rawRequest(q, v);
        } finally {
          be.issues.set(snapshot.id, live);
        }
      }
      if (!q.includes("Reorg") || q.includes("mutation")) {
        const before = be.mutationCalls.length;
        const i = be.issues.get("i-1");
        const snap = i ? { ...i, labelIds: [...i.labelIds] } : null;
        const r = await inner.rawRequest(q, v);
        if (be.mutationCalls.length > before) {
          snapshot = snap;
          left = lag;
        }
        return r;
      }
      return inner.rawRequest(q, v);
    };
    return { client: { rawRequest } } as unknown as LinearClient;
  }

  const noSleep = { verifyDelaysMs: [1, 2, 4, 8], sleep: async () => {} };
  const run = (client: LinearClient, ops: ReorgOp[], j: string, extra: Partial<Parameters<typeof runPlan>[2]> = {}) =>
    runPlan(client, planWith(ops), {
      apply: true, resume: false, allowIrreversible: false,
      journalPath: j, backupRecordPath: freshBackup(), pace: fastPace(), ...noSleep, ...extra,
    });

  test("(a) a stale first post-write read is retried and the op journals ok", async () => {
    const be = relabelBackend();
    const j = join(dir, "j.jsonl");
    const events: string[] = [];
    const r = await run(lagClient(be, 1), [relabelOp()], j, { onEvent: (e) => events.push(e.kind) });
    expect(r.applied).toBe(1);
    expect(events).toContain("verify-retry");
    const rows = journalRead(j);
    expect(rows.map((x) => x.ok)).toEqual([true]);
    expect(rows[0].alreadyApplied).toBeUndefined();
  });

  test("(b) a write that is never reflected mismatches after the configured retries; nothing journals ok", async () => {
    const be = relabelBackend();
    const j = join(dir, "j.jsonl");
    const sleeps: number[] = [];
    await expect(
      run(lagClient(be, 99), [relabelOp()], j, { sleep: async (ms) => { sleeps.push(ms); } }),
    ).rejects.toBeInstanceOf(ReorgMismatch);
    expect(sleeps).toEqual([1, 2, 4, 8]);
    expect(journalRead(j).filter((x) => x.ok)).toEqual([]);
  });

  test("(c) live already equal to the expected end state journals ok alreadyApplied with zero mutations", async () => {
    const be = relabelBackend([LB, LC]); // already at the planned end state
    const j = join(dir, "j.jsonl");
    const events: string[] = [];
    const r = await run(fakeClient(be), [relabelOp()], j, { onEvent: (e) => events.push(e.kind) });
    expect(r.applied).toBe(1);
    expect(be.mutationCalls).toEqual([]);
    expect(events).toContain("already-applied");
    const rows = journalRead(j);
    expect(rows).toHaveLength(1);
    expect(rows[0].ok).toBe(true);
    expect(rows[0].alreadyApplied).toBe(true);
    expect(rows[0].before).toEqual({ labelIds: [LA, LB] });
    expect((rows[0].after as { labelIds: string[] }).labelIds).toEqual([LB, LC].sort());
    // resume treats it as done
    expect(journalOkSeqs(rows).has(1)).toBe(true);
  });

  test("(c2) --check reports already applied, not drift", async () => {
    const be = relabelBackend([LB, LC]);
    const lines: string[] = [];
    const r = await runPlan(fakeClient(be), planWith([relabelOp()]), {
      apply: false, check: true, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), pace: fastPace(), onEvent: (e) => lines.push(e.detail),
    });
    expect(r.drifted).toEqual([]);
    expect(lines.some((l) => l.includes("already applied"))).toBe(true);
  });

  test("(d) live equal to neither from nor expected end state is still drift", async () => {
    const be = relabelBackend([LB]); // neither [A,B] nor [B,C]
    await expect(run(fakeClient(be), [relabelOp()], join(dir, "j.jsonl"))).rejects.toBeInstanceOf(ReorgMismatch);
    expect(be.mutationCalls).toEqual([]);
  });

  test("(e2) rollback skips alreadyApplied rows by default and lists them", async () => {
    const be = relabelBackend([LB, LC]);
    const j = join(dir, "j.jsonl");
    await run(fakeClient(be), [relabelOp()], j);
    const dry = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), ...noSleep });
    expect(dry.planned).toBe(0);
    expect(dry.skipped).toHaveLength(1);
    expect(dry.skipped[0]).toContain("already applied before this run (not written by the tool)");
    const rb = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true, ...noSleep });
    expect(rb.rolledBack).toBe(0);
    expect(be.mutationCalls).toEqual([]);
    expect([...be.issues.get("i-1")!.labelIds].sort()).toEqual([LB, LC].sort());
  });

  test("(e) rollback inverts an alreadyApplied relabel with includeAlreadyApplied", async () => {
    const be = relabelBackend([LB, LC]);
    const j = join(dir, "j.jsonl");
    await run(fakeClient(be), [relabelOp()], j);
    expect(be.mutationCalls).toEqual([]);
    const rb = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true, includeAlreadyApplied: true, ...noSleep });
    expect(rb.rolledBack).toBe(1);
    expect([...be.issues.get("i-1")!.labelIds].sort()).toEqual([LA, LB].sort());
  });

  test("batch: already-applied members are excluded from the write and journaled alreadyApplied", async () => {
    const be = relabelBackend();
    be.issues.set("i-2", { ...ISSUE_1, id: "i-2", identifier: "EX-2", labelIds: [LB, LC] }); // already done
    const mk = (n: number, id: string, from: string[]) =>
      baseOp({
        seq: n, op: "relabel", target: { type: "issue", id, identifier: `EX-${n}` },
        from: { labelIds: from }, to: { add: [LC], remove: [LA] }, batchKey: "k",
      });
    const j = join(dir, "j.jsonl");
    const batchIds: string[][] = [];
    const inner = (fakeClient(be) as unknown as {
      client: { rawRequest: (q: string, v: Record<string, unknown>) => Promise<unknown> };
    }).client;
    const spy = { client: { rawRequest: async (q: string, v: Record<string, unknown>) => {
      if (q.includes("ReorgBatchUpdate")) batchIds.push([...(v.ids as string[])]);
      return inner.rawRequest(q, v);
    } } } as unknown as LinearClient;
    const r = await run(spy, [mk(1, "i-1", [LA, LB]), mk(2, "i-2", [LA, LB])], j);
    expect(r.applied).toBe(2);
    expect(batchIds).toEqual([["i-1"]]); // the already-applied member is NOT written
    const rows = journalRead(j);
    expect(rows.map((x) => [x.seq, x.ok, x.alreadyApplied === true])).toEqual([[1, true, false], [2, true, true]]);
    expect([...be.issues.get("i-1")!.labelIds].sort()).toEqual([LB, LC].sort());
  });
});

// ---------------------------------------------------------------------------
// --check surfaces apply-time precondition refusals; journal marker ordering;
// project-status lookup without a server-side filter
// ---------------------------------------------------------------------------

describe("--check runs precondition reads (no writes)", () => {
  const checkOpts = () => ({
    check: true, apply: false, resume: false, allowIrreversible: false,
    journalPath: join(dir, "j.jsonl"), pace: fastPace(),
  });

  test("archive-state: occupied state (archived issue included) is a refusal, not drift; no mutation", async () => {
    const be = freshBackend();
    be.states.set("s-ready", { id: "s-ready", name: "Ready", type: "unstarted", archivedAt: null });
    be.issues.set("i-1", { ...ISSUE_1, stateId: "s-ready", labelIds: [], archived: true });
    const op = baseOp({
      phase: 2, op: "archive-state", reversible: false, approval: "deck-1",
      target: { type: "state", id: "s-ready", identifier: "EX/Ready" },
      from: { archived: false }, to: { archived: true },
    });
    const events: string[] = [];
    const r = await runPlan(fakeClient(be), planWith([op]), { ...checkOpts(), onEvent: (e) => events.push(`${e.kind}: ${e.detail}`) });
    expect(r.drifted).toEqual([]);
    expect(r.refused).toEqual([1]);
    expect(events.some((e) => e.startsWith("refuse: REFUSE seq 1") && e.includes("still in the state"))).toBe(true);
    expect(be.mutationCalls).toEqual([]);
    // control: emptied state passes cleanly
    be.issues.get("i-1")!.stateId = "s-todo";
    const clean = await runPlan(fakeClient(be), planWith([op]), checkOpts());
    expect(clean.refused).toEqual([]);
    expect(clean.drifted).toEqual([]);
    expect(be.mutationCalls).toEqual([]);
  });

  test("delete-team: attached project is a refusal; no mutation", async () => {
    const be = freshBackend();
    be.teams.set("t-9", { id: "t-9", key: "OLD", triageEnabled: false, deleted: false });
    be.projects.set("p-9", { id: "p-9", name: "Leftover", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-9"], initiativeIds: [] });
    const del = baseOp({
      seq: 9, phase: 6, op: "delete-team", reversible: false, approval: "deck-1",
      target: { type: "team", id: "t-9", identifier: "OLD" }, from: {}, to: {},
    });
    const r = await runPlan(fakeClient(be), planWith([del]), checkOpts());
    expect(r.refused).toEqual([9]);
    expect(be.mutationCalls).toEqual([]);
    expect(be.teams.get("t-9")!.deleted).toBe(false);
  });

  test("move-issue-team: missing phase-1 verify in the journal is a refusal", async () => {
    const be = freshBackend();
    be.issues.set("i-1", { ...ISSUE_1, labelIds: [] });
    const op = baseOp({
      phase: 3, op: "move-issue-team",
      from: { teamId: "t-1", cycleId: null }, to: { teamId: "t-2", reapplyLabelIds: [] },
    });
    const r = await runPlan(fakeClient(be), planWith([op]), checkOpts());
    expect(r.refused).toEqual([1]);
    expect(be.mutationCalls).toEqual([]);
  });
});

describe("project guards (check-mode refusals)", () => {
  const checkOpts = () => ({
    check: true, apply: false, resume: false, allowIrreversible: false,
    journalPath: join(dir, "j.jsonl"), pace: fastPace(),
  });
  const projectOp = (over: Partial<ReorgOp>): ReorgOp =>
    baseOp({ target: { type: "project", id: "p-1", identifier: "Proj" }, ...over });
  const mkProject = (over: Partial<FakeProject> = {}): FakeProject => ({
    id: "p-1", name: "Proj", statusId: "st-1", leadId: null, targetDate: null,
    trashed: false, teamIds: ["t-1"], initiativeIds: [], ...over,
  });
  const mkIssue = (id: string, archived: boolean): FakeIssue => ({
    ...ISSUE_1, id, identifier: `EX-${id}`, labelIds: [], archived,
  });
  const archiveOp = () => projectOp({
    op: "archive-project",
    from: { archived: false, trashed: false }, to: { archived: true },
  });

  test("archive-project: open issues refuse with the count (a refusal is NOT drift); archiving them first passes", async () => {
    const be = freshBackend();
    be.projects.set("p-1", mkProject());
    be.issues.set("i-1", mkIssue("i-1", false));
    be.issues.set("i-2", mkIssue("i-2", false));
    be.issues.set("i-3", mkIssue("i-3", true)); // archived issues do NOT count
    const events: string[] = [];
    const r = await runPlan(fakeClient(be), planWith([archiveOp()]), { ...checkOpts(), onEvent: (e) => events.push(`${e.kind}: ${e.detail}`) });
    expect(r.drifted).toEqual([]);
    expect(r.refused).toEqual([1]);
    expect(events.some((e) => e.startsWith("refuse: REFUSE seq 1") && e.includes("2 open issue(s)"))).toBe(true);
    expect(be.mutationCalls).toEqual([]);
    expect(be.projects.get("p-1")!.archived ?? false).toBe(false);
    // positive control: issues archived first -> clean pass
    be.issues.get("i-1")!.archived = true;
    be.issues.get("i-2")!.archived = true;
    const clean = await runPlan(fakeClient(be), planWith([archiveOp()]), checkOpts());
    expect(clean.refused).toEqual([]);
    expect(clean.drifted).toEqual([]);
    expect(be.mutationCalls).toEqual([]);
  });

  test("archive-project guard also holds under apply: refuse before any write", async () => {
    const be = freshBackend();
    be.projects.set("p-1", mkProject());
    be.issues.set("i-1", mkIssue("i-1", false));
    await expect(applyPlan(be, [archiveOp()], join(dir, "j.jsonl"))).rejects.toThrow(/open issue/);
    expect(be.mutationCalls).toEqual([]);
    expect(be.projects.get("p-1")!.archived ?? false).toBe(false);
  });

  test("archived target: project ops are refused; the unarchive form is the one allowed op", async () => {
    const be = freshBackend();
    be.projects.set("p-1", mkProject({ archived: true }));
    const ops = [
      projectOp({ op: "set-project-status", from: { statusId: "st-1" }, to: { statusId: "st-2" } }),
      projectOp({ seq: 2, op: "set-project-lead", from: { leadId: null }, to: { leadId: "u-1" } }),
      projectOp({ seq: 3, op: "archive-project", from: { archived: true, trashed: false }, to: { archived: true } }),
      projectOp({ seq: 4, op: "move-project-initiative", from: { initiativeIds: [] }, to: { toInitiativeId: "in-1" } }),
    ];
    const events: string[] = [];
    const r = await runPlan(fakeClient(be), planWith(ops), { ...checkOpts(), onEvent: (e) => events.push(`${e.kind}: ${e.detail}`) });
    expect(r.drifted).toEqual([]);
    expect(r.refused).toEqual([1, 2, 3, 4]);
    expect(events.filter((e) => e.startsWith("refuse: REFUSE") && e.includes("archived project"))).toHaveLength(4);
    expect(be.mutationCalls).toEqual([]);
    // exception: unarchiving an archived project is allowed
    const unarchive = projectOp({
      op: "archive-project", from: { archived: true, trashed: false }, to: { archived: false },
    });
    const ok = await runPlan(fakeClient(be), planWith([unarchive]), checkOpts());
    expect(ok.refused).toEqual([]);
    expect(ok.drifted).toEqual([]);
    expect(be.mutationCalls).toEqual([]);
  });

  test("unarchived target (control): set-project-status / set-project-lead / move-project-initiative pass", async () => {
    const be = freshBackend();
    be.projects.set("p-1", mkProject());
    const ops = [
      projectOp({ op: "set-project-status", from: { statusId: "st-1" }, to: { statusId: "st-2" } }),
      projectOp({ seq: 2, op: "set-project-lead", from: { leadId: null }, to: { leadId: "u-1" } }),
      projectOp({ seq: 3, op: "move-project-initiative", from: { initiativeIds: [] }, to: { toInitiativeId: "in-1" } }),
    ];
    const r = await runPlan(fakeClient(be), planWith(ops), checkOpts());
    expect(r.refused).toEqual([]);
    expect(r.drifted).toEqual([]);
  });

  test("remove-project-team: removing the last team is refused; leaving one team passes", async () => {
    const be = freshBackend();
    be.projects.set("p-1", mkProject({ teamIds: ["t-1"] }));
    const last = projectOp({
      op: "remove-project-team", from: { teamIds: ["t-1"] }, to: { teamId: "t-1" },
    });
    const events: string[] = [];
    const r = await runPlan(fakeClient(be), planWith([last]), { ...checkOpts(), onEvent: (e) => events.push(`${e.kind}: ${e.detail}`) });
    expect(r.drifted).toEqual([]);
    expect(r.refused).toEqual([1]);
    expect(events.some((e) => e.startsWith("refuse: REFUSE seq 1") && e.includes("at least one team"))).toBe(true);
    expect(be.mutationCalls).toEqual([]);
    expect(be.projects.get("p-1")!.teamIds).toEqual(["t-1"]);
    // positive control: one team remains after the removal
    be.projects.get("p-1")!.teamIds = ["t-1", "t-2"];
    const keep = projectOp({
      op: "remove-project-team", from: { teamIds: ["t-1", "t-2"] }, to: { teamId: "t-1" },
    });
    const clean = await runPlan(fakeClient(be), planWith([keep]), checkOpts());
    expect(clean.refused).toEqual([]);
    expect(clean.drifted).toEqual([]);
  });
});

describe("journalPhaseVerified uses the latest marker", () => {
  const mark = (ok: boolean): JournalRecord => ({ seq: "verify", phase: 2, at: "t", ok });
  test("green then red is not verified", () => {
    expect(journalPhaseVerified([mark(true), mark(false)], 2)).toBe(false);
  });
  test("red then green is verified", () => {
    expect(journalPhaseVerified([mark(false), mark(true)], 2)).toBe(true);
  });
  test("other phases' markers do not count", () => {
    expect(journalPhaseVerified([mark(true)], 1)).toBe(false);
  });
});

describe("create-project-status read", () => {
  test("matches by exact name and type among all statuses; same name of another type is not a match", async () => {
    const be = freshBackend();
    be.projectStatuses.set("ps-a", { id: "ps-a", name: "paused", type: "started" }); // case differs
    be.projectStatuses.set("ps-b", { id: "ps-b", name: "Paused", type: "paused" }); // type differs
    const op = baseOp({
      op: "create-project-status", target: { type: "project", id: "new:Paused", identifier: "Paused" },
      from: { statusId: null }, to: { name: "Paused", color: "#f59e0b", type: "started" },
    });
    const result = await applyPlan(be, [op], join(dir, "j.jsonl"));
    expect(result.applied).toBe(1);
    expect(be.mutationCalls).toEqual(["projectStatusCreate"]);
  });
});

describe("guarded paging and refusal messages", () => {
  const teamDel = () => baseOp({
    seq: 9, phase: 6, op: "delete-team", reversible: false, approval: "deck-1",
    target: { type: "team", id: "t-9", identifier: "OLD" }, from: {}, to: {},
  });

  test("delete-team: an active label on page 2 blocks the delete (labels are paginated)", async () => {
    const be = freshBackend();
    be.teams.set("t-9", { id: "t-9", key: "OLD", triageEnabled: false, deleted: false });
    be.labels.set("l-1", { id: "l-1", name: "stray", retiredAt: null, teamId: "t-9", teamKey: "OLD" });
    be.forceLabelPagination = true;
    await expect(applyPlan(be, [teamDel()], join(dir, "j.jsonl"), { allowIrreversible: true }))
      .rejects.toThrow("non-retired label(s) remain");
    expect(be.mutationCalls).toEqual([]);
  });

  test("a cursor that does not advance throws instead of spinning (labels and initiative joins)", async () => {
    const be = freshBackend();
    be.teams.set("t-9", { id: "t-9", key: "OLD", triageEnabled: false, deleted: false });
    be.stuckCursor = true;
    await expect(applyPlan(be, [teamDel()], join(dir, "j.jsonl"), { allowIrreversible: true }))
      .rejects.toThrow("cursor did not advance");

    const be2 = freshBackend();
    be2.projects.set("p-1", { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1"], initiativeIds: ["in-1"] });
    be2.stuckCursor = true;
    const mv = baseOp({
      phase: 4, op: "move-project-initiative", target: { type: "project", id: "p-1", identifier: "P" },
      from: { initiativeIds: ["in-1"] }, to: { fromInitiativeId: "in-1", toInitiativeId: "in-2" },
    });
    await expect(applyPlan(be2, [mv], join(dir, "j2.jsonl"))).rejects.toThrow("cursor did not advance");
    expect(be2.mutationCalls).toEqual([]);
  });

  test("archive-state refusal names archived issues and says the refusal is conservative", async () => {
    const be = freshBackend();
    be.states.set("s-ready", { id: "s-ready", name: "Ready", type: "unstarted", archivedAt: null });
    be.issues.set("i-1", { ...ISSUE_1, stateId: "s-ready", labelIds: [], archived: true });
    const op = baseOp({
      phase: 2, op: "archive-state", reversible: false, approval: "deck-1",
      target: { type: "state", id: "s-ready", identifier: "EX/Ready" },
      from: { archived: false }, to: { archived: true },
    });
    await expect(applyPlan(be, [op], join(dir, "j.jsonl"), { allowIrreversible: true }))
      .rejects.toThrow(/archived: EX-1\)\. Linear may allow archiving .* refuses conservatively/);
  });
});

// ---------------------------------------------------------------------------
// Team-label carry-over: create-team-label, move labelMap, prior journals
// ---------------------------------------------------------------------------

describe("team-label carry-over", () => {
  const lid = (n: number) => `33333333-3333-4333-8333-${String(n).padStart(12, "0")}`;
  const L_SRC_BUG = lid(1);   // source team label "bug"
  const L_SRC_OTHER = lid(2); // source team label "other"
  const L_WS = lid(3);        // workspace label kept through the move
  const L_PARENT = lid(4);    // parent-owned label "shared"
  const L_UNRELATED = lid(5); // label of an unrelated team

  /** Teams: AAA (source, unrelated to BBB), BBB (destination), PPP parent of SSS. */
  function backend(): FakeBackend {
    const be = freshBackend();
    for (const [id, key, parentId] of [["t-a", "AAA", null], ["t-b", "BBB", null], ["t-p", "PPP", null], ["t-s", "SSS", "t-p"], ["t-u", "UUU", null]] as const)
      be.teams.set(id, { id, key, triageEnabled: true, deleted: false, parentId });
    be.projects.set("p-1", { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-a", "t-b", "t-p", "t-s"], initiativeIds: [] });
    be.labels.set(L_SRC_BUG, { id: L_SRC_BUG, name: "bug", retiredAt: null, teamId: "t-a", teamKey: "AAA" });
    be.labels.set(L_SRC_OTHER, { id: L_SRC_OTHER, name: "other", retiredAt: null, teamId: "t-a", teamKey: "AAA" });
    be.labels.set(L_WS, { id: L_WS, name: "ws-kept", retiredAt: null, teamId: null, teamKey: null });
    be.labels.set(L_PARENT, { id: L_PARENT, name: "shared", retiredAt: null, teamId: "t-p", teamKey: "PPP" });
    be.labels.set(L_UNRELATED, { id: L_UNRELATED, name: "elsewhere", retiredAt: null, teamId: "t-u", teamKey: "UUU" });
    be.issues.set("i-1", { ...ISSUE_1, teamId: "t-a", teamKey: "AAA", labelIds: [L_SRC_BUG, L_WS], projectId: "p-1" });
    return be;
  }
  const createOp = (seq: number, teamId: string, name: string, extra: Partial<ReorgOp> = {}): ReorgOp =>
    baseOp({
      seq, phase: 5, op: "create-team-label",
      target: { type: "team", id: teamId, identifier: teamId },
      from: { labelId: null }, to: { name, color: "#ff0000" }, ...extra,
    });
  const moveWith = (seq: number, labelMap: Record<string, string>, over: Partial<ReorgOp> = {}): ReorgOp =>
    baseOp({
      seq, phase: 5, op: "move-issue-team",
      from: { teamId: "t-a", projectId: "p-1", cycleId: null, stateId: "s-todo", labelIds: [L_SRC_BUG, L_WS] },
      to: { teamId: "t-b", labelMap, reapplyLabelIds: [] },
      ...over,
    });
  const green = (j: string) => {
    journalAppend(j, { seq: "verify", phase: 1, at: "2026-10-05T00:00:01Z", ok: true });
    journalAppend(j, { seq: "verify", phase: 2, at: "2026-10-05T00:00:02Z", ok: true });
  };
  const events = (be: FakeBackend, ops: ReorgOp[], extra: Partial<Parameters<typeof runPlan>[2]> = {}) => {
    const lines: string[] = [];
    return runPlan(fakeClient(be), planWith(ops), {
      apply: false, check: true, resume: false, allowIrreversible: false,
      journalPath: join(dir, "chk.jsonl"), pace: fastPace(),
      onEvent: (e) => lines.push(e.detail), ...extra,
    }).then((r) => ({ r, lines }));
  };

  describe("move already completed by a parent's cascade", () => {
    const L_DEST = lid(9); // workspace label the source team label maps to
    const DEST_STATE = "s-dest";
    const cascadeOp = () =>
      moveWith(2, { [L_SRC_BUG]: L_DEST }, {
        to: { teamId: "t-b", labelMap: { [L_SRC_BUG]: L_DEST }, reapplyLabelIds: [], stateId: DEST_STATE },
      });
    /** The issue as Linear leaves a sub-issue after its parent's move. */
    function cascaded(over: Partial<{ teamId: string; stateId: string; labelIds: string[]; projectId: string | null }> = {}): FakeBackend {
      const be = backend();
      be.labels.set(L_DEST, { id: L_DEST, name: "bug-ws", retiredAt: null, teamId: null, teamKey: null });
      be.issues.set("i-1", {
        ...ISSUE_1, teamId: "t-b", teamKey: "BBB", stateId: DEST_STATE,
        labelIds: [L_DEST, L_WS], projectId: "p-1", ...over,
      });
      return be;
    }

    test("full end state matches: journaled alreadyApplied + cascade, zero writes", async () => {
      const be = cascaded();
      const j = join(dir, "j.jsonl");
      green(j);
      const res = await applyPlan(be, [cascadeOp()], j);
      expect(res.applied).toBe(1);
      expect(be.mutationCalls).toEqual([]);
      const rec = journalRead(j).find((r) => r.seq === 2)!;
      expect(rec.ok).toBe(true);
      expect(rec.alreadyApplied).toBe(true);
      expect(rec.cascade).toBe(true);
      expect((rec.after as { teamId: string }).teamId).toBe("t-b");
    });

    test("a mapped label dropped by the cascade is a mismatch naming the label", async () => {
      const be = cascaded({ labelIds: [L_WS] });
      const j = join(dir, "j.jsonl");
      green(j);
      await expect(applyPlan(be, [cascadeOp()], j)).rejects.toThrow(
        new RegExp(`parent's cascade.*missing \\["${L_DEST}"\\]`),
      );
      expect(be.mutationCalls).toEqual([]);
      expect(journalRead(j).some((r) => r.seq === 2)).toBe(false);
    });

    test("an unexpected extra label is a mismatch", async () => {
      const be = cascaded({ labelIds: [L_DEST, L_WS, L_PARENT] });
      const j = join(dir, "j.jsonl");
      green(j);
      await expect(applyPlan(be, [cascadeOp()], j)).rejects.toThrow(/unexpected/);
    });

    test("wrong state is a mismatch", async () => {
      const be = cascaded({ stateId: "s-other" });
      const j = join(dir, "j.jsonl");
      green(j);
      await expect(applyPlan(be, [cascadeOp()], j)).rejects.toThrow(/state differs/);
      expect(be.mutationCalls).toEqual([]);
    });

    test("lost project membership is a mismatch", async () => {
      const be = cascaded({ projectId: null });
      const j = join(dir, "j.jsonl");
      green(j);
      await expect(applyPlan(be, [cascadeOp()], j)).rejects.toThrow(/project membership/);
    });

    test("an op with no to.stateId is never already applied", async () => {
      const be = cascaded();
      const j = join(dir, "j.jsonl");
      green(j);
      const op = moveWith(2, { [L_SRC_BUG]: L_DEST }, { to: { teamId: "t-b", labelMap: { [L_SRC_BUG]: L_DEST }, reapplyLabelIds: [] } });
      await expect(applyPlan(be, [op], j)).rejects.toThrow(/no to\.stateId/);
    });

    test("--check reports the matching cascade as already applied and the incomplete one as drift", async () => {
      const ok = await events(cascaded(), [cascadeOp()]);
      expect(ok.r.drifted).toEqual([]);
      expect(ok.lines.some((l) => l.includes("already applied seq 2"))).toBe(true);
      const bad = await events(cascaded({ labelIds: [L_WS] }), [cascadeOp()]);
      expect(bad.r.drifted).toEqual([2]);
      expect(bad.lines.join("\n")).toContain(L_DEST);
    });

    test("team differing from the destination is never already applied, even when state/project/labels match", async () => {
      const be = cascaded({ teamId: "t-p" });
      const j = join(dir, "j.jsonl");
      green(j);
      await expect(applyPlan(be, [cascadeOp()], j)).rejects.toThrow(ReorgMismatch);
      expect(be.mutationCalls).toEqual([]);
      expect(journalRead(j).some((r) => r.seq === 2)).toBe(false);
    });

    describe("rollback", () => {
      const opts = { pace: fastPace(), apply: true, verifyDelaysMs: [0], sleep: async () => {} };

      test("a non-move inverse already at its end state is still refused as on main", async () => {
        const be = freshBackend();
        be.issues.set("i-1", { ...ISSUE_1, labelIds: [L_WS] });
        const j = join(dir, "j.jsonl");
        const op = baseOp({ seq: 3, phase: 1, op: "relabel", from: { labelIds: [L_SRC_BUG, L_WS] }, to: { add: [], remove: [L_SRC_BUG] } });
        journalAppend(j, { seq: 3, phase: 1, op: "relabel", original: op, before: op.from, after: { labelIds: [L_SRC_BUG, L_WS] }, at: "2026-10-05T00:00:04Z", ok: true });
        // live already holds the inverse's end state ([L_SRC_BUG, L_WS]) but not its from-state
        be.issues.get("i-1")!.labelIds = [L_SRC_BUG, L_WS];
        await expect(rollbackPhase(fakeClient(be), j, 1, opts)).rejects.toThrow(ReorgMismatch);
        expect(be.mutationCalls).toEqual([]);
      });
      async function movedForward() {
        const be = backend();
        be.labels.set(L_DEST, { id: L_DEST, name: "bug-ws", retiredAt: null, teamId: null, teamKey: null });
        const j = join(dir, "j.jsonl");
        green(j);
        await applyPlan(be, [cascadeOp()], j);
        return { be, j };
      }

      test("a sub-issue already carried back by its parent's inverse is accepted without a write", async () => {
        const { be, j } = await movedForward();
        Object.assign(be.issues.get("i-1")!, { teamId: "t-a", teamKey: "AAA", stateId: "s-todo", labelIds: [L_SRC_BUG, L_WS], projectId: "p-1" });
        const before = be.mutationCalls.length;
        const rb = await rollbackPhase(fakeClient(be), j, 5, opts);
        expect(rb.rolledBack).toBe(1);
        expect(be.mutationCalls.length).toBe(before);
      });

      test("a half-reverted sub-issue (source label missing) still refuses", async () => {
        const { be, j } = await movedForward();
        Object.assign(be.issues.get("i-1")!, { teamId: "t-a", teamKey: "AAA", stateId: "s-todo", labelIds: [L_WS], projectId: "p-1" });
        await expect(rollbackPhase(fakeClient(be), j, 5, opts)).rejects.toThrow(ReorgMismatch);
      });
    });
  });

  describe("create-team-label name conflicts", () => {
    test("--check: free in an unrelated team, even when the name exists elsewhere", async () => {
      const be = backend();
      const { r } = await events(be, [createOp(1, "t-b", "bug")]); // AAA owns "bug"; BBB is unrelated
      expect(r.drifted).toEqual([]);
    });

    test("--check: parent, sub-team, workspace and case-insensitive clashes are all refused", async () => {
      const be = backend();
      // sub-team SSS owns "Sub-Thing"; parent PPP owns "shared"; workspace owns "ws-kept"
      be.labels.set(lid(6), { id: lid(6), name: "Sub-Thing", retiredAt: null, teamId: "t-s", teamKey: "SSS" });
      const cases: [string, string][] = [
        ["t-p", "SUB-THING"],  // dest parent vs a sub-team's label, other case
        ["t-s", "Shared"],     // dest sub-team vs its parent's label
        ["t-b", "WS-KEPT"],    // workspace label, other case
        ["t-p", "shared"],     // the destination's own label
      ];
      for (const [team, name] of cases) {
        const { r, lines } = await events(be, [createOp(1, team, name)]);
        // the destination's OWN label is drift (absence anchor); the rest are refusals
        expect(r.drifted.length + r.refused.length).toBeGreaterThan(0);
        expect(lines.join("\n")).toMatch(/REFUSE|DRIFT/);
        if (name !== "shared" || team !== "t-p") {
          expect(r.refused).toEqual([1]);
          expect(lines.join("\n")).toContain("name taken by");
        }
      }
    });

    test("apply refuses with no write when the name is taken in another scope", async () => {
      const be = backend();
      await expect(applyPlan(be, [createOp(1, "t-s", "shared")], join(dir, "j.jsonl"))).rejects.toThrow("name taken by");
      expect(be.mutationCalls).toEqual([]);
    });

    test("a lower-seq rename frees the name (check and apply); a higher-seq rename does not", async () => {
      const be = backend();
      // sub-team SSS owns "bug"; creating "bug" in its parent PPP needs the rename first
      be.labels.set(lid(7), { id: lid(7), name: "bug", retiredAt: null, teamId: "t-s", teamKey: "SSS" });
      const rename = (seq: number) => baseOp({
        seq, phase: 5, op: "rename-label", target: { type: "label", id: lid(7), identifier: "SSS/bug" },
        from: { name: "bug", retired: false }, to: { name: "bug·old-sss" },
      });
      const ok = await events(be, [rename(1), createOp(2, "t-p", "bug")]);
      expect(ok.r.drifted).toEqual([]);
      expect(ok.r.refused).toEqual([]);
      const late = await events(be, [createOp(1, "t-p", "bug"), rename(2)]);
      expect(late.r.refused).toEqual([1]);

      const j = join(dir, "j.jsonl");
      const res = await applyPlan(be, [rename(1), createOp(2, "t-p", "bug")], j);
      expect(res.applied).toBe(2);
      const made = [...be.labels.values()].find((l) => l.teamId === "t-p" && l.name === "bug");
      expect(made).toBeDefined();
      expect(journalRead(j).find((r) => r.seq === 2)!.original!.to.labelId).toBe(made!.id);
    });
  });

  describe("move-issue-team labelMap", () => {
    test("created:<seq> resolves from the journal; the move sends the exact set (workspace label kept, mapped label added)", async () => {
      const be = backend();
      const j = join(dir, "j.jsonl");
      green(j);
      const ops = [
        createOp(1, "t-b", "bug"),
        moveWith(2, { [L_SRC_BUG]: "created:1", [L_SRC_OTHER]: "created:1" /* not on the issue: must add nothing */ }),
      ];
      const res = await applyPlan(be, ops, j);
      expect(res.applied).toBe(2);
      const made = [...be.labels.values()].find((l) => l.teamId === "t-b" && l.name === "bug")!;
      const i = be.issues.get("i-1")!;
      expect(i.teamId).toBe("t-b");
      expect([...i.labelIds].sort()).toEqual([made.id, L_WS].sort());
      const rec = journalRead(j).find((r) => r.seq === 2)!;
      expect(rec.original!.to.labelIdsComputed).toEqual([made.id, L_WS].sort());
      const v = await verifyPhase(fakeClient(be), planWith(ops), 5, { journalPath: j, pace: fastPace() });
      expect(v.ok).toBe(true);
    });

    test("an unresolvable created:<seq> refuses before any write", async () => {
      const be = backend();
      const j = join(dir, "j.jsonl");
      green(j);
      await expect(applyPlan(be, [moveWith(2, { [L_SRC_BUG]: "created:1" })], j)).rejects.toThrow("no ok create-label journal record");
      expect(be.mutationCalls).toEqual([]);
    });

    test("(a) a team label on the issue that is neither swapped nor mapped refuses, naming it", async () => {
      const be = backend();
      const j = join(dir, "j.jsonl");
      green(j);
      await expect(applyPlan(be, [moveWith(2, { [L_SRC_OTHER]: L_WS })], j)).rejects.toThrow(`"bug" (${L_SRC_BUG}) is live on EX-1 with no journaled relabel to a workspace replacement and no to.labelMap entry`);
      expect(be.mutationCalls).toEqual([]);
    });

    test("(a) a mapped destination outside the destination team's scope refuses", async () => {
      const be = backend();
      const j = join(dir, "j.jsonl");
      green(j);
      await expect(applyPlan(be, [moveWith(2, { [L_SRC_BUG]: L_UNRELATED })], j)).rejects.toThrow("outside the destination team's scope");
      expect(be.mutationCalls).toEqual([]);
    });

    test("a workspace label or the destination parent's label is an acceptable destination", async () => {
      const be = backend();
      be.issues.get("i-1")!.labelIds = [L_SRC_BUG, L_WS];
      const j = join(dir, "j.jsonl");
      green(j);
      // source AAA -> destination SSS (sub-team of PPP): the parent's label is in scope
      const res = await applyPlan(be, [moveWith(2, { [L_SRC_BUG]: L_PARENT }, { to: { teamId: "t-s", labelMap: { [L_SRC_BUG]: L_PARENT }, reapplyLabelIds: [] } })], j);
      expect(res.applied).toBe(1);
      expect([...be.issues.get("i-1")!.labelIds].sort()).toEqual([L_PARENT, L_WS].sort());
    });

    test("an inherited child on the issue maps through its owner id", async () => {
      const be = backend();
      const child = lid(8);
      // sub-team SSS carries an inherited view of the parent's "shared"
      be.labels.set(child, { id: child, name: "shared", retiredAt: null, teamId: "t-s", teamKey: "SSS", inheritedFrom: L_PARENT });
      be.issues.set("i-1", { ...ISSUE_1, teamId: "t-s", teamKey: "SSS", labelIds: [child, L_WS], projectId: "p-1" });
      const j = join(dir, "j.jsonl");
      green(j);
      const op = moveWith(2, { [L_PARENT]: L_PARENT }, {
        from: { teamId: "t-s", projectId: "p-1", cycleId: null, stateId: "s-todo", labelIds: [child, L_WS] },
        to: { teamId: "t-p", labelMap: { [L_PARENT]: L_PARENT }, reapplyLabelIds: [] },
      });
      const res = await applyPlan(be, [op], j);
      expect(res.applied).toBe(1);
      expect([...be.issues.get("i-1")!.labelIds].sort()).toEqual([L_PARENT, L_WS].sort());
    });

    test("post-move verify stops when the issue's labels are not exactly the expected set", async () => {
      const be = backend();
      const j = join(dir, "j.jsonl");
      green(j);
      // Linear silently drops the mapped label after acknowledging the write
      const inner = (fakeClient(be) as unknown as { client: { rawRequest: (q: string, v: Record<string, unknown>) => Promise<unknown> } }).client;
      const client = {
        client: {
          rawRequest: async (q: string, v: Record<string, unknown>) => {
            const r = await inner.rawRequest(q, v);
            const input = v.input as { labelIds?: string[] } | undefined;
            if (q.includes("ReorgIssueUpdate") && input?.labelIds) {
              const i = be.issues.get("i-1")!;
              i.labelIds = i.labelIds.filter((x) => x === L_WS);
            }
            return r;
          },
        },
      } as unknown as LinearClient;
      const ops = [createOp(1, "t-b", "bug"), moveWith(2, { [L_SRC_BUG]: "created:1" })];
      await expect(
        runPlan(client, planWith(ops), {
          apply: true, resume: false, allowIrreversible: false, journalPath: j,
          backupRecordPath: freshBackup(), pace: fastPace(), verifyDelaysMs: [0, 0], sleep: async () => {},
        }),
      ).rejects.toThrow(ReorgMismatch);
      expect(journalRead(j).some((r) => r.seq === 2)).toBe(false); // never journaled ok
    });

    test("verifyPhase fails when the labels drift off the journaled set later", async () => {
      const be = backend();
      const j = join(dir, "j.jsonl");
      green(j);
      const ops = [createOp(1, "t-b", "bug"), moveWith(2, { [L_SRC_BUG]: "created:1" })];
      await applyPlan(be, ops, j);
      be.issues.get("i-1")!.labelIds = [L_WS]; // mapped label lost afterwards
      const v = await verifyPhase(fakeClient(be), planWith(ops), 5, { journalPath: j, pace: fastPace() });
      expect(v.ok).toBe(false);
      expect(v.failures.join("\n")).toContain("labelIds");
    });

    test("--check flags an unresolvable created ref and an out-of-scope plain destination; accepts a lower-seq planned create", async () => {
      const be = backend();
      green(join(dir, "chk.jsonl"));
      const bad = await events(be, [moveWith(2, { [L_SRC_BUG]: "created:1" })]);
      expect(bad.r.refused).toContain(2);
      expect(bad.lines.join("\n")).toContain("no ok create-label journal record");
      const scope = await events(be, [moveWith(2, { [L_SRC_BUG]: L_UNRELATED })]);
      expect(scope.r.refused).toContain(2);
      expect(scope.lines.join("\n")).toContain("outside the destination team's scope");
      // gates are green and the ref is a lower-seq planned create: nothing to refuse
      const good = await events(be, [createOp(1, "t-b", "bug"), moveWith(2, { [L_SRC_BUG]: "created:1" })]);
      expect(good.r.drifted).toEqual([]);
      expect(good.r.refused).toEqual([]);
    });
  });

  describe("rollback with a source label retired since the move", () => {
    async function moved() {
      const be = backend();
      const j = join(dir, "j.jsonl");
      green(j);
      await applyPlan(be, [createOp(1, "t-b", "bug"), moveWith(2, { [L_SRC_BUG]: "created:1" })], j);
      be.labels.get(L_SRC_BUG)!.retiredAt = "2026-10-05T00:00:00Z";
      be.mutationCalls.length = 0;
      return { be, j };
    }
    const opts = { pace: fastPace(), verifyDelaysMs: [0], sleep: async () => {} };

    test("dry run and apply refuse, naming the label, with no write", async () => {
      const { be, j } = await moved();
      await expect(rollbackPhase(fakeClient(be), j, 5, opts)).rejects.toThrow(/retired since the move: "bug"/);
      await expect(rollbackPhase(fakeClient(be), j, 5, { ...opts, apply: true })).rejects.toThrow("--restore-retired");
      expect(be.mutationCalls).toEqual([]);
      expect(be.issues.get("i-1")!.teamId).toBe("t-b");
    });

    test("a restore that does not land stops the rollback before the move", async () => {
      const { be, j } = await moved();
      // only the restore is acknowledged but not applied
      const inner = (fakeClient(be) as unknown as { client: { rawRequest: (q: string, v: Record<string, unknown>) => Promise<unknown> } }).client;
      const client = {
        client: {
          rawRequest: async (q: string, v: Record<string, unknown>) =>
            q.includes("ReorgLabelRestore") ? { data: { issueLabelRestore: { success: true } }, headers: undefined } : inner.rawRequest(q, v),
        },
      } as unknown as LinearClient;
      await expect(rollbackPhase(client, j, 5, { ...opts, apply: true, restoreRetired: true })).rejects.toThrow(ReorgMismatch);
      expect(be.issues.get("i-1")!.teamId).toBe("t-b");
    });

    test("--restore-retired restores it (verified) and then moves back with the source labels", async () => {
      const { be, j } = await moved();
      const lines: string[] = [];
      const dry = await rollbackPhase(fakeClient(be), j, 5, { ...opts, restoreRetired: true, onEvent: (e) => lines.push(e.detail) });
      expect(dry.dryRun).toBe(true);
      expect(lines.join("\n")).toContain("would restore retired label");
      expect(be.mutationCalls).toEqual([]);
      await rollbackPhase(fakeClient(be), j, 5, { ...opts, apply: true, restoreRetired: true });
      expect(be.labels.get(L_SRC_BUG)!.retiredAt).toBeNull();
      expect(be.mutationCalls).toContain("issueLabelRestore");
      const i = be.issues.get("i-1")!;
      expect(i.teamId).toBe("t-a");
      expect([...i.labelIds].sort()).toEqual([L_SRC_BUG, L_WS].sort());
    });
  });

  describe("rollback", () => {
    test("restores the source team and the source labels recorded in `before`; retires the created label", async () => {
      const be = backend();
      const j = join(dir, "j.jsonl");
      green(j);
      // the plan's census copy of the labels is stale; the journal's `before` is the truth
      const ops = [
        createOp(1, "t-b", "bug"),
        moveWith(2, { [L_SRC_BUG]: "created:1" }, {
          from: { teamId: "t-a", projectId: "p-1", cycleId: null, stateId: "s-todo", labelIds: [L_SRC_OTHER] },
        }),
      ];
      await applyPlan(be, ops, j);
      const made = [...be.labels.values()].find((l) => l.teamId === "t-b" && l.name === "bug")!;
      expect(be.issues.get("i-1")!.labelIds).toContain(made.id);

      const rb = await rollbackPhase(fakeClient(be), j, 5, { pace: fastPace(), apply: true, verifyDelaysMs: [0], sleep: async () => {} });
      expect(rb.rolledBack).toBe(2);
      const i = be.issues.get("i-1")!;
      expect(i.teamId).toBe("t-a");
      expect([...i.labelIds].sort()).toEqual([L_SRC_BUG, L_WS].sort());
      expect(be.labels.get(made.id)!.retiredAt).not.toBeNull();
    });
  });

  describe("created:<seq> must name a label of the destination team or its parent", () => {
    test("a create in an unrelated team is refused by --check and before ANY write on apply", async () => {
      const be = backend();
      const j = join(dir, "j.jsonl");
      green(j);
      const ops = [createOp(1, "t-u", "bug"), moveWith(2, { [L_SRC_BUG]: "created:1" })];
      const chk = await events(be, ops, { journalPath: j });
      expect(chk.r.refused).toEqual([2]);
      expect(chk.lines.join("\n")).toMatch(/targets team t-u, but the move's destination is BBB/);
      await expect(applyPlan(be, ops, j)).rejects.toThrow("the label must belong to the destination team or its parent");
      expect(be.mutationCalls).toEqual([]); // the create (seq 1) never landed
    });

    test("a create in the destination's parent is accepted", async () => {
      const be = backend();
      const j = join(dir, "j.jsonl");
      green(j);
      const move = moveWith(2, { [L_SRC_BUG]: "created:1" }, { to: { teamId: "t-s", labelMap: { [L_SRC_BUG]: "created:1" }, reapplyLabelIds: [] } });
      const chk = await events(be, [createOp(1, "t-p", "bug"), move], { journalPath: j });
      expect(chk.r.refused).toEqual([]);
      const res = await applyPlan(be, [createOp(1, "t-p", "bug"), move], j);
      expect(res.applied).toBe(2);
    });
  });

  describe("--prior-journal gates", () => {
    const writeJ = (name: string, recs: JournalRecord[]) => {
      const p = join(dir, name);
      for (const r of recs) journalAppend(p, r);
      return p;
    };
    const mk = (phase: number, at: string, ok: boolean): JournalRecord => ({ seq: "verify", phase, at, ok });
    const move = () => moveWith(2, { [L_SRC_BUG]: L_WS });

    test("green markers only in the prior journal satisfy the gate; the prior file is never written or resumed", async () => {
      const be = backend();
      const prior = writeJ("prior.jsonl", [
        mk(1, "2026-10-05T00:00:01Z", true), mk(2, "2026-10-05T00:00:02Z", true),
        // an ok op record for the same seq in the prior journal must NOT be resumed
        { seq: 2, phase: 5, op: "move-issue-team", at: "2026-10-05T00:00:03Z", ok: true },
      ]);
      const before = readFileSync(prior, "utf8");
      const res = await applyPlan(be, [move()], join(dir, "cur.jsonl"), { priorJournalPaths: [prior], resume: true });
      expect(res.applied).toBe(1);
      expect(res.skipped).toBe(0);
      expect(be.issues.get("i-1")!.teamId).toBe("t-b");
      expect(readFileSync(prior, "utf8")).toBe(before);
    });

    test("without the prior journal the same plan is refused", async () => {
      const be = backend();
      await expect(applyPlan(be, [move()], join(dir, "cur.jsonl"))).rejects.toThrow("phase-1 verify");
    });

    test("a LATER red marker anywhere fails the gate (in the current journal, or in another prior)", async () => {
      const be = backend();
      const prior = writeJ("prior.jsonl", [mk(1, "2026-10-05T00:00:01Z", true), mk(2, "2026-10-05T00:00:02Z", true)]);
      const cur = writeJ("cur.jsonl", [mk(1, "2026-10-05T00:00:09Z", false)]);
      await expect(applyPlan(be, [move()], cur, { priorJournalPaths: [prior] })).rejects.toThrow("phase-1 verify");
      const prior2 = writeJ("prior2.jsonl", [mk(2, "2026-10-05T00:00:07Z", false)]);
      const cur2 = writeJ("cur2.jsonl", [mk(1, "2026-10-05T00:00:03Z", true)]);
      await expect(applyPlan(be, [move()], cur2, { priorJournalPaths: [prior, prior2] })).rejects.toThrow("phase-2 verify");
      expect(be.mutationCalls).toEqual([]);
    });

    test("an EARLIER red followed by a later green passes (latest wins)", async () => {
      const be = backend();
      const prior = writeJ("prior.jsonl", [
        mk(1, "2026-10-05T00:00:01Z", false), mk(1, "2026-10-05T00:00:05Z", true), mk(2, "2026-10-05T00:00:06Z", true),
      ]);
      const res = await applyPlan(be, [move()], join(dir, "cur.jsonl"), { priorJournalPaths: [prior] });
      expect(res.applied).toBe(1);
    });

    test("a missing prior journal is an error, not an empty gate", async () => {
      const be = backend();
      await expect(applyPlan(be, [move()], join(dir, "cur.jsonl"), { priorJournalPaths: [join(dir, "nope.jsonl")] })).rejects.toThrow("does not exist");
    });

    test("journalPhaseVerifiedAcross: the current journal decides alone; priors only when it has no marker", () => {
      const m = (ok: boolean, at = "2026-10-05T00:00:01Z"): JournalRecord => ({ seq: "verify", phase: 1, at, ok });
      const noClock = { seq: "verify", phase: 1, ok: false } as unknown as JournalRecord; // missing `at`
      // prior green + current red with a missing timestamp -> NOT verified
      expect(journalPhaseVerifiedAcross([[m(true, "2026-10-06T00:00:00Z")]], [noClock], 1)).toBe(false);
      expect(journalPhaseVerifiedAcross([[m(true)]], [], 1)).toBe(true);
      expect(journalPhaseVerifiedAcross([[m(false)]], [], 1)).toBe(false);
      expect(journalPhaseVerifiedAcross([[m(false)]], [m(true)], 1)).toBe(true);
      // every prior journal with a marker must end green
      expect(journalPhaseVerifiedAcross([[m(true)], [m(false)]], [], 1)).toBe(false);
      // file order inside one journal
      expect(journalPhaseVerifiedAcross([], [m(true, "2026-10-05T00:00:05Z"), m(false, "2026-10-05T00:00:01Z")], 1)).toBe(false);
      expect(journalPhaseVerifiedAcross([], [], 1)).toBe(false);
    });
  });

  test("parsePlanFile rejects a malformed labelMap and a nameless create-team-label", () => {
    const hdr = JSON.stringify({ _meta: { generated: "g", censusHash: "c", workspaceId: "w", rulesHash: "r" } });
    const write = (op: ReorgOp) => { const p = join(dir, "p.jsonl"); writeFileSync(p, `${hdr}\n${JSON.stringify(op)}\n`); return p; };
    expect(() => parsePlanFile(write(moveWith(1, { a: 5 as unknown as string })))).toThrow("labelMap");
    expect(() => parsePlanFile(write(createOp(1, "t-b", "")))).toThrow("to.name");
    expect(parsePlanFile(write(createOp(1, "t-b", "x"))).ops).toHaveLength(1);
  });
});

describe("archive-state and inherited workflow states", () => {
  function stateBackend(): FakeBackend {
    const be = freshBackend();
    be.states.set("s-owner", { id: "s-owner", name: "Review", type: "started", archivedAt: null, teamKey: "PPP" });
    be.states.set("s-view", { id: "s-view", name: "Review", type: "started", archivedAt: null, inheritedFrom: "s-owner", teamKey: "SSS" });
    return be;
  }
  const archive = (id: string, ident: string) =>
    baseOp({
      phase: 2, op: "archive-state", reversible: false, approval: "deck-1",
      target: { type: "state", id, identifier: ident }, from: { archived: false }, to: { archived: true },
    });
  const run = async (be: FakeBackend, ops: ReorgOp[], extra: Partial<Parameters<typeof runPlan>[2]>) => {
    const lines: string[] = [];
    const r = await runPlan(fakeClient(be), planWith(ops), {
      apply: false, resume: false, allowIrreversible: true, journalPath: join(dir, "s.jsonl"),
      pace: fastPace(), onEvent: (e) => lines.push(e.detail), ...extra,
    });
    return { r, lines: lines.join("\n") };
  };

  test("an inherited view refuses on apply, with no write", async () => {
    const be = stateBackend();
    await expect(applyPlan(be, [archive("s-view", "SSS/Review")], join(dir, "j.jsonl"), { allowIrreversible: true }))
      .rejects.toThrow("act on the owner state");
    expect(be.mutationCalls).toEqual([]);
  });

  test("--check reports an inherited view as REFUSE", async () => {
    const be = stateBackend();
    const { r, lines } = await run(be, [archive("s-view", "SSS/Review")], { check: true });
    expect(r.refused).toEqual([1]);
    expect(lines).toContain("act on the owner state");
  });

  test("--check and the plain dry run list the inherited views an owner archive takes with it", async () => {
    const be = stateBackend();
    const chk = await run(be, [archive("s-owner", "PPP/Review")], { check: true });
    expect(chk.r.refused).toEqual([]);
    expect(chk.lines).toContain("will also archive 1 inherited view(s): SSS/Review");
    const dry = await run(be, [archive("s-owner", "PPP/Review")], {});
    expect(dry.lines).toContain("will also archive 1 inherited view(s): SSS/Review");
    expect(be.mutationCalls).toEqual([]);
  });

  test("an owner whose inherited view still holds issues refuses naming the view", async () => {
    const be = stateBackend();
    be.issues.set("i-1", { ...ISSUE_1, stateId: "s-view", labelIds: [] });
    await expect(applyPlan(be, [archive("s-owner", "PPP/Review")], join(dir, "j.jsonl"), { allowIrreversible: true }))
      .rejects.toThrow("inherited view SSS/Review still holds issue(s)");
    expect(be.mutationCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Team visibility guard
// ---------------------------------------------------------------------------

describe("team visibility", () => {
  const T = (id: string, priv: boolean, memberIds: string[] | null = null) => ({ id, key: id.toUpperCase(), private: priv, memberIds });

  test("rule: the move and project-add matrix", () => {
    expect(moveVisibilityChange(T("a", true), T("b", false))).toContain("every member of the workspace");
    // destination has a member the source lacks: that member GAINS access
    expect(moveVisibilityChange(T("a", true, ["u1"]), T("b", true, ["u1", "u2"]))).toContain("1 member(s) of B");
    // destination lacks source members: readers removed, not a widening
    expect(moveVisibilityChange(T("a", true, ["u1", "u2"]), T("b", true, ["u1"]))).toBeNull();
    expect(moveAccessLost(T("a", true, ["u1", "u2"]), T("b", true, ["u1"]))).toBe(1);
    expect(moveAccessLost(T("a", true, ["u1"]), T("b", true, ["u1"]))).toBe(0);
    expect(moveVisibilityChange(T("a", true, ["u1"]), T("b", true, ["u1"]))).toBeNull();
    expect(moveVisibilityChange(T("a", true, null), T("b", true, ["u1"]))).not.toBeNull(); // unknown fails closed
    expect(moveVisibilityChange(T("a", false), T("b", true, ["u1"]))).toBeNull();
    expect(moveVisibilityChange(T("a", false), T("b", false))).toBeNull();
    expect(projectTeamAddVisibilityChange([T("a", true)], [T("b", false)])).toContain("project page");
    expect(projectTeamAddVisibilityChange([T("a", true)], [T("b", true)])).toBeNull();
    expect(projectTeamAddVisibilityChange([T("a", true), T("c", false)], [T("b", false)])).toBeNull();
    expect(projectTeamAddVisibilityChange([], [T("b", false)])).toBeNull();
  });

  function visBackend(src: { private: boolean; memberIds?: string[] }, dst: { private: boolean; memberIds?: string[] }): FakeBackend {
    const be = freshBackend();
    be.teams.set("t-1", { id: "t-1", key: "EX", triageEnabled: true, deleted: false, ...src });
    be.teams.set("t-2", { id: "t-2", key: "NEW", triageEnabled: true, deleted: false, ...dst });
    be.projects.set("p-1", { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1", "t-2"], initiativeIds: [] });
    be.labels.set("11111111-1111-4111-8111-1111111110c5", { id: "11111111-1111-4111-8111-1111111110c5", name: "bug", retiredAt: null, teamId: null, teamKey: null });
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["11111111-1111-4111-8111-1111111110c5"], stateId: "s-todo" });
    return be;
  }
  const moveOp = (over: Partial<ReorgOp> = {}) => baseOp({
    seq: 5, op: "move-issue-team",
    from: { teamId: "t-1", projectId: "p-1", cycleId: null, labelIds: ["11111111-1111-4111-8111-1111111110c5"] },
    to: { teamId: "t-2", reapplyLabelIds: ["11111111-1111-4111-8111-1111111110c5"], stateId: "s-new-todo" },
    ...over,
  });
  function journal(): string {
    const j = join(dir, "j.jsonl");
    journalAppend(j, { seq: "verify", phase: 1, at: "a", ok: true });
    journalAppend(j, { seq: "verify", phase: 2, at: "b", ok: true });
    return j;
  }
  async function check(be: FakeBackend, ops: ReorgOp[]) {
    const events: string[] = [];
    const r = await runPlan(fakeClient(be), planWith(ops), {
      check: true, apply: false, resume: false, allowIrreversible: false,
      journalPath: journal(), pace: fastPace(), onEvent: (e) => events.push(`${e.kind}: ${e.detail}`),
    });
    return { r, events };
  }

  test("private -> public: apply refuses before any write, naming both teams", async () => {
    const be = visBackend({ private: true }, { private: false });
    await expect(applyPlan(be, [moveOp()], journal())).rejects.toThrow(/visibility change refused \(EX -> NEW\).*every member of the workspace/s);
    expect(be.mutationCalls).toEqual([]);
    expect(be.issues.get("i-1")!.teamId).toBe("t-1");
  });

  test("private -> public: --check reports REFUSE", async () => {
    const be = visBackend({ private: true }, { private: false });
    const { r, events } = await check(be, [moveOp()]);
    expect(r.refused).toEqual([5]);
    expect(events.some((e) => e.includes("REFUSE seq 5") && e.includes("(EX -> NEW)") && e.includes("every member of the workspace"))).toBe(true);
    expect(be.mutationCalls).toEqual([]);
  });

  test("private -> private: gaining members refused; equal and fewer allowed", async () => {
    const gain = visBackend({ private: true, memberIds: ["u1"] }, { private: true, memberIds: ["u1", "u2"] });
    await expect(applyPlan(gain, [moveOp()], journal())).rejects.toThrow(/visibility change refused.*1 member\(s\) of NEW/s);
    expect(gain.mutationCalls).toEqual([]);
    expect((await check(gain, [moveOp()])).r.refused).toEqual([5]);
    const equal = visBackend({ private: true, memberIds: ["u1"] }, { private: true, memberIds: ["u1"] });
    expect((await applyPlan(equal, [moveOp()], journal())).applied).toBe(1);
    const fewer = visBackend({ private: true, memberIds: ["u1", "u2"] }, { private: true, memberIds: ["u1"] });
    const { r, events } = await check(fewer, [moveOp()]);
    expect(r.refused).toEqual([]);
    expect(events.some((e) => e.includes("info seq 5") && e.includes("1 source member(s) lose access"))).toBe(true);
    expect((await applyPlan(fewer, [moveOp()], journal())).applied).toBe(1);
    expect(fewer.issues.get("i-1")!.teamId).toBe("t-2");
  });

  test("public -> private and public -> public are allowed", async () => {
    for (const dst of [{ private: true, memberIds: ["u1"] }, { private: false }]) {
      const be = visBackend({ private: false }, dst);
      expect((await applyPlan(be, [moveOp()], journal())).applied).toBe(1);
    }
  });

  test("opt-in allows the move and --check lists it as allowed", async () => {
    const op = moveOp({ allowVisibilityChange: true });
    const { r, events } = await check(visBackend({ private: true }, { private: false }), [op]);
    expect(r.refused).toEqual([]);
    expect(events.some((e) => e.includes("visibility change (allowed) seq 5"))).toBe(true);
    const be = visBackend({ private: true }, { private: false });
    expect((await applyPlan(be, [op], journal())).applied).toBe(1);
    expect(be.issues.get("i-1")!.teamId).toBe("t-2");
  });

  test("apply reports an opted-in visibility change as an event", async () => {
    const be = visBackend({ private: true }, { private: false });
    const events: string[] = [];
    await applyPlan(be, [moveOp({ allowVisibilityChange: true })], journal(), { onEvent: (e) => events.push(`${e.kind}: ${e.detail}`) });
    expect(events.some((e) => e.startsWith("visibility: visibility change (allowed) seq 5") && e.includes("EX -> NEW"))).toBe(true);
  });

  describe("fails closed when visibility cannot be established", () => {
    const cases: [string, (be: FakeBackend) => void][] = [
      ["source team not found", (be) => { be.teams.get("t-1")!.deleted = true; }],
      ["private flag is null", (be) => { be.teams.get("t-1")!.private = null; }],
      ["destination private flag is null", (be) => { be.teams.get("t-2")!.private = null; }],
      ["members read fails", (be) => { be.teams.get("t-2")!.membersFail = true; }],
      ["members read stuck cursor", (be) => { be.teams.get("t-1")!.membersStuck = true; }],
    ];
    test.each(cases)("%s: --check refuses, apply writes nothing", async (_n, break_) => {
      const mk = () => {
        const be = visBackend({ private: true, memberIds: ["u1"] }, { private: true, memberIds: ["u1"] });
        break_(be);
        return be;
      };
      const c = mk();
      expect((await check(c, [moveOp()])).r.refused).toEqual([5]);
      const be = mk();
      await expect(applyPlan(be, [moveOp()], journal())).rejects.toThrow();
      expect(be.mutationCalls).toEqual([]);
      expect(be.issues.get("i-1")!.teamId).toBe("t-1");
    });
  });

  test("add-project-team of a public team to an all-private project is refused", async () => {
    const be = visBackend({ private: true }, { private: false });
    be.projects.get("p-1")!.teamIds = ["t-1"];
    const op = baseOp({
      op: "add-project-team", target: { type: "project", id: "p-1", identifier: "P" },
      from: { teamIds: ["t-1"] }, to: { teamId: "t-2", teamIds: ["t-1", "t-2"] },
    });
    await expect(applyPlan(be, [op], join(dir, "j.jsonl"))).rejects.toThrow(/visibility change refused.*project page/s);
    expect(be.mutationCalls).toEqual([]);
    expect((await check(be, [op])).r.refused).toEqual([1]);
    expect((await applyPlan(be, [{ ...op, allowVisibilityChange: true }], join(dir, "j2.jsonl"))).applied).toBe(1);
  });

  test("a private team added to a private project is not a visibility change", async () => {
    const be = visBackend({ private: true }, { private: true, memberIds: [] });
    be.projects.get("p-1")!.teamIds = ["t-1"];
    const op = baseOp({
      op: "add-project-team", target: { type: "project", id: "p-1", identifier: "P" },
      from: { teamIds: ["t-1"] }, to: { teamId: "t-2", teamIds: ["t-1", "t-2"] },
    });
    expect((await applyPlan(be, [op], join(dir, "j.jsonl"))).applied).toBe(1);
  });

  test("rollback of an allowed private -> public move (a move back into the private team) is not refused", async () => {
    const be = visBackend({ private: true }, { private: false });
    const j = journal();
    expect((await applyPlan(be, [moveOp({ allowVisibilityChange: true })], j)).applied).toBe(1);
    const rb = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true });
    expect(rb.rolledBack).toBe(1);
    expect(be.issues.get("i-1")!.teamId).toBe("t-1");
    // and the rule itself: public -> private is never a change
    expect(moveVisibilityChange(T("b", false), T("a", true, ["u1"]))).toBeNull();
  });
});
