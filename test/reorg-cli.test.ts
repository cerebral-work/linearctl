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
      id: "t-ex", key: "EX", name: "Example", triageEnabled: false, private: false, archivedAt: null,
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
  workspaceLabels: [{ id: "l-ws-bug", name: "bug", retiredAt: null, team: null, teamKey: null, issueCount: 0, inheritedFromId: null }],
  teamLabels: [{ id: "l-team-bug", name: "bug", retiredAt: null, team: { id: "t-ex", key: "EX" }, teamKey: "EX", issueCount: 1, inheritedFromId: null }],
  projects: [
    {
      id: "p-1", name: "Toy Project", archivedAt: null, trashed: false,
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

  test("a partial census yields a plan warning naming the reasons (CER-2389)", async () => {
    const censusPath = join(dir, "census.json");
    writeFileSync(
      censusPath,
      JSON.stringify({ ...TOY_CENSUS, partial: true, partialReasons: ["issues: cursor did not advance (stuck at cur-1)"] }),
    );
    const rulesPath = join(dir, "rules.json");
    writeFileSync(
      rulesPath,
      JSON.stringify([
        { phase: 2, op: "enable-triage", match: { entity: "team", where: { key: "EX" } }, to: { triageEnabled: true }, evidence: "e" },
      ]),
    );
    const out = join(dir, "plan.jsonl");
    await reorgPlan({ rules: rulesPath, census: censusPath, out });
    const meta = JSON.parse(readFileSync(out, "utf8").split("\n")[0])._meta;
    expect(meta.warnings.some((w: string) => w.includes("partial") && w.includes("cursor did not advance"))).toBe(true);
    // control: a complete census adds no such warning
    writeFileSync(censusPath, JSON.stringify(TOY_CENSUS));
    await reorgPlan({ rules: rulesPath, census: censusPath, out });
    const meta2 = JSON.parse(readFileSync(out, "utf8").split("\n")[0])._meta;
    expect(meta2.warnings.some((w: string) => w.includes("partial"))).toBe(false);
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

describe("team-state rules and inherited views (CER-2390)", () => {
  const stateCensus = {
    ...TOY_CENSUS,
    teams: [
      { id: "t-par", key: "PAR", name: "Parent", triageEnabled: false, private: false, archivedAt: null, issueCount: 0,
        states: { nodes: [{ id: "s-owner", name: "Review", type: "started", position: 1, archivedAt: null, inheritedFrom: null }] } },
      { id: "t-sub", key: "SUB", name: "Sub", triageEnabled: false, private: false, archivedAt: null, issueCount: 0,
        states: { nodes: [{ id: "s-view", name: "Review", type: "started", position: 1, archivedAt: null, inheritedFrom: { id: "s-owner" } }] } },
    ],
  } as unknown as CensusData;
  const stateRule = (teamKey: string) =>
    rule({ op: "archive-state", approval: "ap-1", to: {}, match: { entity: "team-state", teamKey, where: { name: "Review" } } });

  test("a rule naming an inherited view by id is refused, naming state, team and owner", () => {
    const byId = rule({ op: "archive-state", approval: "ap-1", to: {}, match: { entity: "team-state", where: { id: "s-view" } } });
    expect(() => planFromRules([byId], stateCensus, META)).toThrow(
      /SUB\/Review.*s-view.*s-owner.*act on the owner state/s,
    );
  });

  test("a broad rule skips inherited views: only the owner is planned (its views cascade)", () => {
    const broad = rule({ op: "archive-state", approval: "ap-1", to: {}, match: { entity: "team-state", where: { name: "Review" } } });
    const plan = planFromRules([broad], stateCensus, META);
    expect(plan.ops.map((o) => o.target.id)).toEqual(["s-owner"]);
  });

  test("a rule scoped to the sub-team matches nothing: its only match is a view", () => {
    expect(() => planFromRules([stateRule("SUB")], stateCensus, META)).toThrow(/matched nothing/);
  });

  test("control: a rule matching only the owner state plans normally", () => {
    const plan = planFromRules([stateRule("PAR")], stateCensus, META);
    expect(plan.ops.map((o) => o.target.id)).toEqual(["s-owner"]);
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
        [rule({ op: "archive-project", match: { entity: "project", where: { name: "Toy Project" } }, to: { archived: true } })],
        dupCensus, META,
      ),
    ).toThrow("matches 2 projects");
    const plan = planFromRules(
      [rule({ op: "archive-project", match: { entity: "project", where: { id: "p-2" } }, to: { archived: true } })],
      dupCensus, META,
    );
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].target.id).toBe("p-2");
  });
});

