import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearClient } from "@linear/sdk";
import {
  RateTracker,
  ReorgMismatch,
  TokenBucket,
  assertFreshBackup,
  assertMovePreconditions,
  estimateRequests,
  journalAppend,
  journalOkSeqs,
  journalPhaseVerified,
  journalRead,
  parsePlanFile,
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
interface FakeLabel { id: string; name: string; retiredAt: string | null; teamId: string | null; teamKey: string | null }
interface FakeState { id: string; name: string; type: string; archivedAt: string | null }
interface FakeProject { id: string; name: string; statusId: string; leadId: string | null; targetDate: string | null; trashed: boolean; teamIds: string[]; initiativeIds: string[] }
interface FakeInitiative { id: string; name: string; archivedAt: string | null; ownerId: string | null }
interface FakeTeam { id: string; key: string; triageEnabled: boolean; deleted: boolean }

interface FakeBackend {
  issues: Map<string, FakeIssue>;
  labels: Map<string, FakeLabel>;
  states: Map<string, FakeState>;
  projects: Map<string, FakeProject>;
  initiatives: Map<string, FakeInitiative>;
  teams: Map<string, FakeTeam>;
  projectStatuses: Map<string, { id: string; name: string }>;
  swallowWrites: boolean;
  /** ids the batch mutation deliberately skips (mid-batch mismatch testing). */
  batchSkip: Set<string>;
  /** When set, the projects probe answers in two pages: the blocking project
   *  arrives on page two — an engine that drops the pagination loop misses it. */
  forceProjectPagination: boolean;
  mutationCalls: string[];
  readCalls: number;
  /** ReorgTeamProjects calls — the pagination test asserts the second page. */
  projectProbeCalls: number;
  /** Invoked after each ReorgProjectState read — tests mutate state between
   *  the drift pre-read and the apply-time live read. */
  projectReadHook?: (projectId: string) => void;
  createdLabelSeq: number;
}

function fakeClient(be: FakeBackend): LinearClient {
  const ok = (payload: Record<string, unknown>) => ({ data: payload, headers: undefined });
  const rawRequest = async (
    query: string,
    vars: Record<string, unknown>,
  ): Promise<{ data: unknown; headers: undefined }> => {
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
      return ok({ issueLabel: l ? { id: l.id, name: l.name, retiredAt: l.retiredAt, team: l.teamId ? { id: l.teamId, key: l.teamKey } : null } : null });
    }
    if (query.includes("ReorgStateState")) {
      be.readCalls++;
      const s = be.states.get(vars.id as string);
      return ok({ workflowState: s ? { id: s.id, name: s.name, type: s.type, archivedAt: s.archivedAt } : null });
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
              targetDate: p.targetDate, trashed: p.trashed,
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
    if (query.includes("ReorgFindProjectStatus")) {
      be.readCalls++;
      const nodes = [...be.projectStatuses.values()].filter((s) => s.name === vars.name);
      return ok({ projectStatuses: { nodes } });
    }
    if (query.includes("ReorgTeamState")) {
      be.readCalls++;
      const t = be.teams.get(vars.id as string);
      return ok({ team: t && !t.deleted ? { id: t.id, key: t.key, triageEnabled: t.triageEnabled } : null });
    }
    if (query.includes("ReorgFindWsLabel")) {
      be.readCalls++;
      const nodes = [...be.labels.values()].filter((l) => l.name === vars.name && l.teamId == null);
      return ok({ issueLabels: { nodes } });
    }
    if (query.includes("ReorgLabelsByNameAllScopes")) {
      be.readCalls++;
      const nodes = [...be.labels.values()].filter((l) => l.name === vars.name);
      return ok({ issueLabels: { nodes: nodes.map((l) => ({ id: l.id, name: l.name, team: l.teamId ? { id: l.teamId, key: l.teamKey } : null })) } });
    }
    if (query.includes("ReorgLabelScopes")) {
      be.readCalls++;
      const ids = vars.ids as string[];
      return ok({
        issueLabels: {
          nodes: ids.map((id) => be.labels.get(id)).filter(Boolean).map((l) => ({
            id: l!.id, name: l!.name, team: l!.teamId ? { id: l!.teamId, key: l!.teamKey } : null,
          })),
        },
      });
    }
    if (query.includes("ReorgIssuesInState")) {
      be.readCalls++;
      return ok({ issues: { nodes: [...be.issues.values()].filter((i) => i.stateId === vars.id && !i.archived).map((i) => ({ id: i.id })) } });
    }
    // The fake honours includeArchived EXACTLY like Linear: archived rows are
    // hidden unless the query carries the flag. An engine that drops the flag
    // sees a truncated world (the tests pin this).
    const inclArchived = query.includes("includeArchived: true");
    if (query.includes("ReorgTeamIssues")) {
      be.readCalls++;
      return ok({ issues: { nodes: [...be.issues.values()].filter((i) => (inclArchived || !i.archived) && i.teamId === vars.id).map((i) => ({ id: i.id })) } });
    }
    if (query.includes("ReorgTeamLabels")) {
      be.readCalls++;
      return ok({ issueLabels: { nodes: [...be.labels.values()].filter((l) => l.teamId === vars.id).map((l) => ({ id: l.id, retiredAt: l.retiredAt })) } });
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
      if (!be.swallowWrites) fn();
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
        const input = (vars.input ?? {}) as { stateId?: string; teamId?: string; addedLabelIds?: string[]; removedLabelIds?: string[] };
        if (input.teamId) {
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
        const input = vars.input as { name: string; description?: string };
        // Linear enforces label-name uniqueness ACROSS workspace + team scope
        if ([...be.labels.values()].some((l) => l.name === input.name))
          throw new Error(`Duplicate label name - Label "${input.name}" already exists`);
        const id = `l-new-${++be.createdLabelSeq}`;
        be.labels.set(id, { id, name: input.name, retiredAt: null, teamId: null, teamKey: null });
      });
    if (query.includes("ReorgLabelUpdate"))
      return W("issueLabelUpdate", () => {
        const l = be.labels.get(vars.id as string)!;
        const input = vars.input as { retiredAt?: string | null; name?: string };
        if ("retiredAt" in input) l.retiredAt = input.retiredAt ?? null;
        if (typeof input.name === "string") l.name = input.name;
      });
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
      return W("projectArchive", () => { be.projects.get(vars.id as string)!.trashed = true; });
    if (query.includes("ReorgProjectUnarchive"))
      return W("projectUnarchive", () => { be.projects.get(vars.id as string)!.trashed = false; });
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
        const input = vars.input as { name: string };
        const id = `ps-${be.projectStatuses.size + 1}`;
        be.projectStatuses.set(id, { id, name: input.name });
      });
    if (query.includes("ReorgInitJoins")) {
      be.readCalls++;
      // fake join-row id convention: "<initiativeId>:<projectId>"
      const p = be.projects.get(vars.projectId as string);
      const initId = vars.initiativeId as string;
      const member = p && p.initiativeIds.includes(initId);
      return ok({ initiativeToProjects: { nodes: member ? [{ id: `${initId}:${p!.id}` }] : [] } });
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
    projectStatuses: new Map(),
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
  id: "i-1", identifier: "EX-1", stateId: "s-todo", labelIds: ["l-a"],
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
    journalPath, backupRecordPath: freshBackup(), pace: fastPace(), ...extra,
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
    be.issues.set("i-2", { ...ISSUE_1, id: "i-2", identifier: "EX-2", labelIds: ["l-a"] });
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
      be.issues.set(id, { ...ISSUE_1, id, identifier: `EX-${n}`, labelIds: ["l-a"] });
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
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["l-a", "l-b"] });
    be.labels.set("l-a", { id: "l-a", name: "a", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    be.labels.set("l-b", { id: "l-b", name: "b", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    be.labels.set("l-ws", { id: "l-ws", name: "bug", retiredAt: null, teamId: null, teamKey: null });
    await triple(be, baseOp({
      op: "relabel",
      from: { labelIds: ["l-a", "l-b"] },
      to: { add: ["l-ws"], remove: ["l-a"] },
    }), {
      afterApply: () => expect([...be.issues.get("i-1")!.labelIds].sort()).toEqual(["l-b", "l-ws"]),
      afterRollback: () => expect([...be.issues.get("i-1")!.labelIds].sort()).toEqual(["l-a", "l-b"]),
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

  test("archive-project", async () => {
    const be = freshBackend();
    be.projects.set("p-1", { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1"], initiativeIds: [] });
    await triple(be, baseOp({
      op: "archive-project", target: { type: "project", id: "p-1", identifier: "P" },
      from: { trashed: false }, to: { trashed: true },
    }), {
      afterApply: () => expect(be.projects.get("p-1")!.trashed).toBe(true),
      afterRollback: () => expect(be.projects.get("p-1")!.trashed).toBe(false),
    });
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
    be.labels.set("l-t", { id: "l-t", name: "teambug", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    await triple(be, baseOp({
      op: "retire-or-delete-label", target: { type: "label", id: "l-t", identifier: "EX/teambug" },
      from: { retired: false }, to: { retired: true },
    }), {
      afterApply: () => expect(be.labels.get("l-t")!.retiredAt).not.toBeNull(),
      afterRollback: () => expect(be.labels.get("l-t")!.retiredAt).toBeNull(),
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
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["l-a"] });
    // seeded WITHOUT the destination team: the drift check passes and the
    // swallowed write (not the drift abort) is what the verify catches
    be.projects.set("p-1", { id: "p-1", name: "P", statusId: "st", leadId: null, targetDate: null, trashed: false, teamIds: ["t-1"], initiativeIds: [] });
    let op: ReorgOp;
    if (kind === "relabel") {
      op = baseOp({ op: kind, from: { labelIds: ["l-a"] }, to: { add: ["l-ws"], remove: [] } });
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
        from: { teamId: "t-1", projectId: "p-1", cycleId: null, labelIds: ["l-a"] },
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
      be.issues.set(id, { ...ISSUE_1, id, identifier: `EX-${n}`, labelIds: ["l-a"] });
      ops.push(baseOp({
        seq: n, op: "relabel", target: { type: "issue", id, identifier: `EX-${n}` },
        from: { labelIds: ["l-a"] }, to: { add: ["l-b"], remove: [] }, batchKey: "k",
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
      be.issues.set(id, { ...ISSUE_1, id, identifier: `EX-${n}`, labelIds: ["l-a"], archived: n === 2 });
      ops.push(baseOp({
        seq: n, op: "relabel", target: { type: "issue", id, identifier: `EX-${n}` },
        from: { labelIds: ["l-a"] }, to: { add: ["l-b"], remove: [] }, batchKey: "k",
      }));
    }
    const result = await applyPlan(be, ops, join(dir, "j.jsonl"));
    expect(result.applied).toBe(2);
    expect(be.mutationCalls.filter((c) => c === "issueBatchUpdate")).toHaveLength(1);
    expect(be.issues.get("i-2")!.labelIds).toContain("l-b"); // archived member relabeled
  });

  test("mid-batch mismatch: good members journaled ok, bad one marked ok:false, then stop", async () => {
    const be = freshBackend();
    const ops: ReorgOp[] = [];
    for (const n of [1, 2, 3]) {
      const id = `i-${n}`;
      be.issues.set(id, { ...ISSUE_1, id, identifier: `EX-${n}`, labelIds: ["l-a"] });
      ops.push(baseOp({
        seq: n, op: "relabel", target: { type: "issue", id, identifier: `EX-${n}` },
        from: { labelIds: ["l-a"] }, to: { add: ["l-b"], remove: [] }, batchKey: "k",
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
    be.labels.set("l-team", { id: "l-team", name: "teambug", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    be.labels.set("l-ws", { id: "l-ws", name: "bug", retiredAt: null, teamId: null, teamKey: null });
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["l-ws"], stateId: "s-todo" });
    return be;
  }
  const moveOp = baseOp({
    seq: 5, op: "move-issue-team",
    from: { teamId: "t-1", projectId: "p-1", cycleId: null, labelIds: ["l-ws"] },
    to: { teamId: "t-2", reapplyLabelIds: ["l-ws"], stateId: "s-new-todo" },
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
    expect(i.labelIds).toContain("l-ws");
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
    be.issues.get("i-1")!.labelIds = ["l-ws", "l-team"]; // team label still on it
    const j = join(dir, "j.jsonl");
    journalAppend(j, { seq: "verify", phase: 1, at: "a", ok: true });
    journalAppend(j, { seq: "verify", phase: 2, at: "b", ok: true });
    await expect(applyPlan(be, [moveOp], j)).rejects.toThrow("(a)");
    expect(be.mutationCalls).toEqual([]);
  });

  test("(a) passes when the team label's swap is journaled into reapplyLabelIds", async () => {
    const be = moveBackend();
    be.issues.get("i-1")!.labelIds = ["l-ws", "l-team"];
    const j = join(dir, "j.jsonl");
    journalAppend(j, { seq: "verify", phase: 1, at: "a", ok: true });
    journalAppend(j, { seq: "verify", phase: 2, at: "b", ok: true });
    journalAppend(j, {
      seq: 2, phase: 1, op: "relabel", at: "c", ok: true,
      original: baseOp({
        seq: 2, op: "relabel", target: { type: "issue", id: "i-1", identifier: "EX-1" },
        from: { labelIds: ["l-team"] }, to: { add: ["l-ws"], remove: ["l-team"] },
      }),
    });
    const result = await applyPlan(be, [moveOp], j);
    expect(result.applied).toBe(1);
    const i = be.issues.get("i-1")!;
    expect(i.teamId).toBe("t-2");
    expect(i.labelIds).not.toContain("l-team"); // dropped by the move, as designed
    expect(i.labelIds).toContain("l-ws");
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
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["l-a"] });
    const j = join(dir, "j.jsonl");
    const ops = [
      baseOp({
        seq: 1, op: "create-workspace-label",
        target: { type: "label", id: "new:bug", identifier: "bug" },
        from: { labelId: null }, to: { name: "bug", color: "#e5484d" },
      }),
      baseOp({
        seq: 2, op: "relabel",
        from: { labelIds: ["l-a"] },
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
    be.labels.set("l-ws", { id: "l-ws", name: "bug", retiredAt: null, teamId: null, teamKey: null });
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["l-a"] });
    const result = await applyPlan(be, [baseOp({
      op: "relabel", from: { labelIds: ["l-a"] }, to: { add: ["name:bug"], remove: [] },
    })], join(dir, "j.jsonl"));
    expect(result.applied).toBe(1);
    expect(be.issues.get("i-1")!.labelIds).toContain("l-ws");
  });

  test("ambiguity and zero hits both refuse", async () => {
    const be = freshBackend();
    be.labels.set("l-1", { id: "l-1", name: "dup", retiredAt: null, teamId: null, teamKey: null });
    be.labels.set("l-2", { id: "l-2", name: "dup", retiredAt: null, teamId: null, teamKey: null });
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["l-a"] });
    await expect(applyPlan(be, [baseOp({
      op: "relabel", from: { labelIds: ["l-a"] }, to: { add: ["name:dup"], remove: [] },
    })], join(dir, "j.jsonl"))).rejects.toThrow("ambiguous");
    await expect(applyPlan(be, [baseOp({
      op: "relabel", from: { labelIds: ["l-a"] }, to: { add: ["name:ghost"], remove: [] },
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
    be.labels.set("l-t", { id: "l-t", name: "bug", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    const j = join(dir, "j.jsonl");
    const op = baseOp({
      op: "rename-label", target: { type: "label", id: "l-t", identifier: "EX/bug" },
      from: { name: "bug" }, to: { name: "bug·old-EX" },
    });
    await applyPlan(be, [op], j);
    expect(be.labels.get("l-t")!.name).toBe("bug·old-EX");
    const v = await verifyPhase(fakeClient(be), planWith([op]), 1, { journalPath: j, pace: fastPace() });
    expect(v.ok).toBe(true);
    const rb = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true });
    expect(rb.rolledBack).toBe(1);
    expect(be.labels.get("l-t")!.name).toBe("bug");
  });

  describe("rollback gate + planner-shaped rename journal", () => {
    // Planner-shaped row: `from` carries {retired} but NOT the old name; the old
    // name lives only in the journaled live read (`before`).
    function seedRename(be: FakeBackend, liveName: string): string {
      be.labels.set("l-t", { id: "l-t", name: liveName, retiredAt: null, teamId: "t-1", teamKey: "EX" });
      const j = join(dir, "rb.jsonl");
      journalAppend(j, {
        seq: 6, phase: 1, op: "rename-label", at: "t", ok: true,
        original: baseOp({
          seq: 6, op: "rename-label", target: { type: "label", id: "l-t", identifier: "EX/ci" },
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
      expect(be.labels.get("l-t")!.name).toBe("ci·old-EX");
      expect(events[0]).toContain("would revert");
      expect(events[0]).toContain('"name":"ci"');
    });

    test("--apply restores the name when live equals the journaled after-state", async () => {
      const be = freshBackend();
      const j = seedRename(be, "ci·old-EX");
      const r = await rollbackPhase(fakeClient(be), j, 1, { pace: fastPace(), apply: true });
      expect(r.rolledBack).toBe(1);
      expect(be.labels.get("l-t")!.name).toBe("ci");
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
      expect(be.labels.get("l-t")!.name).toBe("someone-renamed-it");
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
    be.labels.set("l-t", { id: "l-t", name: "bug", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    await expect(applyPlan(be, [baseOp({
      op: "create-workspace-label", target: { type: "label", id: "new:bug", identifier: "bug" },
      from: { labelId: null }, to: { name: "bug" },
    })], join(dir, "j.jsonl"))).rejects.toThrow("Duplicate label name");
  });

  test("--check flags the name conflict as drift; a planned rename clears it", async () => {
    const be = freshBackend();
    be.labels.set("l-t", { id: "l-t", name: "bug", retiredAt: null, teamId: "t-1", teamKey: "EX" });
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
      seq: 1, op: "rename-label", target: { type: "label", id: "l-t", identifier: "EX/bug" },
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
    be.issues.set("i-1", { ...ISSUE_1, labelIds: ["l-a"] });
    be.labels.set("l-live", { id: "l-live", name: "bug", retiredAt: null, teamId: null, teamKey: null });
    const j = join(dir, "j.jsonl");
    // a create landed earlier in THIS plan (journal carries the created id)
    journalAppend(j, {
      seq: 1, phase: 1, op: "create-workspace-label", at: "a", ok: true,
      original: baseOp({
        seq: 1, op: "create-workspace-label",
        target: { type: "label", id: "new:bug", identifier: "bug" },
        from: { labelId: null }, to: { name: "bug", labelId: "l-journaled" },
      }),
    });
    const result = await applyPlan(be, [baseOp({
      seq: 2, op: "relabel", from: { labelIds: ["l-a"] }, to: { add: ["name:bug"], remove: [] },
    })], j);
    expect(result.applied).toBe(1);
    expect(be.issues.get("i-1")!.labelIds).toContain("l-journaled");
    expect(be.issues.get("i-1")!.labelIds).not.toContain("l-live");
  });

  test("rename-label drift anchor: refuses when the live name differs from from.name", async () => {
    const be = freshBackend();
    be.labels.set("l-t", { id: "l-t", name: "renamed-elsewhere", retiredAt: null, teamId: "t-1", teamKey: "EX" });
    await expect(applyPlan(be, [baseOp({
      op: "rename-label", target: { type: "label", id: "l-t", identifier: "EX/bug" },
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
