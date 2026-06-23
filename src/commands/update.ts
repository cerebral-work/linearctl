import { makeClient } from "../client.js";
import { updateIssue, closeIssue } from "../core/issues.js";
import { parseBulkSpec, bulkUpdate } from "../core/bulk.js";
import { readStdin } from "../lib/io.js";
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
  milestone?: string;
  stdin?: boolean;
  apply?: boolean;
  json?: boolean;
}

/**
 * `linearctl update <id>` — mutate an issue's state / assignee / labels /
 * project / priority. With `--stdin`, run a BULK update instead (see
 * {@link bulkUpdate}): read a plan from stdin and apply it in batched GraphQL
 * mutations. Delegates to `core.updateIssue` / `core.bulkUpdate`. docs/spec.md §6.8.
 */
export async function update(id: string | undefined, opts: UpdateOptions): Promise<void> {
  const client = makeClient();

  if (opts.stdin) {
    await bulk(client, opts);
    return;
  }
  if (!id) {
    throw new Error("update needs an <id> — or pass --stdin for a bulk update.");
  }

  const issue = await updateIssue(client, id, {
    state: opts.state,
    assignee: opts.assignee,
    labels: opts.label,
    projectId: opts.project,
    priority: opts.priority !== undefined ? Number(opts.priority) : undefined,
    milestone: opts.milestone,
  });

  if (opts.json) {
    printJson(issue);
    return;
  }
  renderIssue(issue);
}

/**
 * Bulk path: read a JSON-array / NDJSON plan of
 * `{ id, labels?, addLabels?, priority?, project?, assignee? }` from stdin,
 * resolve it, and (dry-run by default) preview — or `--apply` to write in
 * batched mutations. Mirrors `stale`'s dry-run→apply contract.
 */
async function bulk(client: ReturnType<typeof makeClient>, opts: UpdateOptions): Promise<void> {
  const items = parseBulkSpec(await readStdin());
  if (items.length === 0) throw new Error("--stdin: no issues in the plan.");
  const plan = await bulkUpdate(client, items, opts.apply === true);

  if (opts.json) {
    printJson(plan);
    return;
  }

  const actionable = plan.rows.filter((r) => r.uuid && !r.skipped);
  if (!plan.apply) {
    process.stdout.write(
      `[dry-run] ${actionable.length}/${plan.rows.length} issue(s) would update; re-run with --apply to write.\n`,
    );
    for (const r of plan.rows) {
      const fields = Object.keys(r.input).join(", ") || "—";
      process.stdout.write(`  ${r.ref}${r.skipped ? ` (skip: ${r.skipped})` : `  set: ${fields}`}\n`);
    }
    return;
  }

  const res = plan.result;
  process.stdout.write(`updated ${res?.succeeded ?? 0}/${plan.rows.length} issue(s).\n`);
  if (plan.unresolved.length) {
    process.stdout.write(`  not found: ${plan.unresolved.join(", ")}\n`);
  }
  if (res?.failed.length) {
    process.stdout.write(`  failed: ${res.failed.map((f) => `${f.ref} (${f.error})`).join("; ")}\n`);
  }
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
