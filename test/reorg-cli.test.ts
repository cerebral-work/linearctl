import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reorgJournalCount, reorgPlan } from "../src/commands/reorg.js";
import { parsePlanFile, sha256File } from "../src/core/reorg.js";
import type { CensusData } from "../src/core/reorg.js";

/**
 * Command-layer tests for `reorg plan` — the only subcommand that runs without
 * a Linear client (census/apply/verify/rollback all need LINEAR_API_KEY and are
 * covered by core tests via the rawRequest stub).
 */

const TOY_CENSUS: CensusData = {
  workspace: { id: "ws-toy", urlKey: "toy" },
  teams: [
    {
      id: "t-ex", key: "EX", name: "Example", triageEnabled: false, archivedAt: null,
      issueCount: 3,
      states: {
        nodes: [
          { id: "s-todo", name: "Todo", type: "unstarted", position: 2, archivedAt: null },
          { id: "s-ready", name: "Ready", type: "unstarted", position: 1, archivedAt: null },
        ],
      },
    },
  ],
  issues: [
    {
      id: "i-1", identifier: "EX-1", teamId: "t-ex", teamKey: "EX",
      stateId: "s-todo", labelIds: ["l-team-bug"], projectId: "p-1",
      cycleId: null, archived: false,
    },
  ],
  workspaceLabels: [{ id: "l-ws-bug", name: "bug", retiredAt: null, team: null, teamKey: null, issueCount: 0 }],
  teamLabels: [{ id: "l-team-bug", name: "bug", retiredAt: null, team: { id: "t-ex", key: "EX" }, teamKey: "EX", issueCount: 1 }],
  projects: [
    {
      id: "p-1", name: "Toy Project", trashed: false,
      status: { id: "st-started", name: "Started" },
      lead: null, targetDate: null,
      teams: { nodes: [{ id: "t-ex", key: "EX" }] },
      initiatives: { nodes: [] },
    },
  ],
  initiatives: [{ id: "i-dup", name: "[DUP] old thing", archivedAt: null }],
  generatedAt: "2026-10-04T00:00:00Z",
  rateBudget: { limit: 2500, remaining: 2000 },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "reorg-cli-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("reorg plan (command)", () => {
  test("rules + census → valid plan file, parseable, hashes match inputs", async () => {
    const censusPath = join(dir, "census.json");
    writeFileSync(censusPath, JSON.stringify(TOY_CENSUS));
    const rulesPath = join(dir, "rules.json");
    writeFileSync(
      rulesPath,
      JSON.stringify([
        {
          phase: 2, op: "enable-triage",
          match: { entity: "team", where: { key: "EX" } },
          to: { triageEnabled: true },
          evidence: "every team runs Triage",
        },
        {
          phase: 2, op: "archive-state",
          match: { entity: "team-state", teamKey: "EX", where: { name: "Ready" } },
          to: { archived: true },
          evidence: "Ready emptied and retired",
        },
        {
          phase: 3, op: "archive-initiative",
          match: { entity: "initiative", where: { name: "[DUP] old thing" } },
          to: { archived: true },
          evidence: "duplicate initiative",
        },
      ]),
    );
    const out = join(dir, "plan.jsonl");
    await reorgPlan({ rules: rulesPath, census: censusPath, out });

    const plan = parsePlanFile(out);
    expect(plan.meta.workspaceId).toBe("ws-toy");
    expect(plan.meta.censusHash).toBe(sha256File(censusPath));
    expect(plan.meta.rulesHash).toBe(sha256File(rulesPath));
    expect(plan.ops.map((o) => [o.op, o.target.identifier])).toEqual([
      ["enable-triage", "EX"],
      ["archive-state", "EX/Ready"],
      ["archive-initiative", "[DUP] old thing"],
    ]);
    // `from` captured from the census — the executor's drift anchor
    expect(plan.ops[0].from).toEqual({ triageEnabled: false });
    expect(plan.ops[1].from).toEqual({ archived: false });
    // seqs assigned in rule order
    expect(plan.ops.map((o) => o.seq)).toEqual([1, 2, 3]);
  });

  test("a rule matching nothing is an error, not a silent no-op", async () => {
    const censusPath = join(dir, "census.json");
    writeFileSync(censusPath, JSON.stringify(TOY_CENSUS));
    const rulesPath = join(dir, "rules.json");
    writeFileSync(
      rulesPath,
      JSON.stringify([
        {
          phase: 1, op: "enable-triage",
          match: { entity: "team", where: { key: "NOPE" } },
          to: { triageEnabled: true }, evidence: "typo'd rule",
        },
      ]),
    );
    await expect(
      reorgPlan({ rules: rulesPath, census: censusPath, out: join(dir, "p.jsonl") }),
    ).rejects.toThrow("matched nothing");
  });

  test("a non-census file is refused at the boundary", async () => {
    const badPath = join(dir, "not-a-census.json");
    writeFileSync(badPath, JSON.stringify({ hello: "world" }));
    const rulesPath = join(dir, "rules.json");
    writeFileSync(rulesPath, "[]");
    await expect(
      reorgPlan({ rules: rulesPath, census: badPath, out: join(dir, "p.jsonl") }),
    ).rejects.toThrow("not a reorg census file");
  });
});

describe("reorgJournalCount (CLI seam)", () => {
  test("0 for a missing file, N after appends", () => {
    const j = join(dir, "applied.jsonl");
    expect(reorgJournalCount(j)).toBe(0);
    writeFileSync(j, JSON.stringify({ seq: 1, at: "a", ok: true }) + "\n");
    expect(reorgJournalCount(j)).toBe(1);
  });
});
