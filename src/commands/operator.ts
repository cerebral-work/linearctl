/**
 * `linearctl operator` — the long-running daemon subcommand (CER-1149).
 *
 * Runs the operator core: mints a token at startup, polls the Cloudflare Queue
 * `linear-agent-events`, and serves `linearctl watch`'s delegate-to-operator
 * path over a Unix socket (`POST /delegate`, `GET /healthz`). Stays in the
 * foreground until SIGINT/SIGTERM, which trigger graceful shutdown (stop
 * polling, drain in-flight events, close + unlink the socket).
 *
 *   `linearctl operator [--socket <path>] [--queue-poll-interval <ms>] [--json]`
 *
 * `--socket` overrides the default `~/.local/state/linearctl/operator.sock`.
 * `--json` suppresses the human banner (stderr) and emits the listening
 * address as a single JSON line on stdout for machine consumption.
 *
 * The token value is never logged/echoed. Only redacted handles appear in
 * error messages, matching the `src/lib/secrets.ts` Secret pattern.
 */

import { printJson } from "../lib/output.js";
import { DEFAULT_OPERATOR_SOCKET } from "../lib/control-socket.js";
import { startOperator, type OperatorOptions } from "../core/operator.js";

export interface OperatorCommandOptions {
  /** Override the Unix socket path (default: ~/.local/state/linearctl/operator.sock). */
  socket?: string;
  /** Override the queue poll interval in ms. */
  queuePollInterval?: number;
  /** Emit the listening address as JSON on stdout (suppresses the human banner). */
  json?: boolean;
}

function parsePollInterval(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`--queue-poll-interval must be a positive number of milliseconds, got "${raw}"`);
  }
  return Math.floor(n);
}

/**
 * `linearctl operator [--socket <path>] [--queue-poll-interval <ms>] [--json]`.
 *
 * Starts the daemon and blocks until SIGINT/SIGTERM. The banner goes to
 * stderr so stdout stays clean for `--json` machine output.
 */
export async function operator(opts: OperatorCommandOptions): Promise<void> {
  const operatorOpts: OperatorOptions = {
    socketPath: opts.socket ?? DEFAULT_OPERATOR_SOCKET,
    queuePollIntervalMs: parsePollInterval(opts.queuePollInterval?.toString()),
  };

  const handle = await startOperator(operatorOpts);

  if (opts.json) {
    printJson({ ok: true, socket: handle.socketPath, polling: handle.polling });
  } else {
    process.stderr.write(
      `linearctl operator listening on ${handle.socketPath}\n` +
        `  polling: ${handle.polling ? "on" : "off (set CF_ACCOUNT_ID/CF_QUEUE_ID/CF_API_TOKEN to enable)"}\n` +
        `  stop:   SIGINT / SIGTERM\n`,
    );
  }

  // Block until the process is killed (startOperator wired the signal handlers).
  // `startOperator`'s shutdown handler calls process.exit(0); we just hold here.
  return new Promise(() => {});
}
