/**
 * Role scheduler — the scheduled-routine harness (CER-1188, Phase 1).
 *
 * Wraps the existing poller-loop pattern from `src/core/operator.ts`
 * (`schedulePoll` / the recursive `setTimeout` + bounded in-flight drain) into
 * a generic `scheduleRole(role, intervalMs, runner)` that fires a role's handler
 * on D4 cadence.
 *
 * One scheduler per role. Runs are SEQUENTIAL — a slow run delays the next tick
 * (correct for a single-token actor; no overlapping mutations). The first run
 * fires immediately so a backlog drains on boot (the same pattern the queue
 * poller uses). The handle's `.stop()` clears the timer; `drain()` awaits any
 * in-flight run (bounded), mirroring the daemon's SIGTERM shutdown.
 *
 * The guardrail gate (`assertRoleMayAct`) is called by the role handler itself
 * before its mutation — the scheduler does not gate; it only schedules. See
 * `docs/agent-facility.md` §4 (loop shape) + §5 (guardrails).
 */

import type { RoleDescriptor, RoleRunner, RoleRunResult } from "./role-catalog.js";
import { checkHold } from "./containment.js";
import { fetchRateLimit, isExhausted } from "./ratelimit.js";

/** Supplies the current app-actor token to a role run (the daemon's cache). */
export type TokenProvider = () => string;

/** A preflight verdict: run, or skip this tick with a logged reason. */
export type PreflightResult = { skip: false } | { skip: true; reason: string };

/** Decides per-tick whether a role run may proceed. */
export type Preflight = () => Promise<PreflightResult>;

/**
 * The scheduler's built-in gate: the HOLD switch only — synchronous, no
 * network, so bare `scheduleRole` calls stay cheap and test-friendly.
 */
const holdOnlyPreflight: Preflight = async (): Promise<PreflightResult> => {
  const hold = checkHold();
  return hold.held ? { skip: true, reason: `HOLD engaged (${hold.reason})` } : { skip: false };
};

/**
 * The full operator preflight (OPS-1214 containment): skip the tick when the
 * HOLD switch is engaged, and skip when Linear reports zero remaining quota on
 * either rate-limit axis (probe cost: one complexity-1 request). Errors in the
 * quota probe do NOT skip — an unreachable probe must not stop the cadence
 * (same posture as `isExhausted`'s unknown-is-not-exhausted rule); the run
 * itself will surface real API failures. The operator daemon wires this in
 * explicitly (`src/core/operator.ts`); it is not the bare-call default because
 * it performs network I/O.
 */
export function makeDefaultPreflight(token: TokenProvider): Preflight {
  return async (): Promise<PreflightResult> => {
    const hold = await holdOnlyPreflight();
    if (hold.skip) return hold;
    try {
      const info = await fetchRateLimit(`Bearer ${token()}`);
      if (isExhausted(info)) {
        const reset = info.requests.resetAt ?? info.complexity.resetAt ?? "unknown";
        return { skip: true, reason: `Linear rate limit exhausted (resets ${reset})` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`preflight: rate-limit probe failed (${msg}); proceeding`);
    }
    return { skip: false };
  };
}

/** A live role-scheduler handle. */
export interface RoleSchedulerHandle {
  /** The role being scheduled. */
  readonly role: RoleDescriptor;
  /** Stop the cadence timer. Does not await an in-flight run (use `drain`). */
  stop(): void;
  /** Await the in-flight run to finish (bounded by `timeoutMs`). No-op if idle. */
  drain(timeoutMs?: number): Promise<void>;
  /** True iff at least one run has fired. */
  readonly ran: boolean;
}

/**
 * Schedule a role's handler on a fixed cadence.
 *
 * - Fires the first run immediately (backlog drains on boot).
 * - Re-fires every `intervalMs` AFTER the prior run settles (sequential).
 * - Errors in `runner` are logged to stderr and swallowed — one bad run must
 *   not stop the cadence (same contract as the queue poller's ack-anyway).
 * - Returns a handle; `.stop()` clears the timer, `.drain()` awaits in-flight.
 */
export function scheduleRole(
  role: RoleDescriptor,
  intervalMs: number,
  runner: RoleRunner,
  token: TokenProvider,
  /** Per-tick gate (HOLD + rate limit). Default: {@link makeDefaultPreflight}. */
  preflight?: Preflight,
): RoleSchedulerHandle {
  const gate = preflight ?? holdOnlyPreflight;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let stopped = false;
  let ran = false;

  const fire = async (): Promise<void> => {
    // inFlight covers the preflight too, so drain() awaits a tick that is
    // mid-gate. A skipped tick is not a run (`ran` untouched by the skip), and
    // a preflight error must not stop the cadence (fail-open — the run itself
    // surfaces real API failures).
    inFlight = true;
    try {
      const verdict = await gate();
      if (verdict.skip) {
        console.error(`role[${role.name}]: run skipped — ${verdict.reason}`);
        return;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`role[${role.name}]: preflight failed: ${msg}; proceeding`);
    } finally {
      inFlight = false;
    }
    inFlight = true;
    ran = true;
    try {
      const result: RoleRunResult = await runner(token());
      // The runner is responsible for gating its own mutations via
      // assertRoleMayAct; the scheduler only observes + logs the summary.
      if (result.summary) {
        console.error(`role[${role.name}]: ${result.summary.slice(0, 280)}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`role[${role.name}]: run failed: ${msg} (will retry next cadence)`);
    } finally {
      inFlight = false;
    }
  };

  const scheduleNext = (): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      void fire().finally(() => scheduleNext());
    }, intervalMs);
  };

  // Fire immediately so a backlog drains on boot, then re-arm on cadence.
  void fire().finally(() => scheduleNext());

  return {
    role,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
    async drain(timeoutMs = 10_000): Promise<void> {
      const deadlineMonotonicMs = performance.now() + timeoutMs;
      while (inFlight && performance.now() < deadlineMonotonicMs) {
        await new Promise((r) => setTimeout(r, 50));

      }
    },
    get ran() {
      return ran;
    },
  };
}
