import { readFileSync, writeFileSync } from "node:fs";
import { makeClient } from "../client.js";
import { printJson } from "../lib/output.js";
import {
  RateTracker,
  ReorgMismatch,
  RollbackRefused,
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
  // Parse with `!== undefined`, not truthiness: "0" must reach the validator
  // rather than being silently dropped as "no limit".
  const limit = opts.limit !== undefined ? Number.parseInt(opts.limit, 10) : undefined;
  const data = await census(client, { teamKeys: opts.team, limit }, makePace());
  if (opts.out) {
    writeFileSync(opts.out, JSON.stringify(data, null, 2) + "\n");
    process.stderr.write(`census written to ${opts.out}\n`);
  }
  // A capped census is a smoke probe, not a workspace total. Say so on stderr
  // so stdout stays pipe-clean; the JSON carries `partial` for machines.
  if (data.partial) {
    for (const r of data.partialReasons ?? ["--limit capped what was fetched; counts are lower bounds"])
      process.stderr.write(`partial: ${r}\n`);
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
    // Preserve the marker: planning against a capped census must not silently
    // present lower-bound counts as totals.
    partial: cand.partial === true,
    ...(Array.isArray(cand.partialReasons) ? { partialReasons: cand.partialReasons.map(String) } : {}),
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
  // Warning, not refusal: counts from a partial census are lower bounds.
  if (censusData.partial)
    plan.warnings.push(
      `census is partial (${(censusData.partialReasons ?? ["reason not recorded"]).join("; ")}); the plan was built from lower-bound counts`,
    );

  const lines = [
    JSON.stringify({ _meta: { ...plan.meta, warnings: plan.warnings } }),
    ...plan.ops.map((o) => JSON.stringify(o)),
  ].join("\n") + "\n";
  const out = opts.out ?? "reorg-plan.jsonl";
  writeFileSync(out, lines);
  for (const w of plan.warnings) process.stderr.write(`warning: ${w}\n`);
  for (const v of plan.visibility ?? [])
    process.stdout.write(
      `visibility change (${v.allowed ? "allowed" : "refused"}): ${v.kind} ${v.from} -> ${v.to}: ${v.count}\n`,
    );
  for (const n of plan.notes ?? []) process.stdout.write(`info: ${n}\n`);
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
  priorJournal?: string[];
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
      priorJournalPaths: opts.priorJournal,
      backupRecordPath: opts.backupRecord,
      pace: makePace(),
      onEvent: (ev) => process.stdout.write(`${ev.detail}\n`),
    });
    if (opts.check && !opts.apply) {
      if (result.drifted.length > 0 || result.refused.length > 0) {
        if (result.drifted.length > 0)
          process.stdout.write(`check: ${result.drifted.length} op(s) drifted — plan is stale, regenerate or review\n`);
        if (result.refused.length > 0)
          process.stdout.write(`check: ${result.refused.length} op(s) would be refused at apply (precondition reads or plan shape)\n`);
        process.exit(1);
      }
      process.stdout.write(`check: no drift, no precondition refusals across the plan\n`);
    } else if (result.dryRun && result.refused.length > 0) {
      process.stdout.write(`dry-run: ${result.refused.length} op(s) would be refused at apply (plan shape) — fix the plan before --apply\n`);
      process.exit(1);
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
  priorJournal?: string[];
  json?: boolean;
}

export async function reorgVerify(opts: ReorgVerifyOptions): Promise<void> {
  const plan = parsePlanFile(opts.plan);
  const phase = Number.parseInt(opts.phase, 10);
  const journalPath = opts.journal ?? `${opts.plan}.applied.jsonl`;
  const client = makeClient();
  const { ok, failures, gateGreen, superseded } = await verifyPhase(client, plan, phase, {
    journalPath,
    priorJournalPaths: opts.priorJournal,
    pace: makePace(),
    reportPath: opts.report ?? `${journalPath}.verify-phase-${phase}.json`,
  });
  if (opts.json) {
    printJson({ ok, failures, gateGreen, superseded });
  } else {
    for (const f of failures) process.stdout.write(`FAIL ${f}\n`);
    for (const sp of superseded) process.stdout.write(`SUPERSEDED ${sp}\n`);
    process.stdout.write(ok ? `phase ${phase} verified ✓\n` : `phase ${phase}: ${failures.length} failure(s)\n`);
    if (opts.priorJournal?.length)
      process.stdout.write(`phase ${phase} gate across journals: ${gateGreen ? "green" : "RED"}\n`);
  }
  if (!ok) process.exit(1);
}

export interface ReorgRollbackOptions {
  phase: string;
  apply?: boolean;
  check?: boolean;
  includeAlreadyApplied?: boolean;
  restoreRetired?: boolean;
  json?: boolean;
}

export async function reorgRollback(journalPath: string, opts: ReorgRollbackOptions): Promise<void> {
  const client = makeClient();
  try {
    const r = await rollbackPhase(client, journalPath, Number.parseInt(opts.phase, 10), {
      pace: makePace(),
      apply: opts.apply === true,
      check: opts.check === true,
      includeAlreadyApplied: opts.includeAlreadyApplied === true,
      restoreRetired: opts.restoreRetired === true,
      // --json keeps stdout a single document; progress goes to stderr
      onEvent: (ev) => (opts.json ? process.stderr : process.stdout).write(`${ev.detail}\n`),
    });
    const out = opts.json ? process.stderr : process.stdout;
    for (const s of r.skipped) out.write(`skipped: ${s}\n`);
    for (const d of r.drifted) out.write(`drift: ${d}\n`);
    if (opts.json) {
      printJson({
        dryRun: r.dryRun,
        planned: r.planned,
        rolledBack: r.rolledBack,
        skipped: r.skipped,
        drifted: r.drifted,
      });
    } else if (r.dryRun) {
      const tail = opts.check
        ? r.drifted.length > 0
          ? `check: ${r.drifted.length} op(s) drifted from the journaled state`
          : `check: no drift across ${r.planned} op(s)`
        : `dry-run: ${r.planned} inverse op(s), ${r.skipped.length} skipped; re-run with --apply to write`;
      process.stdout.write(`${tail}\n`);
    } else {
      process.stdout.write(`rolled back ${r.rolledBack} op(s), ${r.skipped.length} skipped\n`);
    }
    if (r.dryRun && opts.check && r.drifted.length > 0) process.exit(1);
  } catch (err) {
    if (err instanceof ReorgMismatch) {
      const msg = err instanceof RollbackRefused ? `ROLLBACK REFUSED at seq ${err.seq}: ${err.reason}` : `ROLLBACK MISMATCH at seq ${err.seq}: expected ${JSON.stringify(err.diff.expected)}, actual ${JSON.stringify(err.diff.actual)}`;
      if (opts.json) printJson({ error: "rollback-mismatch", seq: err.seq, expected: err.diff.expected, actual: err.diff.actual, message: msg });
      process.stderr.write(`${msg}\n`);
      process.exit(3);
    }
    throw err;
  }
}

/** test seam: journal read-through for CLI tests without a client. */
export function reorgJournalCount(path: string): number {
  return journalRead(path).length;
}
