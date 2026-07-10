#!/usr/bin/env node
import { Command } from "commander";
import { whoami } from "./commands/whoami.js";
import { digest } from "./commands/digest.js";
import { file } from "./commands/file.js";
import { triage } from "./commands/triage.js";
import { milestone, milestoneDelete } from "./commands/milestone.js";
import { projectCreate, projectList } from "./commands/project.js";
import { update, close } from "./commands/update.js";
import { stale } from "./commands/stale.js";
import { xref } from "./commands/xref.js";
import { show } from "./commands/show.js";
import { ratelimit } from "./commands/ratelimit.js";
import { docGetOverview, docSetOverview } from "./commands/doc.js";
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
  .argument("<id>", "issue id or identifier (e.g. CER-123)")
  .option("--json", "emit JSON")
  .action((id, opts) => close(id, opts));

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

program
  .command("show")
  .description("Show one issue in full: metadata + description.")
  .argument("<id>", "issue id or identifier (e.g. CER-123)")
  .option("--json", "emit JSON")
  .action((id, opts) => show(id, opts));

const docCmd = program
  .command("doc")
  .description("Project documents: read / write a project's overview (markdown).");

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
