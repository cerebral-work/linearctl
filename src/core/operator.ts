/**
 * Operator daemon core (CER-1149).
 *
 * The long-running daemon behind `linearctl operator`. It does three things:
 *
 *   1. **Token cache** — mints a 30-day app-actor token at startup via
 *      `loadClientCreds()` + `mintClientCredentialsToken()` (reused from
 *      `src/core/auth.ts`), holds it in memory, and re-mints on 401 via
 *      `refreshToken()`. 30d lifetime → rare mints.
 *   2. **Queue poller** — polls the Cloudflare Queue `linear-agent-events` via
 *      the Queues REST API (`POST .../messages/pull`, `.../ack`). For each
 *      message: parse the body as an `AgentSessionEvent`, call
 *      `runEventLoop(event, token)` (thought FIRST → 10s SLA), then ack.
 *      Errors are logged and the message is acked anyway (don't poison the
 *      queue with infinite retry — Linear re-creates the session if needed).
 *   3. **Unix-socket control server** — `POST /delegate` runs the event loop
 *      synchronously for `linearctl watch`; `GET /healthz` is the liveness
 *      probe. Graceful SIGINT/SIGTERM: stop polling, drain in-flight events,
 *      close + unlink the socket.
 *
 * The token value is NEVER logged/echoed (estate secret rules). Error messages
 * use the redacted `Secret` handle shape from `src/lib/secrets.ts`.
 */

import { loadClientCreds, mintClientCredentialsToken, DEFAULT_BOT_SCOPES } from "./auth.js";
import { checkHold } from "./containment.js";
import { runEventLoop, type AgentSessionEvent, type EventLoopResult } from "./watch.js";
import {
  makeDefaultPreflight,
  scheduleRole,
  type RoleSchedulerHandle,
  type TokenProvider,
} from "./scheduler.js";
import { cadenceToMs, type RoleDescriptor, type RoleRunResult } from "./role-catalog.js";
import {
  startControlServer,
  type ControlServer,
  type ControlRequest,
  type ControlResponse,
  type ControlHandler,
} from "../lib/control-socket.js";

/**
 * Required environment for queue polling. The socket server + delegate path
 * work without these (delegate mints/uses the token synchronously); the poller
 * only starts when all three are present.
 */
export interface QueueEnv {
  CF_ACCOUNT_ID: string;
  CF_QUEUE_ID: string;
  CF_API_TOKEN: string;
}

/** Pull the queue env, returning null (not throwing) when absent. */
function readQueueEnv(): QueueEnv | null {
  const { CF_ACCOUNT_ID: accountId, CF_QUEUE_ID: queueId, CF_API_TOKEN: apiToken } = process.env;
  if (!accountId || !queueId || !apiToken) return null;
  return { CF_ACCOUNT_ID: accountId, CF_QUEUE_ID: queueId, CF_API_TOKEN: apiToken };
}

/** The default poll interval for the queue poller. */
export const DEFAULT_QUEUE_POLL_INTERVAL_MS = 2000;

/**
 * Mints an app-actor token. Stubbed in tests (no 1Password, no network).
 * Returns the opaque access_token string — held only in memory.
 */
export type TokenMinter = () => Promise<string>;

/**
 * Runs the event loop for one event against a token. Stubbed in tests.
 * Mirrors `runEventLoop` from `src/core/watch.ts` so the daemon can swap in a
 * fake without `mock.module`. The real default wires through to watch.ts.
 */
export type EventLoopRunner = (event: AgentSessionEvent, token: string) => Promise<EventLoopResult>;

/**
 * Fetch impl for the queue REST calls. Injectable so tests don't hit network.
 */
export type QueueFetcher = (url: string, init: RequestInit) => Promise<Response>;

/** Default token minter: load creds from 1Password, mint via client_credentials. */
export const defaultTokenMinter: TokenMinter = async () => {
  const creds = loadClientCreds();
  const token = await mintClientCredentialsToken(creds, DEFAULT_BOT_SCOPES);
  return token.access_token;
};

