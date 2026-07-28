/**
 * `linearctl watch` — run the full agent-session loop from a webhook payload (CER-1149).
 *
 * The full-loop fallback path: mint/cache a token via the OAuth helpers, then
 * drive `emitThought` → `driveAgentLoop` → `moveToStartedIfDelegated` over the
 * parsed `AgentSessionEvent` payload. Used when the `linearctl operator` daemon
 * is unreachable (its delegate-to-operator Unix-socket branch is a follow-up).
 *
 *   `linearctl watch --once --payload <file|-> [--json]`
 *
 * `--payload -` reads the AgentSessionEvent webhook payload JSON from stdin.
 * The token is minted via `loadClientCreds()` + `mintClientCredentialsToken()`
 * (Path A, reused from `src/core/auth.ts`) — never stored, cached, or printed.
 *
 * Delegate-first: when the `linearctl operator` daemon is running, `watch`
 * hands the event to it over the Unix control socket (faster — the daemon
 * holds a cached token + queue context). On any socket error (daemon down,
 * timeout, non-200), `watch` falls through to the full-loop path below.
 */

import { readFile } from "node:fs/promises";
import { printJson } from "../lib/output.js";
import { readStdin } from "../lib/io.js";
import {
  DEFAULT_BOT_SCOPES,
  loadClientCreds,
  mintClientCredentialsToken,
} from "../core/auth.js";
import {
  runEventLoop,
  type AgentSessionEvent,
  type EventLoopResult,
} from "../core/watch.js";
import {
  DEFAULT_OPERATOR_SOCKET,
  makeControlClient,
} from "../lib/control-socket.js";

export interface WatchOptions {
  /** Run exactly one loop iteration (no long-running tail). */
  once?: boolean;
  /** Path to the AgentSessionEvent payload JSON file; `-` reads stdin. */
  payload?: string;
  /** Emit the emitted activity node ids as JSON. */
  json?: boolean;
  /** Skip the delegate-to-operator attempt (force the full-loop fallback). */
  noDelegate?: boolean;
  /** Override the operator socket path (else DEFAULT_OPERATOR_SOCKET). */
  socket?: string;
}

/** Read the AgentSessionEvent payload from a file path or `-` (stdin). */
async function readPayload(path: string): Promise<string> {
  if (path === "-") {
    return await readStdin();
  }
  return await readFile(path, "utf8");
}

/**
 * Try to delegate the event to the `linearctl operator` daemon over its Unix
 * control socket. Returns the loop result on success, or `null` if the daemon
 * is unreachable (ECONNREFUSED / timeout / non-200) — the caller falls through
 * to the in-process full-loop path. Never throws.
 */
export async function tryDelegate(
  rawPayload: string,
  socketPath: string,
): Promise<EventLoopResult | null> {
  let client;
  try {
    client = makeControlClient(socketPath);
  } catch {
    return null;
  }
  try {
    const res = await client.request("POST", "/delegate", rawPayload);
    if (res.status !== 200 || !res.body) return null;
    const result = JSON.parse(res.body) as EventLoopResult;
    return result;
  } catch {
    // ECONNREFUSED, timeout, or bad JSON — daemon down or unhealthy. Fall back.
    return null;
  }
}

/**
 * `linearctl watch --once --payload <file|-> [--json]` — run the full agent
 * loop over one AgentSessionEvent webhook payload.
 */
export async function watch(opts: WatchOptions): Promise<void> {
  if (!opts.once) {
    throw new Error("`linearctl watch` currently requires --once (the long-running tail is CER-1149 follow-up).");
  }
  if (!opts.payload) {
    throw new Error("`linearctl watch --once` requires --payload <file|-> (read the AgentSessionEvent JSON from a file or stdin).");
  }

  const raw = await readPayload(opts.payload);
  if (!raw.trim()) {
    throw new Error("--payload is empty; expected an AgentSessionEvent JSON body.");
  }

  let event: AgentSessionEvent;
  try {
    event = JSON.parse(raw) as AgentSessionEvent;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`--payload is not valid JSON: ${msg}`);
  }

  // Delegate-first: hand the event to the operator daemon if it's running.
  // The daemon holds a cached token + queue context, so this is the fast path.
  // On any failure (daemon down / timeout / non-200), fall through to the
  // full-loop fallback below.
  if (!opts.noDelegate) {
    const socketPath = opts.socket ?? DEFAULT_OPERATOR_SOCKET;
    const delegated = await tryDelegate(raw, socketPath);
    if (delegated) {
      if (opts.json) {
        printJson(delegated);
        return;
      }
      process.stderr.write(`watch — delegated to operator (${socketPath})\n`);
      process.stdout.write(
        `watch — agent-session loop complete (via operator)\n` +
          `  thought:  ${delegated.thoughtId}\n` +
          `  response: ${delegated.responseId}\n` +
          `  moved:    ${delegated.movedToStateId ?? "(already started / no issue)"}\n`,
      );
      return;
    }
  }

  // Full-loop fallback (secondary path): mint + immediately use the token.
  const creds = loadClientCreds();
  const token = await mintClientCredentialsToken(creds, DEFAULT_BOT_SCOPES);

  const result = await runEventLoop(event, token.access_token);

  if (opts.json) {
    printJson(result);
    return;
  }

  process.stdout.write(
    `watch — agent-session loop complete\n` +
      `  thought:  ${result.thoughtId}\n` +
      `  response: ${result.responseId}\n` +
      `  moved:    ${result.movedToStateId ?? "(already started / no issue)"}\n`,
  );
}

