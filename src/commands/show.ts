import { makeClient } from "../client.js";
import { getIssue, renderIssueDetail } from "../core/issues.js";
import { printJson } from "../lib/output.js";

export interface ShowOptions {
  json?: boolean;
}

/**
 * `linearctl show <id>` — read one issue in full (metadata + description).
 * Delegates to `core.getIssue`. See docs/spec.md §6.
 */
export async function show(id: string, opts: ShowOptions): Promise<void> {
  const client = makeClient();
  const detail = await getIssue(client, id);
  if (opts.json) {
    printJson(detail);
    return;
  }
  process.stdout.write(renderIssueDetail(detail));
}
