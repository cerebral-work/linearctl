import { spawn } from "node:child_process";
import type {
  SagaPlan,
  SagaPlanStep,
  AgentRole,
  CpmStepSchedule,
  CpmScheduleResult,
} from "./types.js";

/**
 * Port of uas / saga classify_step (Spec 0040 U9, unchanged).
 */
export function classifyStepRole(step: SagaPlanStep): AgentRole {
  const kind = (step.kind || "verify").toLowerCase();
  if (kind === "gate" || step.gate) {
    return "main_session";
  }

  if (step.agent) {
    const a = step.agent.toLowerCase();
    if (a === "probe" || a === "fast" || a === "lint") return "probe";
    if (a === "critic" || a === "review") return "critic";
    if (a === "builder" || a === "impl") return "builder";
    if (a === "main" || a === "operator") return "main_session";
  }

  if (kind === "verify" || kind === "test") {
    const id = step.id.toLowerCase();
    const title = step.title.toLowerCase();
    if (
      id.includes("review") ||
      id.includes("critic") ||
      title.includes("review") ||
      title.includes("critic")
    ) {
      return "critic";
    }
    return "probe";
  }

  if (kind === "impl") {
    return "builder";
  }

  if (kind === "gate") {
    return "main_session";
  }

  return "probe";
}

/**
 * Returns the effective duration of a step (Spec 0040 U2).
 * Default: verify=5, impl=20, gate=1.
 */
export function getEffectiveDuration(step: SagaPlanStep): number {
  if (step.duration !== undefined && step.duration >= 0) {
    return step.duration;
  }
  const kind = (step.kind || "verify").toLowerCase();
  if (kind === "impl") return 20;
  if (kind === "gate") return 1;
  return 5;
}

export interface CpmComputeResult {
  steps: Map<string, CpmStepSchedule>;
  total_duration: number;
  critical_path: string[];
}

/**
 * Computes CPM schedule according to Saga Spec 0040 U1 & U2.
 */
export function computeCpm(steps: SagaPlanStep[]): CpmComputeResult {
  const byId = new Map<string, SagaPlanStep>();

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (!s.id || s.id.trim().length === 0) {
      throw new Error(`step ${i} has an empty id`);
    }
    if (byId.has(s.id)) {
      throw new Error(`duplicate step id: ${s.id}`);
    }
    byId.set(s.id, s);
  }

  for (const step of steps) {
    const deps = step.deps || [];
    for (const dep of deps) {
      if (dep === step.id) {
        throw new Error(`step ${step.id} cannot depend on itself`);
      }
      if (!byId.has(dep)) {
        throw new Error(`step ${step.id} references unknown dependency: ${dep}`);
      }
    }
  }

  const preds = new Map<string, Set<string>>();
  const succs = new Map<string, Set<string>>();

  for (const step of steps) {
    preds.set(step.id, new Set(step.deps || []));
    succs.set(step.id, new Set());
  }

  for (const step of steps) {
    for (const dep of step.deps || []) {
      succs.get(dep)?.add(step.id);
    }
  }

  // Kahn's algorithm
  const inDegree = new Map<string, number>();
  for (const [id, p] of preds.entries()) {
    inDegree.set(id, p.size);
  }

  const queue: string[] = Array.from(inDegree.entries())
    .filter(([_, d]) => d === 0)
    .map(([id]) => id)
    .sort();

  const topo: string[] = [];
  while (queue.length > 0) {
    const u = queue.shift()!;
    topo.push(u);
    const successors = Array.from(succs.get(u) || []).sort();
    for (const v of successors) {
      const d = inDegree.get(v)! - 1;
      inDegree.set(v, d);
      if (d === 0) {
        queue.push(v);
        queue.sort();
      }
    }
  }

  if (topo.length !== steps.length) {
    const done = new Set(topo);
    const cycleNodes = steps.filter((s) => !done.has(s.id)).map((s) => s.id);
    throw new Error(`dependency cycle among steps: ${cycleNodes.sort().join(", ")}`);
  }

  // Forward pass
  const esMap = new Map<string, number>();
  const efMap = new Map<string, number>();

  for (const id of topo) {
    const step = byId.get(id)!;
    const dur = getEffectiveDuration(step);
    const stepPreds = Array.from(preds.get(id) || []);
    const es = stepPreds.length > 0 ? Math.max(...stepPreds.map((p) => efMap.get(p) || 0)) : 0;
    esMap.set(id, es);
    efMap.set(id, es + dur);
  }

  let totalDuration = 0;
  for (const ef of efMap.values()) {
    if (ef > totalDuration) {
      totalDuration = ef;
    }
  }

  // Backward pass
  const lfMap = new Map<string, number>();
  const lsMap = new Map<string, number>();

  for (let i = topo.length - 1; i >= 0; i--) {
    const id = topo[i];
    const step = byId.get(id)!;
    const dur = getEffectiveDuration(step);
    const stepSuccs = Array.from(succs.get(id) || []);
    const lf = stepSuccs.length > 0 ? Math.min(...stepSuccs.map((s) => lsMap.get(s) || 0)) : totalDuration;
    lfMap.set(id, lf);
    lsMap.set(id, Math.max(0, lf - dur));
  }

  const schedule: Map<string, CpmStepSchedule> = new Map<string, CpmStepSchedule>();
  for (const [id, step] of byId.entries()) {
    const es = esMap.get(id) || 0;
    const ef = efMap.get(id) || 0;
    const ls = lsMap.get(id) || 0;
    const lf = lfMap.get(id) || 0;
    const slack = Math.max(0, ls - es);
    const critical = slack === 0;
    const role = classifyStepRole(step);

    schedule.set(id, {
      id,
      role,
      duration: getEffectiveDuration(step),
      es,
      ef,
      ls,
      lf,
      slack,
      critical,
      wave: 0, // Assigned later in wave split
    });
  }

  // Primary critical path
  const criticalPath: string[] = [];
  let next: string | undefined = Array.from(schedule.values())
    .filter((s) => s.critical && s.es === 0)
    .map((s) => s.id)
    .sort()[0];

  while (next !== undefined) {
    criticalPath.push(next);
    const curStep = schedule.get(next);
    if (!curStep) break;
    const curEf: number = curStep.ef;
    const successors: string[] = Array.from(succs.get(next) || []);
    next = successors
      .filter((n: string): boolean => {
        const s = schedule.get(n);
        return s !== undefined && s.critical && s.es === curEf;
      })
      .sort()[0];
  }

  return {
    steps: schedule,
    total_duration: totalDuration,
    critical_path: criticalPath,
  };
}

