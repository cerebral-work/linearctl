import { describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  startOperator,
  type OperatorOptions,
} from "../src/core/operator.js";
import { type AgentSessionEvent } from "../src/core/watch.js";
import { makeControlClient } from "../src/lib/control-socket.js";

/**
 * Operator daemon contract tests (CER-1149).
 *
 * Stubs the token minter (no 1Password) + event-loop runner (no network) and
 * uses a temp-dir socket so tests never pollute ~/.local/state/linearctl.
 * Verifies:
 *   - /healthz returns 200 with uptime + queueDepth
 *   - POST /delegate with a valid AgentSessionEvent calls the loop + returns ids
 *   - unknown route → 404
 *   - graceful shutdown (stop polling, drain, close + unlink socket)
 *   - queue poller consumes a message, runs the loop, acks (stubbed fetch)
 *
 * Signal handlers are disabled (registerSignals: false); tests invoke
 * `handle.shutdown()` directly — the same drain path SIGTERM calls — so
 * `process.exit(0)` never fires inside the test runner.
 */

// A minimal AgentSessionEvent shape for the delegate body (see src/core/watch.ts).
function createdEvent(opts?: { sessionId?: string; issueId?: string }): AgentSessionEvent {
  return {
    type: "AgentSessionEvent",
    action: "created",
    promptContext: "<issue identifier=\"CER-1149\"/>",
    agentSession: {
      id: opts?.sessionId ?? "session-uuid-1",
      issueId: opts?.issueId ?? "issue-uuid-1",
    },
  };
}

/** Build a temp socket path under the OS temp dir (never ~/.local/state). */
function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "linearctl-op-test-"));
  return join(dir, "operator.sock");
}

/** Common deps: stub token minter (no 1Password) + stub loop (no network). */
function stubDeps(): {
  opts: OperatorOptions;
  calls: AgentSessionEvent[];
} {
  const calls: AgentSessionEvent[] = [];
  const opts: OperatorOptions = {
    socketPath: tempSocketPath(),
    registerSignals: false,
    tokenMinter: async () => "opaque-minted-token",
    eventLoopRunner: async (event) => {
      calls.push(event);
      return {
        thoughtId: "act-thought-1",
        responseId: "act-response-2",
        movedToStateId: "state-started-1",
      };
    },
    queueEnv: null, // no polling by default; poller tests override
  };
  return { opts, calls };
}

/**
 * Poll a predicate until it returns true (awaiting the real state change, not
 * a guessed fixed delay) with a bounded deadline. Used by the poller tests,
 * which wait for the async poll loop to produce observable effects (acks,
 * loop calls) — there is no deterministic timer hook into the poll loop, so
 * this awaits the genuine side effect rather than sleeping a fixed duration.
 */
async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

describe("operator /healthz", () => {
  test("returns 200 with ok, uptime, and queueDepth=0 (no polling)", async () => {
    const { opts } = stubDeps();
    const handle = await startOperator(opts);
    try {
      const client = makeControlClient(handle.socketPath);
      const res = await client.request("GET", "/healthz");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body ?? "");
      expect(body.ok).toBe(true);
      expect(typeof body.uptime).toBe("number");
      expect(body.uptime).toBeGreaterThanOrEqual(0);
      expect(body.queueDepth).toBe(0); // no polling → no messages seen
    } finally {
      await handle.shutdown();
    }
  });
});

describe("operator POST /delegate", () => {
  test("calls the event loop with the event + cached token, returns activity ids", async () => {
    const { opts, calls } = stubDeps();
    const handle = await startOperator(opts);
    try {
      const client = makeControlClient(handle.socketPath);
      const event = createdEvent({ sessionId: "sess-delegate-1" });
      const res = await client.request("POST", "/delegate", JSON.stringify(event));

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body ?? "");
      expect(body.ok).toBe(true);
      expect(body.thoughtId).toBe("act-thought-1");
      expect(body.responseId).toBe("act-response-2");
      expect(body.movedToStateId).toBe("state-started-1");

      // The loop ran exactly once, with the event we sent.
      expect(calls).toHaveLength(1);
      expect(calls[0].agentSession.id).toBe("sess-delegate-1");
    } finally {
      await handle.shutdown();
    }
  });

  test("rejects malformed JSON body with 400", async () => {
    const { opts } = stubDeps();
    const handle = await startOperator(opts);
    try {
      const client = makeControlClient(handle.socketPath);
      const res = await client.request("POST", "/delegate", "{not json");
      expect(res.status).toBe(400);
      const body = JSON.parse(res.body ?? "");
      expect(body.ok).toBe(false);
      expect(body.error).toContain("invalid JSON");
    } finally {
      await handle.shutdown();
    }
  });
});

