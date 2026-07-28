/**
 * `linearctl operator` — the long-running daemon subcommand (CER-1149 / CER-1188).
 *
 * Runs the operator core: mints a token at startup, polls the Cloudflare Queue
 * `linear-agent-events`, serves `linearctl watch`'s delegate-to-operator path
 * over a Unix socket (`POST /delegate`, `GET /healthz`), and (since CER-1188)
 * boots a set of maintainer-agent roles on D4 cadence. Stays in the foreground
 * until SIGINT/SIGTERM, which trigger graceful shutdown (stop polling, drain
 * in-flight events + role runs, close + unlink the socket).
 *
 *   `linearctl operator [--socket <path>] [--queue-poll-interval <ms>] [--role <name...>] [--json]`
 *
 * `--socket` overrides the default `~/.local/state/linearctl/operator.sock`.
 * `--role` repeats to boot roles from `src/core/role-catalog.ts` (e.g.
 * `--role intake-triage --role grooming`). Roles share the cached app-actor
 * token so actions attribute as the bot, not a user (D2).
 * `--json` suppresses the human banner (stderr) and emits the listening
 * address + booted roles as a single JSON line on stdout for machine consumption.
 *
 * The token value is never logged/echoed. Only redacted handles appear in
 * error messages, matching the `src/lib/secrets.ts` Secret pattern.
 */

import { printJson } from "../lib/output.js";
import { DEFAULT_OPERATOR_SOCKET } from "../lib/control-socket.js";
import { startOperator, type OperatorOptions } from "../core/operator.js";
import { getRole, type RoleDescriptor, type RoleRunner } from "../core/role-catalog.js";
import { runIntakeTriage } from "../roles/intake-triage.js";
import { runGrooming } from "../roles/grooming.js";

export interface OperatorCommandOptions {
  /** Override the Unix socket path (default: ~/.local/state/linearctl/operator.sock). */
  socket?: string;
  /** Override the queue poll interval in ms. */
  queuePollInterval?: number;
  /** Role name(s) to boot on cadence (e.g. intake-triage, grooming). Repeatable. */
  role?: string[];
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
 * The default role-runner map: role name → handler. The first slice ships two
 * runners (intake-triage, grooming); later phases add the rest behind the LLM.
 * `--role` looks up names in the catalog, then resolves the handler here.
 */
const ROLE_RUNNERS: Record<string, RoleRunner> = {
  "intake-triage": runIntakeTriage,
  grooming: runGrooming,
};

/** Resolve `--role` names to descriptors + runners, throwing on a tyop. */
function resolveRoles(
  names: string[] | undefined,
): { roles: RoleDescriptor[]; runners: Record<string, RoleRunner> } | undefined {
  if (!names?.length) return undefined;
  const roles: RoleDescriptor[] = [];
  const runners: Record<string, RoleRunner> = {};
  for (const name of names) {
    const role = getRole(name); // throws on unknown name (typo) with the known list
    roles.push(role);
    const runner = ROLE_RUNNERS[name];
    if (!runner) {
      throw new Error(
        `role "${name}" is registered but has no runner implementation (first slice: intake-triage, grooming)`,
      );
    }
    runners[name] = runner;
  }
  return { roles, runners };
}

/**
 * `linearctl operator [--socket <path>] [--queue-poll-interval <ms>] [--role <name...>] [--json]`.
 *
 * Starts the daemon and blocks until SIGINT/SIGTERM. The banner goes to
 * stderr so stdout stays clean for `--json` machine output.
 */
export async function operator(opts: OperatorCommandOptions): Promise<void> {
  const resolved = resolveRoles(opts.role);

  const operatorOpts: OperatorOptions = {
    socketPath: opts.socket ?? DEFAULT_OPERATOR_SOCKET,
    queuePollIntervalMs: parsePollInterval(opts.queuePollInterval?.toString()),
    ...(resolved ? { roles: resolved.roles, roleRunners: resolved.runners } : {}),
  };

  const handle = await startOperator(operatorOpts);

  if (opts.json) {
    printJson({ ok: true, socket: handle.socketPath, polling: handle.polling, roles: handle.roles });
  } else {
    process.stderr.write(
      `linearctl operator listening on ${handle.socketPath}\n` +
        `  polling: ${handle.polling ? "on" : "off (set CF_ACCOUNT_ID/CF_QUEUE_ID/CF_API_TOKEN to enable)"}\n` +
        `  roles:   ${handle.roles.length ? handle.roles.join(", ") : "none (use --role <name>)"}\n` +
        `  stop:   SIGINT / SIGTERM\n`,
    );
  }

  // Block until the process is killed (startOperator wired the signal handlers).
  // `startOperator`'s shutdown handler calls process.exit(0); we just hold here.
  return new Promise(() => {});
}
