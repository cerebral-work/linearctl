#!/usr/bin/env node
import { Command } from "commander";
import { whoami } from "./commands/whoami.js";
import { digest } from "./commands/digest.js";
import { file } from "./commands/file.js";
import { triage } from "./commands/triage.js";
import { milestone, milestoneDelete, milestoneCreate } from "./commands/milestone.js";
import { projectCreate, projectList, projectUpdate } from "./commands/project.js";
import { update, close } from "./commands/update.js";
import { comment } from "./commands/comment.js";
import { stale } from "./commands/stale.js";
import { xref } from "./commands/xref.js";
import { show } from "./commands/show.js";
import { searchCmd } from "./commands/search.js";
import { dupcheckCmd } from "./commands/dupcheck.js";
import { park } from "./commands/park.js";
import { labelList, labelCreate, labelRename } from "./commands/label.js";
import { historyCmd } from "./commands/history.js";
import { templateList, templateValidate, templateFile } from "./commands/template.js";
import { cycleCmd } from "./commands/cycle.js";
import { linkCmd } from "./commands/link.js";
import { commentsCmd } from "./commands/comments.js";
import { releaseNotesCmd } from "./commands/release-notes.js";
import { standup } from "./commands/standup.js";
import { ratelimit } from "./commands/ratelimit.js";
import { docGetOverview, docSetOverview, docList, docCreate, docUpdate } from "./commands/doc.js";
import { roadmap } from "./commands/roadmap.js";
import { serve } from "./mcp/serve.js";
import pkg from "../package.json";

const program = new Command();

program
  .name("linearctl")
  .description(
    "Headless CLI for frequently ad-hocced Linear workflows (built on @linear/sdk).",
  )
  .version(pkg.version);

program
  .command("whoami")
  .description("Resolve the authenticated viewer — the thin slice that proves auth works.")
  .option("--json", "emit JSON")
  .action((opts) => whoami(opts));

program
  .command("digest")
  .description('"What have we been up to": recent issue activity grouped by status.')
  .option("--since <window>", "look-back window (e.g. 7d, 24h, 2w)", "7d")
  .option("--team <key...>", "restrict to team key(s) (e.g. CER); omit or 'all' for every team")
  .option("--project <ref>", "restrict to a project (id or name)")
  .option("--json", "emit JSON")
  .action((opts) => digest(opts));

program
  .command("file")
  .description("Create a Linear issue from the CLI (headless / batch).")
  .argument("[title]", "issue title (prompted for at a TTY when omitted)")
  .option("--team <key>", "team key (e.g. CER; prompted for at a TTY when omitted)")
  .option("--project <id>", "attach to a project")
  .option("--desc <markdown>", "description (markdown; '-' reads stdin)")
  .option("--label <name...>", "label(s) to attach")
  .option("--assignee <who>", "assignee: 'me', an email, a display name, or a user id")
  .option("--priority <0-4|none>", "priority: 1=Urgent 2=High 3=Medium 4=Low, 0/none=unset")
  .option("--milestone <ref>", "project milestone (name or id; pair with --project for name lookup)")
  .option("--cycle <ref>", "cycle: a number, 'current'/'next', a cycle id, or 'none'")
  .option("--parent <id>", "create as a sub-issue of this issue (id or identifier)")
  .option("--blocked-by <id...>", "issue(s) that block this one")
  .option("--related-to <id...>", "issue(s) to link as related")
  .option("--check-dups", "refuse to create when a likely duplicate exists (see dupcheck)")
  .option("--force", "with --check-dups: file anyway")
  .option(
    "--stdin",
    "batch: read a JSON-array/NDJSON plan of {title,team?,desc?,labels?,project?,assignee?,priority?,milestone?,parent?} from stdin",
  )
  .option("--apply", "with --stdin: create the issues (default is a dry-run preview)")
  .option("--json", "emit JSON")
  .action((title, opts) => file(title, opts));

