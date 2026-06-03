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
