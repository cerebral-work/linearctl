/**
 * Test fixture for the operator SIGTERM subprocess test (CER-1149).
 *
 * Boots the operator with STUBBED deps (no 1Password, no network) and signal
 * handlers ENABLED, then blocks until SIGTERM/SIGINT. The parent test spawns
 * this via `bun run`, pokes /healthz to confirm liveness, sends SIGTERM, and
 * asserts: exit code 0 + socket file unlinked (graceful, no orphan).
 *
 * The socket path is passed via `OPERATOR_SOCKET` env so the test controls the
 * temp dir. The token minter returns a fixed opaque string (never logged).
 */
import { startOperator } from "../../src/core/operator.js";

const socketPath = process.env.OPERATOR_SOCKET;
if (!socketPath) {
  console.error("OPERATOR_SOCKET env required");
  process.exit(2);
}

const handle = await startOperator({
  socketPath,
  registerSignals: true, // the path under test
  queueEnv: null, // no polling — keep the test purely about signal shutdown
  tokenMinter: async () => "opaque-fixture-token",
  eventLoopRunner: async () => ({ thoughtId: "t", responseId: "r", movedToStateId: null }),
});

process.stderr.write(`fixture: listening on ${handle.socketPath}\n`);
// Block until the signal handler calls process.exit(0).
await new Promise(() => {});
