import { makeClient } from "../client.js";
import { updateIssue, closeIssue } from "../core/issues.js";
import { parseBulkSpec, bulkUpdate } from "../core/bulk.js";
import { readStdin } from "../lib/io.js";
import { printJson } from "../lib/output.js";
import { isInteractive } from "../lib/interactive.js";
import { promptText, promptSelect, promptConfirm, promptIssuePick } from "../lib/prompts.js";
import { withSpinner } from "../lib/spinner.js";
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
  title?: string;
  desc?: string;
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

  // `--desc -` reads stdin — resolve BEFORE the interactive trigger so a piped
  // body doesn't race the wizard's TTY check.
  const description = opts.desc === "-" ? await readStdin() : opts.desc;

  const hasMutation =
    opts.state !== undefined ||
    opts.assignee !== undefined ||
    opts.label !== undefined ||
    opts.project !== undefined ||
    opts.priority !== undefined ||
    opts.milestone !== undefined ||
    opts.title !== undefined ||
    description !== undefined;

  if (!hasMutation && isInteractive(opts.json)) {
    const proceed = await updateWizard(client, id, opts);
    if (!proceed) {
      process.stdout.write("aborted — nothing written.\n");
      return;
    }
  }

  const issue = await withSpinner(`Updating ${id}…`, () =>
    updateIssue(client, id, {
      state: opts.state,
      assignee: opts.assignee,
      labels: opts.label,
      projectId: opts.project,
      priority: opts.priority !== undefined ? Number(opts.priority) : undefined,
      milestone: opts.milestone,
      title: opts.title,
      description,
    }),
  );

  if (opts.json) {
    printJson(issue);
    return;
  }
  renderIssue(issue);
}

/**
 * Interactive wizard for `update <id>` with no mutation flags: pick a field,
 * pick a value, confirm — then the normal update path runs with the chosen
 * flag filled in. Returns false when the operator declines the confirm.
 * See docs/features/interactive.md (CER-1551).
 */
async function updateWizard(
  client: ReturnType<typeof makeClient>,
  id: string,
  opts: UpdateOptions,
): Promise<boolean> {
  const field = await promptSelect("Update what?", [
    { name: "state", value: "state" },
    { name: "assignee", value: "assignee" },
    { name: "priority", value: "priority" },
  ]);

  let summary: string;
  if (field === "state") {
    const issue = await client.issue(id);
    const team = await issue.team;
    if (!team) throw new Error(`${id}: could not resolve the issue's team.`);
    const states = await team.states({ first: 50 });
    opts.state = await promptSelect(
      "New state",
      states.nodes.map((s) => ({ name: s.name, value: s.name })),
    );
    summary = `set state → ${opts.state}`;
  } else if (field === "assignee") {
    opts.assignee = await promptText("Assignee ('me', an email, or a display name)");
    summary = `set assignee → ${opts.assignee}`;
  } else {
    opts.priority = await promptSelect("Priority", [
      { name: "1 — Urgent", value: "1" },
      { name: "2 — High", value: "2" },
      { name: "3 — Medium", value: "3" },
      { name: "4 — Low", value: "4" },
      { name: "0 — None", value: "0" },
    ]);
    summary = `set priority → ${opts.priority}`;
  }

  return promptConfirm(`${id}: ${summary}?`);
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
  team?: string[];
  json?: boolean;
}

/**
 * `linearctl close <id>` — move an issue to its team's completed state.
 * Delegates to `core.closeIssue`. At a TTY with no id, offers a fuzzy picker
 * plus a confirm gate (closing is the CLI's most consequential one-keystroke
 * write). A fully-specified `close CER-123` stays confirm-free — headless and
 * muscle-memory behavior unchanged. See docs/spec.md §6.8.
 */
export async function close(id: string | undefined, opts: CloseOptions): Promise<void> {
  const client = makeClient();
  if (!id && isInteractive(opts.json)) {
    id = await promptIssuePick(client, "Close which issue?", opts.team);
    if (!(await promptConfirm(`Close ${id}?`))) {
      process.stdout.write("aborted — nothing written.\n");
      return;
    }
  }
  if (!id) throw new Error("close needs an <id> (e.g. CER-123).");
  const issue = await withSpinner(`Closing ${id}…`, () => closeIssue(client, id));

  if (opts.json) {
    printJson(issue);
    return;
  }
  renderIssue(issue);
}
