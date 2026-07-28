/**
 * `linearctl tui` — command wrapper (CER-1550).
 *
 * Parses `--team`, `--focus`, gates TTY (the load-bearing guard — non-TTY MUST
 * error, never enter the TUI), then calls `src/tui/app.ts`. The TUI is the
 * human-at-terminal surface; the headless commands are the pipe path
 * (`docs/features/tui.md:79-82`). No `--json` mode — the TUI is human-only
 * (`tui.md:166-167`).
 *
 *   `linearctl tui [--team KEY...] [--focus triage]`
 */

import { app } from "../tui/app.js";

export interface TuiCommandOptions {
  /** Team key(s) to scope all panes (e.g. CER); omit for all teams. */
  team?: string[];
  /** Project ref to scope (id or name). */
  project?: string;
  /** Initial pane focus: only `triage` is active in the first slice. */
  focus?: string;
}

/**
 * The TTY gate (load-bearing). If stdout is not a TTY (piped, redirected, CI),
 * `linearctl tui` errors immediately — it never degrades to a broken
 * half-render (`docs/features/tui.md:79-82,193-195`). Exits non-zero so scripts
 * that pipe `tui` fail loudly.
 */
function assertTty(): void {
  if (!process.stdout.isTTY) {
    console.error('error: tui requires a terminal (stdout is not a TTY).\n  Run in an interactive terminal, not piped/redirected.');
    process.exit(1);
  }
}

/**
 * `linearctl tui [--team KEY...] [--focus triage]` — open the full-screen
 * dashboard. TTY-gated: non-TTY invocation errors before any render.
 */
export async function tui(opts: TuiCommandOptions): Promise<void> {
  assertTty();

  const focus = opts.focus === "triage" ? "triage" : undefined;
  await app({ team: opts.team, project: opts.project, focus });
}
