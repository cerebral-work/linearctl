import { makeClient } from "../client.js";
import { createIssue } from "../core/issues.js";
import { readStdin } from "../lib/io.js";
import { printJson } from "../lib/output.js";
import { isInteractive } from "../lib/interactive.js";
import { promptText, promptTeamKey, promptOptionalText } from "../lib/prompts.js";
import { withSpinner } from "../lib/spinner.js";

export interface FileOptions {
  team?: string;
  project?: string;
  desc?: string;
  label?: string[];
  json?: boolean;
}

/**
 * `linearctl file <title> --team CER` — create a Linear issue headless / batch.
 *
 * Delegates to `core.createIssue`; this layer handles the `--desc -` stdin
 * convention and output formatting. See docs/spec.md §6.3.
 *
 * Interactive: at a TTY (no `--json`), missing title/team are prompted for
 * instead of erroring — see docs/features/interactive.md. A fully-specified
 * invocation never prompts.
 */
export async function file(title: string | undefined, opts: FileOptions): Promise<void> {
  const client = makeClient();
  let description = opts.desc === "-" ? await readStdin() : opts.desc;
  let team = opts.team;

  if (isInteractive(opts.json) && (!title || !team)) {
    if (!title) title = await promptText("Title");
    if (!team) team = await promptTeamKey(client);
    if (description === undefined) description = await promptOptionalText("Description");
  }
  if (!title) throw new Error("file needs a <title>.");
  if (!team) throw new Error("file needs --team <key> (e.g. CER).");
  const teamKey = team;
  const issueTitle = title;

  const issue = await withSpinner("Creating issue…", () =>
    createIssue(client, {
      teamKey,
      title: issueTitle,
      description,
      projectId: opts.project,
      labels: opts.label,
    }),
  );

  if (opts.json) {
    printJson(issue);
    return;
  }

  process.stdout.write(
    `created ${issue.identifier}: ${issue.title}\n  url: ${issue.url}\n`,
  );
}