describe("archived-project sandwich (planner, CER-2586 part 2)", () => {
  const archivedCensus: CensusData = {
    ...TOY_CENSUS,
    projects: [{ ...TOY_CENSUS.projects[0], archivedAt: "2026-09-01T00:00:00Z" }],
    issues: [
      { ...TOY_CENSUS.issues[0], archived: true },
      { id: "i-9", identifier: "EX-9", teamId: "t-ex", teamKey: "EX", stateId: "s-todo", labelIds: [], projectId: "p-1", cycleId: null, archived: true },
    ],
  };
  const statusRule = () =>
    rule({ op: "set-project-status", match: { entity: "project", where: { name: "Toy Project" } }, to: { statusId: "st-done" } });

  test("(b) a modifying op on an archived project becomes unarchive -> op -> re-archive", () => {
    const plan = planFromRules([statusRule()], archivedCensus, META);
    expect(plan.ops.map((o) => o.op)).toEqual(["archive-project", "set-project-status", "archive-project"]);
    const [u, m, r] = plan.ops;
    expect([u.seq, m.seq, r.seq]).toEqual([1, 2, 3]);
    expect(u.target.id).toBe("p-1");
    expect(r.target.id).toBe("p-1");
    // anchors: U expects the archived live state; R expects the post-U state
    expect(u.from).toMatchObject({ archived: true, trashed: false });
    expect(u.to).toMatchObject({ archived: false });
    expect(r.from).toMatchObject({ archived: false, trashed: false });
    expect(r.to.archived).toBe(true);
    // R restores the issues Linear's unarchive cascades open (census archived set)
    expect(r.to.cascadeRearchiveIssueIds).toEqual(["i-1", "i-9"]);
    // all three are reversible and carry the rule's phase
    for (const o of [u, m, r]) {
      expect(o.reversible).toBe(true);
      expect(o.phase).toBe(1);
    }
  });

  test("positive control: the same rule on an unarchived project plans one op", () => {
    const plan = planFromRules([statusRule()], TOY_CENSUS, META);
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].op).toBe("set-project-status");
  });

  test("control: archive-project itself is not sandwiched", () => {
    const plan = planFromRules(
      [rule({ op: "archive-project", match: { entity: "project", where: { name: "Toy Project" } }, to: { archived: true } })],
      archivedCensus, META,
    );
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].op).toBe("archive-project");
  });

  test("a sandwich plan carries exactly one _meta warning; the unarchived control none", () => {
    const plan = planFromRules([statusRule()], archivedCensus, META);
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toContain("seq 1-3 archived-project sandwich on Toy Project");
    expect(plan.warnings[0]).toContain("seq 2 REFUSED");
    expect(plan.warnings[0]).toContain("seq 3 DRIFT");
    const plain = planFromRules([statusRule()], TOY_CENSUS, META);
    expect(plain.warnings).toEqual([]);
  });

  test("the phase-5 reorder keeps the sandwich triple adjacent (rank sort moves it as one unit)", () => {
    const census: CensusData = {
      ...archivedCensus,
      teams: [
        ...archivedCensus.teams,
        { id: "t-new", key: "NEW", name: "New", triageEnabled: false, private: false, archivedAt: null, issueCount: 0, states: { nodes: [] } },
      ],
    };
    const plan = planFromRules(
      [
        rule({ phase: 5, op: "add-project-team", match: { entity: "project", where: { name: "Toy Project" } }, to: { teamId: "t-new" } }),
        rule({ phase: 5, op: "create-team-label", match: { entity: "team", where: { key: "EX" } }, to: { name: "nl" } }),
      ],
      census, META,
    );
    // create-team-label (rank 1) sorts before add-project-team (rank 2), but
    // the triple must move as a unit — [U, create, R, M] would refuse mid-apply
    expect(plan.ops.map((o) => o.op)).toEqual([
      "create-team-label", "archive-project", "add-project-team", "archive-project",
    ]);
    const [c, u, m, r] = plan.ops;
    expect([c.seq, u.seq, m.seq, r.seq]).toEqual([1, 2, 3, 4]);
    expect(r.to.cascadeRearchiveIssueIds).toEqual(["i-1", "i-9"]);
  });
});

