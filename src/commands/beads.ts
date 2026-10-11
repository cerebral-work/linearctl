import { readFileSync, writeFileSync } from "fs";
import { makeClient } from "../client.js";
import { printJson, printTable } from "../lib/output.js";
import { usageError } from "../lib/errors.js";
import { pc } from "../lib/style.js";
import {
  discoverBeads,
  initBeadsWorkspace,
  loadBeadsIssues,
  saveBeadsIssues,
  loadBeadsMetadata,
  evaluateReadiness,
  getReadyIssues,
  getIssueBlockers,
  getIssueDependents,
  claimIssue,
  closeIssue,
  syncBeads,
  type BeadsIssue,
  type BeadsSyncOptions,
} from "../core/beads/index.js";

interface BeadsInitOptions {
  team?: string;
  project?: string;
  idMode?: "linear" | "hash";
  json?: boolean;
}

export async function beadsInitCmd(opts: BeadsInitOptions): Promise<void> {
  const result = await initBeadsWorkspace(process.cwd(), {
    teamKey: opts.team,
    projectId: opts.project,
    idMode: opts.idMode,
  });

  if (opts.json) {
    printJson({
      status: "initialized",
      beadsDir: result.beadsDir,
      hasBdCli: result.hasBdCli,
      bdCliPath: result.bdCliPath,
    });
    return;
  }

  process.stdout.write(pc.green("✓ Initialized Beads workspace at ") + result.beadsDir + "\n");
  if (result.hasBdCli) {
    process.stdout.write(pc.dim(`  System bd CLI detected at: ${result.bdCliPath}\n`));
  } else {
    process.stdout.write(pc.dim("  Standalone embedded engine active (bd CLI not required).\n"));
  }
}

interface BeadsStatusOptions {
  json?: boolean;
}

export async function beadsStatusCmd(opts: BeadsStatusOptions): Promise<void> {
  const discovery = discoverBeads();

  if (!discovery.found) {
    if (opts.json) {
      printJson({ found: false, message: "No Beads workspace discovered." });
      return;
    }
    process.stdout.write(pc.yellow("No Beads workspace discovered.\n"));
    process.stdout.write("Run 'linearctl beads init' to initialize, or set BEADS_DIR.\n");
    return;
  }

  const metadata = loadBeadsMetadata(discovery);
  const issues = loadBeadsIssues(discovery);
  const readiness = evaluateReadiness(issues);

  const openCount = issues.filter((i) => i.status === "open").length;
  const inProgressCount = issues.filter((i) => i.status === "in_progress").length;
  const closedCount = issues.filter((i) => i.status === "closed").length;

  if (opts.json) {
    printJson({
      found: true,
      rootDir: discovery.rootDir,
      beadsDir: discovery.beadsDir,
      issuesPath: discovery.issuesPath,
      hasBdCli: discovery.hasBdCli,
      bdCliPath: discovery.bdCliPath,
      lastSync: metadata?.last_sync ?? null,
      teamIds: metadata?.team_ids ?? [],
      counts: {
        total: issues.length,
        open: openCount,
        inProgress: inProgressCount,
        closed: closedCount,
        ready: readiness.ready.length,
        blocked: readiness.blocked.length,
      },
    });
    return;
  }

  process.stdout.write(pc.bold("\nBeads Workspace Status\n"));
  process.stdout.write(`  Location:   ${discovery.beadsDir}\n`);
  process.stdout.write(`  Backend:    ${metadata?.backend ?? "linearctl"}\n`);
  process.stdout.write(`  bd CLI:     ${discovery.hasBdCli ? pc.green("installed (" + discovery.bdCliPath + ")") : pc.dim("not in PATH (embedded engine)")}\n`);
  process.stdout.write(`  Last sync:  ${metadata?.last_sync ? pc.cyan(metadata.last_sync) : pc.dim("never")}\n\n`);

  const rows = [
    { Status: "Ready (unblocked)", Count: String(readiness.ready.length) },
    { Status: "Blocked by deps", Count: String(readiness.blocked.length) },
    { Status: "In Progress", Count: String(inProgressCount) },
    { Status: "Open (total)", Count: String(openCount) },
    { Status: "Closed", Count: String(closedCount) },
    { Status: "Total Issues", Count: String(issues.length) },
  ];

  printTable(rows, ["Status", "Count"]);
}

interface BeadsSyncCmdOptions extends BeadsSyncOptions {
  json?: boolean;
}

