import { makeClient } from "../client.js";
import { createIssue } from "../core/issues.js";
import { readStdin } from "../lib/io.js";
import { printJson } from "../lib/output.js";

export interface FileOptions {
  team: string;
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
 */
export async function file(title: string, opts: FileOptions): Promise<void> {
  const client = makeClient();
  const description = opts.desc === "-" ? await readStdin() : opts.desc;

  const issue = await createIssue(client, {
    teamKey: opts.team,
    title,
    description,
    projectId: opts.project,
    labels: opts.label,
  });

  if (opts.json) {
    printJson(issue);
    return;
  }

  process.stdout.write(
    `created ${issue.identifier}: ${issue.title}\n  url: ${issue.url}\n`,
  );
}