describe("operator unknown route", () => {
  test("GET /nope → 404", async () => {
    const { opts } = stubDeps();
    const handle = await startOperator(opts);
    try {
      const client = makeControlClient(handle.socketPath);
      const res = await client.request("GET", "/nope");
      expect(res.status).toBe(404);
      const body = JSON.parse(res.body ?? "");
      expect(body.ok).toBe(false);
      expect(body.error).toContain("unknown route");
    } finally {
      await handle.shutdown();
    }
  });
});

describe("operator graceful shutdown", () => {
  test("shutdown stops the server and unlinks the socket file", async () => {
    const { opts } = stubDeps();
    const handle = await startOperator(opts);

    // Socket exists while running.
    expect(existsSync(handle.socketPath)).toBe(true);

    await handle.shutdown();

    // After shutdown, the socket file is gone (no orphan).
    expect(existsSync(handle.socketPath)).toBe(false);
  });

  test("shutdown is idempotent", async () => {
    const { opts } = stubDeps();
    const handle = await startOperator(opts);
    await handle.shutdown();
    // A second shutdown must not throw.
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  test("client connect fails fast after shutdown (ECONNREFUSED, well under 1s)", async () => {
    const { opts } = stubDeps();
    const handle = await startOperator(opts);
    const socketPath = handle.socketPath;
    await handle.shutdown();

    const client = makeControlClient(socketPath);
    const start = Date.now();
    await expect(client.request("GET", "/healthz")).rejects.toBeDefined();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("operator queue poller", () => {
  test("pulls a message, runs the loop, and acks the receipt", async () => {
    // Stub fetch: first pull returns one message; ack is recorded.
    const pulledEvents: AgentSessionEvent[] = [];
    const acked: string[] = [];
    let pullCount = 0;

    const stubFetch = async (url: string, init: RequestInit): Promise<Response> => {
      if (url.endsWith("/messages/pull")) {
        pullCount += 1;
        if (pullCount === 1) {
          const event = createdEvent({ sessionId: "sess-queue-1" });
          pulledEvents.push(event);
          return new Response(
            JSON.stringify({ result: [{ receipt: "rcpt-1", body: JSON.stringify(event) }] }),
            { status: 200 },
          );
        }
        // Subsequent pulls: empty queue.
        return new Response(JSON.stringify({ result: [] }), { status: 200 });
      }
      if (url.endsWith("/messages/ack")) {
        const body = JSON.parse(String(init.body)) as { receipts: string[] };
        acked.push(...body.receipts);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("", { status: 404 });
    };

    const loopCalls: AgentSessionEvent[] = [];
    const opts: OperatorOptions = {
      socketPath: tempSocketPath(),
      registerSignals: false,
      queuePollIntervalMs: 5, // poll fast for the test
      tokenMinter: async () => "opaque-minted-token",
      eventLoopRunner: async (event) => {
        loopCalls.push(event);
        return { thoughtId: "t1", responseId: "r1", movedToStateId: null };
      },
      queueFetcher: stubFetch,
      queueEnv: {
        CF_ACCOUNT_ID: "acct-test",
        CF_QUEUE_ID: "queue-test",
        CF_API_TOKEN: "token-test",
      },
    };
    const handle = await startOperator(opts);
    try {
      // Await the genuine side effect: the poll loop acked the receipt.
      // No deterministic timer hook into the async poll loop, so we await the
      // observable ack rather than guessing a fixed sleep duration.
      await waitFor(() => acked.includes("rcpt-1"));
      await handle.shutdown();

      expect(pullCount).toBeGreaterThanOrEqual(1);
      expect(loopCalls).toHaveLength(1);
      expect(loopCalls[0].agentSession.id).toBe("sess-queue-1");
      expect(acked).toContain("rcpt-1");
    } finally {
      await handle.shutdown();
    }
  });

  test("acks a malformed message (no infinite retry; doesn't poison the queue)", async () => {
    const acked: string[] = [];
    let pullCount = 0;

    const stubFetch = async (url: string, init: RequestInit): Promise<Response> => {
      if (url.endsWith("/messages/pull")) {
        pullCount += 1;
        if (pullCount === 1) {
          return new Response(
            JSON.stringify({ result: [{ receipt: "rcpt-bad", body: "{not json" }] }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ result: [] }), { status: 200 });
      }
      if (url.endsWith("/messages/ack")) {
        const body = JSON.parse(String(init.body)) as { receipts: string[] };
        acked.push(...body.receipts);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response("", { status: 404 });
    };

    const loopCalls: AgentSessionEvent[] = [];
    const opts: OperatorOptions = {
      socketPath: tempSocketPath(),
      registerSignals: false,
      queuePollIntervalMs: 5,
      tokenMinter: async () => "opaque-minted-token",
      eventLoopRunner: async (event) => {
        loopCalls.push(event);
        return { thoughtId: "t1", responseId: "r1", movedToStateId: null };
      },
      queueFetcher: stubFetch,
      queueEnv: {
        CF_ACCOUNT_ID: "acct-test",
        CF_QUEUE_ID: "queue-test",
        CF_API_TOKEN: "token-test",
      },
    };

    const handle = await startOperator(opts);
    try {
      await waitFor(() => acked.includes("rcpt-bad"));
      await handle.shutdown();

      // The malformed message was acked (not retried forever).
      expect(acked).toContain("rcpt-bad");
      // The loop never ran (body failed to parse).
      expect(loopCalls).toHaveLength(0);
    } finally {
      await handle.shutdown();
    }
  });

  test("does not start polling when queueEnv is null (polling flag false)", async () => {
    const { opts } = stubDeps();
    const handle = await startOperator(opts);
    try {
      expect(handle.polling).toBe(false);
    } finally {
      await handle.shutdown();
    }
  });
});

describe("operator SIGTERM subprocess (graceful exit 0 + socket unlink)", () => {
  test(
    "SIGTERM → poller stops, socket closes, process exits 0",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "linearctl-op-sigterm-"));
      const socketPath = join(dir, "operator.sock");

      // Spawn the fixture (stubbed deps, signal handlers ENABLED).
      const child = spawn("bun", ["run", "test/fixtures/operator-sigterm.ts"], {
        env: { ...process.env, OPERATOR_SOCKET: socketPath },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stderr: string[] = [];
      child.stderr.on("data", (c) => stderr.push(c.toString()));

      try {
        // Wait for the fixture to report it's listening.
        const ready = await new Promise<boolean>((resolve) => {
          const to = setTimeout(() => resolve(false), 10_000);
          child.stderr.on("data", (c: Buffer) => {
            if (c.toString().includes("fixture: listening on")) {
              clearTimeout(to);
              resolve(true);
            }
          });
        });
        expect(ready).toBe(true);

        // Confirm liveness via the control socket before signaling.
        const client = makeControlClient(socketPath);
        const health = await client.request("GET", "/healthz");
        expect(health.status).toBe(200);
        expect(existsSync(socketPath)).toBe(true);

        // Send SIGTERM — the real daemon shutdown path.
        child.kill("SIGTERM");

        const code = await new Promise<number | null>((resolve) => {
          child.on("exit", (c) => resolve(c));
          setTimeout(() => resolve(null), 10_000); // timeout guard
        });

        // Graceful exit, no crash, no orphaned socket file.
        expect(code).toBe(0);
        expect(existsSync(socketPath)).toBe(false);
      } finally {
        if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
    30_000,
  );
});
