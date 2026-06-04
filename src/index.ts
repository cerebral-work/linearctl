#!/usr/bin/env node
import { Command } from "commander";
import { whoami } from "./commands/whoami.js";
import { digest } from "./commands/digest.js";
import { file } from "./commands/file.js";
import { triage } from "./commands/triage.js";
import { milestone } from "./commands/milestone.js";
import { projectCreate, projectList } from "./commands/project.js";
import { update, close } from "./commands/update.js";
import { stale } from "./commands/stale.js";
import { xref } from "./commands/xref.js";
import { serve } from "./mcp/serve.js";

const program = new Command();

program
  .name("linearctl")
  .description(
    "Headless CLI for frequently ad-hocced Linear workflows (built on @linear/sdk).",
  )
  .version("0.1.0");

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
  .option("--json", "emit JSON")
  .action((opts) => digest(opts));

program
  .command("file")
  .description("Create a Linear issue from the CLI (headless / batch).")
  .argument("<title>", "issue title")
  .requiredOption("--team <key>", "team key (e.g. CER)")
  .option("--project <id>", "attach to a project")
  .option("--desc <markdown>", "description (markdown; '-' reads stdin)")
  .option("--label <name...>", "label(s) to attach")
  .option("--json", "emit JSON")
  .action((title, opts) => file(title, opts));

program
  .command("triage")
  .description("Surface issues needing triage: Triage state, or unassigned/unestimated/no-priority.")
  .option("--team <key...>", "restrict to team key(s) (e.g. CER); omit or 'all' for every team")
  .option("--json", "emit JSON")
  .action((opts) => triage(opts));

program
  .command("milestone")
  .description("Project / milestone progress (done vs open).")
  .option("--project <id>", "restrict to a project")
  .option("--json", "emit JSON")
  .action((opts) => milestone(opts));

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
  .description("Update an issue: state / assignee / labels / project / priority.")
  .argument("<id>", "issue id or identifier (e.g. CER-123)")
  .option("--state <name>", "workflow state name (e.g. 'In Progress')")
  .option("--assignee <who>", "assignee: 'me', an email, a display name, or a user id")
  .option("--label <name...>", "label(s) to set (replaces existing)")
  .option("--project <id>", "move to a project")
  .option("--priority <0-4>", "priority: 0=None 1=Urgent 2=High 3=Medium 4=Low")
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
  .option("--older-than <window>", "warn threshold (e.g. 30d, 2w)", "30d")
  .option("--label <name>", "label to add to stale issues (mutating; dry-run unless --apply)")
  .option("--apply", "actually write --label (default is a dry-run preview)")
  .option("--json", "emit JSON")
  .action((opts) => stale(opts));

program
  .command("xref")
  .description("Reconcile GitHub PRs <-> Linear tickets (read-only; needs `gh`).")
  .option("--repo <owner/repo>", "GitHub repo (default: current directory's repo)")
  .option("--team <key...>", "only count refs with these team-key prefix(es)")
  .option("--limit <n>", "how many merged PRs to scan", "50")
  .option("--json", "emit JSON")
  .action((opts) => xref(opts));

const mcpCmd = program
  .command("mcp")
  .description("Model Context Protocol server (for Claude Desktop / Claude Code).");

mcpCmd
  .command("serve")
  .description("Run the stdio MCP server exposing linearctl's tools.")
  .action(() => serve());

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? `error: ${err.message}` : err);
  process.exit(1);
});