program
  .command("triage")
  .description("Surface issues needing triage: Triage state, or unassigned/unestimated/no-priority.")
  .option("--team <key...>", "restrict to team key(s) (e.g. CER); omit or 'all' for every team")
  .option("--project <ref>", "restrict to a project (id or name)")
  .option("--json", "emit JSON")
  .action((opts) => triage(opts));

const milestoneCmd = program
  .command("milestone")
  .description("Project / milestone progress (done vs open).")
  .option("--project <id>", "restrict to a project")
  .option("--json", "emit JSON")
  .action((opts) => milestone(opts));


milestoneCmd
  .command("create")
  .description("Create a project milestone.")
  .argument("<name>", "milestone name")
  .option("--target-date <YYYY-MM-DD>", "planned delivery date")
  .option("--desc <markdown|->", "milestone description (use '-' for stdin)")
  .action((name: string, opts: { targetDate?: string; desc?: string }, cmd: Command) => {
    const parentOpts = cmd.parent?.opts() ?? {};
    const project = parentOpts.project as string | undefined;
    const json = parentOpts.json as boolean | undefined;
    if (!project) throw new Error("milestone create needs --project <ref>.");
    return milestoneCreate(name, { project, json, ...opts });
  });
milestoneCmd
  .command("delete")
  .description("Delete a project milestone by id (dry-run unless --yes).")
  .argument("<id>", "milestone UUID (find via `milestone --json`)")
  .option("--yes", "perform the delete (default is a dry-run preview)")
  .option("--json", "emit JSON")
  .action((id, opts) => milestoneDelete(id, opts));

const projectCmd = program
  .command("project")
  .description("Create and list Linear projects (the dogfood-loop container for `file`).");

projectCmd
  .command("create")
  .description("Create a Linear project.")
  .argument("<name>", "project name")
  .requiredOption("--team <key>", "team key (e.g. CER)")
  .option("--desc <markdown>", "short description (markdown; '-' reads stdin)")
  .option("--json", "emit JSON")
  .action((name, opts) => projectCreate(name, opts));

projectCmd
  .command("list")
  .description("List projects (optionally restricted to a team).")
  .option("--team <key>", "restrict to a team key (e.g. CER)")
  .option("--json", "emit JSON")
  .action((opts) => projectList(opts));

projectCmd
  .command("update")
  .description("Update a project's state, name, or description.")
  .argument("<ref>", "project name or UUID")
  .option("--state <state>", "project state (backlog, planned, started, paused, completed, canceled)")
  .option("--name <name>", "rename the project")
  .option("--desc <markdown|->", "project description (use '-' for stdin)")
  .option("--json", "emit JSON")
  .action((ref: string, opts: { state?: string; name?: string; desc?: string; json?: boolean }) => projectUpdate(ref, opts));

program
  .command("roadmap")
  .description("View or export a project roadmap (milestone timeline).")
  .requiredOption("--project <ref>", "project name or UUID")
  .option("--json", "emit JSON")
  .action((opts: { project: string; json?: boolean }) => roadmap(opts));

program
  .command("update")
  .description("Update an issue (or bulk-update many via --stdin).")
  .argument("[id]", "issue id or identifier (e.g. CER-123); omit when using --stdin")
  .option("--state <name>", "workflow state name (e.g. 'In Progress')")
  .option("--assignee <who>", "assignee: 'me', an email, a display name, or a user id")
  .option("--label <name...>", "label(s) to set (replaces existing)")
  .option("--project <id>", "move to a project")
  .option("--priority <0-4>", "priority: 0=None 1=Urgent 2=High 3=Medium 4=Low")
  .option("--milestone <ref>", "project milestone (name or id)")
  .option("--cycle <ref>", "cycle: a number, 'current'/'next', a cycle id, or 'none' to remove")
  .option("--parent <id>", "re-parent under this issue (id or identifier)")
  .option("--blocked-by <id...>", "add issue(s) that block this one")
  .option("--related-to <id...>", "add issue(s) as related")
  .option("--title <text>", "replace the issue title")
  .option("--desc <markdown>", "replace the description (markdown; '-' reads stdin)")
  .option(
    "--stdin",
    "bulk: read a JSON-array/NDJSON plan of {id,labels?,addLabels?,priority?,project?,assignee?,milestone?} from stdin",
  )
  .option("--apply", "with --stdin: write changes (default is a dry-run preview)")
  .option("--json", "emit JSON")
  .action((id, opts) => update(id, opts));

