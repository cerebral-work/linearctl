import { readFileSync, writeFileSync } from "node:fs";
import { makeClient } from "../client.js";
import { printJson } from "../lib/output.js";
import {
  RateTracker,
  ReorgMismatch,
  TokenBucket,
  census,
  journalRead,
  parsePlanFile,
  planFromRules,
  rollbackPhase,
  runPlan,
  sha256File,
  verifyPhase,
  REORG_RATE_PER_HOUR,
  type CensusData,
  type ReorgRule,
} from "../core/reorg.js";

/**
 * `linearctl reorg` — plan-file-driven workspace reorganization (census | plan
 * | apply | verify | rollback). The engine is generic; workspace-specific
 * rules live outside the repo. Dry-run by default; `--apply` requires a fresh
 * backup record; irreversible ops need --allow-irreversible + approval ids.
 * No Linear MCP anywhere in this path.
 */

function makePace() {
  return {
    bucket: new TokenBucket(REORG_RATE_PER_HOUR / 3600_000, 200),
    tracker: new RateTracker(Date.now, undefined, (remaining) =>
      process.stderr.write(`[reorg] rate budget low (${remaining}); sleeping to reset…\n`),
    ),
  };
}

export interface ReorgCensusOptions {
  team?: string[];
  limit?: string;
  out?: string;
  json?: boolean;
}

export async function reorgCensus(opts: ReorgCensusOptions): Promise<void> {
  const client = makeClient();
  const limit = opts.limit ? Number.parseInt(opts.limit, 10) : undefined;
  const data = await census(client, { teamKeys: opts.team, limit }, makePace());
  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(data, null, 2) + "\n");
    process.stderr.write(`census written to ${opts.out}\n`);
  }
  if (opts.json || !opts.out) {
    printJson(data);
    return;
  }
  const teams = data.teams.length;
  const labels = data.workspaceLabels.length;
  process.stdout.write(
    `census: ${teams} team(s), ${data.issues.length} issue(s), ${labels} workspace label(s), ${data.teamLabels.length} team label(s), ${data.projects.length} project(s), ${data.initiatives.length} initiative(s)\n`,
  );
}

export interface ReorgPlanOptions {
  rules: string;
  census: string;
  out?: string;
  /** Refuse to plan against a census older than this many minutes. */
  sinceCensus?: string;
}

export async function reorgPlan(opts: ReorgPlanOptions): Promise<void> {
  // Boundary validation: the census file is external input to this process.
  const parsed: unknown = JSON.parse(readFileSync(opts.census, "utf8"));
  if (!parsed || typeof parsed !== "object") throw new Error(`${opts.census} is not an object`);
  const cand = parsed as Partial<CensusData>;
  if (!Array.isArray(cand.teams) || !Array.isArray(cand.workspaceLabels))
    throw new Error(`${opts.census} is not a reorg census file (teams/workspaceLabels missing)`);
  const censusData: CensusData = {
    workspace: cand.workspace ?? { id: "unknown", urlKey: "unknown" },
    teams: cand.teams,
    issues: Array.isArray(cand.issues) ? cand.issues : [],
    workspaceLabels: cand.workspaceLabels,
    teamLabels: Array.isArray(cand.teamLabels) ? cand.teamLabels : [],
    projects: Array.isArray(cand.projects) ? cand.projects : [],
    initiatives: Array.isArray(cand.initiatives) ? cand.initiatives : [],
    generatedAt: typeof cand.generatedAt === "string" ? cand.generatedAt : "unknown",
    rateBudget: cand.rateBudget ?? { limit: 0, remaining: 0 },
  };
  if (opts.sinceCensus !== undefined) {
    const maxAgeMin = Number.parseInt(opts.sinceCensus, 10);
    if (!Number.isFinite(maxAgeMin) || maxAgeMin <= 0)
      throw new Error("--since-census takes minutes (positive integer)");
    const ageMs = Date.now() - Date.parse(censusData.generatedAt);
    if (!Number.isFinite(ageMs) || ageMs > maxAgeMin * 60_000)
      throw new Error(
        `census is stale (generated ${censusData.generatedAt}); re-run reorg census — planning against a census older than ${maxAgeMin}m is refused`,
      );
  }
  const rules = JSON.parse(readFileSync(opts.rules, "utf8")) as ReorgRule[];
  if (!Array.isArray(rules)) throw new Error(`${opts.rules} must be a JSON array of rules`);

  const meta = {
    generated: new Date().toISOString(),
    censusHash: sha256File(opts.census),
    workspaceId: censusData.workspace?.id ?? "unknown",
    rulesHash: sha256File(opts.rules),
  };
  const plan = planFromRules(rules, censusData, meta);

  const lines = [
    JSON.stringify({ _meta: { ...plan.meta, warnings: plan.warnings } }),
    ...plan.ops.map((o) => JSON.stringify(o)),
  ].join("\n") + "\n";
  const out = opts.out ?? "reorg-plan.jsonl";
  writeFileSync(out, lines);
  for (const w of plan.warnings) process.stderr.write(`warning: ${w}\n`);
  process.stdout.write(
    `plan: ${plan.ops.length} op(s) across phases ${[...new Set(plan.ops.map((o) => o.phase))].sort().join(", ")} → ${out}\n` +
      `review the file, then: linearctl reorg apply ${out} --phase N --apply --backup-record <backup.verified.json>\n`,
  );
}

