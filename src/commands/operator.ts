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
 *   `linearctl operator [--socket <path>] [--queue-poll-interval <ms>] [--role <name...>] [--json] [--check] [--health]`
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
 *
 * `--check` does NOT start the daemon — it connects to a running operator's
 * Unix socket, GETs `/readyz`, prints the readiness report, and exits 0 if
 * ready / 1 if not (a drain on the runbook's step-7 smoke). CF env is reported
 * presence-only (never the values).
 *
 * `--health` (PR #120) does NOT start the daemon either — it connects to a
 * running operator's Unix socket, GETs `/healthz`, prints the liveness report
 * (uptime + queue depth), and exits 0 if alive / 1 if not. The cluster's
 * liveness probe uses this; readiness uses `--check` (`/readyz`). `--health`
 * and `--check` are mutually exclusive (an explicit error, not silent precedence).
 */

import { printJson } from "../lib/output.js";
import { DEFAULT_OPERATOR_SOCKET, makeControlClient } from "../lib/control-socket.js";
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
  /** Don't start the daemon — probe a running operator's /readyz and exit 0/1 (Track 4). */
  check?: boolean;
  /** Don't start the daemon — probe a running operator's /healthz and exit 0/1 (PR #120 liveness). */
  health?: boolean;
}

/** The parsed /readyz report body (presence-only — no secret values). */
interface ReadyzReport {
  ok: boolean;
  cfEnv: { accountId: boolean; queueId: boolean; apiToken: boolean };
  tokenAgeSec: number;
  lastPoll: string | null;
  queueDepth: number;
}

/** The parsed /healthz report body (PR #120 liveness — uptime + queue depth). */
interface HealthReport {
  ok: boolean;
  uptime: number;
  queueDepth: number;
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

/** Resolve `--role` names to descriptors + runners, throwing on a typo. */
function resolveRoles(
  names: string[] | undefined,
): { roles: RoleDescriptor[]; runners: Record<string, RoleRunner> } | undefined {
  if (!names?.length) return undefined;
  const roles: RoleDescriptor[] = [];
  const runners: Record<string, RoleRunner> = {};
  for (const name of names) {
    const role = getRole(name);
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
 * `linearctl operator [--socket <path>] [--queue-poll-interval <ms>] [--role <name...>] [--json] [--check] [--health]`.
 *
 * Starts the daemon and blocks until SIGINT/SIGTERM. The banner goes to
 * stderr so stdout stays clean for `--json` machine output. `--check` short-
 * circuits: it probes a running operator's `/readyz` and exits 0/1 instead of
 * starting a new daemon. `--health` (PR #120) likewise short-circuits to probe
 * `/healthz`; the two are mutually exclusive.
 */
export async function operator(opts: OperatorCommandOptions): Promise<void> {
  // --health and --check are mutually exclusive — the liveness vs readiness
  // probes must not be conflated. An explicit error beats silent precedence.
  if (opts.health && opts.check) {
    throw new Error(
      "linearctl operator: --health and --check are mutually exclusive " +
        "(--health probes /healthz for liveness, --check probes /readyz for readiness).",
    );
  }

  // --health: probe liveness (/healthz), don't start the daemon.
  if (opts.health) {
    await healthOperator(opts.socket ?? DEFAULT_OPERATOR_SOCKET, opts.json);
    return;
  }

  // --check: probe readiness (/readyz), don't start the daemon.
  if (opts.check) {
    await checkOperator(opts.socket ?? DEFAULT_OPERATOR_SOCKET, opts.json);
    return;
  }

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

/**
 * Probe a running operator's `/readyz` over the Unix socket + report.
 *
 * Print the readiness report (presence-only CF env, token age, last poll,
 * queue depth) and exit 0 if the daemon is ready to consume / 1 otherwise.
 * A connection failure (no daemon, socket stale) is a not-ready result with a
 * diagnostic on stderr — it is NOT a thrown exception, so the runbook's step-7
 * smoke gets a clean exit code rather than a stack trace.
 *
 * `--json` prints the raw /readyz body as JSON; the default prints a human report.
 */
export async function checkOperator(socketPath: string, json?: boolean): Promise<void> {
  let report: ReadyzReport;
  try {
    const client = makeControlClient(socketPath, { connectTimeoutMs: 1000 });
    const res = await client.request("GET", "/readyz");
    if (res.status !== 200) {
      process.stderr.write(`operator --check: /readyz returned HTTP ${res.status}\n`);
      process.exit(1);
    }
    report = JSON.parse(res.body ?? "") as ReadyzReport;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) printJson({ ok: false, error: msg });
    else process.stderr.write(`operator --check: not ready — ${msg}\n`);
    process.exit(1);
  }

  if (json) {
    printJson(report);
  } else {
    const cf = report.cfEnv;
    process.stdout.write(
      `operator readiness: ${report.ok ? "READY" : "NOT READY"}\n` +
        `  cf env: accountId=${cf.accountId} queueId=${cf.queueId} apiToken=${cf.apiToken}\n` +
        `  token age: ${report.tokenAgeSec}s\n` +
        `  last poll: ${report.lastPoll ?? "(never)"}\n` +
        `  queue depth: ${report.queueDepth}\n`,
    );
  }
  process.exit(report.ok ? 0 : 1);
}

/**
 * Probe a running operator's `/healthz` over the Unix socket + report (PR #120).
 *
 * Liveness probe: "is the process alive?" — distinct from `--check`'s
 * "is it able to consume?" readiness. Prints the liveness report (uptime +
 * queue depth) and exits 0 if the daemon is alive / 1 otherwise. A connection
 * failure (no daemon, socket stale) is a not-alive result with a diagnostic on
 * stderr — not a thrown exception — so the kubelet exec liveness probe gets a
 * clean exit code rather than a stack trace.
 *
 * `--json` prints the raw /healthz body as JSON; the default prints a human report.
 */
export async function healthOperator(socketPath: string, json?: boolean): Promise<void> {
  let report: HealthReport;
  try {
    const client = makeControlClient(socketPath, { connectTimeoutMs: 1000 });
    const res = await client.request("GET", "/healthz");
    if (res.status !== 200) {
      process.stderr.write(`operator --health: /healthz returned HTTP ${res.status}\n`);
      process.exit(1);
    }
    report = JSON.parse(res.body ?? "") as HealthReport;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) printJson({ ok: false, error: msg });
    else process.stderr.write(`operator --health: not alive — ${msg}\n`);
    process.exit(1);
  }

  if (json) {
    printJson(report);
  } else {
    process.stdout.write(
      `operator liveness: ${report.ok ? "ALIVE" : "NOT ALIVE"}\n` +
        `  uptime: ${report.uptime}s\n` +
        `  queue depth: ${report.queueDepth}\n`,
    );
  }
  process.exit(report.ok ? 0 : 1);
}
