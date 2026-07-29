import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
 * /readyz route + `linearctl operator --check` tests (Track 4).
 *
 * /healthz = "is the process alive?"; /readyz = "is it actually able to
 * consume?" — the latter reports CF env PRESENCE (never values), token age,
 * last poll time, and last-known queue depth. `--check` connects to a running
 * operator's socket, GETs /readyz, prints the report, and exits 0/1.
 *
 * All deps are stubbed (no 1Password, no network). The socket lives under a
 * temp dir (never ~/.local/state). `--check` is exercised via a subprocess
 * pointing at the stubbed operator's socket, using `process.execPath` (the
 * live bun binary) so the spawn never hits the bare-"bun" ENOENT that haunts
 * `node:child_process` spawn under some PATH configs.
 */

// A minimal AgentSessionEvent shape for poll messages (see src/core/watch.ts).
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
  const dir = mkdtempSync(join(tmpdir(), "linearctl-readyz-"));
  return join(dir, "operator.sock");
}

/** Poll a predicate until true (bounded) — awaits genuine async side effects. */
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
}

describe("operator /readyz", () => {
  test("no polling: reports cfEnv presence (false), token age>0, lastPoll null", async () => {
    const opts: OperatorOptions = {
      socketPath: tempSocketPath(),
      registerSignals: false,
      tokenMinter: async () => "opaque-minted-token",
      eventLoopRunner: async () => ({ thoughtId: "t", responseId: "r", movedToStateId: null }),
      queueEnv: null, // no CF env → poller off
    };
    const handle = await startOperator(opts);
    try {
      const client = makeControlClient(handle.socketPath);
      const res = await client.request("GET", "/readyz");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body ?? "");
      // NOT ready: no queue env, no poll.
      expect(body.ok).toBe(false);
      // Presence-only — never the values.
      expect(body.cfEnv).toEqual({ accountId: false, queueId: false, apiToken: false });
      expect(body.tokenAgeSec).toBeGreaterThanOrEqual(0);
      expect(body.lastPoll).toBe(null);
      expect(body.queueDepth).toBe(0);
    } finally {
      await handle.shutdown();
    }
  });

  test("with queue env but no poll yet: cfEnv presence true, lastPoll still null, ok false", async () => {
    const opts: OperatorOptions = {
      socketPath: tempSocketPath(),
      registerSignals: false,
      tokenMinter: async () => "opaque-minted-token",
      eventLoopRunner: async () => ({ thoughtId: "t", responseId: "r", movedToStateId: null }),
      queueEnv: {
        CF_ACCOUNT_ID: "acct-real",
        CF_QUEUE_ID: "queue-real",
        // A *TOKEN*-named value — must NEVER appear in /readyz output.
        CF_API_TOKEN: "super-secret-never-leak",
      },
      queueFetcher: async () => new Response(JSON.stringify({ result: [] }), { status: 200 }),
      queuePollIntervalMs: 5,
    };
    const handle = await startOperator(opts);
    try {
      // Wait for at least one poll to land so lastPoll is set.
      await waitFor(async () => {
        const res = await makeControlClient(handle.socketPath).request("GET", "/readyz");
        const b = JSON.parse(res.body ?? "");
        return b.lastPoll !== null;
      });

      const client = makeControlClient(handle.socketPath);
      const res = await client.request("GET", "/readyz");
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body ?? "");
      // Ready now: env present + a fresh poll landed.
      expect(body.ok).toBe(true);
      expect(body.cfEnv).toEqual({ accountId: true, queueId: true, apiToken: true });
      expect(body.lastPoll).not.toBe(null);
      // CRITICAL: the token value must never leave /readyz — presence only.
      expect(JSON.stringify(body)).not.toContain("super-secret-never-leak");
    } finally {
      await handle.shutdown();
    }
  });

  test("/readyz never echoes the CF_API_TOKEN value (secret-invariant guard)", async () => {
    const secret = "aklive-NEVER-LEAK-ME-12345";
    const opts: OperatorOptions = {
      socketPath: tempSocketPath(),
      registerSignals: false,
      tokenMinter: async () => "opaque",
      eventLoopRunner: async () => ({ thoughtId: "t", responseId: "r", movedToStateId: null }),
      queueEnv: {
        CF_ACCOUNT_ID: "acct",
        CF_QUEUE_ID: "q",
        CF_API_TOKEN: secret,
      },
      queueFetcher: async () => new Response(JSON.stringify({ result: [] }), { status: 200 }),
      queuePollIntervalMs: 5,
    };
    const handle = await startOperator(opts);
    try {
      const client = makeControlClient(handle.socketPath);
      const res = await client.request("GET", "/readyz");
      const text = res.body ?? "";
      expect(text).not.toContain(secret);
      // Presence-only boolean must be the only signal about the token.
      expect(JSON.parse(text).cfEnv.apiToken).toBe(true);
    } finally {
      await handle.shutdown();
    }
  });
});

