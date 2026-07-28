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

/** Supplies the current app-actor token to a role run (the daemon's cache). */
export type TokenProvider = () => string;

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
): RoleSchedulerHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = false;
  let stopped = false;
  let ran = false;

  const fire = async (): Promise<void> => {
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
      const deadline = Date.now() + timeoutMs;
      while (inFlight && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
    },
    get ran() {
      return ran;
    },
  };
}
