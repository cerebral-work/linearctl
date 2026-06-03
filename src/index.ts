#!/usr/bin/env node
import { Command } from "commander";
import { whoami } from "./commands/whoami.js";
import { digest } from "./commands/digest.js";
import { file } from "./commands/file.js";
import { triage } from "./commands/triage.js";
import { milestone } from "./commands/milestone.js";

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
  .option("--team <key>", "restrict to a team key (e.g. CER)")
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
  .description("Surface issues needing triage: in Triage state, or unassigned/unestimated.")
  .requiredOption("--team <key>", "team key (e.g. CER)")
  .option("--json", "emit JSON")
  .action((opts) => triage(opts));

program
  .command("milestone")
  .description("Project / milestone progress (done vs open).")
  .option("--project <id>", "restrict to a project")
  .option("--json", "emit JSON")
  .action((opts) => milestone(opts));

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? `error: ${err.message}` : err);
  process.exit(1);
});
