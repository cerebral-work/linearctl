/**
 * Interactive mode — the middle layer between headless (`--json`, pipes) and a
 * future full-screen TUI. See docs/features/interactive.md (CER-1551).
 *
 * The trigger is deliberately narrow: prompts may fire only when a human is on
 * BOTH ends (stdin and stdout are TTYs) and `--json` was not passed. Whether a
 * command actually prompts is then a per-command decision based on which
 * arguments are missing — a fully-specified invocation never prompts, so
 * muscle-memory one-liners behave identically at a terminal and in a script.
 */

export interface InteractiveStreams {
  stdinIsTTY: boolean;
  stdoutIsTTY: boolean;
}

const processStreams = (): InteractiveStreams => ({
  stdinIsTTY: Boolean(process.stdin.isTTY),
  stdoutIsTTY: Boolean(process.stdout.isTTY),
});

/** May this invocation prompt at all? (streams injectable for tests) */
export function isInteractive(
  json: boolean | undefined,
  streams: InteractiveStreams = processStreams(),
): boolean {
  return streams.stdinIsTTY && streams.stdoutIsTTY && json !== true;
}
