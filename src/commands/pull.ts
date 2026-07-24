import { makeClient } from "../client.js";
import { pullIssues } from "../core/pull.js";
import { printJson } from "../lib/output.js";
import { classifyError } from "../lib/retry.js";

export interface PullOptions {
  team?: string[];
  state?: string;
  label?: string[];
  assignee?: string;
  project?: string;
  priority?: string;
  text?: string;
  updatedSince?: string;
  createdSince?: string;
  json?: boolean;
}

/**
 * `linearctl pull [--team KEY...] [--state <name|type>] [--label NAME...]` —
 * machine-consumable issue stream for the soma WorkSource reconcile loop.
 * Emits **JSON only** (one object per issue; stable field names, no ANSI) so
 * the Rust operator can parse it directly or implement the same GraphQL query
 * itself. See `docs/funnel-contract.md` — that doc is the contract.
 *
 * Default scope is active states (completed/canceled excluded); `--state all`
 * lifts it. Ordered by `updatedAt` desc.
 */
export async function pull(opts: PullOptions): Promise<void> {
  const client = makeClient();
  let items;
  try {
    items = await pullIssues(client, {
      teamKeys: opts.team,
      state: opts.state,
      labels: opts.label,
      assignee: opts.assignee,
      project: opts.project,
      priority: opts.priority,
      text: opts.text,
      updatedSince: opts.updatedSince,
      createdSince: opts.createdSince,
    });
  } catch (err) {
    // The funnel contract (docs/funnel-contract.md §1) documents exit 2 when
    // the Linear API rate limit is exhausted so an unattended operator can
    // distinguish "rate-limited, retry later" from a real error (exit 1).
    // `withRetry` already retries with backoff; if it still throws
    // RATELIMITED after exhausting attempts, surface it as exit 2 here.
    const { transient, reason } = classifyError(err);
    if (transient && /ratelimit/i.test(reason)) {
      console.error("error: Linear API rate limit exhausted after retries.");
      process.exit(2);
    }
    throw err;
  }

  // JSON is the only output path — `pull` exists for machine consumption.
  // `--json` is accepted for consistency with every other command, but the
  // human-table path is intentionally absent (use `search` for that).
  void opts.json;
  printJson(items);
}