/** Default event-loop runner: the real `runEventLoop` from watch.ts. */
export const defaultEventLoopRunner: EventLoopRunner = (event, token) =>
  runEventLoop(event, token);

/** Options accepted by `startOperator`. */
export interface OperatorOptions {
  /** Override the Unix socket path (tests use a temp dir). */
  socketPath?: string;
  /** Override the queue poll interval (ms). */
  queuePollIntervalMs?: number;
  /** Override the token minter (tests inject a stub). */
  tokenMinter?: TokenMinter;
  /** Override the event-loop runner (tests inject a stub). */
  eventLoopRunner?: EventLoopRunner;
  /** Override the queue fetch impl (tests inject a stub). */
  queueFetcher?: QueueFetcher;
  /** Override the queue env (tests inject a stub; default reads process.env). */
  queueEnv?: QueueEnv | null;
  /** Register SIGINT/SIGTERM handlers (default true). Tests pass false to use `handle.shutdown()` directly. */
  registerSignals?: boolean;
  /**
   * Roles to boot alongside the poller + control server (CER-1188). Each is a
   * {@link RoleDescriptor} from `src/core/role-catalog.ts`. The daemon schedules
   * each role on its D4 cadence after the token cache mints, sharing the cached
   * app-actor token so role actions attribute as the bot, not a user (D2).
   */
  roles?: RoleDescriptor[];
  /** Override the role runners (tests inject stubs; default loads `src/roles/*`). */
  roleRunners?: Record<string, (token: string) => Promise<unknown>>;
}

/** An in-memory token cache. The token value never leaves here except to Linear. */
interface TokenCache {
  getToken(): string;
  refreshToken(): Promise<void>;
}

/** Build a token cache from a minter. The cached value is never logged. */
function makeTokenCache(minter: TokenMinter): TokenCache {
  let cached: string | null = null;
  return {
    getToken() {
      if (cached === null) {
        throw new Error("operator token cache: no token minted yet — call refreshToken() first");
      }
      return cached;
    },
    async refreshToken() {
      // The minter returns an opaque string; we hold it in memory only.
      cached = await minter();
    },
  };
}

/** The result of a /delegate call, returned to the watch client as JSON. */
interface DelegateResponse {
  ok: true;
  thoughtId: string;
  responseId: string;
  movedToStateId: string | null;
}

/**
 * A live operator handle.
 *
 * `shutdown()` is the graceful-shutdown path the SIGINT/SIGTERM handlers call
 * (minus their `process.exit`). It is the single source of truth for: stop
 * polling, drain in-flight events, close + unlink the socket. Tests invoke it
 * directly with `registerSignals: false` so `process.exit` doesn't kill the
 * test runner; the real daemon's signal handlers call it then exit(0).
 *
 * `stop()` is kept as a backward-compatible alias of `shutdown()` (no exit),
 * so callers that just want to tear the handle down inline can use either.
 */
export interface OperatorHandle {
  /** The socket path actually listening on. */
  readonly socketPath: string;
  /** Graceful shutdown: stop polling, drain in-flight, close + unlink socket (no exit). */
  shutdown: () => Promise<void>;
  /** Alias of `shutdown()` (no exit). */
  stop: () => Promise<void>;
  /** Whether queue polling is active (false when CF env absent). */
  readonly polling: boolean;
  /** Role names booted on cadence (CER-1188). Empty when no `--role` given. */
  readonly roles: string[];
}

/**
 * Start the operator daemon. Mints a token at startup, starts the queue
 * poller (if CF env is present), starts the Unix-socket control server, and
 * wires SIGINT/SIGTERM for graceful shutdown. Returns once the socket is
 * listening; the process stays alive via the poller + socket event loop.
 *
 * The SIGINT/SIGTERM handlers call `shutdown()` then `process.exit(0)`. Tests
 * pass `registerSignals: false` and invoke `handle.shutdown()` directly so
 * `process.exit` doesn't kill the test runner; the shutdown path (stop
 * polling, drain in-flight, close + unlink socket) is identical either way.
 */
