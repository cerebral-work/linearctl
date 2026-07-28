/**
 * `linearctl tui` — Ink app entry + pane router (CER-1550).
 *
 * The full-screen dashboard over `core/*` (`docs/features/tui.md:28-32`). This
 * first slice implements the Triage pane only; the tab bar renders `1`–`5` but
 * only `2` (Triage) is active — the others are placeholders (`tui.md:60-68`,
 * first-slice scope per `followup-tracks-plan.md` Track 2).
 *
 * The TTY gate lives in `src/commands/tui.ts` (the command wrapper), not here —
 * this module assumes it's already past the gate and running interactively.
 * `app()` is pure: it fetches the triage queue from `core/grooming` then mounts
 * the Ink tree. It never talks to Linear directly (`tui.md:108-110`).
 */

import { render } from "ink";
import type { LinearClient } from "@linear/sdk";
import { triage } from "../core/grooming.js";
import { makeClient } from "../client.js";
import { Dashboard } from "./dashboard.js";

export interface TuiOptions {
  /** Team key(s) to scope the triage queue (e.g. `["CER"]`). */
  team?: string[];
  /** Project ref to scope (id or name). */
  project?: string;
  /** Initial pane focus: only `triage` is active in the first slice. */
  focus?: "triage";
  /**
   * Override the client (test seam). When omitted, `makeClient()` is used —
   * the same auth path as every headless command.
   */
  client?: LinearClient;
}

/**
 * Entry point for `linearctl tui`. Fetches the triage queue from
 * `core/grooming.triage()` (same fn as `linearctl triage`), then renders the
 * Ink dashboard. Blocks until the user quits (`q`) or Ctrl-C.
 */
export async function app(opts: TuiOptions): Promise<void> {
  const client = opts.client ?? makeClient();
  const items = await triage(client, opts.team, opts.project);

  const instance = render(<Dashboard items={items} team={opts.team} />);

  await instance.waitUntilExit();
}
