import { makeClient } from "../client.js";
import { resolveTeamByKey } from "../lib/resolve.js";
import { readStdin } from "../lib/io.js";
import { pickLabelIds } from "../lib/labels.js";
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
 * Complements the `file-bug` / `linear-file-spec` skills for non-interactive use
 * (CI, scripts, loops). Resolves the team by key, resolves any `--label` names to
 * IDs, then `createIssue({ teamId, title, description, projectId, labelIds })` and
 * prints the new issue's `identifier` + `url`. `--desc -` reads markdown from
 * stdin. Bypasses the LOCAL MCP rate-guard but still respects Linear's own
 * `RATELIMITED` limits — batch with backoff (T6). See docs/spec.md §6.3.
 */
export async function file(title: string, opts: FileOptions): Promise<void> {
  const client = makeClient();
  const team = await resolveTeamByKey(client, opts.team);
  const description = opts.desc === "-" ? await readStdin() : opts.desc;

  let labelIds: string[] = [];
  if (opts.label?.length) {
    const filter = { or: opts.label.map((n) => ({ name: { eqIgnoreCase: n } })) };
    const labels = await client.issueLabels({ filter });
    labelIds = pickLabelIds(labels.nodes, opts.label);
  }

  const res = await client.createIssue({
    teamId: team.id,
    title,
    ...(description ? { description } : {}),
    ...(opts.project ? { projectId: opts.project } : {}),
    ...(labelIds.length ? { labelIds } : {}),
  });
  if (!res.success) {
    throw new Error("Linear reported the issue create did not succeed.");
  }
  const issue = await res.issue;
  if (!issue) {
    throw new Error("issue created but the payload returned no issue.");
  }

  if (opts.json) {
    printJson({
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      url: issue.url,
    });
    return;
  }

  process.stdout.write(
    `created ${issue.identifier}: ${issue.title}\n  url: ${issue.url}\n`,
  );
}
