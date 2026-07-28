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
} from "../core/watch.js";

export interface WatchOptions {
  /** Run exactly one loop iteration (no long-running tail). */
  once?: boolean;
  /** Path to the AgentSessionEvent payload JSON file; `-` reads stdin. */
  payload?: string;
  /** Emit the emitted activity node ids as JSON. */
  json?: boolean;
}

/** Read the AgentSessionEvent payload from a file path or `-` (stdin). */
async function readPayload(path: string): Promise<string> {
  if (path === "-") {
    return await readStdin();
  }
  return await readFile(path, "utf8");
}

/**
 * `linearctl watch --once --payload <file|-> [--json]` — run the full agent
 * loop over one AgentSessionEvent webhook payload.
 */
export async function watch(opts: WatchOptions): Promise<void> {
  // FOLLOW-UP(CER-1149): try-delegate to linearctl operator Unix socket here;
  // on connection-refused, fall through to the full-loop path above.
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

  // Mint + immediately use the token (held in memory only).
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
