#!/usr/bin/env bun
import { openCacheDb } from "../src/core/cache/db.js";
import {
  teams,
  workflowStates,
  issueLabels,
  issues,
  type InsertIssue,
  type InsertTeam,
  type InsertWorkflowState,
  type InsertIssueLabel,
} from "../src/core/cache/schema.js";
import {
  getCachedIssue,
  pullCachedIssues,
  searchCachedIssues,
} from "../src/core/cache/query.js";

interface BenchStats {
  count: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

function calculatePercentiles(durations: number[]): BenchStats {
  durations.sort((a, b) => a - b);
  const count = durations.length;
  const sum = durations.reduce((acc, d) => acc + d, 0);

  const p50 = durations[Math.floor(count * 0.5)];
  const p95 = durations[Math.floor(count * 0.95)];
  const p99 = durations[Math.floor(count * 0.99)];

  return {
    count,
    min: durations[0],
    max: durations[count - 1],
    avg: sum / count,
    p50,
    p95,
    p99,
  };
}

function printStats(name: string, stats: BenchStats, thresholdP99Ms: number): boolean {
  const passed = stats.p99 <= thresholdP99Ms;
  const badge = passed ? "✓ PASS" : "✗ FAIL";

  console.log(`\n=== [${badge}] ${name} ===`);
  console.log(`  Iterations: ${stats.count}`);
  console.log(`  Min:        ${stats.min.toFixed(3)} ms`);
  console.log(`  Avg:        ${stats.avg.toFixed(3)} ms`);
  console.log(`  p50:        ${stats.p50.toFixed(3)} ms`);
  console.log(`  p95:        ${stats.p95.toFixed(3)} ms`);
  console.log(`  p99:        ${stats.p99.toFixed(3)} ms (Guardrail: <= ${thresholdP99Ms.toFixed(3)} ms)`);
  console.log(`  Max:        ${stats.max.toFixed(3)} ms`);

  return passed;
}

async function runBenchmark() {
  console.log("==> Initializing in-memory SQLite cache for benchmark...");
  const cache = openCacheDb({ inMemory: true });

  const TOTAL_ISSUES = 10_000;
  const TOTAL_TEAMS = 10;
  const TOTAL_STATES = 20;
  const TOTAL_LABELS = 50;

  console.log(`==> Seeding dataset (${TOTAL_TEAMS} teams, ${TOTAL_STATES} states, ${TOTAL_LABELS} labels, ${TOTAL_ISSUES} issues)...`);

  const nowIso = new Date().toISOString();

  const teamList: InsertTeam[] = [];
  for (let i = 1; i <= TOTAL_TEAMS; i++) {
    teamList.push({
      id: `team-${i}`,
      name: `Engineering Team ${i}`,
      key: `TEAM${i}`,
      updatedAt: nowIso,
    });
  }

  const stateTypes = ["backlog", "unstarted", "started", "completed", "canceled"];
  const stateList: InsertWorkflowState[] = [];
  for (let t = 1; t <= TOTAL_TEAMS; t++) {
    for (let s = 0; s < stateTypes.length; s++) {
      const type = stateTypes[s];
      stateList.push({
        id: `state-${t}-${type}`,
        name: `${type.charAt(0).toUpperCase() + type.slice(1)} (Team ${t})`,
        type,
        teamId: `team-${t}`,
        position: (s + 1) * 10,
        updatedAt: nowIso,
      });
    }
  }

  const labelList: InsertIssueLabel[] = [];
  for (let i = 1; i <= TOTAL_LABELS; i++) {
    labelList.push({
      id: `label-${i}`,
      name: `label-${i}`,
      color: "#ff0000",
      updatedAt: nowIso,
    });
  }

  const issueList: InsertIssue[] = [];
  const words = [
    "performance", "latency", "sqlite", "drizzle", "cache",
    "worker", "reconcile", "operator", "funnel", "pipeline",
    "memory", "deadlock", "timeout", "regression", "benchmark",
  ];

  for (let i = 1; i <= TOTAL_ISSUES; i++) {
    const teamIdx = ((i - 1) % TOTAL_TEAMS) + 1;
    const type = stateTypes[Math.floor((i - 1) / TOTAL_TEAMS) % stateTypes.length];
    const stateId = `state-${teamIdx}-${type}`;
    const stateName = `${type.charAt(0).toUpperCase() + type.slice(1)} (Team ${teamIdx})`;
    const w1 = words[i % words.length];
    const w2 = words[(i * 3) % words.length];

    issueList.push({
      id: `issue-uuid-${i.toString().padStart(6, "0")}`,
      identifier: `TEAM${teamIdx}-${i}`,
      number: i,
      title: `Synthetic issue ${i} addressing ${w1} and ${w2}`,
      description: `Detailed description for issue ${i} with discussion on ${w1} metrics and ${w2} architecture.`,
      priority: (i % 4) + 1,
      teamId: `team-${teamIdx}`,
      teamKey: `TEAM${teamIdx}`,
      stateId,
      stateName,
      stateType: type,
      labelsJson: JSON.stringify([`label-${(i % 10) + 1}`, `label-${(i % 5) + 1}`]),
      url: `https://linear.app/cerebral/issue/TEAM${teamIdx}-${i}`,
      createdAt: new Date(Date.now() - i * 60000).toISOString(),
      updatedAt: new Date(Date.now() - (i % 1000) * 60000).toISOString(),
    });
  }

  const seedStart = performance.now();
  cache.db.transaction((tx) => {
    for (const t of teamList) tx.insert(teams).values(t).run();
    for (const s of stateList) tx.insert(workflowStates).values(s).run();
    for (const l of labelList) tx.insert(issueLabels).values(l).run();
    for (const iss of issueList) tx.insert(issues).values(iss).run();
  });
  const seedDuration = performance.now() - seedStart;
  console.log(`==> Seeded ${TOTAL_ISSUES} issues in ${seedDuration.toFixed(1)} ms.`);

  const ITERATIONS = 1000;
  let allPassed = true;

  // 1. Point lookup by identifier
  console.log(`\n--> Running Benchmark 1: Point lookup by identifier (${ITERATIONS} iterations)...`);
  const pointDurations: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const targetNum = (i % TOTAL_ISSUES) + 1;
    const teamIdx = ((targetNum - 1) % TOTAL_TEAMS) + 1;
    const identifier = `TEAM${teamIdx}-${targetNum}`;

    const t0 = performance.now();
    const res = getCachedIssue(cache, identifier);
    pointDurations.push(performance.now() - t0);

    if (!res) {
      throw new Error(`Failed to lookup issue: ${identifier}`);
    }
  }
  const pointStats = calculatePercentiles(pointDurations);
  if (!printStats("Point Issue Lookup by Identifier", pointStats, 2.0)) {
    allPassed = false;
  }

