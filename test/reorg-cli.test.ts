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
  partial: false,
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
          approval: "deck-ready-archive",
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

// ---------------------------------------------------------------------------
// Planner gaps: selectors, by-id, warnings, since-census
// ---------------------------------------------------------------------------

import { planFromRules } from "../src/core/reorg.js";
import type { ReorgRule } from "../src/core/reorg.js";

const META = { generated: "2026-10-04T00:00:00Z", censusHash: "c", workspaceId: "w", rulesHash: "r" };

function rule(over: Partial<ReorgRule>): ReorgRule {
  return {
    phase: 1, op: "relabel",
    match: { entity: "issue", where: {} },
    to: { add: ["l-ws"], remove: [] },
    evidence: "test rule",
    ...over,
  };
}

describe("issue selectors", () => {
  test("the label filter EXCLUDES non-carriers (not just matches everything)", () => {
    const census = {
      ...TOY_CENSUS,
      issues: [
        ...TOY_CENSUS.issues,
        { id: "i-2", identifier: "EX-2", teamId: "t-ex", teamKey: "EX", stateId: "s-todo", labelIds: [], projectId: "p-1", cycleId: null, archived: false },
      ],
    };
    const plan = planFromRules(
      [rule({ match: { entity: "issue", where: { label: "bug" } } })],
      census, META,
    );
    expect(plan.ops.map((o) => o.target.identifier)).toEqual(["EX-1"]); // EX-2 excluded
    const byId = planFromRules(
      [rule({ match: { entity: "issue", where: { labelId: "l-team-bug" } } })],
      census, META,
    );
    expect(byId.ops.map((o) => o.target.identifier)).toEqual(["EX-1"]);
  });

  test("by label NAME (any census label with the name counts) + team, in combination", () => {
    const plan = planFromRules(
      [rule({ match: { entity: "issue", where: { label: "bug", teamKey: "EX" } }, batchKey: "ws-bug" })],
      TOY_CENSUS, META,
    );
    expect(plan.ops).toHaveLength(1); // EX-1 carries l-team-bug (a 'bug' label)
    expect(plan.ops[0].target.identifier).toBe("EX-1");
    expect(plan.ops[0].batchKey).toBe("ws-bug");
  });

  test("by labelId; unknown label name throws", () => {
    const byId = planFromRules(
      [rule({ match: { entity: "issue", where: { labelId: "l-team-bug" } } })],
      TOY_CENSUS, META,
    );
    expect(byId.ops).toHaveLength(1);
    expect(() =>
      planFromRules([rule({ match: { entity: "issue", where: { label: "ghost" } } })], TOY_CENSUS, META)
    ).toThrow("no census label named");
  });
});

describe("by-id selection + duplicate refusal", () => {
  const dupCensus = {
    ...TOY_CENSUS,
    projects: [
      ...TOY_CENSUS.projects,
      { ...TOY_CENSUS.projects[0], id: "p-2" }, // same name "Toy Project", second id
    ],
    initiatives: [
      ...TOY_CENSUS.initiatives,
      { id: "i-dup-2", name: "[DUP] old thing", archivedAt: null }, // duplicate name
    ],
  };
  test("name match hitting two initiatives refuses; id selects exactly one", () => {
    expect(() =>
      planFromRules(
        [rule({ op: "archive-initiative", match: { entity: "initiative", where: { name: "[DUP] old thing" } }, to: { archived: true } })],
        dupCensus, META,
      ),
    ).toThrow("matches 2 initiatives");
    const plan = planFromRules(
      [rule({ op: "archive-initiative", match: { entity: "initiative", where: { id: "i-dup-2" } }, to: { archived: true } })],
      dupCensus, META,
    );
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].target.id).toBe("i-dup-2");
  });
  test("name match hitting two projects refuses; id selects exactly one", () => {
    expect(() =>
      planFromRules(
        [rule({ op: "archive-project", match: { entity: "project", where: { name: "Toy Project" } }, to: { trashed: true } })],
        dupCensus, META,
      ),
    ).toThrow("matches 2 projects");
    const plan = planFromRules(
      [rule({ op: "archive-project", match: { entity: "project", where: { id: "p-2" } }, to: { trashed: true } })],
      dupCensus, META,
    );
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].target.id).toBe("p-2");
  });
});

