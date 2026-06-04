import { makeClient } from "../client.js";
import { updateIssue, closeIssue } from "../core/issues.js";
import { printJson } from "../lib/output.js";
import type { UpdatedIssue } from "../core/issues.js";

function renderIssue(issue: UpdatedIssue): void {
  process.stdout.write(
    `${issue.identifier} [${issue.state}]${issue.assignee ? ` @${issue.assignee}` : ""}: ${issue.title}\n` +
      `  url: ${issue.url}\n`,
  );
}

export interface UpdateOptions {
  state?: string;
  assignee?: string;
  label?: string[];
  project?: string;
  priority?: string;
  json?: boolean;
}

/**
 * `linearctl update <id>` — mutate an issue's state / assignee / labels /
 * project / priority. Delegates to `core.updateIssue`. See docs/spec.md §6.8.
 */
export async function update(id: string, opts: UpdateOptions): Promise<void> {
  const client = makeClient();
  const issue = await updateIssue(client, id, {
    state: opts.state,
    assignee: opts.assignee,
    labels: opts.label,
    projectId: opts.project,
    priority: opts.priority !== undefined ? Number(opts.priority) : undefined,
  });

  if (opts.json) {
    printJson(issue);
    return;
  }
  renderIssue(issue);
}

export interface CloseOptions {
  json?: boolean;
}

/**
 * `linearctl close <id>` — move an issue to its team's completed state.
 * Delegates to `core.closeIssue`. See docs/spec.md §6.8.
 */
export async function close(id: string, opts: CloseOptions): Promise<void> {
  const client = makeClient();
  const issue = await closeIssue(client, id);

  if (opts.json) {
    printJson(issue);
    return;
  }
  renderIssue(issue);
}
