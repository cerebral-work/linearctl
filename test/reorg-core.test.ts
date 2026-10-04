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
// Fake Linear backend over the rawRequest seam (test/pull.test.ts pattern)
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

interface FakeBackend {
  issues: Map<string, FakeIssue>;
  /** When true, mutations are swallowed (verify then sees no change). */
  swallowWrites: boolean;
  mutationCalls: string[];
  readCalls: number;
}

function fakeClient(backend: FakeBackend): LinearClient {
  const rawRequest = async (
    query: string,
    vars: Record<string, unknown>,
  ): Promise<{ data: unknown; headers: undefined }> => {
    if (query.includes("ReorgIssueState")) {
      backend.readCalls++;
      const i = backend.issues.get(vars.id as string);
      return {
        data: {
          issue: i
            ? {
                id: i.id,
                identifier: i.identifier,
                state: { id: i.stateId, name: "Todo", type: "unstarted" },
                labels: { nodes: i.labelIds.map((id) => ({ id })) },
                project: i.projectId ? { id: i.projectId } : null,
                cycle: i.cycleId ? { id: i.cycleId } : null,
                team: { id: i.teamId, key: i.teamKey },
                archivedAt: i.archived ? "2026-01-01T00:00:00Z" : null,
                trashed: false,
              }
            : null,
        },
        headers: undefined,
      };
    }
    if (query.includes("ReorgBatchVerify")) {
      backend.readCalls++;
      const ids = vars.ids as string[];
      return {
        data: {
          issues: {
            nodes: ids
              .map((id) => backend.issues.get(id))
              .filter(Boolean)
              .map((i) => ({
                id: i!.id,
                state: { id: i!.stateId },
                labels: { nodes: i!.labelIds.map((id) => ({ id })) },
              })),
          },
        },
        headers: undefined,
      };
    }
    if (query.includes("ReorgBatchUpdate")) {
      backend.mutationCalls.push("batchUpdate");
      if (!backend.swallowWrites) {
        const input = (vars.input ?? {}) as {
          stateId?: string;
          addedLabelIds?: string[];
          removedLabelIds?: string[];
        };
        for (const id of vars.ids as string[]) {
          const i = backend.issues.get(id);
          if (!i) continue;
          if (input.stateId) i.stateId = input.stateId;
          for (const l of input.addedLabelIds ?? [])
            if (!i.labelIds.includes(l)) i.labelIds.push(l);
          for (const l of input.removedLabelIds ?? [])
            i.labelIds = i.labelIds.filter((x) => x !== l);
        }
      }
      return { data: { issueBatchUpdate: { success: true } }, headers: undefined };
    }
    if (query.includes("ReorgIssueUpdate")) {
      backend.mutationCalls.push(`issueUpdate:${String(vars.id)}`);
      if (!backend.swallowWrites) {
        const i = backend.issues.get(vars.id as string);
        const input = (vars.input ?? {}) as {
          stateId?: string;
          teamId?: string;
          addedLabelIds?: string[];
          removedLabelIds?: string[];
        };
        if (i) {
          if (input.stateId) i.stateId = input.stateId;
          if (input.teamId) i.teamId = input.teamId;
          for (const l of input.addedLabelIds ?? [])
            if (!i!.labelIds.includes(l)) i!.labelIds.push(l);
          for (const l of input.removedLabelIds ?? [])
            i!.labelIds = i!.labelIds.filter((x) => x !== l);
        }
      }
      return { data: { issueUpdate: { success: true } }, headers: undefined };
    }
    throw new Error(`fake backend: unhandled query: ${query.slice(0, 60)}`);
  };
  return { client: { rawRequest } } as unknown as LinearClient;
}

function fastPace() {
  return {
    bucket: new TokenBucket(1e9, 200),
    tracker: new RateTracker(),
  };
}

function issueOp(over: Partial<ReorgOp>): ReorgOp {
  return {
    seq: 1,
    phase: 1,
    op: "set-state",
    target: { type: "issue", id: "i-1", identifier: "EX-1" },
    from: { stateId: "s-todo" },
    to: { stateId: "s-done" },
    evidence: "test",
    reversible: true,
    ...over,
  };
}

function planWith(ops: ReorgOp[]): ReorgPlan {
  return {
    meta: { generated: "2026-10-04T00:00:00Z", censusHash: "c", workspaceId: "w", rulesHash: "r" },
    ops,
  };
}