export interface ReorgApplyOptions {
  phase?: string;
  apply?: boolean;
  check?: boolean;
  resume?: boolean;
  maxOps?: string;
  allowIrreversible?: boolean;
  backupRecord?: string;
  journal?: string;
}

export async function reorgApply(planPath: string, opts: ReorgApplyOptions): Promise<void> {
  const plan = parsePlanFile(planPath);
  const journalPath = opts.journal ?? `${planPath}.applied.jsonl`;
  const client = makeClient();
  try {
    const result = await runPlan(client, plan, {
      phase: opts.phase !== undefined ? Number.parseInt(opts.phase, 10) : undefined,
      apply: opts.apply === true,
      check: opts.check === true,
      resume: opts.resume === true,
      maxOps: opts.maxOps !== undefined ? Number.parseInt(opts.maxOps, 10) : undefined,
      allowIrreversible: opts.allowIrreversible === true,
      journalPath,
      backupRecordPath: opts.backupRecord,
      pace: makePace(),
      onEvent: (ev) => process.stdout.write(`${ev.detail}\n`),
    });
    if (opts.check && !opts.apply) {
      if (result.drifted.length > 0) {
        process.stdout.write(`check: ${result.drifted.length} op(s) drifted — plan is stale, regenerate or review\n`);
        process.exit(1);
      }
      process.stdout.write(`check: no drift across the plan\n`);
    } else if (result.dryRun) {
      process.stdout.write(`dry-run — re-run with --apply to write (journal: ${journalPath})\n`);
    } else {
      process.stdout.write(
        `applied ${result.applied} op(s), skipped ${result.skipped} (journaled)\n`,
      );
    }
  } catch (err) {
    if (err instanceof ReorgMismatch) {
      process.stderr.write(
        `MISMATCH at seq ${err.seq}:\n  expected ${JSON.stringify(err.diff.expected)}\n  actual   ${JSON.stringify(err.diff.actual)}\n`,
      );
      process.exit(3);
    }
    throw err;
  }
}

export interface ReorgVerifyOptions {
  plan: string;
  phase: string;
  journal?: string;
  report?: string;
  json?: boolean;
}

export async function reorgVerify(opts: ReorgVerifyOptions): Promise<void> {
  const plan = parsePlanFile(opts.plan);
  const phase = Number.parseInt(opts.phase, 10);
  const journalPath = opts.journal ?? `${opts.plan}.applied.jsonl`;
  const client = makeClient();
  const { ok, failures } = await verifyPhase(client, plan, phase, {
    journalPath,
    pace: makePace(),
    reportPath: opts.report ?? `${journalPath}.verify-phase-${phase}.json`,
  });
  if (opts.json) {
    printJson({ ok, failures });
  } else {
    for (const f of failures) process.stdout.write(`FAIL ${f}\n`);
    process.stdout.write(ok ? `phase ${phase} verified ✓\n` : `phase ${phase}: ${failures.length} failure(s)\n`);
  }
  if (!ok) process.exit(1);
}

export interface ReorgRollbackOptions {
  phase: string;
  json?: boolean;
}

export async function reorgRollback(journalPath: string, opts: ReorgRollbackOptions): Promise<void> {
  const client = makeClient();
  try {
    const { rolledBack, skipped } = await rollbackPhase(
      client,
      journalPath,
      Number.parseInt(opts.phase, 10),
      { pace: makePace(), onEvent: (ev) => process.stdout.write(`${ev.detail}\n`) },
    );
    for (const s of skipped) process.stdout.write(`skipped: ${s}\n`);
    const summary = `rolled back ${rolledBack} op(s), ${skipped.length} skipped`;
    if (opts.json) printJson({ rolledBack, skipped });
    else process.stdout.write(`${summary}\n`);
  } catch (err) {
    if (err instanceof ReorgMismatch) {
      process.stderr.write(`ROLLBACK MISMATCH at seq ${err.seq}\n`);
      process.exit(3);
    }
    throw err;
  }
}

/** test seam: journal read-through for CLI tests without a client. */
export function reorgJournalCount(path: string): number {
  return journalRead(path).length;
}