program
  .command("close")
  .description("Close an issue (move it to the team's completed state).")
  .argument("[id]", "issue id or identifier (e.g. CER-123); fuzzy picker at a TTY when omitted")
  .option("--team <key...>", "scope the interactive picker to team key(s)")
  .option("--json", "emit JSON")
  .action((id, opts) => close(id, opts));

program
  .command("comment")
  .description("Add a comment to an issue (headless; non-destructive).")
  .argument("<id>", "issue id or identifier (e.g. CER-123)")
  .requiredOption("--body <markdown>", "comment body (markdown; '-' reads stdin)")
  .option("--json", "emit JSON")
  .action((id, opts) => comment(id, opts));

program
  .command("comments")
  .description("Recent comments by an author across issues — one query, not a per-issue sweep.")
  .option("--author <who>", "'me', an email, a display name, or a user id")
  .option("--since <window>", "look-back window (e.g. 7d, 24h)", "7d")
  .option("--team <key...>", "restrict to issues in team key(s)")
  .option("--limit <n>", "max comments", "200")
  .option("--json", "emit JSON")
  .action((opts) => commentsCmd(opts));

program
  .command("stale")
  .description("Sweep stale issues by last-update age (report-only; --label + --apply to relabel).")
  .option("--team <key...>", "restrict to team key(s) (e.g. CER); omit or 'all' for every team")
  .option("--project <ref>", "restrict to a project (id or name)")
  .option("--older-than <window>", "warn threshold (e.g. 30d, 2w)", "30d")
  .option("--label <name>", "label to add to stale issues (mutating; dry-run unless --apply)")
  .option("--apply", "actually write --label (default is a dry-run preview)")
  .option("--json", "emit JSON")
  .action((opts) => stale(opts));

program
  .command("xref")
  .description("Reconcile GitHub PRs <-> Linear tickets (read-only unless --fix --apply; needs `gh`).")
  .option("--repo <owner/repo>", "GitHub repo (default: current directory's repo)")
  .option("--team <key...>", "only count refs with these team-key prefix(es)")
  .option("--limit <n>", "how many merged PRs to scan", "50")
  .option("--fix", "plan ticket-state remediation from findings (close / start)")
  .option("--apply", "with --fix: execute the plan (default is a dry-run preview)")
  .option("--json", "emit JSON")
  .action((opts) => xref(opts));

const labelCmd = program
  .command("label")
  .description("Label management: list / create / rename (no delete — D6).");

labelCmd
  .command("list")
  .description("List labels for a team (or all teams). --counts adds per-label issue usage.")
  .option("--team <key...>", "restrict to team key(s); omit for all teams")
  .option("--counts", "aggregate per-label issue counts (one request per 100 issues)")
  .option("--json", "emit JSON")
  .action((opts) => labelList(opts));

labelCmd
  .command("create")
  .description("Create a team label (additive, non-destructive).")
  .argument("<name>", "label name")
  .option("--team <key>", "team key (e.g. CER)")
  .option("--color <hex>", "label color (e.g. #bec2c8)")
  .option("--json", "emit JSON")
  .action((name, opts) => labelCreate(name, opts));

labelCmd
  .command("rename")
  .description("Rename a team label (issues re-tag automatically; reversible).")
  .argument("<old>", "current label name")
  .argument("<new>", "new label name")
  .option("--team <key>", "team key (e.g. CER)")
  .option("--json", "emit JSON")
  .action((from, to, opts) => labelRename(from, to, opts));