const ISSUE_1: FakeIssue = {
  id: "i-1",
  identifier: "EX-1",
  stateId: "s-todo",
  labelIds: ["l-a"],
  projectId: "p-1",
  cycleId: null,
  teamId: "t-1",
  teamKey: "EX",
  archived: false,
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reorg-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function freshBackup(): string {
  const p = join(dir, "backup.verified.json");
  writeFileSync(p, JSON.stringify({ verifiedAt: new Date().toISOString() }));
  return p;
}

// ---------------------------------------------------------------------------

describe("parsePlanFile", () => {
  test("round-trips a valid plan and sorts by seq", () => {
    const p = join(dir, "plan.jsonl");
    const ops = [issueOp({ seq: 2 }), issueOp({ seq: 1 })];
    writeFileSync(
      p,
      JSON.stringify({ _meta: planWith(ops).meta }) + "\n" +
        ops.map((o) => JSON.stringify(o)).join("\n") + "\n",
    );
    const plan = parsePlanFile(p);
    expect(plan.ops.map((o) => o.seq)).toEqual([1, 2]);
    expect(plan.meta.workspaceId).toBe("w");
  });

  test("rejects duplicate seq, unknown op, irreversible outside phase 6, irreversible without approval", () => {
    const p = join(dir, "plan.jsonl");
    const write = (ops: unknown[]) =>
      writeFileSync(
        p,
        JSON.stringify({ _meta: planWith([]).meta }) + "\n" +
          ops.map((o) => JSON.stringify(o)).join("\n") + "\n",
      );
    write([issueOp({ seq: 1 }), issueOp({ seq: 1 })]);
    expect(() => parsePlanFile(p)).toThrow("duplicate seq");
    write([issueOp({ op: "nonsense" as never })]);
    expect(() => parsePlanFile(p)).toThrow("unknown op");
    write([issueOp({ reversible: false, phase: 2, approval: "deck-1", op: "archive-state" })]);
    expect(() => parsePlanFile(p)).toThrow("phase-6 only");
    write([issueOp({ reversible: false, phase: 6, op: "delete-team" })]);
    expect(() => parsePlanFile(p)).toThrow("needs an approval id");
    write([issueOp({ reversible: false, phase: 6, approval: "d", op: "set-state" })]);
    expect(() => parsePlanFile(p)).toThrow("no irreversible form");
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
    expect(journalPhaseVerified(recs, 2)).toBe(false);
    // content actually on disk (fsync path)
    expect(readFileSync(j, "utf8").trim().split("\n")).toHaveLength(3);
  });
});

describe("backup freshness gate", () => {
  test("fresh passes; missing, stale, and malformed fail closed", () => {
    expect(() => assertFreshBackup(freshBackup())).not.toThrow();
    expect(() => assertFreshBackup(join(dir, "nope.json"))).toThrow("requires a fresh backup");
    const stale = join(dir, "stale.json");
    writeFileSync(stale, JSON.stringify({ verifiedAt: "2026-10-03T00:00:00Z" }));
    expect(() => assertFreshBackup(stale, new Date("2026-10-04T12:00:00Z"))).toThrow("stale");
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{}");
    expect(() => assertFreshBackup(bad)).toThrow("verifiedAt");
  });
});

describe("runPlan executor", () => {
  test("dry-run default: zero API calls, prints per-op diff + budget", async () => {
    const backend: FakeBackend = { issues: new Map([["i-1", { ...ISSUE_1 }]]), swallowWrites: false, mutationCalls: [], readCalls: 0 };
    const events: string[] = [];
    const result = await runPlan(fakeClient(backend), planWith([issueOp({})]), {
      apply: false,
      resume: false,
      allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"),
      pace: fastPace(),
      onEvent: (e) => events.push(`${e.kind}:${e.detail}`),
    });
    expect(result.dryRun).toBe(true);
    expect(backend.readCalls).toBe(0);
    expect(backend.mutationCalls).toEqual([]);
    expect(events.some((e) => e.startsWith("dry:seq 1"))).toBe(true);
    expect(events.some((e) => e.includes("request(s)"))).toBe(true);
  });

  test("apply: pre-read → write → re-read → journal; state lands", async () => {
    const backend: FakeBackend = { issues: new Map([["i-1", { ...ISSUE_1 }]]), swallowWrites: false, mutationCalls: [], readCalls: 0 };
    const j = join(dir, "j.jsonl");
    const result = await runPlan(fakeClient(backend), planWith([issueOp({})]), {
      apply: true, resume: false, allowIrreversible: false,
      journalPath: j, backupRecordPath: freshBackup(), pace: fastPace(),
    });
    expect(result).toEqual({ applied: 1, skipped: 0, dryRun: false });
    expect(backend.issues.get("i-1")!.stateId).toBe("s-done");
    const recs = journalRead(j);
    expect(recs).toHaveLength(1);
    expect(recs[0].ok).toBe(true);
    expect(recs[0].original?.op).toBe("set-state");
  });

  test("drift abort: live ≠ from, no mutation attempted", async () => {
    const backend: FakeBackend = { issues: new Map([["i-1", { ...ISSUE_1, stateId: "s-progress" }]]), swallowWrites: false, mutationCalls: [], readCalls: 0 };
    await expect(
      runPlan(fakeClient(backend), planWith([issueOp({})]), {
        apply: true, resume: false, allowIrreversible: false,
        journalPath: join(dir, "j.jsonl"), backupRecordPath: freshBackup(), pace: fastPace(),
      }),
    ).rejects.toBeInstanceOf(ReorgMismatch);
    expect(backend.mutationCalls).toEqual([]);
  });

  test("first-mismatch stop: swallowed write → exit, later ops never attempted", async () => {
    const i2: FakeIssue = { ...ISSUE_1, id: "i-2", identifier: "EX-2" };
    const backend: FakeBackend = { issues: new Map([["i-1", { ...ISSUE_1 }], ["i-2", i2]]), swallowWrites: true, mutationCalls: [], readCalls: 0 };
    const j = join(dir, "j.jsonl");
    await expect(
      runPlan(fakeClient(backend), planWith([issueOp({}), issueOp({ seq: 2, target: { type: "issue", id: "i-2", identifier: "EX-2" } })]), {
        apply: true, resume: false, allowIrreversible: false,
        journalPath: j, backupRecordPath: freshBackup(), pace: fastPace(),
      }),
    ).rejects.toBeInstanceOf(ReorgMismatch);
    expect(backend.mutationCalls).toEqual(["issueUpdate:i-1"]); // EX-2 never written
    expect(journalRead(j)).toHaveLength(0); // nothing journaled ok
  });

  test("resume: journaled-ok seqs are skipped", async () => {
    const backend: FakeBackend = { issues: new Map([["i-1", { ...ISSUE_1 }]]), swallowWrites: false, mutationCalls: [], readCalls: 0 };
    const j = join(dir, "j.jsonl");
    journalAppend(j, { seq: 1, phase: 1, op: "set-state", at: "a", ok: true });
    const result = await runPlan(fakeClient(backend), planWith([issueOp({})]), {
      apply: true, resume: true, allowIrreversible: false,
      journalPath: j, backupRecordPath: freshBackup(), pace: fastPace(),
    });
    expect(result.skipped).toBe(1);
    expect(backend.mutationCalls).toEqual([]);
  });

  test("batch cap: 51 same-batchKey relabel ops → one batchUpdate (50) + one single write", async () => {
    const issues = new Map<string, FakeIssue>();
    const ops: ReorgOp[] = [];
    for (let n = 1; n <= 51; n++) {
      const id = `i-${n}`;
      // fresh array per issue — sharing ISSUE_1.labelIds would alias all 51
      issues.set(id, { ...ISSUE_1, labelIds: [...ISSUE_1.labelIds], id, identifier: `EX-${n}` });
      ops.push(issueOp({
        seq: n,
        op: "relabel",
        target: { type: "issue", id, identifier: `EX-${n}` },
        from: { labelIds: ["l-a"] },
        to: { add: ["l-b"], remove: [] },
        batchKey: "add-l-b",
      }));
    }
    const backend: FakeBackend = { issues, swallowWrites: false, mutationCalls: [], readCalls: 0 };
    const result = await runPlan(fakeClient(backend), planWith(ops), {
      apply: true, resume: false, allowIrreversible: false,
      journalPath: join(dir, "j.jsonl"), backupRecordPath: freshBackup(), pace: fastPace(),
    });
    expect(result.applied).toBe(51);
    expect(backend.mutationCalls.filter((c) => c === "batchUpdate")).toHaveLength(1);
    expect(backend.mutationCalls.filter((c) => c.startsWith("issueUpdate"))).toHaveLength(1);
    expect(backend.readCalls).toBe(53); // 50 batch drift reads + 1 batch verify + solo drift read + solo post-write re-read
  });

  test("gated: --apply refuses without a backup record; irreversible refuses without the flag", async () => {
    const backend: FakeBackend = { issues: new Map([["i-1", { ...ISSUE_1 }]]), swallowWrites: false, mutationCalls: [], readCalls: 0 };
    await expect(
      runPlan(fakeClient(backend), planWith([issueOp({})]), {
        apply: true, resume: false, allowIrreversible: false,
        journalPath: join(dir, "j.jsonl"), pace: fastPace(),
      }),
    ).rejects.toThrow("--backup-record");
    const del: ReorgOp = issueOp({
      seq: 9, phase: 6, op: "delete-team", reversible: false, approval: "deck-1",
      target: { type: "team", id: "t-9", identifier: "OLD" }, from: {}, to: {},
    });
    await expect(
      runPlan(fakeClient(backend), planWith([del]), {
        apply: true, resume: false, allowIrreversible: false,
        journalPath: join(dir, "j2.jsonl"), backupRecordPath: freshBackup(), pace: fastPace(),
      }),
    ).rejects.toThrow("--allow-irreversible");
    expect(backend.mutationCalls).toEqual([]);
  });
});

describe("move-issue-team preconditions", () => {
  const move = issueOp({
    seq: 5,
    op: "move-issue-team",
    from: { teamId: "t-1", projectId: "p-1", projectTeamIds: ["t-1"], cycleId: null },
    to: { teamId: "t-2", reapplyLabelIds: ["l-ws"] },
  });
  test("fails without phase-1/2 verify markers", () => {
    expect(() => assertMovePreconditions(move, [])).toThrow("phase-1 verify");
    const j1: JournalRecord[] = [{ seq: "verify", phase: 1, at: "a", ok: true }];
    expect(() => assertMovePreconditions(move, j1)).toThrow("phase-2 verify");
  });
  test("fails (b) when the destination team is in neither census teamIds nor an earlier landed add-project-team", () => {
    const j: JournalRecord[] = [
      { seq: "verify", phase: 1, at: "a", ok: true },
      { seq: "verify", phase: 2, at: "b", ok: true },
    ];
    expect(() => assertMovePreconditions(move, j)).toThrow("(b)");
  });
  test("passes with markers + census teamIds; passes via earlier add-project-team", () => {
    const j: JournalRecord[] = [
      { seq: "verify", phase: 1, at: "a", ok: true },
      { seq: "verify", phase: 2, at: "b", ok: true },
    ];
    const withTeam = issueOp({
      seq: 5, op: "move-issue-team",
      from: { teamId: "t-1", projectId: "p-1", projectTeamIds: ["t-1", "t-2"], cycleId: null },
      to: { teamId: "t-2", reapplyLabelIds: [] },
    });
    expect(() => assertMovePreconditions(withTeam, j)).not.toThrow();
    const viaJournal: JournalRecord[] = [
      ...j,
      {
        seq: 3, phase: 5, op: "add-project-team", at: "c", ok: true,
        original: issueOp({
          seq: 3, op: "add-project-team",
          target: { type: "project", id: "p-1", identifier: "proj" },
          from: { teamIds: ["t-1"] },
          to: { teamId: "t-2", teamIds: ["t-1", "t-2"] },
        }),
      },
    ];
    expect(() => assertMovePreconditions(move, viaJournal)).not.toThrow();
  });

  test("move applies teamId + re-applied labels in one input; projectId preserved", async () => {
    const moved: FakeIssue = { ...ISSUE_1, teamId: "t-1" };
    const backend: FakeBackend = { issues: new Map([["i-1", moved]]), swallowWrites: false, mutationCalls: [], readCalls: 0 };
    const j: string = join(dir, "j.jsonl");
    journalAppend(j, { seq: "verify", phase: 1, at: "a", ok: true });
    journalAppend(j, { seq: "verify", phase: 2, at: "b", ok: true });
    const op = issueOp({
      seq: 5, op: "move-issue-team",
      from: { teamId: "t-1", projectId: "p-1", projectTeamIds: ["t-1", "t-2"], cycleId: null, labelIds: ["l-a"] },
      to: { teamId: "t-2", reapplyLabelIds: ["l-ws"] },
    });
    const result = await runPlan(fakeClient(backend), planWith([op]), {
      apply: true, resume: false, allowIrreversible: false,
      journalPath: j, backupRecordPath: freshBackup(), pace: fastPace(),
    });
    expect(result.applied).toBe(1);
    const i = backend.issues.get("i-1")!;
    expect(i.teamId).toBe("t-2");
    expect(i.labelIds).toContain("l-ws"); // re-applied in the same input
    expect(i.projectId).toBe("p-1"); // untouched by the fake
  });
});

describe("verifyPhase", () => {
  test("green when journal ok + live matches; red on missing journal or drift; marker journaled", async () => {
    const backend: FakeBackend = { issues: new Map([["i-1", { ...ISSUE_1, stateId: "s-done" }]]), swallowWrites: false, mutationCalls: [], readCalls: 0 };
    const plan = planWith([issueOp({})]);
    const j = join(dir, "j.jsonl");
    const missing = await verifyPhase(fakeClient(backend), plan, 1, { journalPath: j, pace: fastPace() });
    expect(missing.ok).toBe(false);
    expect(missing.failures[0]).toContain("no ok journal entry");

    journalAppend(j, { seq: 1, phase: 1, op: "set-state", at: "a", ok: true });
    const green = await verifyPhase(fakeClient(backend), plan, 1, { journalPath: j, pace: fastPace() });
    expect(green.ok).toBe(true);
    expect(journalPhaseVerified(journalRead(j), 1)).toBe(true);

    backend.issues.get("i-1")!.stateId = "s-todo"; // live drift after the fact
    const red = await verifyPhase(fakeClient(backend), plan, 1, { journalPath: j, pace: fastPace() });
    expect(red.ok).toBe(false);
    expect(red.failures[0]).toContain("stateId");
  });
});

describe("rollbackPhase", () => {
  test("inverse of set-state restores the before state; no-inverse ops skipped", async () => {
    const backend: FakeBackend = { issues: new Map([["i-1", { ...ISSUE_1, stateId: "s-done" }]]), swallowWrites: false, mutationCalls: [], readCalls: 0 };
    const j = join(dir, "applied.jsonl");
    const applied = issueOp({});
    journalAppend(j, {
      seq: 1, phase: 1, op: "set-state", at: "a", ok: true,
      original: applied,
      before: { stateId: "s-todo" }, after: { stateId: "s-done" },
    });
    journalAppend(j, {
      seq: 2, phase: 1, op: "archive-state", at: "b", ok: true,
      original: issueOp({ seq: 2, op: "archive-state", reversible: false, phase: 6, approval: "d", target: { type: "state", id: "st-9", identifier: "EX/Ready" }, from: { archived: false }, to: { archived: true } }),
    });
    const { rolledBack, skipped } = await rollbackPhase(fakeClient(backend), j, 1, { pace: fastPace() });
    expect(rolledBack).toBe(1);
    expect(backend.issues.get("i-1")!.stateId).toBe("s-todo");
    expect(skipped[0]).toContain("no inverse");
  });
});

describe("pacing", () => {
  test("TokenBucket sleeps when empty", async () => {
    let now = 0;
    const sleeps: number[] = [];
    const bucket = new TokenBucket(0.001, 1, () => now, async (ms) => { sleeps.push(ms); now += ms; });
    await bucket.acquire(); // drains the capacity
    await bucket.acquire(); // must sleep
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps[0]).toBeGreaterThan(0);
  });

  test("RateTracker sleeps to reset under 10% remaining", async () => {
    let now = 1_000_000;
    const sleeps: number[] = [];
    const tracker = new RateTracker(() => now, async (ms) => { sleeps.push(ms); now += ms; });
    const headers = new Headers({
      "x-ratelimit-requests-limit": "2500",
      "x-ratelimit-requests-remaining": "100", // 4% < 10%
      "x-ratelimit-requests-reset": String(now + 60_000),
    });
    tracker.recordHeaders(headers);
    await tracker.throttleIfLow();
    expect(sleeps[0]).toBe(61_000); // reset delta + 1s
  });

  test("estimateRequests: 3/op solo, batching amortizes the verify read", () => {
    const solo = [issueOp({})];
    expect(estimateRequests(solo)).toBe(3);
    const batched = [0, 1, 2, 3].map((n) => issueOp({ seq: n + 1, batchKey: "k" }));
    expect(estimateRequests(batched)).toBe(4 + 2); // 4 members + 1 batch + verify
  });
});
