import { resolveProject, UUID_RE } from "../core/projects.js";
import { makeClient } from "../client.js";
import { createIssue, addRelations } from "../core/issues.js";
import { readStdin, readStdinFor } from "../lib/io.js";
import { printJson } from "../lib/output.js";
import { isInteractive } from "../lib/interactive.js";
import { promptText, promptTeamKey, promptOptionalText } from "../lib/prompts.js";
import { withSpinner } from "../lib/spinner.js";
import { parsePriority } from "../lib/priority.js";
import { dupcheck } from "../core/dupcheck.js";
import { parseFileBatchSpec, batchFileIssues } from "../core/file-batch.js";
import { fetchRateLimit, isExhausted } from "../core/ratelimit.js";

export interface FileOptions {
  team?: string;
  project?: string;
  desc?: string;
  label?: string[];
  assignee?: string;
  priority?: string;
  milestone?: string;
  cycle?: string;
  parent?: string;
  blockedBy?: string[];
  relatedTo?: string[];
  checkDups?: boolean;
  force?: boolean;
  stdin?: boolean;
  apply?: boolean;
  json?: boolean;
}

/**
 * Batch path (`--stdin`): read a JSON-array/NDJSON plan of issues, dry-run by
 * default, `--apply` to create. Pre-flight quota gate aborts before a batch
 * can exhaust the window (spec §7 T6, CER-1141). Mirrors `update --stdin`.
 */
async function fileBatch(client: ReturnType<typeof makeClient>, opts: FileOptions): Promise<void> {
  const items = parseFileBatchSpec(await readStdin());
  if (items.length === 0) throw new Error("--stdin: no issues in the plan.");

  // Validate project refs in dry-run so the preview is a reliable predictor
  // of what --apply will do (CER-1604). A non-UUID project ref that can't be
  // resolved surfaces here, not mid-batch at apply time.
  const projectRefs = [...new Set(items.map((i) => i.project).filter(Boolean))] as string[];
  for (const ref of projectRefs) {
    if (!UUID_RE.test(ref)) {
      await resolveProject(client, ref); // throws if unresolvable
    }
  }
  if (!opts.apply) {
    if (opts.json) {
      printJson({ apply: false, count: items.length, items });
      return;
    }
    process.stdout.write(
      `[dry-run] would create ${items.length} issue(s); re-run with --apply to write.\n`,
    );
    for (const i of items) {
      process.stdout.write(`  [${i.team ?? opts.team ?? "??"}] ${i.title}\n`);
    }
    return;
  }

  const apiKey = process.env.LINEAR_API_KEY as string;
  const quota = await fetchRateLimit(apiKey).catch(() => null);
  if (quota && (isExhausted(quota) || (quota.requests.remaining ?? Infinity) < items.length * 3)) {
    throw new Error(
      `rate budget too low for a ${items.length}-issue batch ` +
        `(${quota.requests.remaining ?? "?"} requests remaining) — see \`linearctl ratelimit\`.`,
    );
  }

  const outcomes = await batchFileIssues(client, items, opts.team, (done, total) => {
    if (!opts.json) process.stderr.write(`\r\x1b[2K${done}/${total} created…`);
  });
  if (!opts.json) process.stderr.write("\r\x1b[2K");

  const ok = outcomes.filter((o) => o.created);
  const failed = outcomes.filter((o) => o.error);
  if (opts.json) {
    printJson({ apply: true, created: ok.length, failed: failed.length, outcomes });
    return;
  }
  process.stdout.write(`created ${ok.length}/${outcomes.length} issue(s).\n`);
  for (const o of ok) process.stdout.write(`  ${o.created!.identifier}  ${o.title}\n`);
  if (failed.length) {
    process.stdout.write(`failed ${failed.length}:\n`);
    for (const o of failed) process.stdout.write(`  ${o.title}: ${o.error}\n`);
  }
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

  if (opts.stdin) {
    await fileBatch(client, opts);
    return;
  }

  let description = opts.desc === "-" ? await readStdinFor("--desc -") : opts.desc;
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

  if (opts.checkDups && !opts.force) {
    const dups = await withSpinner("Checking for duplicates…", () =>
      dupcheck(client, issueTitle, { teamKeys: [teamKey] }),
    );
    if (dups.matches.length) {
      const lines = dups.matches
        .map((m) => `  ${m.identifier} (${m.score.toFixed(2)})  ${m.title}`)
        .join("\n");
      throw new Error(
        `${dups.matches.length} likely duplicate(s) found (use --force to file anyway):\n${lines}`,
      );
    }
  }

  const issue = await withSpinner("Creating issue…", () =>
    createIssue(client, {
      teamKey,
      title: issueTitle,
      description,
      projectId: opts.project,
      labels: opts.label,
      assignee: opts.assignee,
      priority: opts.priority !== undefined ? parsePriority(opts.priority) : undefined,
      milestone: opts.milestone,
      cycle: opts.cycle,
      parent: opts.parent,
    }),
  );
  if (opts.blockedBy?.length || opts.relatedTo?.length) {
    await withSpinner("Wiring relations…", () =>
      addRelations(client, issue.identifier, {
        blockedBy: opts.blockedBy,
        relatedTo: opts.relatedTo,
      }),
    );
  }

  if (opts.json) {
    printJson(issue);
    return;
  }

  process.stdout.write(
    `created ${issue.identifier}: ${issue.title}\n  url: ${issue.url}\n`,
  );
}
