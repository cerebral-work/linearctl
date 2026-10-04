import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LinearClient } from "@linear/sdk";
import {
  ENTITIES,
  ENTITY_NAMES,
  buildLookups,
  recordToDetail,
  renderIssueMd,
  resolveSince,
  runBackup,
  verifyBackup,
} from "../src/core/backup.js";
import { renderIssueDetail } from "../src/core/issues.js";
import { backup as backupCommand } from "../src/commands/backup.js";

type Row = Record<string, unknown>;

interface Stub {
  client: LinearClient;
  calls: Array<{ query: string; vars?: Record<string, unknown> }>;
}

/**
 * rawRequest stub that serves the backup engine: introspection, one query per
 * entity (paged by per-entity call count), history, count and sample queries.
 * `hook` may throw to simulate transport/API failures.
 */
function stub(opts: {
  pages?: Record<string, Row[][]>;
  roots?: string[];
  history?: Record<string, Row[]>;
  hook?: (query: string, vars: Record<string, unknown> | undefined, n: number) => void;
  remaining?: number;
  live?: Record<string, Row>;
}): Stub {
  const calls: Stub["calls"] = [];
  const perEntity: Record<string, number> = {};
  let n = 0;
  const roots = opts.roots ?? ENTITIES.map((e) => e.root);
  const rawRequest = async (query: string, vars?: Record<string, unknown>) => {
    n += 1;
    calls.push({ query, vars });
    opts.hook?.(query, vars, n);
    const headers = new Headers(opts.remaining !== undefined ? { "x-ratelimit-requests-remaining": String(opts.remaining) } : {});
    if (query.includes('__type(name: "Query")')) {
      return { headers, data: { __type: { fields: roots.map((name) => ({ name })) } } };
    }
    if (query.includes("query BackupHistory")) {
      const id = String(vars?.id);
      return { headers, data: { issue: { history: { nodes: opts.history?.[id] ?? [], pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }
    const m = /query Backup_(\w+)/.exec(query);
    if (m) {
      const spec = ENTITIES.find((e) => e.name === m[1])!;
      const i = (perEntity[spec.name] = (perEntity[spec.name] ?? -1) + 1);
      if (spec.kind === "single") return { headers, data: { [spec.root]: opts.pages?.[spec.name]?.[0]?.[0] ?? { id: "org-1", name: "Acme", urlKey: "acme" } } };
      if (spec.kind === "list") return { headers, data: { [spec.root]: opts.pages?.[spec.name]?.[0] ?? [] } };
      const pages = opts.pages?.[spec.name] ?? [[]];
      const nodes = pages[Math.min(i, pages.length - 1)] ?? [];
      const hasNext = i < pages.length - 1;
      return { headers, data: { [spec.root]: { nodes, pageInfo: { hasNextPage: hasNext, endCursor: hasNext ? `c${i + 1}` : null } } } };
    }
    if (query.includes("query Count")) {
      const root = /\n\s+(\w+)\(first/.exec(query)![1];
      const spec = ENTITIES.find((e) => e.root === root)!;
      const rows = (opts.pages?.[spec.name] ?? [[]]).flat();
      return { headers, data: { [root]: { nodes: rows.map((r) => ({ id: r.id })), pageInfo: { hasNextPage: false, endCursor: null } } } };
    }
    if (query.includes("query($id: String!)")) {
      return { headers, data: { issue: opts.live?.[String(vars?.id)] ?? null } };
    }
    throw new Error(`unhandled query: ${query.slice(0, 60)}`);
  };
  const client = { client: { rawRequest } } as unknown as LinearClient;
  return { client, calls };
}

const issue = (id: string, extra: Row = {}): Row => ({
  id,
  identifier: `T-${id}`,
  number: 1,
  title: `Issue ${id}`,
  description: `body ${id}`,
  priority: 2,
  priorityLabel: "High",
  url: `https://linear.app/x/issue/T-${id}`,
  labelIds: ["l1"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  team: { id: "t1" },
  state: { id: "s1" },
  assignee: { id: "u1" },
  project: null,
  parent: null,
  ...extra,
});

const base = (): Record<string, Row[][]> => ({
  teams: [[{ id: "t1", key: "T", name: "Team" }]],
  workflowStates: [[{ id: "s1", name: "Todo", type: "unstarted", team: { id: "t1" } }]],
  users: [[{ id: "u1", displayName: "Ada" }]],
  issueLabels: [[{ id: "l1", name: "bug", team: null }]],
});

const fast = { retry: { baseMs: 1, capMs: 2, onRetry: () => {} } };
let out: string;
beforeEach(() => {
  out = mkdtempSync(join(tmpdir(), "linearctl-backup-"));
});
afterEach(() => rmSync(out, { recursive: true, force: true }));

const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const lines = (dir: string, f: string) => read(dir, f).split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row);

describe("pagination", () => {
  test("follows the cursor and dedupes rows repeated across pages", async () => {
    const s = stub({ pages: { ...base(), issues: [[issue("a"), issue("b")], [issue("b"), issue("c")]] } });
    const { dir, manifest } = await runBackup(s.client, { out, version: "t", ...fast });
    const afters = s.calls.filter((c) => c.query.includes("Backup_issues")).map((c) => c.vars?.after);
    expect(afters).toEqual([null, "c1"]);
    expect(manifest.entities.issues.count).toBe(3);
    expect(lines(dir, "issues.jsonl").map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  test("requests first:100 with includeArchived", async () => {
    const s = stub({ pages: { ...base(), issues: [[issue("a")]] } });
    await runBackup(s.client, { out, version: "t", ...fast });
    const q = s.calls.find((c) => c.query.includes("Backup_issues"))!;
    expect(q.vars?.first).toBe(100);
    expect(q.query).toContain("includeArchived: true");
  });
});

describe("manifest", () => {
  test("counts, sha256 and bytes match the files; relations are *Id only", async () => {
    const s = stub({ remaining: 2000, pages: { ...base(), issues: [[issue("b"), issue("a")]] } });
    const { dir, manifest } = await runBackup(s.client, { out, version: "9.9.9", ...fast });
    const body = read(dir, "issues.jsonl");
    expect(manifest.entities.issues).toEqual({ count: 2, file: "issues.jsonl", sha256: sha(body), bytes: Buffer.byteLength(body) });
    const first = lines(dir, "issues.jsonl")[0];
    expect(first.stateId).toBe("s1");
    expect(first.teamId).toBe("t1");
    expect(first).not.toHaveProperty("state");
    expect(manifest.workspace).toEqual({ id: "org-1", urlKey: "acme", name: "Acme" });
    expect(manifest.linearctlVersion).toBe("9.9.9");
    expect(manifest.rateLimit.minRequestsRemaining).toBe(2000);
    expect(manifest.partial).toBe(false);
    expect(JSON.parse(read(dir, "manifest.json")).entities.issues.sha256).toBe(sha(body));
    expect(Object.keys(manifest.entities).sort()).toEqual([...ENTITY_NAMES].sort());
  });

  test("missing root connection lands in warnings[] and marks the dump partial", async () => {
    const roots = ENTITIES.map((e) => e.root).filter((r) => r !== "customers");
    const s = stub({ roots, pages: base() });
    const { manifest } = await runBackup(s.client, { out, version: "t", ...fast });
    expect(manifest.warnings.join("\n")).toContain('"customers"');
    expect(manifest.entities.customers).toBeUndefined();
    expect(manifest.partial).toBe(true);
  });

  test("the API token never reaches the manifest or any file", async () => {
    const prev = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_api_SENTINEL_SECRET_123";
    try {
      const s = stub({ pages: { ...base(), issues: [[issue("a")]] } });
      const { dir } = await runBackup(s.client, { out, version: "t", ...fast });
      const all = [
        read(dir, "manifest.json"),
        ...readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => read(dir, f)),
      ].join("\n");
      expect(all).not.toContain("SENTINEL_SECRET");
    } finally {
      if (prev === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = prev;
    }
  });
});

describe("scope flags", () => {
  test("--limit truncates and marks the manifest partial with a warning", async () => {
    const s = stub({ pages: { ...base(), issues: [[issue("a"), issue("b"), issue("c")]] } });
    const { manifest } = await runBackup(s.client, { out, version: "t", limit: 2, ...fast });
    expect(manifest.entities.issues.count).toBe(2);
    expect(manifest.partial).toBe(true);
    expect(manifest.scope.limit).toBe(2);
    expect(manifest.warnings.join("\n")).toContain("truncated at --limit 2");
  });

  test("--since sends an updatedAt filter and marks partial", async () => {
    const s = stub({ pages: { ...base(), issues: [[issue("a")]] } });
    const { manifest } = await runBackup(s.client, { out, version: "t", since: "2026-01-01T00:00:00.000Z", ...fast });
    const q = s.calls.find((c) => c.query.includes("Backup_issues"))!.query;
    expect(q).toContain('updatedAt: { gte: "2026-01-01T00:00:00.000Z" }');
    expect(manifest.partial).toBe(true);
    expect(manifest.scope.since).toBe("2026-01-01T00:00:00.000Z");
  });

  test("--team filters issues server-side and scopes dependents to the dumped issues", async () => {
    const s = stub({
      pages: {
        ...base(),
        issues: [[issue("a")]],
        comments: [[{ id: "c1", issueId: "a", body: "in" }, { id: "c2", issueId: "zzz", body: "out" }]],
      },
    });
    const { dir, manifest } = await runBackup(s.client, { out, version: "t", teams: ["t"], ...fast });
    expect(s.calls.find((c) => c.query.includes("Backup_issues"))!.query).toContain('team: { key: { in: ["T"] } }');
    expect(lines(dir, "comments.jsonl").map((r) => r.id)).toEqual(["c1"]);
    expect(manifest.partial).toBe(true);
  });

  test("--entities restricts the dump; unknown entities are a usage error", async () => {
    const s = stub({ pages: base() });
    const { manifest } = await runBackup(s.client, { out, version: "t", entities: ["teams"], ...fast });
    expect(Object.keys(manifest.entities)).toEqual(["teams"]);
    expect(manifest.partial).toBe(true);
    await expect(runBackup(s.client, { out, version: "t", entities: ["nope"], ...fast })).rejects.toThrow(/unknown entities/);
  });

  test("resolveSince handles windows and ISO dates", () => {
    const now = new Date("2026-10-04T12:00:00.000Z");
    expect(resolveSince("24h", now)).toBe("2026-10-03T12:00:00.000Z");
    expect(resolveSince("2d", now)).toBe("2026-10-02T12:00:00.000Z");
    expect(resolveSince("2026-09-01", now)).toBe("2026-09-01T00:00:00.000Z");
    expect(() => resolveSince("soon", now)).toThrow();
  });
});

describe("resilience", () => {
  test("a transient 503 is retried and the dump still completes", async () => {
    let thrown = 0;
    const s = stub({
      pages: { ...base(), issues: [[issue("a")]] },
      hook: (q) => {
        if (q.includes("Backup_issues") && thrown === 0) {
          thrown += 1;
          throw Object.assign(new Error("upstream"), { status: 503 });
        }
      },
    });
    const { manifest } = await runBackup(s.client, { out, version: "t", ...fast });
    expect(thrown).toBe(1);
    expect(manifest.entities.issues.count).toBe(1);
    expect(s.calls.filter((c) => c.query.includes("Backup_issues"))).toHaveLength(2);
  });

  test("a non-transient failure aborts and leaves a checkpoint; --resume skips finished entities", async () => {
    const pages = { ...base(), issues: [[issue("a")]] };
    const failing = stub({
      pages,
      hook: (q) => {
        if (q.includes("Backup_comments")) throw new Error("boom");
      },
    });
    await expect(runBackup(failing.client, { out, version: "t", ...fast })).rejects.toThrow("boom");
    const runDir = join(out, readdirSync(out).find((d) => d.startsWith("linear-"))!);
    expect(existsSync(join(runDir, ".state.json"))).toBe(true);

    const ok = stub({ pages });
    const { dir, manifest } = await runBackup(ok.client, { out, version: "t", resume: true, ...fast });
    expect(dir).toBe(runDir);
    expect(ok.calls.some((c) => c.query.includes("Backup_issues"))).toBe(false); // already checkpointed
    expect(ok.calls.some((c) => c.query.includes("Backup_comments"))).toBe(true);
    expect(manifest.entities.issues.count).toBe(1);
    expect(existsSync(join(dir, ".state.json"))).toBe(false);
  });

  test("--resume with different flags is refused", async () => {
    const failing = stub({ pages: base(), hook: (q) => { if (q.includes("Backup_issues")) throw new Error("boom"); } });
    await expect(runBackup(failing.client, { out, version: "t", ...fast })).rejects.toThrow("boom");
    await expect(runBackup(stub({ pages: base() }).client, { out, version: "t", resume: true, limit: 5, ...fast })).rejects.toThrow(/flags differ/);
  });
});

describe("history pass", () => {
  const hist = (id: string): Row => ({ id: `h-${id}`, createdAt: "2026-01-03T00:00:00.000Z", toStateId: "s1" });

  test("resumes from the last 50-issue checkpoint without refetching finished ones", async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `i${String(i).padStart(2, "0")}`);
    const pages = { ...base(), issues: [ids.map((id) => issue(id))] };
    const history = Object.fromEntries(ids.map((id) => [id, [hist(id)]]));
    const failing = stub({
      pages,
      history,
      hook: (q, vars) => {
        if (q.includes("BackupHistory") && vars?.id === "i55") throw new Error("history boom");
      },
    });
    await expect(runBackup(failing.client, { out, version: "t", includeHistory: true, ...fast })).rejects.toThrow("history boom");

    const ok = stub({ pages, history });
    const { dir, manifest } = await runBackup(ok.client, { out, version: "t", includeHistory: true, resume: true, markdown: false, ...fast });
    const fetched = ok.calls.filter((c) => c.query.includes("BackupHistory")).map((c) => c.vars?.id);
    expect(fetched).toEqual(ids.slice(50)); // first 50 were checkpointed; the rest are re-fetched
    expect(manifest.entities.issueHistory.count).toBe(60);
    expect(new Set(lines(dir, "issueHistory.jsonl").map((r) => r.issueId)).size).toBe(60);
  });

  test("sleeps when the request budget is under the floor", async () => {
    const slept: number[] = [];
    const s = stub({ pages: { ...base(), issues: [[issue("a"), issue("b")]] }, history: {}, remaining: 50 });
    await runBackup(s.client, { out, version: "t", includeHistory: true, sleep: async (ms) => { slept.push(ms); }, ...fast });
    expect(slept.length).toBeGreaterThan(0);
  });

  test("is off by default", async () => {
    const s = stub({ pages: { ...base(), issues: [[issue("a")]] } });
    const { manifest } = await runBackup(s.client, { out, version: "t", ...fast });
    expect(s.calls.some((c) => c.query.includes("BackupHistory"))).toBe(false);
    expect(manifest.entities.issueHistory).toBeUndefined();
  });
});

describe("markdown", () => {
  test("renderIssueMd opens with exactly the renderIssueDetail block", async () => {
    const s = stub({
      pages: {
        ...base(),
        issues: [[issue("a", { project: { id: "p1" }, projectMilestone: { id: "m1" }, parent: { id: "a0" } }), issue("a0")]],
        projects: [[{ id: "p1", name: "Proj" }]],
        projectMilestones: [[{ id: "m1", name: "Launch", targetDate: "2026-10-10" }]],
        comments: [[{ id: "c1", issueId: "a", body: "hello", createdAt: "2026-01-05T00:00:00.000Z", user: { id: "u1" } }]],
      },
    });
    const { dir } = await runBackup(s.client, { out, version: "t", ...fast });
    const data: Record<string, Row[]> = {};
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) data[f.replace(".jsonl", "")] = lines(dir, f);
    const lk = buildLookups(data);
    const rec = data.issues.find((r) => r.id === "a")!;
    const expected = renderIssueDetail({
      id: "a",
      identifier: "T-a",
      title: "Issue a",
      url: "https://linear.app/x/issue/T-a",
      state: "Todo",
      stateType: "unstarted",
      assignee: "Ada",
      priority: "High",
      project: "Proj",
      milestone: { id: "m1", name: "Launch", targetDate: "2026-10-10" },
      labels: ["bug"],
      parent: "T-a0",
      description: "body a",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const md = renderIssueMd(rec, lk);
    expect(md.startsWith(expected)).toBe(true);
    expect(md).toContain("## Comments (1)");
    expect(md).toContain("hello");
    expect(recordToDetail(rec, lk).labels).toEqual(["bug"]);
    expect(readFileSync(join(dir, "issues-md", "T", "T-a.md"), "utf8")).toBe(md);
  });

  test("--no-markdown skips issues-md/", async () => {
    const s = stub({ pages: { ...base(), issues: [[issue("a")]] } });
    const { dir, manifest } = await runBackup(s.client, { out, version: "t", markdown: false, ...fast });
    expect(existsSync(join(dir, "issues-md"))).toBe(false);
    expect(manifest.markdown).toBeNull();
  });
});

describe("unlisted teams", () => {
  test("team ids that rows reference but teams omits are recorded and tolerated by verify", async () => {
    const s = stub({
      pages: { ...base(), workflowStates: [[{ id: "s1", name: "Todo", type: "unstarted", team: { id: "t1" } }, { id: "s9", name: "Todo", type: "unstarted", team: { id: "hidden" } }]], issues: [[issue("a")]] },
    });
    const { dir, manifest } = await runBackup(s.client, { out, version: "t", ...fast });
    expect(manifest.unresolved).toEqual({ teams: ["hidden"] });
    expect(manifest.warnings.join("\n")).toContain("not returned by the teams query");
    expect((await verifyBackup(dir)).exitCode).toBe(0);
    // control: the same dangling id without the manifest allowance fails
    const m = JSON.parse(read(dir, "manifest.json"));
    delete m.unresolved;
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    expect((await verifyBackup(dir)).exitCode).toBe(1);
  });
});

describe("verifyBackup", () => {
  async function make(extra: Record<string, Row[][]> = {}) {
    const s = stub({ pages: { ...base(), issues: [[issue("a"), issue("b")]], ...extra } });
    return (await runBackup(s.client, { out, version: "t", ...fast })).dir;
  }

  test("a clean dump verifies offline with exit 0", async () => {
    const dir = await make();
    const r = await verifyBackup(dir);
    expect(r.exitCode).toBe(0);
    expect(r.hashMismatches).toEqual([]);
  });

  test("a tampered line is a hash mismatch (exit 1)", async () => {
    const dir = await make();
    const p = join(dir, "issues.jsonl");
    writeFileSync(p, read(dir, "issues.jsonl").replace("Issue a", "Issue X"));
    const r = await verifyBackup(dir);
    expect(r.exitCode).toBe(1);
    expect(r.hashMismatches.join("\n")).toContain("issues: sha256 differs");
  });

  test("a deleted line is a count mismatch (exit 1)", async () => {
    const dir = await make();
    const kept = read(dir, "issues.jsonl").split("\n").filter(Boolean).slice(0, 1).join("\n") + "\n";
    writeFileSync(join(dir, "issues.jsonl"), kept);
    const r = await verifyBackup(dir);
    expect(r.exitCode).toBe(1);
    expect(r.countMismatches.join("\n")).toContain("issues: 1 lines, manifest says 2");
  });

  test("a dangling reference fails a full dump but only notes a partial one", async () => {
    const full = await make({ comments: [[{ id: "c1", issueId: "ghost", body: "x" }]] });
    const r = await verifyBackup(full);
    expect(r.exitCode).toBe(1);
    expect(r.integrity.join("\n")).toContain("comments.issueId");

    rmSync(out, { recursive: true, force: true });
    out = mkdtempSync(join(tmpdir(), "linearctl-backup-"));
    const s = stub({ pages: { ...base(), issues: [[issue("a")]], comments: [[{ id: "c1", issueId: "ghost", body: "x" }]] } });
    const { dir } = await runBackup(s.client, { out, version: "t", entities: ["teams", "workflowStates", "users", "issueLabels", "issues", "comments"], ...fast });
    const partial = await verifyBackup(dir);
    expect(partial.integrity.length).toBeGreaterThan(0);
  });

  test("live count drift beyond tolerance exits 2; within tolerance exits 0", async () => {
    const dir = await make();
    const grew = stub({ pages: { ...base(), issues: [[issue("a"), issue("b"), issue("c"), issue("d")]] } });
    const live = {
      a: { identifier: "T-a", title: "Issue a", description: "body a", priorityLabel: "High", createdAt: "2026-01-01T00:00:00.000Z", team: { id: "t1" }, updatedAt: "2026-01-02T00:00:00.000Z", state: { name: "Todo" } },
      b: { identifier: "T-b", title: "Issue b", description: "body b", priorityLabel: "High", createdAt: "2026-01-01T00:00:00.000Z", team: { id: "t1" }, updatedAt: "2026-01-02T00:00:00.000Z", state: { name: "Todo" } },
    };
    const sGrew = stub({ pages: { ...base(), issues: [[issue("a"), issue("b"), issue("c"), issue("d")]] }, live });
    const r = await verifyBackup(dir, { client: sGrew.client, tolerance: 0.02, rand: () => 0 });
    expect(r.exitCode).toBe(2);
    expect(r.drift.join("\n")).toContain("issues: live 4, backup 2");
    void grew;

    const sSame = stub({ pages: { ...base(), issues: [[issue("a"), issue("b")]] }, live });
    const ok = await verifyBackup(dir, { client: sSame.client, tolerance: 0.02, rand: () => 0 });
    expect(ok.exitCode).toBe(0);
    const tolerant = await verifyBackup(dir, { client: sGrew.client, tolerance: 0.6, rand: () => 0 });
    expect(tolerant.drift).toEqual([]);
  });

  test("a sampled issue that differs live is reported (exit 2)", async () => {
    const dir = await make();
    const live = {
      a: { identifier: "T-a", title: "RENAMED", description: "body a", priorityLabel: "High", createdAt: "2026-01-01T00:00:00.000Z", team: { id: "t1" }, updatedAt: "2026-01-02T00:00:00.000Z", state: { name: "Todo" } },
      b: { identifier: "T-b", title: "Issue b", description: "body b", priorityLabel: "High", createdAt: "2026-01-01T00:00:00.000Z", team: { id: "t1" }, updatedAt: "2026-01-02T00:00:00.000Z", state: { name: "Todo" } },
    };
    const s = stub({ pages: { ...base(), issues: [[issue("a"), issue("b")]] }, live });
    const r = await verifyBackup(dir, { client: s.client, sample: 2, rand: (() => { let i = 0; return () => (i++ === 0 ? 0 : 0.99); })() });
    expect(r.exitCode).toBe(2);
    expect(r.sampleMismatches.join("\n")).toContain("T-a: title differ");
  });

  test("missing manifest is a usage error", async () => {
    await expect(verifyBackup(out)).rejects.toThrow(/no manifest/);
  });
});

describe("round 1 hardening", () => {
  test("a finished history pass is reused on --resume after a later crash", async () => {
    const fixed = new Date("2026-10-04T10:00:00.000Z");
    const pages = { ...base(), issues: [[issue("a"), issue("b")]] };
    const history = { a: [{ id: "h1", createdAt: "2026-01-03T00:00:00.000Z" }], b: [] };
    const dirName = join(out, "linear-20261004T100000Z");
    let planted = false;
    const crashing = stub({
      pages,
      history,
      hook: (q) => {
        if (q.includes("BackupHistory") && !planted) {
          planted = true;
          writeFileSync(join(dirName, "issues-md"), "blocker"); // makes the markdown step fail later
        }
      },
    });
    await expect(runBackup(crashing.client, { out, version: "t", includeHistory: true, now: () => fixed, ...fast })).rejects.toThrow();
    rmSync(join(dirName, "issues-md"));
    const again = stub({ pages, history });
    const { manifest } = await runBackup(again.client, { out, version: "t", includeHistory: true, resume: true, now: () => fixed, ...fast });
    expect(again.calls.some((c) => c.query.includes("BackupHistory"))).toBe(false);
    expect(manifest.entities.issueHistory.count).toBe(1);
  });

  test("history over many issues checkpoints in batches and keeps every row", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `i${String(i).padStart(3, "0")}`);
    const history = Object.fromEntries(ids.map((id) => [id, [{ id: `h-${id}`, createdAt: "2026-01-03T00:00:00.000Z" }]]));
    const s = stub({ pages: { ...base(), issues: [ids.map((id) => issue(id))] }, history });
    const { dir, manifest } = await runBackup(s.client, { out, version: "t", includeHistory: true, markdown: false, ...fast });
    expect(manifest.entities.issueHistory.count).toBe(120);
    expect(lines(dir, "issueHistory.jsonl")).toHaveLength(120);
  });

  test("manifest records the request count", async () => {
    const s = stub({ pages: { ...base(), issues: [[issue("a")]] } });
    const { manifest } = await runBackup(s.client, { out, version: "t", ...fast });
    expect(manifest.requests).toBe(s.calls.length);
  });

  test("unresolved-team detection is skipped (with a warning) under --limit", async () => {
    const s = stub({
      pages: { ...base(), workflowStates: [[{ id: "s9", name: "Todo", type: "unstarted", team: { id: "hidden" } }]], issues: [[issue("a")]] },
    });
    const { manifest } = await runBackup(s.client, { out, version: "t", limit: 5, ...fast });
    expect(manifest.unresolved).toBeUndefined();
    expect(manifest.warnings.join("\n")).toContain("unresolved-team check skipped");
  });

  test("an issue edited since the dump is a note, not drift; a changed createdAt is a failure", async () => {
    const s0 = stub({ pages: { ...base(), issues: [[issue("a")]] } });
    const { dir } = await runBackup(s0.client, { out, version: "t", ...fast });
    const liveBase = { identifier: "T-a", title: "Edited", description: "body a", priorityLabel: "High", createdAt: "2026-01-01T00:00:00.000Z", team: { id: "t1" }, state: { name: "Todo" } };
    const edited = stub({ pages: { ...base(), issues: [[issue("a")]] }, live: { a: { ...liveBase, updatedAt: "2026-02-01T00:00:00.000Z" } } });
    const r = await verifyBackup(dir, { client: edited.client, rand: () => 0 });
    expect(r.exitCode).toBe(0);
    expect(r.notes.join("\n")).toContain("edited since the dump");
    const bad = stub({ pages: { ...base(), issues: [[issue("a")]] }, live: { a: { ...liveBase, createdAt: "2020-01-01T00:00:00.000Z", updatedAt: "2026-02-01T00:00:00.000Z" } } });
    const r2 = await verifyBackup(dir, { client: bad.client, rand: () => 0 });
    expect(r2.exitCode).toBe(2);
    expect(r2.sampleMismatches.join("\n")).toContain("createdAt");
  });
});

describe("CLI entry point exit codes", () => {
  async function run(opts: Parameters<typeof backupCommand>[0]): Promise<number> {
    const exit = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const err = spyOn(console, "error").mockImplementation(() => {});
    const log = spyOn(console, "log").mockImplementation(() => {});
    try {
      await backupCommand(opts);
      return 0;
    } catch (e) {
      const m = /^exit:(\d+)$/.exec((e as Error).message);
      if (!m) throw e;
      return Number(m[1]);
    } finally {
      exit.mockRestore();
      err.mockRestore();
      log.mockRestore();
    }
  }

  test("no --out is a usage error (3)", async () => {
    expect(await run({})).toBe(3);
  });

  test("--verify --offline exits 0 on a clean dump and 1 on a tampered line", async () => {
    const s = stub({ pages: { ...base(), issues: [[issue("a"), issue("b")]] } });
    const { dir } = await runBackup(s.client, { out, version: "t", ...fast });
    expect(await run({ verify: dir, offline: true })).toBe(0);
    writeFileSync(join(dir, "issues.jsonl"), read(dir, "issues.jsonl").replace("Issue a", "Issue X"));
    expect(await run({ verify: dir, offline: true })).toBe(1);
  });
});
