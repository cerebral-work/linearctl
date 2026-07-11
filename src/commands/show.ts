import { makeClient } from "../client.js";
import { getIssue, renderIssueDetail } from "../core/issues.js";
import { printJson } from "../lib/output.js";
import { isInteractive } from "../lib/interactive.js";
import { promptIssuePick } from "../lib/prompts.js";

export interface ShowOptions {
  team?: string[];
  json?: boolean;
}

/**
 * `linearctl show <id>` — read one issue in full (metadata + description).
 * Delegates to `core.getIssue`. At a TTY with no id, offers a fuzzy picker
 * over recently updated active issues. See docs/spec.md §6.
 */
export async function show(id: string | undefined, opts: ShowOptions): Promise<void> {
  const client = makeClient();
  if (!id && isInteractive(opts.json)) {
    id = await promptIssuePick(client, "Show which issue?", opts.team);
  }
  if (!id) throw new Error("show needs an <id> (e.g. CER-123).");
  const detail = await getIssue(client, id);
  if (opts.json) {
    printJson(detail);
    return;
  }
  process.stdout.write(renderIssueDetail(detail));
}