program
  .command("park")
  .description("Park a user story straight into Backlog (collect, don't commit).")
  .argument("<title>", "story title")
  .option("--team <key>", "team key (e.g. CER)")
  .option("--project <id>", "attach to a project")
  .option("--persona <name>", "story persona ('As a <persona>…')")
  .option("--want <text>", "what the persona wants (defaults to the title)")
  .option("--why <text>", "the payoff ('so that …')")
  .option("--accept <md>", "acceptance criteria, one per line ('-' reads stdin)")
  .option("--label <name...>", "extra label(s) to attach (must exist)")
  .option("--json", "emit JSON")
  .action((title, opts) => park(title, opts));

program
  .command("dupcheck")
  .description("Surface likely duplicate issues for a candidate title (read-only).")
  .argument("<title>", "candidate issue title")
  .option("--team <key...>", "restrict to team key(s) (e.g. CER)")
  .option("--project <ref>", "restrict to a project (id or name)")
  .option("--threshold <0-1>", "minimum similarity score to report", "0.85")
  .option("--limit <n>", "max matches to report", "5")
  .option("--json", "emit JSON")
  .action((title, opts) => dupcheckCmd(title, opts));

program
  .command("search")
  .description("General issue query — the grep for Linear (active states by default).")
  .option("--team <key...>", "restrict to team key(s) (e.g. CER); omit or 'all' for every team")
  .option(
    "--state <ref>",
    "state type (triage|backlog|todo|started|done|canceled|all) or a state name; default: active only",
  )
  .option("--label <name...>", "label name(s) — all must match")
  .option("--assignee <who>", "'me', 'none' (unassigned), an email, a display name, or a user id")
  .option("--project <ref>", "restrict to a project (id or name)")
  .option("--priority <0-4|none>", "exact priority (1=Urgent … 4=Low, 0/none=unset)")
  .option("--text <query>", "full-text match over title + description")
  .option("--updated-since <window>", "updated within window (e.g. 7d, 24h)")
  .option("--created-since <window>", "created within window (e.g. 7d, 24h)")
  .option("--json", "emit JSON")
  .action((opts) => searchCmd(opts));

program
  .command("show")
  .description("Show one issue in full: metadata + description.")
  .argument("[id]", "issue id or identifier (e.g. CER-123); fuzzy picker at a TTY when omitted")
  .option("--team <key...>", "scope the interactive picker to team key(s)")
  .option("--json", "emit JSON")
  .action((id, opts) => show(id, opts));

program
  .command("standup")
  .description("Render the digest as a standup (markdown; no auto-posting — pipe to your sender).")
  .option("--team <key...>", "restrict to team key(s)")
  .option("--since <window>", "look-back window", "24h")
  .option("--json", "emit the underlying digest JSON")
  .action((opts) => standup(opts));

program
  .command("release-notes")
  .description("Markdown notes from issues completed in a range, grouped by label (read-only).")
  .option("--since <window|date>", "range start: window (7d) or ISO date (2026-07-01)", "7d")
  .option("--until <window|date>", "range end (default: now)")
  .option("--team <key...>", "restrict to team key(s)")
  .option("--project <ref>", "restrict to a project (id or name)")
  .option("--json", "emit JSON instead of markdown")
  .action((opts) => releaseNotesCmd(opts));

program
  .command("cycle")
  .description("Current-cycle review: scope, burn-down, at-risk, carry-over (read-only).")
  .option("--team <key>", "team key (must have cycles enabled)")
  .option("--previous", "review the last ended cycle instead of the active one")
  .option("--risk-window <days>", "flag unstarted issues when ≤ this many days remain", "2")
  .option("--json", "emit JSON")
  .action((opts) => cycleCmd(opts));

const templateCmd = program
  .command("template")
  .description("Reusable issue templates: .linearctl/templates + ~/.config/linearctl/templates.");

templateCmd
  .command("list")
  .description("List available templates (repo-local overrides user-global).")
  .option("--json", "emit JSON")
  .action((opts) => templateList(opts));