describe("planner warnings + coercion", () => {
  test("warns when a to-be-deleted team is referenced by rules or still on census projects", () => {
    const census = {
      ...TOY_CENSUS,
      teams: [
        ...TOY_CENSUS.teams,
        { id: "t-old", key: "OLD", name: "Old", triageEnabled: false, archivedAt: null, issueCount: 0, states: { nodes: [] } },
      ],
      projects: [
        { ...TOY_CENSUS.projects[0], teams: { nodes: [{ id: "t-ex", key: "EX" }, { id: "t-old", key: "OLD" }] } },
      ],
    };
    const plan = planFromRules(
      [
        rule({
          phase: 6, op: "delete-team", reversible: false, approval: "deck-1",
          match: { entity: "team", where: { key: "OLD" } }, to: {},
        }),
        rule({
          op: "add-project-team",
          match: { entity: "project", where: { id: "p-1" } },
          to: { teamId: "t-old" },
        }),
      ],
      census, META,
    );
    expect(plan.warnings.some((w) => w.includes("t-old"))).toBe(true);
    expect(plan.warnings.some((w) => w.includes("Toy Project"))).toBe(true);
  });

  test("archive-state rules are coerced to reversible:false and require approval", () => {
    expect(() =>
      planFromRules(
        [rule({
          phase: 2, op: "archive-state",
          match: { entity: "team-state", teamKey: "EX", where: { name: "Ready" } },
          to: { archived: true },
        })],
        TOY_CENSUS, META,
      ),
    ).toThrow("approval");
    const plan = planFromRules(
      [rule({
        phase: 2, op: "archive-state", approval: "deck-ready",
        match: { entity: "team-state", teamKey: "EX", where: { name: "Ready" } },
        to: { archived: true },
      })],
      TOY_CENSUS, META,
    );
    expect(plan.ops[0].reversible).toBe(false);
    expect(plan.ops[0].approval).toBe("deck-ready");
  });
  test("warning suppressed when a remove-project-team rule covers the project+team", () => {
    const census = {
      ...TOY_CENSUS,
      teams: [
        ...TOY_CENSUS.teams,
        { id: "t-old", key: "OLD", name: "Old", triageEnabled: false, archivedAt: null, issueCount: 0, states: { nodes: [] } },
      ],
      projects: [
        { ...TOY_CENSUS.projects[0], teams: { nodes: [{ id: "t-ex", key: "EX" }, { id: "t-old", key: "OLD" }] } },
      ],
    };
    const rules: ReorgRule[] = [
      rule({
        phase: 6, op: "delete-team", reversible: false, approval: "deck-1",
        match: { entity: "team", where: { key: "OLD" } }, to: {},
      }),
      rule({
        phase: 5, op: "remove-project-team",
        match: { entity: "project", where: { id: "p-1" } },
        to: { teamId: "t-old" },
      }),
    ];
    const plan = planFromRules(rules, census, META);
    expect(plan.warnings.some((w) => w.includes("Toy Project"))).toBe(false);
  });
});

describe("phase-1 ordering (rename → create → relabel → retire)", () => {
  test("scrambled rule order still emits the safe seq order", () => {
    const plan = planFromRules(
      [
        rule({
          op: "retire-or-delete-label",
          match: { entity: "team-label", teamKey: "EX", where: { name: "bug" } },
          to: { retired: true }, evidence: "retire",
        }),
        rule({
          op: "relabel", match: { entity: "issue", where: { label: "bug" } },
          to: { add: ["name:bug"], remove: ["l-team-bug"] }, evidence: "relabel",
        }),
        rule({
          op: "create-workspace-label", match: { entity: "none", where: {} },
          to: { name: "bug", color: "#e5484d" }, evidence: "create",
        }),
        rule({
          op: "rename-label",
          match: { entity: "team-label", teamKey: "EX", where: { name: "bug" } },
          to: { name: "bug·old-EX" }, evidence: "rename",
        }),
      ],
      TOY_CENSUS, META,
    );
    expect(plan.ops.map((o) => o.op)).toEqual([
      "rename-label",
      "create-workspace-label",
      "relabel",
      "retire-or-delete-label",
    ]);
    expect(plan.ops.map((o) => o.seq)).toEqual([1, 2, 3, 4]);
  });
});

describe("--since-census guard", () => {
  test("stale census refused; fresh passes", async () => {
    const rulesPath = join(dir, "rules.json");
    writeFileSync(rulesPath, "[]");
    const stale = { ...TOY_CENSUS, generatedAt: "2026-10-01T00:00:00Z" };
    const stalePath = join(dir, "stale.json");
    writeFileSync(stalePath, JSON.stringify(stale));
    await expect(
      reorgPlan({ rules: rulesPath, census: stalePath, out: join(dir, "p.jsonl"), sinceCensus: "60" }),
    ).rejects.toThrow("census is stale");
    const fresh = { ...TOY_CENSUS, generatedAt: new Date().toISOString() };
    const freshPath = join(dir, "fresh.json");
    writeFileSync(freshPath, JSON.stringify(fresh));
    await expect(
      reorgPlan({ rules: rulesPath, census: freshPath, out: join(dir, "p.jsonl"), sinceCensus: "60" }),
    ).resolves.toBeUndefined();
  });
});
