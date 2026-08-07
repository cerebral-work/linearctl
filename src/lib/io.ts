/**
 * Read all of stdin as a trimmed UTF-8 string — backs the `--desc -` convention
 * (read markdown from a pipe / heredoc instead of an argument).
 */
export async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Uint8Array);
  }
  return Buffer.concat(chunks).toString("utf8").trim();
}

/**
 * Refuse an empty body read for a `-` flag value. An empty stdin after
 * `--desc -` / `--body -` means the pipe or redirect delivered nothing
 * (sandboxed shells can hand the process an empty stdin on `< file`
 * redirects, CER-1872) — accepting it silently creates title-only issues.
 */
export function requireBody(flag: string, body: string): string {
  if (body === "") {
    throw new Error(
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