templateCmd
  .command("validate")
  .description("Parse a template and report its required/optional variables.")
  .argument("<name>", "template name")
  .option("--json", "emit JSON")
  .action((name, opts) => templateValidate(name, opts));

templateCmd
  .command("file")
  .description("File an issue from a template, substituting {{ variables }}.")
  .argument("<name>", "template name")
  .option("--team <key>", "team key (e.g. CER)")
  .option("--project <id>", "attach to a project")
  .option("--var <key=value...>", "template variable(s); value '-' reads stdin")
  .option("--json", "emit JSON")
  .action((name, opts) => templateFile(name, opts));

program
  .command("link")
  .description("Attach a URL to an issue (e.g. a PR) — creates a Linear attachment.")
  .argument("<id>", "issue id or identifier (e.g. CER-123)")
  .argument("<url>", "URL to attach")
  .option("--title <text>", "attachment title (defaults to the URL)")
  .option("--json", "emit JSON")
  .action((id, url, opts) => linkCmd(id, url, opts));

program
  .command("history")
  .description("Issue activity timeline: state/assignee/priority/label/comment events (read-only).")
  .argument("<id>", "issue id or identifier (e.g. CER-123)")
  .option("--limit <n>", "newest N events to show", "20")
  .option("--json", "emit JSON")
  .action((id, opts) => historyCmd(id, opts));

const docCmd = program
  .command("doc")
  .description("Project documents: read / write a project's overview (markdown).");

docCmd
  .command("list")
  .description("List documents (optionally scoped to a project).")
  .option("--project <ref>", "project (UUID, slug id, or name)")
  .option("--json", "emit JSON")
  .action((opts) => docList(opts));

docCmd
  .command("create")
  .description("Create a document under a project, issue, or team (exactly one).")
  .argument("<title>", "document title")
  .option("--project <ref>", "parent project (UUID, slug id, or name)")
  .option("--issue <id>", "parent issue (id or identifier)")
  .option("--team <key>", "parent team key")
  .option("--content <md>", "markdown body ('-' reads stdin)")
  .option("--json", "emit JSON")
  .action((title, opts) => docCreate(title, opts));

docCmd
  .command("update")
  .description("Update a document's content and/or title by id or slug.")
  .argument("<ref>", "document id or slug")
  .option("--content <md>", "replacement markdown body ('-' reads stdin)")
  .option("--title <text>", "replacement title")
  .option("--json", "emit JSON")
  .action((ref, opts) => docUpdate(ref, opts));

docCmd
  .command("get-overview")
  .description("Print a project's overview document (raw markdown; --json wraps it).")
  .requiredOption("--project <ref>", "project (UUID, slug id, or name)")
  .option("--json", "emit JSON")
  .action((opts) => docGetOverview(opts));

docCmd
  .command("set-overview")
  .description("Replace a project's overview document from a markdown file ('-' reads stdin).")
  .requiredOption("--project <ref>", "project (UUID, slug id, or name)")
  .requiredOption("--file <path>", "markdown file ('-' reads stdin)")
  .option("--json", "emit JSON")
  .action((opts) => docSetOverview(opts));

program
  .command("ratelimit")
  .description("Probe Linear API quota: remaining budget + reset time (exit 2 when exhausted).")
  .option("--json", "emit JSON")
  .action((opts) => ratelimit(opts));

const mcpCmd = program
  .command("mcp")
  .description("Model Context Protocol server (for Claude Desktop / Claude Code).");

mcpCmd
  .command("serve")
  .description("Run the stdio MCP server exposing linearctl's tools.")
  .action(() => serve());

program.parseAsync().catch((err: unknown) => {
  // Ctrl-C inside an @inquirer prompt: exit quietly like any cancelled command.
  if (err instanceof Error && err.name === "ExitPromptError") {
    process.exit(130);
  }
  console.error(err instanceof Error ? `error: ${err.message}` : err);
  process.exit(1);
});
