import pc from "picocolors";

/**
 * Styled output is for a human at a terminal: stdout is a TTY and NO_COLOR is
 * unset. Pipes, redirects, CI, and `--json` paths never see ANSI codes or
 * box-drawing characters — the headless contract is byte-identical to before
 * styling existed.
 */
export function isStyled(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

export { pc };
