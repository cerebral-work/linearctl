/**
 * Containment set (OPS-1214) — the operational brakes the operator daemon runs
 * behind. Three mechanisms, all mechanical (no LLM, no judgment):
 *
 *   1. **HOLD switch** — a global stop for all Linear writes, honoring the
 *      estate hold-batch-ops SOP. Two forms, either engages the hold:
 *      `LINEARCTL_HOLD=1` (env, set at deploy time) or the existence of a hold
 *      file at `LINEARCTL_HOLD_FILE` (default `/etc/linearctl/hold/HOLD` — a
 *      ConfigMap mount in-cluster, so the hold can be flipped without a
 *      redeploy). Checked before every role run and every queue poll.
 *   2. **Mutation budget** — a per-run cap on issue mutations. A role run may
 *      perform at most `LINEARCTL_MUTATION_BUDGET` (default 10) writes; work
 *      beyond the cap is dropped LOUDLY (logged with the exact dropped count —
 *      the no-silent-truncation rule), never silently.
 *   3. (The rate-limit preflight lives in the scheduler, built on
 *      `core/ratelimit.ts` — see `src/core/scheduler.ts`.)
 *
 * Deny-label enforcement (the soma-ingest rule) is NOT here — it lives in the
 * single guardrail checkpoint (`src/core/guardrails.ts`), where every proposed
 * mutation already passes.
 */

import { existsSync } from "node:fs";

/** Default hold-file path — a ConfigMap mount in-cluster. */
export const DEFAULT_HOLD_FILE = "/etc/linearctl/hold/HOLD";

/** Default per-run mutation budget. */
export const DEFAULT_MUTATION_BUDGET = 10;

/** The result of a hold check. `held: true` carries the reason for the log. */
export type HoldState = { held: false } | { held: true; reason: string };

/**
 * Check the HOLD switch. Reads env + filesystem fresh on every call (the whole
 * point is that flipping the ConfigMap takes effect on the next tick, without
 * a restart). Injectable overrides for tests.
 */
export function checkHold(
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (path: string) => boolean = existsSync,
): HoldState {
  if (env.LINEARCTL_HOLD === "1") {
    return { held: true, reason: "LINEARCTL_HOLD=1" };
  }
  const holdFile = env.LINEARCTL_HOLD_FILE ?? DEFAULT_HOLD_FILE;
  if (fileExists(holdFile)) {
    return { held: true, reason: `hold file present: ${holdFile}` };
  }
  return { held: false };
}

/** Resolve the per-run mutation budget from env (default 10). */
export function resolveMutationBudget(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.LINEARCTL_MUTATION_BUDGET;
  if (raw === undefined) return DEFAULT_MUTATION_BUDGET;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(
      `LINEARCTL_MUTATION_BUDGET must be a non-negative integer, got "${raw}"`,
    );
  }
  return n;
}

/**
 * A per-run mutation budget. Constructed fresh at the start of each role run;
 * every write spends against it BEFORE executing. `trySpend` is the
 * cap-and-continue path (batch truncation); `spend` is the throw path
 * (single writes that must not silently vanish).
 */
export class MutationBudget {
  #remaining: number;
  readonly total: number;

  constructor(total: number = resolveMutationBudget()) {
    this.total = total;
    this.#remaining = total;
  }

  get remaining(): number {
    return this.#remaining;
  }

  /**
   * Reserve up to `want` mutations. Returns how many were granted (may be
   * fewer, may be 0). The caller MUST log the shortfall — the budget grants,
   * the caller narrates.
   */
  trySpend(want: number): number {
    const granted = Math.min(want, this.#remaining);
    this.#remaining -= granted;
    return granted;
  }

  /** Reserve exactly `count` mutations or throw (single-write path). */
  spend(count: number): void {
    if (count > this.#remaining) {
      throw new Error(
        `mutation budget exhausted: wanted ${count}, remaining ${this.#remaining} of ${this.total}`,
      );
    }
    this.#remaining -= count;
  }
}
