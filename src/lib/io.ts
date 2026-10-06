import { readFileSync } from "node:fs";
import { usageError } from "./errors.js";

/**
 * Read all of stdin as a trimmed UTF-8 string — backs the `--desc -` convention
 * (read markdown from a pipe / heredoc instead of an argument).
 *
 * Implementation: a single blocking `fs.readFileSync(0)`. The previous form —
 * `for await (const chunk of process.stdin)` — returns EMPTY under Bun when
 * stdin is a regular-file redirect (`< body.md`) once certain modules
 * (commander) are imported first, while pipes still work. That silently
 * dropped bodies on write paths (CER-2060, CER-2133). Reading fd 0 directly
 * is immune: regular files and pipes are both always-readable, so the
 * blocking read drains them to EOF identically. Edge-case parity with the
 * old loop: interactive TTY blocks until EOF; an empty source reads "" (and
 * `requireBody` below still rejects it); a fully-closed fd 0 blocks in both
 * implementations.
 */
export async function readStdin(): Promise<string> {
  return readFileSync(0).toString("utf8").trim();
}

/**
 * Refuse an empty body read for a `-` flag value. An empty stdin after
 * `--desc -` / `--body -` means the pipe or redirect delivered nothing
 * (sandboxed shells can hand the process an empty stdin on `< file`
 * redirects, CER-1872) — accepting it silently creates title-only issues.
 */
export function requireBody(flag: string, body: string): string {
  if (body === "") {
    throw usageError(
      `${flag}: stdin was empty — refusing to write an empty body. ` +
        `Pipe the content (cat body.md | …) or pass it inline.`,
    );
  }
  return body;
}

/** `readStdin` for a `-` flag value, rejecting an empty read via `requireBody`. */
export async function readStdinFor(flag: string): Promise<string> {
  return requireBody(flag, await readStdin());
}