/**
 * Computes execution waves according to Saga Spec 0040 U3.
 */
export function computeWaves(plan: SagaPlan): CpmScheduleResult {
  const maxConcurrency = plan.flow.max_concurrency && plan.flow.max_concurrency > 0
    ? plan.flow.max_concurrency
    : 3;

  const cpm = computeCpm(plan.steps);
  const byId = new Map(plan.steps.map((s) => [s.id, s]));

  const assigned = new Set<string>();
  const waves: string[][] = [];
  const scheduledSteps: CpmStepSchedule[] = [];

  let waveIndex = 0;
  while (assigned.size < plan.steps.length) {
    const eligible = plan.steps
      .filter((s) => !assigned.has(s.id))
      .filter((s) => (s.deps || []).every((d) => assigned.has(d)));

    if (eligible.length === 0) {
      const remaining = plan.steps.filter((s) => !assigned.has(s.id)).map((s) => s.id);
      throw new Error(`dependency cycle among steps: ${remaining.sort().join(", ")}`);
    }

    // U3 sorting rule: critical first, then smaller slack, then lower ES, then id
    eligible.sort((a, b) => {
      const ca = cpm.steps.get(a.id)!;
      const cb = cpm.steps.get(b.id)!;

      if (cb.critical !== ca.critical) {
        return cb.critical ? 1 : -1;
      }
      if (ca.slack !== cb.slack) {
        return ca.slack - cb.slack;
      }
      if (ca.es !== cb.es) {
        return ca.es - cb.es;
      }
      return a.id.localeCompare(b.id);
    });

    const waveSteps = eligible.slice(0, maxConcurrency);
    const waveIds = waveSteps.map((s) => s.id);
    waves.push(waveIds);

    for (const step of waveSteps) {
      assigned.add(step.id);
      const cpmInfo = cpm.steps.get(step.id)!;
      scheduledSteps.push({
        ...cpmInfo,
        wave: waveIndex,
      });
    }

    waveIndex++;
  }

  // Sort scheduledSteps by wave, then es, then id
  scheduledSteps.sort((a, b) => {
    if (a.wave !== b.wave) return a.wave - b.wave;
    if (a.es !== b.es) return a.es - b.es;
    return a.id.localeCompare(b.id);
  });

  return {
    schema: "saga.plan.v1",
    flow: plan.flow.name,
    max_concurrency: maxConcurrency,
    total_duration: cpm.total_duration,
    waves,
    steps: scheduledSteps,
  };
}

/**
 * Invokes `saga plan schedule <file> --json` if `saga` binary is installed.
 * Returns null if `saga` is not available or encounters an error.
 */
export async function runSagaCliSchedule(filePath: string): Promise<CpmScheduleResult | null> {
  return new Promise((resolve) => {
    try {
      const child = spawn("saga", ["plan", "schedule", filePath, "--json"], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.on("error", () => {
        resolve(null);
      });

      child.on("close", (code) => {
        if (code === 0 && stdout.trim()) {
          try {
            const parsed = JSON.parse(stdout.trim()) as CpmScheduleResult;
            resolve(parsed);
          } catch {
            resolve(null);
          }
        } else {
          resolve(null);
        }
      });
    } catch {
      resolve(null);
    }
  });
}