describe("planner warnings + coercion", () => {
  test("warns when a to-be-deleted team is referenced by rules or still on census projects", () => {
    const census = {
      ...TOY_CENSUS,
      teams: [
        ...TOY_CENSUS.teams,
        { id: "t-old", key: "OLD", name: "Old", triageEnabled: false, private: false, archivedAt: null, issueCount: 0, states: { nodes: [] } },
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
        { id: "t-old", key: "OLD", name: "Old", triageEnabled: false, private: false, archivedAt: null, issueCount: 0, states: { nodes: [] } },
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

describe("inherited labels — planner (CER-2353)", () => {
  const INH_CENSUS = {
    ...TOY_CENSUS,
    teamLabels: [
      ...TOY_CENSUS.teamLabels,
      { id: "l-owner-sec", name: "security", retiredAt: null, team: { id: "t-ex", key: "EX" }, teamKey: "EX", issueCount: 0, inheritedFromId: null },
      { id: "l-child-sec", name: "security", retiredAt: null, team: { id: "t-sub", key: "SUB" }, teamKey: "SUB", issueCount: 7, inheritedFromId: "l-owner-sec" },
    ],
  };

  test("a rule targeting an inherited label id is refused at plan time", () => {
    expect(() =>
      planFromRules(
        [rule({
          op: "retire-or-delete-label",
          match: { entity: "team-label", where: { id: "l-child-sec" } },
          to: { retired: true }, evidence: "bad rule",
        })],
        INH_CENSUS, META,
      ),
    ).toThrow(/inherited label.*target the owner/s);
  });

  test("team-label selection: owners only; owner usage sums its children", () => {
    // zero-own-issues owner with child usage must NOT match an issueCount:0 rule
    // (zero matches = the planner's standard "matched nothing" refusal)
    expect(() =>
      planFromRules(
        [rule({
          op: "retire-or-delete-label",
          match: { entity: "team-label", teamKey: "EX", where: { name: "security", issueCount: 0 } },
          to: { retired: true }, evidence: "zero-issue rule",
        })],
        INH_CENSUS, META,
      ),
    ).toThrow("matched nothing");
    const usedRule = planFromRules(
      [rule({
        op: "retire-or-delete-label",
        match: { entity: "team-label", where: { name: "security", issueCount: 7 } },
        to: { retired: true }, evidence: "usage rule",
      })],
      INH_CENSUS, META,
    );
    // the owner matches (effective 7); the inherited child never matches
    expect(usedRule.ops.map((o) => o.target.id)).toEqual(["l-owner-sec"]);
  });

  test("relabel: removing an owner id maps to the child id the issue carries", () => {
    const census = {
      ...INH_CENSUS,
      issues: [
        { id: "i-sub-1", identifier: "SUB-1", teamId: "t-sub", teamKey: "SUB", stateId: "s-todo", labelIds: ["l-child-sec"], projectId: null, cycleId: null, archived: false },
      ],
    };
    const plan = planFromRules(
      [rule({
        op: "relabel",
        match: { entity: "issue", where: { labelId: "l-owner-sec" } },
        to: { add: ["l-ws-bug"], remove: ["l-owner-sec"] }, evidence: "swap owner for ws",
      })],
      census, META,
    );
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].to.remove).toEqual(["l-child-sec"]); // the child id, not the owner
  });
});

describe("planner invariants (round 1)", () => {
  test("an unknown op kind is an ERROR, never silently accepted", () => {
    expect(() =>
      planFromRules(
        [rule({ op: "future-op" as never, match: { entity: "issue", where: { identifier: "EX-1" } }, to: {} })],
        TOY_CENSUS, META,
      ),
    ).toThrow(/unknown op kind "future-op"/);
  });

  test("create-project-status via the none entity anchors from.statusId (invariant passes)", () => {
    const plan = planFromRules(
      [rule({ op: "create-project-status", match: { entity: "none", where: {} }, to: { name: "Paused", type: "paused" } })],
      TOY_CENSUS, META,
    );
    expect(plan.ops[0].from).toEqual({ statusId: null });
    expect(plan.ops[0].target.type).toBe("project");
  });

  test("child mapping prefers the child in the issue's OWN team (second sub-team)", () => {
    const census = {
      ...TOY_CENSUS,
      teamLabels: [
        ...TOY_CENSUS.teamLabels,
        { id: "l-owner", name: "security", retiredAt: null, team: { id: "t-ex", key: "EX" }, teamKey: "EX", issueCount: 0, inheritedFromId: null },
        { id: "l-child-a", name: "security", retiredAt: null, team: { id: "t-sub-a", key: "SA" }, teamKey: "SA", issueCount: 1, inheritedFromId: "l-owner" },
        { id: "l-child-b", name: "security", retiredAt: null, team: { id: "t-sub-b", key: "SB" }, teamKey: "SB", issueCount: 1, inheritedFromId: "l-owner" },
      ],
      issues: [
        { id: "i-b1", identifier: "SB-1", teamId: "t-sub-b", teamKey: "SB", stateId: "s-todo", labelIds: ["l-child-b"], projectId: null, cycleId: null, archived: false },
      ],
    };
    const plan = planFromRules(
      [rule({
        op: "relabel",
        match: { entity: "issue", where: { labelId: "l-owner" } },
        to: { add: ["l-ws-bug"], remove: ["l-owner"] }, evidence: "swap",
      })],
      census, META,
    );
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].to.remove).toEqual(["l-child-b"]); // its own team's child, not the first
  });

  test("distinguishing: issue carries a DIFFERENT team's child — own-team child wins over the carried one", () => {
    const census = {
      ...TOY_CENSUS,
      teamLabels: [
        ...TOY_CENSUS.teamLabels,
        { id: "l-owner", name: "security", retiredAt: null, team: { id: "t-ex", key: "EX" }, teamKey: "EX", issueCount: 0, inheritedFromId: null },
        { id: "l-child-a", name: "security", retiredAt: null, team: { id: "t-sub-a", key: "SA" }, teamKey: "SA", issueCount: 1, inheritedFromId: "l-owner" },
        { id: "l-child-b", name: "security", retiredAt: null, team: { id: "t-sub-b", key: "SB" }, teamKey: "SB", issueCount: 1, inheritedFromId: "l-owner" },
      ],
      issues: [
        // weird but real-shaped: the issue sits in SB yet carries SA's child
        { id: "i-b1", identifier: "SB-1", teamId: "t-sub-b", teamKey: "SB", stateId: "s-todo", labelIds: ["l-child-a"], projectId: null, cycleId: null, archived: false },
      ],
    };
    const plan = planFromRules(
      [rule({
        op: "relabel",
        match: { entity: "issue", where: { labelId: "l-owner" } },
        to: { add: ["l-ws-bug"], remove: ["l-owner"] }, evidence: "swap",
      })],
      census, META,
    );
    // only the own-team lookup yields l-child-b; the carried-fallback yields l-child-a
    expect(plan.ops[0].to.remove).toEqual(["l-child-b"]);
  });

  test("a census missing an inherited label's owner refuses loudly", () => {
    const census = {
      ...TOY_CENSUS,
      teamLabels: [
        { id: "l-orphan", name: "security", retiredAt: null, team: { id: "t-sub", key: "SUB" }, teamKey: "SUB", issueCount: 1, inheritedFromId: "l-absent-owner" },
      ],
      issues: [
        { id: "i-1", identifier: "SUB-1", teamId: "t-sub", teamKey: "SUB", stateId: "s-todo", labelIds: ["l-orphan"], projectId: null, cycleId: null, archived: false },
      ],
    };
    expect(() =>
      planFromRules(
        [rule({ op: "relabel", match: { entity: "issue", where: { labelId: "l-absent-owner" } }, to: { add: [], remove: ["l-absent-owner"] } })],
        census, META,
      ),
    ).toThrow(/without its owner/);
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

// ---------------------------------------------------------------------------
// Planner: create-team-label rules, labelMap rules, phase-5 ordering
// ---------------------------------------------------------------------------

describe("team-label carry-over planning", () => {
  const CENSUS: CensusData = {
    ...TOY_CENSUS,
    teams: [
      ...TOY_CENSUS.teams,
      { id: "t-bb", key: "BBB", name: "Dest", triageEnabled: false, private: false, archivedAt: null, issueCount: 0, states: { nodes: [] } },
    ],
    issues: [
      ...TOY_CENSUS.issues,
      { id: "i-2", identifier: "EX-2", teamId: "t-ex", teamKey: "EX", stateId: "s-todo", labelIds: [], projectId: "p-1", cycleId: null, archived: false },
    ],
  };
  const createRule = (over: Partial<ReorgRule> = {}): ReorgRule => ({
    phase: 5, op: "create-team-label",
    match: { entity: "team", where: { key: "BBB" } },
    to: { name: "bug", color: "#ff0000" }, evidence: "carry bug", ref: "bug",
    ...over,
  });
  const moveRule = (labelMap: Record<string, string>, over: Partial<ReorgRule> = {}): ReorgRule => ({
    phase: 5, op: "move-issue-team",
    match: { entity: "issue", where: { teamKey: "EX" } },
    to: { teamId: "t-bb", labelMap }, evidence: "fold", ...over,
  });
  const addProject: ReorgRule = {
    phase: 5, op: "add-project-team",
    match: { entity: "project", where: { id: "p-1" } },
    to: { teamId: "t-bb" }, evidence: "membership",
  };
  const rename: ReorgRule = {
    phase: 5, op: "rename-label",
    match: { entity: "team-label", where: { name: "bug" }, teamKey: "EX" },
    to: { name: "bug·old-ex" }, evidence: "free the name",
  };

  test("rules in reverse order are planned rename -> create-team-label -> add-project-team -> move", () => {
    const plan = planFromRules(
      [moveRule({ "l-team-bug": "created:bug" }), addProject, createRule(), rename],
      CENSUS, META,
    );
    expect(plan.ops.map((o) => o.op)).toEqual([
      "rename-label", "create-team-label", "add-project-team", "move-issue-team", "move-issue-team",
    ]);
    expect(plan.ops.map((o) => o.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  test("create-team-label targets the destination team with a null labelId anchor", () => {
    const plan = planFromRules([createRule()], CENSUS, META);
    expect(plan.ops[0].target).toEqual({ type: "team", id: "t-bb", identifier: "BBB" });
    expect(plan.ops[0].from).toEqual({ labelId: null });
  });

  test("created:<ref> becomes created:<seq>, and each move's map is pruned to the labels its issue carries", () => {
    const plan = planFromRules(
      [moveRule({ "l-team-bug": "created:bug", "l-not-carried": "created:bug" }), createRule()],
      CENSUS, META,
    );
    const create = plan.ops.find((o) => o.op === "create-team-label")!;
    const moves = plan.ops.filter((o) => o.op === "move-issue-team");
    const carrier = moves.find((o) => o.target.identifier === "EX-1")!;
    const bare = moves.find((o) => o.target.identifier === "EX-2")!;
    expect(carrier.to.labelMap).toEqual({ "l-team-bug": `created:${create.seq}` });
    expect(bare.to.labelMap).toEqual({});
    expect(bare.to.reapplyLabelIds).toEqual([]);
    expect(create.seq).toBeLessThan(carrier.seq);
  });

  test("an unknown ref is refused even on an entry no issue carries", () => {
    expect(() =>
      planFromRules([moveRule({ "l-not-carried": "created:ghost" }), createRule()], CENSUS, META),
    ).toThrow('names no create-team-label rule ref');
  });

  test("a ref to a create in a team that is neither the destination nor its parent is refused", () => {
    const census = {
      ...CENSUS,
      teams: [...CENSUS.teams, { id: "t-cc", key: "CCC", name: "Other", triageEnabled: false, private: false, archivedAt: null, issueCount: 0, states: { nodes: [] } }],
    };
    expect(() =>
      planFromRules(
        [createRule({ match: { entity: "team", where: { key: "CCC" } } }), moveRule({ "l-team-bug": "created:bug" })],
        census, META,
      ),
    ).toThrow("targets team CCC, but the move's destination is BBB");
    // the destination's parent is fine
    const withParent = {
      ...CENSUS,
      teams: CENSUS.teams.map((t) => (t.key === "BBB" ? { ...t, parent: { id: "t-ex", key: "EX" } } : t)),
    };
    expect(() =>
      planFromRules(
        [createRule({ match: { entity: "team", where: { key: "EX" } } }), moveRule({ "l-team-bug": "created:bug" })],
        withParent, META,
      ),
    ).not.toThrow();
  });

  test("a create-team-label rule must name a team and a label name", () => {
    expect(() => planFromRules([createRule({ match: { entity: "project", where: { id: "p-1" } } })], CENSUS, META)).toThrow('entity "team"');
    expect(() => planFromRules([createRule({ to: {} })], CENSUS, META)).toThrow("to.name");
  });

  test("a plan with these ops survives a write/parse round trip", async () => {
    const censusPath = join(dir, "census.json");
    writeFileSync(censusPath, JSON.stringify(CENSUS));
    const rulesPath = join(dir, "rules.json");
    writeFileSync(rulesPath, JSON.stringify([createRule(), moveRule({ "l-team-bug": "created:bug" })]));
    const out = join(dir, "p.jsonl");
    await reorgPlan({ rules: rulesPath, census: censusPath, out });
    const parsed = parsePlanFile(out);
    expect(parsed.ops.map((o) => o.op)).toEqual(["create-team-label", "move-issue-team", "move-issue-team"]);
  });
});

// ---------------------------------------------------------------------------
// Planner: team visibility guard
// ---------------------------------------------------------------------------

describe("team visibility planning", () => {
  const priv = (over: Partial<CensusData["teams"][number]>) => ({
    id: "t-ex", key: "EX", name: "Example", triageEnabled: false, private: true, memberIds: ["u1"],
    archivedAt: null, issueCount: 3, states: { nodes: [] }, ...over,
  });
  const dest = (over: Partial<CensusData["teams"][number]> = {}) => ({
    id: "t-bb", key: "BBB", name: "Dest", triageEnabled: false, private: false,
    archivedAt: null, issueCount: 0, states: { nodes: [] }, ...over,
  });
  const census = (src: ReturnType<typeof priv>, dst: ReturnType<typeof dest>): CensusData => ({
    ...TOY_CENSUS,
    teams: [src, dst],
    issues: [{ ...TOY_CENSUS.issues[0], labelIds: [] }],
  });
  const move = (over: Partial<ReorgRule> = {}): ReorgRule => ({
    phase: 5, op: "move-issue-team",
    match: { entity: "issue", where: { teamKey: "EX" } },
    to: { teamId: "t-bb", reapplyLabelIds: [] }, evidence: "fold", ...over,
  });

  test("private -> public is refused, with a per team-pair summary", () => {
    expect(() => planFromRules([move()], census(priv({}), dest()), META)).toThrow(
      /1 op\(s\) would change visibility.*Team pairs: move-issue-team EX -> BBB x1.*Ops: seq 1 EX-1 EX -> BBB: .*every member/,
    );
  });

  test("private -> private: gaining members refused; fewer members plans with an info note", () => {
    expect(() =>
      planFromRules([move()], census(priv({ memberIds: ["u1"] }), dest({ private: true, memberIds: ["u1", "u2"] })), META),
    ).toThrow("would change visibility");
    const fewer = planFromRules([move()], census(priv({ memberIds: ["u1", "u2"] }), dest({ private: true, memberIds: ["u1"] })), META);
    expect(fewer.ops).toHaveLength(1);
    expect(fewer.visibility).toBeUndefined();
    expect(fewer.notes).toEqual(["EX -> BBB: 1 source member(s) lose access (1 move(s))"]);
    const equal = planFromRules([move()], census(priv({}), dest({ private: true, memberIds: ["u1"] })), META);
    expect(equal.ops).toHaveLength(1);
    expect(equal.notes).toBeUndefined();
  });

  test("public -> private and public -> public plan without a flag", () => {
    expect(planFromRules([move()], census(priv({ private: false, memberIds: undefined }), dest({ private: true, memberIds: ["u1"] })), META).ops).toHaveLength(1);
    expect(planFromRules([move()], census(priv({ private: false, memberIds: undefined }), dest()), META).ops).toHaveLength(1);
  });

  test("the rule's allowVisibilityChange is copied to the op and counted in the summary; never inferred", () => {
    const c = census(priv({}), dest());
    const plan = planFromRules([move({ allowVisibilityChange: true })], c, META);
    expect(plan.ops[0].allowVisibilityChange).toBe(true);
    expect(plan.visibility).toEqual([{ from: "EX", to: "BBB", kind: "move-issue-team", count: 1, allowed: true }]);
    const plain = planFromRules([move()], census(priv({ private: false, memberIds: undefined }), dest()), META);
    expect("allowVisibilityChange" in plain.ops[0]).toBe(false);
  });

  test("add-project-team of a public team to an all-private project is refused unless opted in", () => {
    const c = { ...census(priv({}), dest()), projects: [{ ...TOY_CENSUS.projects[0] }] };
    const add: ReorgRule = {
      phase: 5, op: "add-project-team", match: { entity: "project", where: { id: "p-1" } },
      to: { teamId: "t-bb" }, evidence: "membership",
    };
    expect(() => planFromRules([add], c, META)).toThrow(/Team pairs: add-project-team EX -> BBB x1.*Ops: seq 1 .*EX -> BBB/);
    expect(planFromRules([{ ...add, allowVisibilityChange: true }], c, META).visibility?.[0].kind).toBe("add-project-team");
  });

  test("a census without team privacy is refused, not assumed public", () => {
    const c = census(priv({}), dest());
    delete (c.teams[0] as { private?: boolean }).private;
    expect(() => planFromRules([move()], c, META)).toThrow("re-run reorg census");
  });
});

describe("planner batchKey rule (CER-2385)", () => {
  const two = { ...TOY_CENSUS, issues: [
    TOY_CENSUS.issues[0],
    { ...TOY_CENSUS.issues[0], id: "i-2", identifier: "EX-2" },
  ] };
  const rel = (add: string, extra: Partial<ReorgRule> = {}) =>
    rule({ match: { entity: "issue", where: { label: "bug" } }, to: { add: [add], remove: [] }, batchKey: "k", evidence: `ev-${add}`, ...extra });

  test("two relabel rules sharing a batchKey with different `to` throw at plan time", () => {
    expect(() => planFromRules([rel("l-a"), rel("l-b")], two, META)).toThrow(/batchKey "k".*ev-l-a.*ev-l-b/s);
  });

  test("same `to` under one batchKey is fine (control)", () => {
    expect(planFromRules([rel("l-a"), rel("l-a")], two, META).ops).toHaveLength(4);
  });

  test("add-project-team with a batchKey and per-target teamIds is fine", () => {
    const c = { ...TOY_CENSUS, teams: [...TOY_CENSUS.teams, { ...TOY_CENSUS.teams[0], id: "t-2", key: "TWO" }],
      projects: [TOY_CENSUS.projects[0], { ...TOY_CENSUS.projects[0], id: "p-2", name: "P2", teams: { nodes: [{ id: "t-2", key: "TWO" }] } }] };
    const plan = planFromRules([rule({
      op: "add-project-team", match: { entity: "project", where: {} }, to: { teamId: "t-ex" }, batchKey: "k", allowVisibilityChange: true,
    })], c, META);
    expect(plan.ops).toHaveLength(2);
    expect(plan.ops[0].to.teamIds).not.toEqual(plan.ops[1].to.teamIds);
  });
});
