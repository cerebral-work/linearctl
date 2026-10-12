import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { makeClient } from "../client.js";
import { printJson, printTable } from "../lib/output.js";
import { usageError } from "../lib/errors.js";
import { pc } from "../lib/style.js";
import {
  discoverBeads,
  loadBeadsIssues,
  type BeadsIssue,
} from "../core/beads/index.js";
import {
  fetchLinearIssues,
  fetchLinearRelations,
  convertLinearToBeads,
} from "../core/beads/sync.js";
import {
  generateSagaPlan,
  serializePlanToToml,
  parseSagaPlanToml,
  computeWaves,
  runSagaCliSchedule,
  type PlanGenerateOptions,
  type SagaPlan,
  type CpmScheduleResult,
} from "../core/plan/index.js";

export interface PlanCmdOptions extends PlanGenerateOptions {
  out?: string;
  schedule?: boolean;
  json?: boolean;
}

export interface PlanScheduleCmdOptions {
  maxConcurrency?: number;
  json?: boolean;
}

/**
 * Loads issues from Beads or Linear depending on source preference and workspace state.
 */
async function loadSourceIssues(opts: PlanCmdOptions): Promise<BeadsIssue[]> {
  if (opts.from === "beads") {
    const discovery = discoverBeads();
    if (!discovery.found) {
      throw usageError("No Beads workspace discovered. Run 'linearctl beads init' to initialize, or set BEADS_DIR.");
    }
    return loadBeadsIssues(discovery);
  }

  if (opts.from === "linear") {
    const client = makeClient();
    const rawIssues = await fetchLinearIssues(client, opts);
    const rawRelations = await fetchLinearRelations(client);
    return convertLinearToBeads(rawIssues, rawRelations);
  }

  // Auto-detection: prefer local Beads graph if discovered, otherwise fetch from Linear
  const discovery = discoverBeads();
  if (discovery.found) {
    return loadBeadsIssues(discovery);
  }

  const client = makeClient();
  const rawIssues = await fetchLinearIssues(client, opts);
  const rawRelations = await fetchLinearRelations(client);
  return convertLinearToBeads(rawIssues, rawRelations);
}

/**
 * Renders CPM schedule and wave breakdown to stdout.
 */
function renderCpmSchedule(result: CpmScheduleResult): void {
  process.stdout.write(pc.bold(`\nSaga Plan CPM Schedule: ${result.flow}\n`));
  process.stdout.write(`  Max concurrency: ${result.max_concurrency}\n`);
  process.stdout.write(`  Total duration:  ${result.total_duration}\n`);
  process.stdout.write(`  Execution waves: ${result.waves.length}\n\n`);

  process.stdout.write(pc.bold("Waves:\n"));
  for (let i = 0; i < result.waves.length; i++) {
    const waveSteps = result.waves[i].map((id) => {
      const step = result.steps.find((s) => s.id === id);
      return step?.critical ? pc.red(id + "*") : id;
    });
    process.stdout.write(`  Wave ${i}: [ ${waveSteps.join(", ")} ]\n`);
  }
  process.stdout.write("\n");

  const rows = result.steps.map((s) => ({
    Wave: String(s.wave),
    ID: s.critical ? pc.red(s.id + " *") : s.id,
    Role: s.role,
    Dur: String(s.duration),
    ES: String(s.es),
    EF: String(s.ef),
    LS: String(s.ls),
    LF: String(s.lf),
    Slack: String(s.slack),
    Critical: s.critical ? pc.red("yes") : "no",
  }));

  printTable(rows, ["Wave", "ID", "Role", "Dur", "ES", "EF", "LS", "LF", "Slack", "Critical"]);
  process.stdout.write(pc.dim("\n  * marks steps on the critical path (zero slack)\n\n"));
}

/**
 * Generate a Saga Spec 0040 Plan from Beads graph or Linear issues.
 */
export async function planGenerateCmd(opts: PlanCmdOptions): Promise<void> {
  const issues = await loadSourceIssues(opts);
  const plan = generateSagaPlan(issues, opts);
  const tomlContent = serializePlanToToml(plan);

  if (opts.schedule) {
    const scheduleResult = computeWaves(plan);
    if (opts.json) {
      printJson(scheduleResult);
      return;
    }
    renderCpmSchedule(scheduleResult);
    if (opts.out) {
      const targetDir = dirname(resolve(opts.out));
      if (!existsSync(targetDir)) {
        mkdirSync(targetDir, { recursive: true });
      }
      writeFileSync(opts.out, tomlContent, "utf8");
      process.stdout.write(pc.green(`✓ Saved plan TOML to ${opts.out}\n`));
    }
    return;
  }

  if (opts.out) {
    const targetDir = dirname(resolve(opts.out));
    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }
    writeFileSync(opts.out, tomlContent, "utf8");
    if (opts.json) {
      printJson({ status: "saved", out: opts.out, steps: plan.steps.length, flow: plan.flow.name });
    } else {
      process.stdout.write(pc.green(`✓ Generated Saga plan written to ${opts.out} (${plan.steps.length} steps)\n`));
    }
    return;
  }

  if (opts.json) {
    printJson(plan);
    return;
  }

  process.stdout.write(tomlContent);
}

/**
 * Schedule and inspect CPM waves for a plan file or stdin.
 */
export async function planScheduleCmd(
  file: string | undefined,
  opts: PlanScheduleCmdOptions
): Promise<void> {
  let tomlText = "";
  let resolvedPath: string | null = null;

  if (file && file !== "-") {
    resolvedPath = resolve(file);
    if (!existsSync(resolvedPath)) {
      throw usageError(`Plan file not found: ${file}`);
    }
    tomlText = readFileSync(resolvedPath, "utf8");
  } else if (file === "-") {
    // Read from stdin
    tomlText = readFileSync(0, "utf8");
  } else {
    // No file provided: check if .saga/plans contains a default plan or generate from workspace
    const discovery = discoverBeads();
    if (discovery.found) {
      const issues = loadBeadsIssues(discovery);
      const plan = generateSagaPlan(issues, { maxConcurrency: opts.maxConcurrency });
      const scheduleResult = computeWaves(plan);
      if (opts.json) {
        printJson(scheduleResult);
        return;
      }
      renderCpmSchedule(scheduleResult);
      return;
    }
    throw usageError("Please specify a plan file (e.g. .saga/plans/<plan>.toml) or stdin (-)");
  }

  // If a disk file was provided and saga binary is present, try native saga CLI first
  if (resolvedPath) {
    const nativeResult = await runSagaCliSchedule(resolvedPath);
    if (nativeResult) {
      if (opts.json) {
        printJson(nativeResult);
        return;
      }
      renderCpmSchedule(nativeResult);
      return;
    }
  }

  const plan = parseSagaPlanToml(tomlText);
  if (opts.maxConcurrency) {
    plan.flow.max_concurrency = opts.maxConcurrency;
  }

  const scheduleResult = computeWaves(plan);
  if (opts.json) {
    printJson(scheduleResult);
    return;
  }

  renderCpmSchedule(scheduleResult);
}
