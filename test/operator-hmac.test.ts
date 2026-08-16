import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startOperator, type OperatorOptions } from "../src/core/operator.js";
import { makeControlClient } from "../src/lib/control-socket.js";
import { makeEnvelope, AUDIENCE_AGENT_EVENTS } from "../src/core/hmac-envelope.js";

/**
 * Operator HMAC posture tests: startup resolution (empty-key refusal, /readyz
 * surfacing), enforce vs warn behavior in the poll loop. All deps stubbed —
 * no 1Password, no network; the queue fetcher serves a scripted message once.
 */

const KEY = "operator-hmac-test-key";

function tempSocketPath(): string {
  return join(mkdtempSync(join(tmpdir(), "linearctl-hmac-")), "operator.sock");
}

function baseOpts(handled: string[]): OperatorOptions {
  return {
    socketPath: tempSocketPath(),
    registerSignals: false,
    tokenMinter: async () => "opaque-minted-token",
    eventLoopRunner: async (event) => {
      handled.push(event.agentSession?.id ?? "?");
      return { thoughtId: "t", responseId: "r", movedToStateId: null };
    },
    queuePollIntervalMs: 5,
  };
}

/** A queue fetcher that serves each body exactly once, then empty results. */
function scriptedQueue(bodies: string[]): { fetcher: OperatorOptions["queueFetcher"]; acked: string[] } {
  const remaining = [...bodies];
  const acked: string[] = [];
  const fetcher: OperatorOptions["queueFetcher"] = async (url, init) => {
    if (url.endsWith("/messages/ack")) {
      const parsed = JSON.parse(String(init.body)) as { receipts: string[] };
      acked.push(...parsed.receipts);
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }
    const body = remaining.shift();
    const result = body === undefined ? [] : [{ receipt: `r-${acked.length}-${remaining.length}`, body }];
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
  return { fetcher, acked };
}

const QUEUE_ENV = { CF_ACCOUNT_ID: "acct", CF_QUEUE_ID: "q", CF_API_TOKEN: "tok" };

async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitFor timeout");
}

const sessionEvent = JSON.stringify({
  type: "AgentSessionEvent",
  action: "created",
  agentSession: { id: "sess-1", issueId: "iss-1" },
});

describe("operator HMAC posture", () => {
  test("a SET-but-empty key refuses to start (present-but-empty secret failure)", async () => {
    const handled: string[] = [];
    await expect(
      startOperator({ ...baseOpts(handled), queueEnv: null, hmac: { key: "   " } }),
    ).rejects.toThrow(/set but EMPTY/);
  });

  test("/readyz surfaces the signing posture: off / enforce / warn", async () => {
    const handled: string[] = [];
    for (const [hmac, expected] of [
      [null, "off"],
      [{ key: KEY }, "enforce"],
      [{ key: KEY, mode: "warn" }, "warn"],
    ] as const) {
      const handle = await startOperator({ ...baseOpts(handled), queueEnv: null, hmac });
      try {
        const res = await makeControlClient(handle.socketPath).request("GET", "/readyz");
        expect(JSON.parse(res.body ?? "").hmac).toBe(expected);
      } finally {
        await handle.shutdown();
      }
    }
  });

  test("enforce: a signed envelope is processed; an unsigned body is rejected AND acked", async () => {
    const handled: string[] = [];
    const signed = makeEnvelope(KEY, AUDIENCE_AGENT_EVENTS, sessionEvent, Date.now());
    const { fetcher, acked } = scriptedQueue([signed, sessionEvent]);
    const handle = await startOperator({
      ...baseOpts(handled),
      queueEnv: QUEUE_ENV,
      queueFetcher: fetcher,
      hmac: { key: KEY },
    });
    try {
      await waitFor(() => acked.length >= 2);
      // Only the signed message reached the event loop; both were acked.
      expect(handled).toEqual(["sess-1"]);
      expect(acked.length).toBe(2);
    } finally {
      await handle.shutdown();
    }
  });

  test("warn mode: an unsigned body is processed (rollout window), with the key still set", async () => {
    const handled: string[] = [];
    const { fetcher, acked } = scriptedQueue([sessionEvent]);
    const handle = await startOperator({
      ...baseOpts(handled),
      queueEnv: QUEUE_ENV,
      queueFetcher: fetcher,
      hmac: { key: KEY, mode: "warn" },
    });
    try {
      await waitFor(() => acked.length >= 1);
      expect(handled).toEqual(["sess-1"]);
    } finally {
      await handle.shutdown();
    }
  });

  test("rotation: an envelope signed with the PREVIOUS key still verifies in enforce", async () => {
    const handled: string[] = [];
    const signedOld = makeEnvelope("old-key", AUDIENCE_AGENT_EVENTS, sessionEvent, Date.now());
    const { fetcher, acked } = scriptedQueue([signedOld]);
    const handle = await startOperator({
      ...baseOpts(handled),
      queueEnv: QUEUE_ENV,
      queueFetcher: fetcher,
      hmac: { key: KEY, prevKey: "old-key" },
    });
    try {
      await waitFor(() => acked.length >= 1);
      expect(handled).toEqual(["sess-1"]);
    } finally {
      await handle.shutdown();
    }
  });
});
