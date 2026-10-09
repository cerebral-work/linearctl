import { makeClient } from "../client.js";
import { resolveTeamByKey } from "../core/teams.js";
import { isInteractive } from "./interactive.js";
import { closestCommand } from "./closest.js";
import { Command, CommanderError, Help } from "commander";
import { EXAMPLES, exampleHint } from "./examples.js";
import { printCliError, usageError, refusedError } from "./errors.js";

export const EXIT_HELP = "Exit codes: 0 ok · 2 usage · 3 auth · 4 not found · 5 rate limited · 6 refused · 1 other.";

/** Install after registering commands, including children already constructed. */
export function configureCli(program: Command) {
  let active = program;
  let diagnostic = "";
  const configure = (command: Command) => {
    command.showSuggestionAfterError(true).allowExcessArguments(false);
    command.configureOutput({ writeErr: str => { diagnostic += str; } });
    command.exitOverride(err => { active = command; throw err; });
    // Commander processes help before unknown commands. Validate the command
    // operand before rendering help so `bogus --help` cannot look successful.
    command.configureHelp({ formatHelp(cmd, helper) {
      const operand = cmd.args.find(arg => !arg.startsWith("-"));
      if (cmd.commands.length && !cmd.registeredArguments.length && operand &&
          !cmd.commands.some(child => child.name() === operand || child.aliases().includes(operand))) {
        active = cmd;
        const suggestion = closestCommand(operand, cmd.commands.map(child => child.name()));
        throw usageError(`unknown command '${operand}'${suggestion ? ` (Did you mean ${suggestion}?)` : ""}`);
      }
      return Help.prototype.formatHelp.call(helper, cmd, helper);
    } });
    command.hook("preAction", async (_thisCommand, actionCommand) => {
      active = actionCommand;
      // Root hook runs once per invocation, before an API call can mask usage errors.
      if (command !== program) return;
      const opts = actionCommand.optsWithGlobals();
      const name = actionCommand.name();
      if (!isInteractive(opts.json)) {
        if (["show", "close", "update", "file", "relate"].includes(name) && !actionCommand.args[0] && !opts.stdin)
          throw usageError(`${name} needs ${name === "file" ? "a <title>" : "an <id>"}${["file", "update"].includes(name) ? " or --stdin" : ""}.`);
        if (name === "file" && !opts.stdin && !opts.team) throw usageError("file needs --team <key>.");
      }
      // Queries otherwise silently return [] for a mistyped team key.
      if (opts.team) {
        const keys: string[] = Array.isArray(opts.team) ? opts.team : [opts.team];
        for (const key of keys) if (key.toLowerCase() !== "all") await resolveTeamByKey(makeClient(), key);
      }
    });
    for (const child of command.commands) configure(child);
  };
  configure(program);
  program.hook("postAction", (_command, action) => {
    const opts = action.optsWithGlobals();
    const name = action.name();
    const parent = action.parent?.name();
    const guarded = (["file", "update"].includes(name) && opts.stdin) ||
      (name === "stale" && opts.label) || (name === "xref" && opts.fix) ||
      (parent === "milestone" && name === "update");
    if (guarded && !opts.apply) throw refusedError("Dry-run only; no changes written.", "Review the preview on stdout; re-run with --apply to write.");
    if (parent === "milestone" && name === "delete" && !opts.yes)
      throw refusedError("Dry-run only; milestone was not deleted.", "Review the preview; re-run with --yes to delete.");
  });
  program.addHelpText("after", `\n${EXIT_HELP}\nExamples: linearctl examples [command]`);
  return async (argv = process.argv) => {
    try { await program.parseAsync(argv); }
    catch (err) {
      if (err instanceof CommanderError && err.exitCode === 0) return;
      if (err instanceof Error && err.name === "ExitPromptError") { process.exitCode = 130; return; }
      const names: string[] = [];
      for (let cmd: Command | null = active; cmd?.parent; cmd = cmd.parent) names.unshift(cmd.name());
      const top = names[0];
      const form = top ? `Form: linearctl ${names.join(" ")} ${active.usage()}. ` : "";
      const example = names.length > 1 ? subcommandExample(active, names) : exampleHint(top ?? "");
      let fallback = top ? `${form}Example: ${example}; linearctl examples ${top}` : "Example: linearctl examples; linearctl --help";
      const failure = err instanceof CommanderError ? usageError((diagnostic || err.message).trim().replace(/^error: /, "")) : err;
      const message = failure instanceof Error ? failure.message : String(failure);
      const unknown = message.match(/unknown command '([^']+)'/);
      if (unknown) {
        const suggestion = closestCommand(unknown[1], active.commands.map(child => child.name()));
        fallback = suggestion
          ? `Example: linearctl ${[...names, suggestion].join(" ")} --help; linearctl examples ${top ?? suggestion}`
          : "Example: linearctl examples; linearctl --help";
      }
      if (top === "comment") fallback = "Comment text is not positional; use --body - to read stdin. " + fallback;
      if (message.includes("unknown option '--json'") && active === program)
        fallback = "Place --json after the subcommand, e.g. linearctl whoami --json. " + fallback;
      // Only flags before -- are options; a literal body containing --json is not one.
      const args = argv.slice(2);
      const end = args.indexOf("--");
      process.exitCode = printCliError(failure, (end < 0 ? args : args.slice(0, end)).includes("--json"), fallback);
    }
  };
}

export function addExamples(program: Command) {
  program.command("examples")
    .description("Print runnable shell examples embedded in this binary.")
    .argument("[command]", "command name; omit for all examples")
    .action((command?: string) => {
      if (command && !EXAMPLES[command]) throw usageError(`unknown examples command ${JSON.stringify(command)}.`, `Available: ${Object.keys(EXAMPLES).join(", ")}.`);
      const examples = command ? [[command, EXAMPLES[command]]] : Object.entries(EXAMPLES);
      for (const [name, script] of examples) process.stdout.write(`# --- ${name} ---\n${script}\n`);
    });
}

function subcommandExample(command: Command, names: string[]): string {
  const explicit: Record<string, string> = {
    "project update": "linearctl project update 'Example project' --state started --json",
    "milestone create": "linearctl milestone create 'Launch' --project 'Example project' --json",
    "milestone update": "linearctl milestone update 00000000-0000-4000-8000-000000000001 --name Launch --json",
    "milestone delete": "linearctl milestone delete 00000000-0000-4000-8000-000000000001 --json",
    "doc create": "linearctl doc create 'Runbook' --team ENG --content 'Setup instructions' --json",
    "doc update": "linearctl doc update 00000000-0000-4000-8000-000000000001 --content 'Setup instructions' --json",
    "handoff create": "linearctl handoff create --title 'Next steps' --body 'Run the checks' --json",
    "label create": "linearctl label create bug --team ENG --json",
    "label rename": "linearctl label rename bug defect --team ENG --json",
    "template file": "linearctl template file example --team ENG --json",
  };
  if (explicit[names.join(" ")]) return explicit[names.join(" ")];
  const values: Record<string, string> = { id: "ENG-123", ref: "'Example project'", name: "'Example name'", old: "bug", new: "defect", file: "body.md", path: "body.md", text: "'Example title'" };
  const args = command.registeredArguments.filter(a => a.required).map(a => values[a.name()] ?? "example");
  const options = command.options.filter(o => o.mandatory).map(o => `${o.long} ${o.long === "--team" ? "ENG" : o.long === "--project" ? "'Example project'" : o.long === "--file" ? "body.md" : "'Example text'"}`);
  return ["linearctl", ...names, ...args, ...options].join(" ");
}