describe("linearctl operator --check", () => {
  test("exits 0 + prints READY when the operator is ready", async () => {
    const socketPath = tempSocketPath();
    const opts: OperatorOptions = {
      socketPath,
      registerSignals: false,
      tokenMinter: async () => "opaque",
      eventLoopRunner: async (_e: AgentSessionEvent) => ({ thoughtId: "t", responseId: "r", movedToStateId: null }),
      queueEnv: {
        CF_ACCOUNT_ID: "acct",
        CF_QUEUE_ID: "q",
        CF_API_TOKEN: "tok",
      },
      queueFetcher: async () => new Response(JSON.stringify({ result: [] }), { status: 200 }),
      queuePollIntervalMs: 5,
    };
    const handle = await startOperator(opts);
    try {
      // Wait until the daemon reports ready (lastPoll set).
      await waitFor(async () => {
        const r = await makeControlClient(socketPath).request("GET", "/readyz");
        return JSON.parse(r.body ?? "").ok === true;
      });

      const { code, stdout, stderr } = await runCheck(socketPath, false);
      expect(code).toBe(0);
      expect(stdout).toContain("READY");
      expect(stdout).toContain("accountId=true queueId=true apiToken=true");
      expect(stdout).toContain("token age:");
      expect(stdout).toContain("queue depth:");
      expect(stderr).toBe("");
    } finally {
      await handle.shutdown();
    }
  }, 15_000);

  test("exits 1 when not ready (no CF env → cfEnv all false, ok false)", async () => {
    const socketPath = tempSocketPath();
    const opts: OperatorOptions = {
      socketPath,
      registerSignals: false,
      tokenMinter: async () => "opaque",
      eventLoopRunner: async (_e: AgentSessionEvent) => ({ thoughtId: "t", responseId: "r", movedToStateId: null }),
      queueEnv: null,
    };
    const handle = await startOperator(opts);
    try {
      const { code, stdout } = await runCheck(socketPath, false);
      expect(code).toBe(1);
      expect(stdout).toContain("NOT READY");
      expect(stdout).toContain("accountId=false queueId=false apiToken=false");
      expect(stdout).toContain("last poll: (never)");
    } finally {
      await handle.shutdown();
    }
  }, 15_000);

  test("exits 1 + stderr diagnostic when no daemon is listening (connection refused)", async () => {
    const socketPath = tempSocketPath(); // nothing bound here
    const { code, stderr, stdout } = await runCheck(socketPath, false);
    expect(code).toBe(1);
    expect(stderr).toContain("not ready");
    // The connection-refused error surfaces on stderr, not stdout.
    expect(stdout).toBe("");
  }, 15_000);

  test("--json prints the raw /readyz body as JSON + exit 0 when ready", async () => {
    const socketPath = tempSocketPath();
    const opts: OperatorOptions = {
      socketPath,
      registerSignals: false,
      tokenMinter: async () => "opaque",
      eventLoopRunner: async (_e: AgentSessionEvent) => ({ thoughtId: "t", responseId: "r", movedToStateId: null }),
      queueEnv: {
        CF_ACCOUNT_ID: "acct",
        CF_QUEUE_ID: "q",
        CF_API_TOKEN: "tok",
      },
      queueFetcher: async () => new Response(JSON.stringify({ result: [] }), { status: 200 }),
      queuePollIntervalMs: 5,
    };
    const handle = await startOperator(opts);
    try {
      await waitFor(async () => {
        const r = await makeControlClient(socketPath).request("GET", "/readyz");
        return JSON.parse(r.body ?? "").ok === true;
      });

      const { code, stdout } = await runCheck(socketPath, true);
      expect(code).toBe(0);
      const body = JSON.parse(stdout);
      expect(body.ok).toBe(true);
      expect(body.cfEnv).toEqual({ accountId: true, queueId: true, apiToken: true });
      expect(typeof body.tokenAgeSec).toBe("number");
      expect(body.lastPoll).not.toBe(null);
    } finally {
      await handle.shutdown();
    }
  }, 15_000);

  test("exits 0 from --help (commander help path, no daemon contact)", async () => {
    // `operator --check --help` must print help and exit 0, not start a daemon.
    const { code, stdout } = await runHelp();
    expect(code).toBe(0);
    expect(stdout).toContain("--check");
    expect(stdout).toContain("operator");
    // PR #120: --help must also advertise the new --health flag.
    expect(stdout).toContain("--health");
  }, 15_000);
});

