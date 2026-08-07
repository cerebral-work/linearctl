/**
 * `linearctl tui` — Ink app entry + pane router (CER-1550).
 *
 * The full-screen dashboard over `core/*` (`docs/features/tui.md:28-32`).
 * All 5 panes are live: Digest, Triage, Milestone, Xref, Stale.
 *
 * The TTY gate lives in `src/commands/tui.ts` (the command wrapper), not here —
 * this module assumes it's already past the gate and running interactively.
 * `app()` fetches data for all panes from `core/*` then mounts the Ink tree.
 * It never talks to Linear directly (`tui.md:108-110`).
 */

import { render } from "ink";
import type { LinearClient } from "@linear/sdk";
import { triage, digest as digestCore, stale as staleCore } from "../core/grooming.js";
import { milestones as milestonesCore } from "../core/milestones.js";
import { xref as xrefCore } from "../core/xref.js";
import { makeClient } from "../client.js";
import { Dashboard } from "./dashboard.js";

export interface TuiOptions {
  /** Team key(s) to scope all panes (e.g. `["CER"]`). */
  team?: string[];
  /** Project ref to scope (id or name). */
  project?: string;
  /** Initial pane focus. */
  focus?: "digest" | "triage" | "milestone" | "xref" | "stale";
  /** Override the client (test seam). */
  client?: LinearClient;
}

/** Days to look back for the digest pane (matches `linearctl digest --since 7d`). */
const DIGEST_SINCE_DAYS = 7;
/** Stale thresholds (match `linearctl stale` defaults). */
const STALE_WARN_DAYS = 14;
const STALE_CRITICAL_DAYS = 30;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

/**
 * Entry point for `linearctl tui`. Fetches data for all 5 panes from `core/*`
 * (same functions the headless commands use), then renders the Ink dashboard.
 * Blocks until the user quits (`q`) or Ctrl-C.
 */
export async function app(opts: TuiOptions): Promise<void> {
  const client = opts.client ?? makeClient();

  const [items, digestResult, milestoneResult, xrefResult, staleResult] =
    await Promise.all([
      triage(client, opts.team, opts.project),
      digestCore(client, daysAgo(DIGEST_SINCE_DAYS), opts.team, opts.project),
      milestonesCore(client, opts.project),
      xrefCore(client, { teamKeys: opts.team }),
      staleCore(client, {
        teamKeys: opts.team,
        project: opts.project,
        warnCutoff: daysAgo(STALE_WARN_DAYS),
        criticalCutoff: daysAgo(STALE_CRITICAL_DAYS),
        now: new Date(),
      }),
    ]);

  const instance = render(
    <Dashboard
      items={items}
      digestResult={digestResult}
      milestoneResult={milestoneResult}
      xrefResult={xrefResult}
      staleResult={staleResult}
      team={opts.team}
    />,
  );

  await instance.waitUntilExit();
}
