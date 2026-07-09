import { makeClient } from "../client.js";
import { createComment } from "../core/issues.js";
import { readStdin } from "../lib/io.js";
import { printJson } from "../lib/output.js";

export interface CommentOptions {
  body?: string;
  json?: boolean;
}

/**
 * `linearctl comment <id> --body <md>` — add a comment to an issue headless.
 * `--body -` reads markdown from stdin (same convention as `file --desc -`).
 * Non-destructive (additive), so no `--apply` gate — safe-by-default is
 * satisfied without a dry-run flag. Delegates to `core.createComment`.
 * See `docs/features/comment.md`.
 */
export async function comment(id: string, opts: CommentOptions): Promise<void> {
  let body: string;
  if (opts.body === "-") {
    body = await readStdin();
  } else if (opts.body) {
    body = opts.body;
  } else {
    throw new Error("comment needs --body <markdown> (or --body - for stdin).");
  }
  if (!body.trim()) {
    throw new Error("comment body is empty.");
  }

  const client = makeClient();
  const result = await createComment(client, id, body);

  if (opts.json) {
    printJson(result);
    return;
  }
  process.stdout.write(
    `${result.identifier}: comment ${result.commentId} added\n  url: ${result.url}\n`,
  );
}