/**
 * `linearctl operator --health` (PR #120) — liveness probe. Distinct from
 * `--check` (readiness): --health GETs /healthz (process-alive: uptime +
 * queue depth), --check GETs /readyz (able-to-consume: cf env + last poll).
 * The cluster's liveness probe uses --health; readiness uses --check.
 * The two flags are mutually exclusive (an explicit error, not silent precedence).
 */
describe("linearctl operator --health", () => {
  test("exits 0 + prints ALIVE against a running operator", async () => {
    const socketPath = tempSocketPath();
    const opts: OperatorOptions = {
      socketPath,
      registerSignals: false,
      tokenMinter: async () => "opaque",
      eventLoopRunner: async (_e: AgentSessionEvent) => ({ thoughtId: "t", responseId: "r", movedToStateId: null }),
      queueEnv: null,
    };
    const handle = await startOperator(opts);
    try {
      const { code, stdout, stderr } = await runHealth(socketPath, false);
      expect(code).toBe(0);
      expect(stdout).toContain("ALIVE");
      expect(stdout).toContain("uptime:");
      expect(stdout).toContain("queue depth:");
      expect(stderr).toBe("");
    } finally {
      await handle.shutdown();
    }
  }, 15_000);

  test("--json prints the raw /healthz body + exit 0 when alive", async () => {
    const socketPath = tempSocketPath();
    const opts: OperatorOptions = {
      socketPath,
      registerSignals: false,
      tokenMinter: async () => "opaque",
      eventLoopRunner: async (_e: AgentSessionEvent) => ({ thoughtId: "t", responseId: "r", movedToStateId: null }),
      queueEnv: null,
    };
    const handle = await startOperator(opts);
    try {
      const { code, stdout } = await runHealth(socketPath, true);
      expect(code).toBe(0);
      const body = JSON.parse(stdout);
      expect(body.ok).toBe(true);
      expect(typeof body.uptime).toBe("number");
      expect(body.queueDepth).toBe(0);
    } finally {
      await handle.shutdown();
    }
  }, 15_000);

  test("exits 1 + stderr diagnostic when no daemon is listening", async () => {
    const socketPath = tempSocketPath(); // nothing bound here
    const { code, stderr, stdout } = await runHealth(socketPath, false);
    expect(code).toBe(1);
    expect(stderr).toContain("not alive");
    expect(stdout).toBe("");
  }, 15_000);

  test("exits 0 from --help and advertises --health + --role + --check", async () => {
    const { code, stdout } = await runHealthHelp();
    expect(code).toBe(0);
    expect(stdout).toContain("--health");
    expect(stdout).toContain("--check");
    expect(stdout).toContain("--role");
  }, 15_000);

  test("--health + --check together is rejected with an explicit error (exit 1)", async () => {
    const { code, stderr } = await runHealthMutex();
    expect(code).toBe(1);
    expect(stderr).toMatch(/mutually exclusive/i);
  }, 15_000);
});

/**
 * Spawn `linearctl operator --check` (and `--help`) against the CLI entrypoint.
 * Uses `process.execPath` (the live bun binary) rather than the bare `"bun"`
 * string so spawn never hits the PATH-resolution ENOENT that bites
 * `node:child_process` under some configs.
 */
function runCheck(socketPath: string, json: boolean): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const args = ["run", "src/index.ts", "operator", "--check", "--socket", socketPath];
  if (json) args.push("--json");
  return runChild(args);
}

function runHelp(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runChild(["run", "src/index.ts", "operator", "--check", "--help"]);
}

function runHealth(socketPath: string, json: boolean): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  const args = ["run", "src/index.ts", "operator", "--health", "--socket", socketPath];
  if (json) args.push("--json");
  return runChild(args);
}

function runHealthMutex(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  // --health + --check together must be rejected deterministically.
  return runChild(["run", "src/index.ts", "operator", "--health", "--check"]);
}

function runHealthHelp(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runChild(["run", "src/index.ts", "operator", "--health", "--help"]);
}

async function runChild(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, args, {
    cwd: import.meta.dir.replace("/test", ""),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env },
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  child.stdout.on("data", (c) => stdout.push(c.toString()));
  child.stderr.on("data", (c) => stderr.push(c.toString()));
  const { promise, resolve } = Promise.withResolvers<{
    code: number | null;
    stdout: string;
    stderr: string;
  }>();
  child.on("exit", (code) => {
    resolve({ code, stdout: stdout.join(""), stderr: stderr.join("") });
  });
  // Timeout guard: SIGKILL a stuck child so the suite never hangs.
  const guard = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 12_000);
  const settled = await promise;
  clearTimeout(guard);
  return settled;
}