export async function beadsSyncCmd(opts: BeadsSyncCmdOptions): Promise<void> {
  const discovery = discoverBeads();
  if (!discovery.found) {
    throw usageError("No Beads workspace discovered. Run 'linearctl beads init' to initialize, or set BEADS_DIR.");
  }

  const client = makeClient();
  const stats = await syncBeads(client, discovery, opts);

  if (opts.json) {
    printJson(stats);
    return;
  }

  process.stdout.write(pc.green("✓ Beads sync complete\n"));
  const rows = [
    { Metric: "Issues Pulled", Value: String(stats.pulled) },
    { Metric: "New Local Issues", Value: String(stats.created) },
    { Metric: "Updated Local Issues", Value: String(stats.updated) },
    { Metric: "Issues Pushed", Value: String(stats.pushed) },
    { Metric: "Pushed (Created)", Value: String(stats.pushedCreated) },
    { Metric: "Pushed (Updated)", Value: String(stats.pushedUpdated) },
    { Metric: "Ready (Unblocked)", Value: pc.bold(String(stats.readyCount)) },
    { Metric: "Total Local Issues", Value: String(stats.totalLocal) },
    { Metric: "Duration", Value: `${stats.durationMs}ms` },
  ];

  printTable(rows, ["Metric", "Value"]);
}

interface BeadsReadyOptions {
  team?: string[];
  priority?: number;
  json?: boolean;
}

export async function beadsReadyCmd(opts: BeadsReadyOptions): Promise<void> {
  const discovery = discoverBeads();
  if (!discovery.found) {
    throw usageError("No Beads workspace discovered. Run 'linearctl beads init' to initialize, or set BEADS_DIR.");
  }

  const issues = loadBeadsIssues(discovery);
  let ready = getReadyIssues(issues);

  if (opts.priority !== undefined) {
    ready = ready.filter((i) => i.priority === opts.priority);
  }

  if (opts.team && opts.team.length > 0) {
    ready = ready.filter((i) => opts.team!.some((t) => i.id.startsWith(t + "-")));
  }

  if (opts.json) {
    printJson(ready);
    return;
  }

  if (ready.length === 0) {
    process.stdout.write(pc.dim("No unblocked ready tasks found in local Beads graph.\n"));
    return;
  }

  process.stdout.write(pc.bold(`\nReady (Unblocked) Tasks (${ready.length})\n\n`));

  const priorityLabels: Record<number, string> = {
    0: pc.red("P0 Urgent"),
    1: pc.yellow("P1 High"),
    2: pc.blue("P2 Medium"),
    3: pc.dim("P3 Low"),
    4: pc.dim("P4 Backlog"),
  };

  const rows = ready.map((i) => ({
    ID: pc.bold(i.id),
    Priority: priorityLabels[i.priority] ?? `P${i.priority}`,
    Title: i.title,
    Assignee: i.assignee || pc.dim("unassigned"),
  }));

  printTable(rows, ["ID", "Priority", "Title", "Assignee"]);
}

interface BeadsShowOptions {
  json?: boolean;
}

export async function beadsShowCmd(id: string, opts: BeadsShowOptions): Promise<void> {
  const discovery = discoverBeads();
  if (!discovery.found) {
    throw usageError("No Beads workspace discovered. Run 'linearctl beads init' to initialize, or set BEADS_DIR.");
  }

  const issues = loadBeadsIssues(discovery);
  const target = issues.find((i) => i.id === id || i.external_ref === id);

  if (!target) {
    throw usageError(`Issue ${id} not found in local Beads workspace.`);
  }

  const blockers = getIssueBlockers(target.id, issues);
  const dependents = getIssueDependents(target.id, issues);

  if (opts.json) {
    printJson({
      issue: target,
      blockers,
      dependents: dependents.map((d) => ({ id: d.id, title: d.title, status: d.status })),
    });
    return;
  }

  process.stdout.write(pc.bold(`\n${target.id}: ${target.title}\n`));
  process.stdout.write(`  Status:    ${target.status}\n`);
  process.stdout.write(`  Priority:  P${target.priority}\n`);
  process.stdout.write(`  Type:      ${target.issue_type || "task"}\n`);
  process.stdout.write(`  Assignee:  ${target.assignee || pc.dim("unassigned")}\n`);
  if (target.external_ref) {
    process.stdout.write(`  Linear:    ${target.external_ref}\n`);
  }
  if (target.created_at) {
    process.stdout.write(`  Created:   ${target.created_at}\n`);
  }

  if (target.description) {
    process.stdout.write(`\n${pc.bold("Description:")}\n${target.description}\n`);
  }

  if (blockers.length > 0) {
    process.stdout.write(`\n${pc.bold("Blocked by:")}\n`);
    for (const b of blockers) {
      const statusColor = b.status === "closed" ? pc.green : pc.red;
      process.stdout.write(`  - ${pc.bold(b.id)}: ${b.title} [${statusColor(b.status)}]\n`);
    }
  } else {
    process.stdout.write(`\n${pc.green("✓ No active blockers (Ready)")}\n`);
  }

  if (dependents.length > 0) {
    process.stdout.write(`\n${pc.bold("Blocks downstream:")}\n`);
    for (const d of dependents) {
      process.stdout.write(`  - ${pc.bold(d.id)}: ${d.title} [${d.status}]\n`);
    }
  }
}

interface BeadsClaimOptions {
  push?: boolean;
  json?: boolean;
}