  // 2. Funnel pull query with state and team filters
  console.log(`\n--> Running Benchmark 2: Funnel pull query (${ITERATIONS} iterations)...`);
  const pullDurations: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const teamKey = `TEAM${(i % TOTAL_TEAMS) + 1}`;

    const t0 = performance.now();
    const res = pullCachedIssues(cache, {
      teamKey,
      state: "started",
      limit: 50,
    });
    pullDurations.push(performance.now() - t0);

    if (res.length === 0) {
      throw new Error(`Expected issues for team ${teamKey}`);
    }
  }
  const pullStats = calculatePercentiles(pullDurations);
  if (!printStats("Funnel Pull Query (Filtered & Sorted)", pullStats, 5.0)) {
    allPassed = false;
  }

  // 3. FTS5 full-text search match
  console.log(`\n--> Running Benchmark 3: FTS5 Full-Text Search (${ITERATIONS} iterations)...`);
  const ftsDurations: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const kw = words[i % words.length];

    const t0 = performance.now();
    const res = searchCachedIssues(cache, {
      text: kw,
      limit: 20,
    });
    ftsDurations.push(performance.now() - t0);

    if (res.length === 0) {
      throw new Error(`Expected search hits for keyword: ${kw}`);
    }
  }
  const ftsStats = calculatePercentiles(ftsDurations);
  if (!printStats("FTS5 Full-Text Search Match", ftsStats, 10.0)) {
    allPassed = false;
  }

  cache.close();

  if (!allPassed) {
    console.error("\n[ERROR] Latency guardrails failed!");
    process.exit(1);
  }

  console.log("\n✓ All performance benchmark guardrails passed successfully!");
}

runBenchmark().catch((err) => {
  console.error("Benchmark error:", err);
  process.exit(1);
});
