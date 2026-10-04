import { makeClient } from "../client.js";
import { pullIssues } from "../core/pull.js";
import { printJson } from "../lib/output.js";

export interface PullOptions {
  team?: string[];
  state?: string;
  /** Repeatable: OR across multiple state names/types (e.g. --state-set Todo --state-set Backlog). */
  stateSet?: string[];
  label?: string[];
  assignee?: string;
  project?: string;
  priority?: string;
  text?: string;
  updatedSince?: string;
  createdSince?: string;
  json?: boolean;
  /** Cap results for safe soma dev/testing. */
  limit?: number;
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
  const items = await pullIssues(client, {
    teamKeys: opts.team,
    state: opts.state,
    stateSet: opts.stateSet,
    assignee: opts.assignee,
    project: opts.project,
    priority: opts.priority,
    text: opts.text,
    updatedSince: opts.updatedSince,
    createdSince: opts.createdSince,
    limit: opts.limit,
  });

  // JSON is the only output path — `pull` exists for machine consumption.
  // `--json` is accepted for consistency with every other command, but the
  // human-table path is intentionally absent (use `search` for that).
  void opts.json;
  printJson(items);
}