export async function beadsClaimCmd(id: string, opts: BeadsClaimOptions): Promise<void> {
  const discovery = discoverBeads();
  if (!discovery.found) {
    throw usageError("No Beads workspace discovered. Run 'linearctl beads init' to initialize, or set BEADS_DIR.");
  }

  const issues = loadBeadsIssues(discovery);
  const actor = process.env.USER || "agent";
  const { updatedIssue, allIssues } = claimIssue(id, actor, issues);

  saveBeadsIssues(discovery, allIssues);

  if (opts.push) {
    try {
      const client = makeClient();
      await client.issue(updatedIssue.id).then(async (linearIssue) => {
        const team = await linearIssue.team;
        if (team) {
          const states = await client.workflowStates({ filter: { team: { id: { eq: team.id } } } });
          const startedState = states.nodes.find((s) => s.type === "started");
          if (startedState) {
            await linearIssue.update({ stateId: startedState.id });
          }
        }
      });
    } catch (err) {
      process.stderr.write(pc.yellow(`Warning: remote push failed: ${String(err)}\n`));
    }
  }

  if (opts.json) {
    printJson(updatedIssue);
    return;
  }

  process.stdout.write(pc.green(`✓ Claimed ${updatedIssue.id} (status: in_progress, assignee: ${actor})\n`));
}

interface BeadsCloseOptions {
  reason?: string;
  push?: boolean;
  json?: boolean;
}

export async function beadsCloseCmd(id: string, opts: BeadsCloseOptions): Promise<void> {
  const discovery = discoverBeads();
  if (!discovery.found) {
    throw usageError("No Beads workspace discovered. Run 'linearctl beads init' to initialize, or set BEADS_DIR.");
  }

  const issues = loadBeadsIssues(discovery);
  const { closedIssue, newlyReady, allIssues } = closeIssue(
    id,
    { reason: opts.reason, session: process.env.CLAUDE_SESSION_ID },
    issues
  );

  saveBeadsIssues(discovery, allIssues);

  if (opts.push) {
    try {
      const client = makeClient();
      await client.issue(closedIssue.id).then(async (linearIssue) => {
        const team = await linearIssue.team;
        if (team) {
          const states = await client.workflowStates({ filter: { team: { id: { eq: team.id } } } });
          const completedState = states.nodes.find((s) => s.type === "completed");
          if (completedState) {
            await linearIssue.update({ stateId: completedState.id });
          }
        }
      });
    } catch (err) {
      process.stderr.write(pc.yellow(`Warning: remote push failed: ${String(err)}\n`));
    }
  }

  if (opts.json) {
    printJson({ closed: closedIssue, newlyReady });
    return;
  }

  process.stdout.write(pc.green(`✓ Closed ${closedIssue.id}\n`));
  if (newlyReady.length > 0) {
    process.stdout.write(pc.bold(`  ${newlyReady.length} downstream task(s) unblocked and now ready:\n`));
    for (const r of newlyReady) {
      process.stdout.write(`    - ${pc.bold(r.id)}: ${r.title}\n`);
    }
  }
}

export async function beadsExportCmd(opts: { out?: string }): Promise<void> {
  const discovery = discoverBeads();
  if (!discovery.found) {
    throw usageError("No Beads workspace discovered. Run 'linearctl beads init' to initialize, or set BEADS_DIR.");
  }

  const issues = loadBeadsIssues(discovery);
  const content = issues.map((i) => JSON.stringify(i)).join("\n") + "\n";

  if (opts.out) {
    writeFileSync(opts.out, content, "utf8");
    process.stdout.write(pc.green(`✓ Exported ${issues.length} issues to ${opts.out}\n`));
  } else {
    process.stdout.write(content);
  }
}

export async function beadsImportCmd(filePath: string, opts: { dryRun?: boolean }): Promise<void> {
  const discovery = discoverBeads();
  if (!discovery.found) {
    throw usageError("No Beads workspace discovered. Run 'linearctl beads init' to initialize, or set BEADS_DIR.");
  }

  const content = readFileSync(filePath, "utf8");
  const importedIssues: BeadsIssue[] = content
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l));

  const existing = loadBeadsIssues(discovery);
  const existingMap = new Map<string, BeadsIssue>(existing.map((i) => [i.id, i]));

  let added = 0;
  let updated = 0;

  for (const imp of importedIssues) {
    if (existingMap.has(imp.id)) {
      existingMap.set(imp.id, imp);
      updated++;
    } else {
      existingMap.set(imp.id, imp);
      added++;
    }
  }

  if (!opts.dryRun) {
    saveBeadsIssues(discovery, Array.from(existingMap.values()));
  }

  process.stdout.write(pc.green(`✓ Imported ${importedIssues.length} issues (${added} added, ${updated} updated)\n`));
}

export async function beadsPlanCmd(opts: import("./plan.js").PlanCmdOptions): Promise<void> {
  const { planGenerateCmd } = await import("./plan.js");
  await planGenerateCmd({ ...opts, from: "beads" });
}