export async function startOperator(opts: OperatorOptions = {}): Promise<OperatorHandle> {
  const minter = opts.tokenMinter ?? defaultTokenMinter;
  const eventLoop = opts.eventLoopRunner ?? defaultEventLoopRunner;
  const socketPath = opts.socketPath;
  const pollIntervalMs = opts.queuePollIntervalMs ?? DEFAULT_QUEUE_POLL_INTERVAL_MS;
  const queueEnv = opts.queueEnv === undefined ? readQueueEnv() : opts.queueEnv;
  const fetchImpl: QueueFetcher = opts.queueFetcher ?? ((url, init) => fetch(url, init));

  // Mint the startup token (rare: 30d lifetime). Held in memory only.
  const tokenCache = makeTokenCache(minter);
  await tokenCache.refreshToken();

  // Readiness signals surfaced by /readyz (Track 4): token age, last poll,
  // CF env presence. Durations use the monotonic clock so NTP/VM wall-clock
  // corrections cannot produce a negative token age or stale/future polls.
  // The wall timestamp remains solely for the human-readable lastPoll field.
  const tokenMintedAtMonotonicMs = performance.now();
  let lastPollAt: number | null = null;
  let lastPollAtMonotonicMs: number | null = null;

  // Last-known queue depth, surfaced by /healthz + /readyz.
  let lastQueueDepth = 0;
  let polling = false;

  // Build the request handler: /healthz + /readyz + /delegate. Unknown → 404.
  const handler: ControlHandler = (req: ControlRequest): Promise<ControlResponse> | ControlResponse => {
    if (req.method === "GET" && req.path === "/healthz") {
      const body = JSON.stringify({
        ok: true,
        uptime: Math.floor(process.uptime()),
        queueDepth: lastQueueDepth,
      });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
      };
    }

    // /readyz (Track 4): "is the daemon actually able to consume?" — distinct
    // from /healthz ("is the process alive?"). Reports CF env presence (never
    // the values), token age (30d lifetime → re-mint near expiry), last poll
    // time (null until the first poll lands), and last-known queue depth.
    if (req.method === "GET" && req.path === "/readyz") {
      const nowMonotonicMs = performance.now();
      const ready =
        !!queueEnv && lastPollAtMonotonicMs !== null
          ? lastPollAtMonotonicMs > nowMonotonicMs - 3 * pollIntervalMs
          : false;
      const body = JSON.stringify({
        ok: ready,
        cfEnv: {
          accountId: !!queueEnv?.CF_ACCOUNT_ID,
          queueId: !!queueEnv?.CF_QUEUE_ID,
          apiToken: !!queueEnv?.CF_API_TOKEN,
        },
        tokenAgeSec: Math.max(0, Math.floor((nowMonotonicMs - tokenMintedAtMonotonicMs) / 1000)),
        lastPoll: lastPollAt === null ? null : new Date(lastPollAt).toISOString(),
        queueDepth: lastQueueDepth,
      });
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body,
      };
    }


    if (req.method === "POST" && req.path === "/delegate") {
      return (async (): Promise<ControlResponse> => {
        // HOLD switch (OPS-1214): the delegate path runs the event loop, which
        // writes to Linear (thought/response/state move) — refused while held.
        const hold = checkHold();
        if (hold.held) {
          return {
            status: 503,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ok: false, error: `operator is HELD — ${hold.reason}` }),
          };
        }
        let event: AgentSessionEvent;
        try {
          event = JSON.parse(req.body) as AgentSessionEvent;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return {
            status: 400,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ok: false, error: `invalid JSON body: ${msg}` }),
          };
        }

        const token = tokenCache.getToken();
        const result = await eventLoop(event, token);
        const payload: DelegateResponse = {
          ok: true,
          thoughtId: result.thoughtId,
          responseId: result.responseId,
          movedToStateId: result.movedToStateId,
        };
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        };
      })();
    }

    return {
      status: 404,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ok: false, error: `unknown route: ${req.method} ${req.path}` }),
    };
  };

  // Start the control server (binds the socket, mkdir -p, registers unlink-on-close).
  const server: ControlServer = await startControlServer(handler, { socketPath });

  // --- Queue poller (only when CF env is present) ---
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight = 0;
  let stopRequested = false;

  // Log HOLD engagement once per transition, not once per 2s tick.
  let wasHeld = false;

  async function pollOnce(): Promise<void> {
    if (!queueEnv) return;
    // HOLD switch (OPS-1214): while held, don't pull at all — messages stay
    // queued (pull-then-ack would consume them; not pulling preserves them
    // for after the hold lifts). Event processing writes to Linear, so the
    // hold binds the whole path.
    const hold = checkHold();
    if (hold.held) {
      if (!wasHeld) console.error(`operator: HOLD engaged (${hold.reason}) — queue polling paused`);
      wasHeld = true;
      return;
    }
    if (wasHeld) {
      console.error("operator: HOLD released — queue polling resumed");
      wasHeld = false;
    }
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${queueEnv.CF_ACCOUNT_ID}` +
      `/queues/${queueEnv.CF_QUEUE_ID}/messages/pull`;

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${queueEnv.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        // batch size 1 (v1) — process one event at a time for the 10s SLA.
        body: JSON.stringify({ batch_size: 1 }),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`operator: queue pull failed: ${msg}`);
      return;
    }

    if (!res.ok) {
      // Authenticated API response bodies are untrusted and may contain
      // sensitive context. Status is sufficient for diagnosis; never read/log
      // the body (and never echo the bearer token).
      console.error(`operator: queue pull HTTP ${res.status}`);

      return;
    }

    // Mark a successful poll — /readyz uses this to confirm the poller is live
    // (not just "env present"). Set before parsing: a successful HTTP pull from
    // the queue API proves reachability + token validity for that surface.
    // Keep wall time for display and monotonic time for freshness decisions.
    lastPollAt = Date.now();
    lastPollAtMonotonicMs = performance.now();

    let messages: Array<{ receipt: string; body: string }>;
    try {
      const json = await res.json();
      messages = Array.isArray(json?.result) ? json.result : [];
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`operator: queue pull response not JSON: ${msg}`);
      return;
    }

    lastQueueDepth = messages.length;

    for (const msg of messages) {
      inFlight += 1;
      try {
        let event: AgentSessionEvent;
        try {
          event = JSON.parse(msg.body) as AgentSessionEvent;
        } catch (err) {
          const m = err instanceof Error ? err.message : String(err);
          console.error(`operator: queue message not valid JSON: ${m}; acking`);
          continue;
        }

        const token = tokenCache.getToken();
        const result = await eventLoop(event, token);
        // stderr only — stdout is reserved for JSON output.
        console.error(
          `operator: handled event session=${event.agentSession?.id ?? "?"} ` +
            `thought=${result.thoughtId} response=${result.responseId}` +
            (result.movedToStateId ? ` moved=${result.movedToStateId}` : ""),
        );
      } catch (err) {
        // Log + ACK anyway — don't poison the queue with infinite retry.
        const msg2 = err instanceof Error ? err.message : String(err);
        console.error(`operator: event loop error: ${msg2}; acking to avoid retry`);
        // On 401 from a Linear call, re-mint for the next iteration.
        if (/\b401\b/.test(msg2)) {
          try {
            await tokenCache.refreshToken();
          } catch (refreshErr) {
            const rmsg = refreshErr instanceof Error ? refreshErr.message : String(refreshErr);
            console.error(`operator: token refresh after 401 failed: ${rmsg}`);
          }
        }
      } finally {
        inFlight -= 1;
        await ack(msg.receipt, queueEnv, fetchImpl);
      }
    }
  }

  async function ack(receipt: string, env: QueueEnv, fetcher: QueueFetcher): Promise<void> {
    const url =
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}` +
      `/queues/${env.CF_QUEUE_ID}/messages/ack`;
    try {
      await fetcher(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ receipts: [receipt] }),
      });
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error(`operator: queue ack failed: ${m}`);
    }
  }

  function schedulePoll(): void {
    if (stopRequested || !queueEnv) return;
    pollTimer = setTimeout(async () => {
      await pollOnce();
      schedulePoll();
    }, pollIntervalMs);
  }

  if (queueEnv) {
    polling = true;
    // Fire the first poll immediately so a backlog drains promptly.
    pollOnce().finally(() => schedulePoll());
  }
  // --- Role schedulers (CER-1188) ---
  // Boot each role on its D4 cadence, sharing the cached app-actor token.
  // Roles fire immediately (backlog drain) then re-arm on cadence, mirroring
  // the queue poller. The token is the app actor (never a user token), so role
  // actions attribute as the bot — the D2 autonomy boundary made physical.
  const roleSchedulers: RoleSchedulerHandle[] = [];
  if (opts.roles?.length) {
    const tokenProvider: TokenProvider = () => tokenCache.getToken();
    for (const role of opts.roles) {
      const runner = opts.roleRunners?.[role.name];
      if (!runner) {
        console.error(`operator: role "${role.name}" has no runner — skipping`);
        continue;
      }
      const handle = scheduleRole(
        role,
        cadenceToMs(role.cadence),
        runner as (token: string) => Promise<RoleRunResult>,
        tokenProvider,
        // Full containment preflight (OPS-1214): HOLD + rate-limit probe.
        makeDefaultPreflight(tokenProvider),
      );
      roleSchedulers.push(handle);
      console.error(`operator: role "${role.name}" scheduled (${role.cadence})`);
    }
  }

  // --- Graceful shutdown ---
  let stopped = false;

  /**
   * Graceful shutdown: stop polling, drain in-flight events, close + unlink
   * the socket. Single source of truth — the SIGINT/SIGTERM handlers (when
   * registered) call this then `process.exit(0)`; tests call it directly.
   * Does NOT exit the process (so in-process callers stay alive).
   */
  const shutdown = async (signal: string = "manual"): Promise<void> => {
    if (stopped) return;
    stopped = true;
    console.error(`operator: received ${signal}; shutting down`);
    stopRequested = true;
    clearTimeout(pollTimer);
    // Stop role schedulers + drain any in-flight role run (CER-1188).
    for (const sched of roleSchedulers) sched.stop();
    await Promise.all(roleSchedulers.map((s) => s.drain()));
    // Drain in-flight queue events (bounded by batch_size=1).
    const deadlineMonotonicMs = performance.now() + 10_000;
    while (inFlight > 0 && performance.now() < deadlineMonotonicMs) {
      await new Promise((r) => setTimeout(r, 50));
    }
    await server.close();
  };

  // Register SIGINT/SIGTERM unless the caller opts out (tests). The handlers
  // run the shared shutdown drain, then exit 0 so the long-running process ends.
  if (opts.registerSignals !== false) {
    const exitHandler = (signal: string) => () => {
      void shutdown(signal).finally(() => process.exit(0));
    };
    process.once("SIGINT", exitHandler("SIGINT"));
    process.once("SIGTERM", exitHandler("SIGTERM"));
  }

  return {
    socketPath: server.socketPath,
    polling,
    roles: roleSchedulers.map((s) => s.role.name),
    shutdown,
    stop: shutdown,
  };
}
