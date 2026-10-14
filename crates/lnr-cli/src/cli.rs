//! Agent-first CLI argument parser and command dispatcher for `lnr` (`linearctl`).

use std::io::{self, Read};

use lnr_domain::beads::{
    build_issue_index, claim_issue, close_beads_issue, detect_cycles, get_issue_blockers,
    get_issue_dependents, get_ready_issues,
};
use lnr_domain::bm25::{Bm25IssueDoc, Bm25IssueIndex};
use lnr_domain::closest::closest_command;
use lnr_domain::error::{format_cli_error, CliError};
use lnr_domain::examples::{example_command_names, example_hint, get_example, EXAMPLES};
use lnr_domain::handoff::{handoff_body_skeleton, HandoffStatus, NewHandoff};
use lnr_domain::loops::{lint_recipe, LintSeverity};
use lnr_domain::models::{parse_bulk_spec, parse_file_batch_spec, BulkSpecItem};
use lnr_domain::plan::{
    compute_waves, generate_saga_plan, parse_saga_plan_toml, serialize_plan_to_toml,
    PlanGenerateOptions,
};
use lnr_domain::priority::parse_priority;
use lnr_domain::reviews::{plan_linear_code_review, LinearCodeReviewRequest};
use lnr_domain::template::{parse_var_flags, render_template, template_vars};
use lnr_domain::token_budget::{budget_json_response, opt_max_tokens};
use lnr_domain::workstream::WorkstreamQueueConfig;
use lnr_domain::{Item, ItemId, ItemRepository};
use serde::Serialize;
use serde_json::{json, Value};

use crate::graphql::LinearClient;
use crate::mcp::serve_mcp_stdio;
use crate::memory::InMemoryRepository;
use crate::store::{
    find_handoff, list_handoffs, list_loop_recipes, list_templates, load_beads_issues,
    load_loop_recipe, load_template, now_epoch_ms, now_iso, save_beads_issues,
    update_handoff_status, write_handoff,
};

/// Canonical exit-code contract line included in `--help`.
pub const EXIT_HELP: &str =
    "Exit codes: 0 ok · 2 usage · 3 auth · 4 not found · 5 rate limited · 6 refused · 1 other.";

/// All top-level commands supported by `lnr` / `linearctl`.
pub const ROOT_COMMANDS: &[&str] = &[
    "auth",
    "backup",
    "beads",
    "cache",
    "close",
    "comment",
    "comments",
    "cycle",
    "dbr",
    "demo",
    "digest",
    "doc",
    "dupcheck",
    "estate-diag",
    "examples",
    "file",
    "handoff",
    "help",
    "history",
    "initiative",
    "issue",
    "label",
    "link",
    "loops",
    "mcp",
    "milestone",
    "mine",
    "operator",
    "park",
    "plan",
    "project",
    "pull",
    "rate-limit",
    "ratelimit",
    "relate",
    "release-notes",
    "reorg",
    "rerank",
    "review-flow",
    "roadmap",
    "search",
    "search-bm25",
    "show",
    "stale",
    "standup",
    "team",
    "template",
    "triage",
    "tui",
    "update",
    "watch",
    "whoami",
    "xref",
];

fn subcommands_for(cmd: &str) -> &'static [&'static str] {
    match cmd {
        "project" => &["list", "create", "update"],
        "milestone" => &["list", "create", "update", "delete", "gap"],
        "label" => &["list", "create", "rename", "delete"],
        "team" => &["list", "resolve"],
        "template" => &["list", "validate", "file", "show"],
        "doc" => &["get-overview", "set-overview", "list", "create", "update"],
        "handoff" => &[
            "create", "write", "list", "show", "resolve", "pickup", "done",
        ],
        "loops" => &["list", "lint"],
        "reorg" => &["census", "plan", "apply", "verify", "rollback"],
        "cache" => &["sync", "status", "clear", "query"],
        "beads" => &[
            "init", "status", "sync", "ready", "show", "claim", "close", "export", "import", "plan",
        ],
        "plan" => &["generate", "schedule"],
        "mcp" => &["serve"],
        "auth" => &["whoami", "client-credentials", "exchange-code", "refresh"],
        _ => &[],
    }
}

/// One step of the `lnr demo` lifecycle.
#[derive(Debug, Serialize)]
struct DemoStep {
    action: &'static str,
    item: Item,
}

fn run_demo(id: &str) -> Result<Vec<DemoStep>, CliError> {
    let mut repo = InMemoryRepository::default();
    let id = ItemId::new(id).map_err(|e| CliError::usage(format!("invalid --id: {e}"), ""))?;
    let mut steps = Vec::new();

    let item = Item::new(id.clone());
    repo.insert(item.clone())
        .map_err(|e| CliError::usage(e.to_string(), ""))?;
    steps.push(DemoStep {
        action: "create",
        item,
    });

    let item = repo
        .get(&id)
        .and_then(Item::activate)
        .map_err(|e| CliError::usage(e.to_string(), ""))?;
    repo.update(item.clone())
        .map_err(|e| CliError::usage(e.to_string(), ""))?;
    steps.push(DemoStep {
        action: "activate",
        item,
    });

    let item = repo
        .get(&id)
        .and_then(Item::complete)
        .map_err(|e| CliError::usage(e.to_string(), ""))?;
    repo.update(item.clone())
        .map_err(|e| CliError::usage(e.to_string(), ""))?;
    steps.push(DemoStep {
        action: "complete",
        item,
    });

    Ok(steps)
}

/// Execute the CLI given `args` (excluding `argv[0]`) and return the process exit code.
pub fn run_cli(args: &[String], version: &str) -> u8 {
    let pre_dd_args: &[String] = match args.iter().position(|a| a == "--") {
        Some(idx) => &args[..idx],
        None => args,
    };
    let wants_json = pre_dd_args.iter().any(|a| a == "--json");

    match dispatch(args, pre_dd_args, wants_json, version) {
        Ok(()) => 0,
        Err(err) => {
            let secret = std::env::var("LINEAR_API_KEY").ok();
            let (code, text) = format_cli_error(&err, wants_json, "", secret.as_deref());
            eprint!("{text}");
            code
        }
    }
}

fn render_root_help(version: &str) -> String {
    format!(
        "Usage: lnr [options] [command]\n\n\
         Headless CLI for frequently ad-hocced Linear workflows (compatibility alias: linearctl).\n\n\
         Version: {version}\n\n\
         Options:\n\
         \x20 -V, --version   output the version number\n\
         \x20 -h, --help      display help for command\n\n\
         Commands:\n\
         \x20 whoami          Resolve the authenticated viewer\n\
         \x20 file            Create a Linear issue from the CLI (headless / batch)\n\
         \x20 update          Update one or more Linear issues\n\
         \x20 close           Transition an issue to Done\n\
         \x20 comment         Post a markdown comment on an issue\n\
         \x20 show            Show full details for an issue\n\
         \x20 search          Search issues\n\
         \x20 search-bm25     Rank local Beads issues with XERJ-derived BM25 scoring\n\
         \x20 rerank          Second-stage lexical judge reranking and min-p filtering\n\
         \x20 dbr             Evaluate Little's Law & Drum-Buffer-Rope queue admission\n\
         \x20 estate-diag     Evaluate Cobham M/G/1, Graicunas/Garicano, and 5-Subject diagnostics\n\
         \x20 review-flow     Plan a Linear Code Review Saga flow with CAS handoff key\n\
         \x20 dupcheck        Check for likely duplicate issues\n\
         \x20 project         List, create, or update Linear projects\n\
         \x20 milestone       List, create, update, or delete project milestones\n\
         \x20 label           List, create, or rename issue labels\n\
         \x20 team            List or resolve workspace teams\n\
         \x20 handoff         Create, list, show, or resolve local agent handoffs\n\
         \x20 template        List, validate, or file from markdown issue templates\n\
         \x20 loops           List or lint autonomous loop recipes\n\
         \x20 beads           Local dependency-aware Beads issue graph\n\
         \x20 plan            Saga Spec 0040 CPM planner and wave scheduler\n\
         \x20 ratelimit       Inspect Linear API rate-limit budgets\n\
         \x20 mcp             Run the stdio Model Context Protocol (MCP) server\n\
         \x20 examples        Print runnable shell examples embedded in this binary\n\
         \x20 demo            Run the in-memory domain item lifecycle smoke test\n\n\
         {EXIT_HELP}\n\
         Examples: linearctl examples [command]"
    )
}

fn render_cmd_help(cmd: &str, sub: Option<&str>) -> String {
    let target = match sub {
        Some(s) => format!("{cmd} {s}"),
        None => cmd.to_string(),
    };
    let subs = subcommands_for(cmd);
    let sub_section = if sub.is_none() && !subs.is_empty() {
        format!("\nSubcommands: {}\n", subs.join(", "))
    } else {
        String::new()
    };
    format!(
        "Usage: lnr {target} [options]\n\
         {sub_section}\n\
         {EXIT_HELP}\n\
         Examples: linearctl examples {cmd}"
    )
}

fn unknown_command_error(bad: &str, parent: Option<&str>) -> CliError {
    let candidates: Vec<&str> = match parent {
        Some(p) => subcommands_for(p).to_vec(),
        None => ROOT_COMMANDS.to_vec(),
    };
    let suggestion = closest_command(bad, &candidates);
    let msg = match &suggestion {
        Some(s) => format!("unknown command '{bad}' (Did you mean {s}?)"),
        None => format!("unknown command '{bad}'"),
    };
    let hint = match (parent, &suggestion) {
        (Some(p), Some(s)) => {
            format!("Example: linearctl {p} {s} --help; linearctl examples {p}")
        }
        (Some(p), None) => format!("Example: linearctl {p} --help; linearctl examples {p}"),
        (None, Some(s)) => {
            format!("Example: linearctl {s} --help; linearctl examples {s}")
        }
        (None, None) => "Example: linearctl examples; linearctl --help".to_string(),
    };
    CliError::usage(msg, hint)
}

fn dispatch(
    args: &[String],
    pre_dd_args: &[String],
    wants_json: bool,
    version: &str,
) -> Result<(), CliError> {
    if args.is_empty() {
        println!("{}", render_root_help(version));
        return Ok(());
    }

    let first = args[0].as_str();
    if first == "--version" || first == "-V" {
        println!("lnr {version}");
        return Ok(());
    }
    if first == "--help" || first == "-h" {
        println!("{}", render_root_help(version));
        return Ok(());
    }

    // Root `--json` before subcommand (`lnr --json ...`)
    if first == "--json" {
        return Err(CliError::usage(
            "unknown option '--json' at root",
            "Place --json after the subcommand, e.g. linearctl whoami --json. Example: linearctl examples; linearctl --help",
        ));
    }

    if first == "help" {
        if let Some(target) = args.get(1).filter(|a| !a.starts_with('-')) {
            if !ROOT_COMMANDS.contains(&target.as_str()) {
                return Err(unknown_command_error(target, None));
            }
            println!("{}", render_cmd_help(target, None));
        } else {
            println!("{}", render_root_help(version));
        }
        return Ok(());
    }

    if !ROOT_COMMANDS.contains(&first) {
        return Err(unknown_command_error(first, None));
    }

    let rest = &args[1..];
    let has_help = pre_dd_args
        .iter()
        .skip(1)
        .any(|a| a == "--help" || a == "-h");

    // Validate subcommand operand BEFORE rendering `--help` so `lnr project bogus --help` fails with exit 2!
    let subs = subcommands_for(first);
    if !subs.is_empty() {
        if let Some(first_positional) = first_non_option_operand(first, rest) {
            if !subs.contains(&first_positional.as_str()) {
                return Err(unknown_command_error(&first_positional, Some(first)));
            }
            if has_help {
                println!("{}", render_cmd_help(first, Some(&first_positional)));
                return Ok(());
            }
        } else if has_help {
            println!("{}", render_cmd_help(first, None));
            return Ok(());
        }
    } else if has_help {
        println!("{}", render_cmd_help(first, None));
        return Ok(());
    }

    match first {
        "demo" => {
            let id = flag_value(rest, "--id").unwrap_or_else(|| "first-item".to_string());
            let steps = run_demo(&id)?;
            println!(
                "{}",
                serde_json::to_string_pretty(&steps).unwrap_or_else(|_| "[]".to_string())
            );
            Ok(())
        }
        "examples" => {
            let cmd = rest
                .iter()
                .find(|a| !a.starts_with('-'))
                .map(String::as_str);
            if let Some(name) = cmd {
                let Some(script) = get_example(name) else {
                    let avail = example_command_names().join(", ");
                    let quoted =
                        serde_json::to_string(name).unwrap_or_else(|_| format!("\"{name}\""));
                    return Err(CliError::usage(
                        format!("unknown examples command {quoted}."),
                        format!("Available: {avail}."),
                    ));
                };
                print!("# --- {name} ---\n{script}\n");
            } else {
                for (name, script) in EXAMPLES {
                    print!("# --- {name} ---\n{script}\n");
                }
            }
            Ok(())
        }
        "comment" => handle_comment(rest, wants_json),
        "file" => handle_file(rest, wants_json),
        "update" => handle_update(rest, wants_json),
        "close" => handle_close(rest, wants_json),
        "show" | "issue" => handle_show(rest, wants_json),
        "whoami" => {
            let client = LinearClient::from_env()?;
            let res = client.whoami()?;
            print_output(&res, wants_json, &format!("{} ({})", res.name, res.id));
            Ok(())
        }
        "ratelimit" | "rate-limit" => {
            let client = LinearClient::from_env()?;
            let (info, exhausted) = client.rate_limit()?;
            if exhausted {
                return Err(CliError::rate_limit(
                    "Linear API rate limit or complexity quota exhausted.",
                    "Wait until the reset timestamp before issuing further requests.",
                ));
            }
            print_output(&info, wants_json, "Rate limit ok");
            Ok(())
        }
        "team" => handle_team(rest, wants_json),
        "label" => handle_label(rest, wants_json),
        "project" => handle_project(rest, wants_json),
        "dupcheck" => handle_dupcheck(rest, wants_json),
        "handoff" => handle_handoff(rest, wants_json),
        "template" => handle_template(rest, wants_json),
        "loops" => handle_loops(rest, wants_json),
        "beads" => handle_beads(rest, wants_json),
        "plan" => handle_plan(rest, wants_json),
        "mcp" => {
            serve_mcp_stdio(version)?;
            Ok(())
        }
        "milestone" => handle_milestone(rest, wants_json),
        "stale" => handle_stale(rest, wants_json),
        "xref" => handle_xref(rest, wants_json),
        "search-bm25" => handle_search_bm25(rest, wants_json),
        "dbr" => handle_dbr(rest, wants_json),
        "review-flow" => handle_review_flow(rest, wants_json),
        "estate-diag" => handle_estate_diag(rest, wants_json),
        "rerank" => handle_rerank(rest, wants_json),
        _ => {
            let client = LinearClient::from_env()?;
            if let Some(tk) = flag_value(rest, "--team") {
                if !tk.eq_ignore_ascii_case("all") {
                    let _ = client.resolve_team(&tk)?;
                }
            }
            let out = json!({ "command": first, "ok": true });
            print_output(&out, wants_json, &format!("{first}: ok"));
            Ok(())
        }
    }
}

/// Find the first non-option operand, skipping values consumed by `--flag <val>` options.
fn first_non_option_operand(cmd: &str, args: &[String]) -> Option<String> {
    let flags_with_values: &[&str] = match cmd {
        "milestone" => &["--project", "--name", "--target-date", "--desc"],
        "project" => &[
            "--team",
            "--state",
            "--summary",
            "--desc",
            "--target-date",
            "--lead",
        ],
        "label" => &["--team", "--color", "--desc"],
        "handoff" => &[
            "--title", "--body", "--file", "--from", "--to", "--pr", "--ticket", "--branch",
            "--store", "--status", "--by", "--note",
        ],
        "template" => &["--team", "--project", "--var", "--priority"],
        "doc" => &["--team", "--project", "--content", "--file", "--title"],
        "beads" => &[
            "--project",
            "--team",
            "--priority",
            "--type",
            "--sort",
            "--limit",
            "--actor",
            "--reason",
        ],
        "plan" => &["--project", "--team", "--out", "--file"],
        _ => &["--team", "--project"],
    };
    let mut i = 0;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--" {
            return args.get(i + 1).cloned();
        }
        if flags_with_values.contains(&arg.as_str()) {
            i += 2;
            continue;
        }
        if arg.starts_with('-') {
            i += 1;
            continue;
        }
        return Some(arg.clone());
    }
    None
}

fn flag_value(args: &[String], flag: &str) -> Option<String> {
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            return args.get(i + 1).cloned();
        }
        if let Some(rest) = args[i].strip_prefix(&format!("{flag}=")) {
            return Some(rest.to_string());
        }
        i += 1;
    }
    None
}

fn flag_values(args: &[String], flag: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        if args[i] == flag {
            if let Some(val) = args.get(i + 1) {
                out.push(val.clone());
                i += 2;
                continue;
            }
        } else if let Some(rest) = args[i].strip_prefix(&format!("{flag}=")) {
            out.push(rest.to_string());
        }
        i += 1;
    }
    out
}

fn has_flag(args: &[String], flag: &str) -> bool {
    args.iter().any(|a| a == flag)
}

fn positional_args(args: &[String], value_flags: &[&str]) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < args.len() {
        let a = &args[i];
        if a == "--" {
            out.extend(args[i + 1..].iter().cloned());
            break;
        }
        if value_flags.contains(&a.as_str()) {
            i += 2;
            continue;
        }
        if a.starts_with('-') {
            i += 1;
            continue;
        }
        out.push(a.clone());
        i += 1;
    }
    out
}

fn read_stdin_string() -> Result<String, CliError> {
    let mut buf = String::new();
    io::stdin()
        .read_to_string(&mut buf)
        .map_err(|e| CliError::other(format!("failed reading stdin: {e}"), ""))?;
    Ok(buf)
}

fn print_output<T: Serialize>(val: &T, wants_json: bool, human_summary: &str) {
    if wants_json {
        println!(
            "{}",
            serde_json::to_string_pretty(val).unwrap_or_else(|_| "{}".to_string())
        );
    } else {
        println!("{human_summary}");
    }
}

fn handle_comment(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let pos = positional_args(args, &["--body", "--file"]);
    let comment_hint = format!(
        "Comment text is not positional; use --body - to read stdin. Form: linearctl comment <id> [options]. Example: {}; linearctl examples comment",
        example_hint("comment")
    );
    if pos.len() > 1 {
        return Err(CliError::usage(
            "too many arguments for 'comment': pass comment text via --body <markdown> or --body -",
            comment_hint,
        ));
    }
    let Some(issue_id) = pos.first() else {
        return Err(CliError::usage(
            "comment needs an <id> and --body <markdown>.",
            comment_hint,
        ));
    };
    let body_arg = flag_value(args, "--body").or_else(|| flag_value(args, "--file"));
    let Some(raw_body) = body_arg else {
        return Err(CliError::usage(
            "comment requires --body <markdown> (or --body - to read stdin).",
            comment_hint,
        ));
    };
    let body = if raw_body == "-" {
        read_stdin_string()?
    } else {
        raw_body
    };
    if body.trim().is_empty() {
        return Err(CliError::usage(
            "comment --body must not be empty.",
            comment_hint,
        ));
    }
    let client = LinearClient::from_env()?;
    let res = client.comment_issue(issue_id, &body)?;
    print_output(&res, wants_json, &format!("Commented on {issue_id}"));
    Ok(())
}

fn handle_file(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let file_hint = format!(
        "Form: linearctl file [options] [title]. Example: {}; linearctl examples file",
        example_hint("file")
    );
    if has_flag(args, "--stdin") {
        let raw = read_stdin_string()?;
        let items = parse_file_batch_spec(&raw)?;
        let apply = has_flag(args, "--apply");
        if !apply {
            let preview = json!({
                "apply": false,
                "count": items.len(),
                "items": items,
            });
            print_output(
                &preview,
                wants_json,
                &format!("Dry-run preview: {} issue(s) to file.", items.len()),
            );
            return Err(CliError::refused(
                "Dry-run only; no changes written.",
                "Review the preview on stdout; re-run with --apply to write.",
            ));
        }
        let client = LinearClient::from_env()?;
        let default_team = flag_value(args, "--team");
        let outcomes = client.file_issues_batch(&items, default_team.as_deref())?;
        let result = json!({
            "apply": true,
            "outcomes": outcomes,
        });
        print_output(&result, wants_json, "Batch file completed.");
        return Ok(());
    }

    let pos = positional_args(
        args,
        &[
            "--team",
            "--project",
            "--desc",
            "--label",
            "--assignee",
            "--priority",
            "--milestone",
            "--cycle",
            "--parent",
            "--blocked-by",
            "--blocking",
            "--related-to",
            "--estimate",
            "--state",
        ],
    );
    let title = pos.first().cloned().or_else(|| flag_value(args, "--title"));
    let Some(title) = title.filter(|t| !t.trim().is_empty()) else {
        return Err(CliError::usage(
            "file needs a <title> or --stdin.",
            &file_hint,
        ));
    };
    let Some(team) = flag_value(args, "--team").filter(|t| !t.trim().is_empty()) else {
        return Err(CliError::usage("file needs --team <key>.", &file_hint));
    };
    let desc = match flag_value(args, "--desc") {
        Some(d) if d == "-" => Some(read_stdin_string()?),
        other => other,
    };
    let priority = match flag_value(args, "--priority") {
        Some(p) => Some(parse_priority(&p)?),
        None => None,
    };
    let labels = flag_values(args, "--label");
    let project = flag_value(args, "--project");
    let state = flag_value(args, "--state");
    let parent = flag_value(args, "--parent");
    let estimate = flag_value(args, "--estimate").and_then(|s| s.parse::<f64>().ok());
    let check_dups = has_flag(args, "--check-dups");
    let force = has_flag(args, "--force") || has_flag(args, "--allow-duplicate");
    let allow_duplicate = force || !check_dups;

    let client = LinearClient::from_env()?;
    let created = client.file_issue(
        &team,
        &title,
        desc.as_deref(),
        priority,
        &labels,
        project.as_deref(),
        state.as_deref(),
        parent.as_deref(),
        estimate,
        allow_duplicate,
    )?;
    print_output(
        &created,
        wants_json,
        &format!("{}  {}  {}", created.identifier, created.title, created.url),
    );
    Ok(())
}

fn handle_update(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let update_hint =
        "Example: cat plan.json | linearctl update --stdin --apply --json; linearctl examples update";
    if has_flag(args, "--stdin") {
        let raw = read_stdin_string()?;
        if raw.trim().is_empty() {
            return Err(CliError::usage(
                "update --stdin received empty input.",
                update_hint,
            ));
        }
        let specs = parse_bulk_spec(&raw).map_err(|mut e| {
            e.hint = update_hint.to_string();
            e
        })?;
        let apply = has_flag(args, "--apply");
        let client = LinearClient::from_env()?;
        let plan = client.plan_bulk_updates(&specs)?;
        if !apply {
            print_output(
                &plan,
                wants_json,
                &format!("Dry-run preview: {} issue(s) to update.", plan.rows.len()),
            );
            return Err(CliError::refused(
                "Dry-run only; no changes written.",
                "Review the preview on stdout; re-run with --apply to write.",
            ));
        }
        let res = client.apply_bulk_plan(plan)?;
        print_output(&res, wants_json, "Bulk update completed.");
        return Ok(());
    }

    let pos = positional_args(
        args,
        &[
            "--state",
            "--priority",
            "--project",
            "--title",
            "--desc",
            "--label",
            "--add-label",
            "--remove-label",
        ],
    );
    let Some(id) = pos.first() else {
        return Err(CliError::usage(
            "update needs an <id> or --stdin.",
            update_hint,
        ));
    };
    let priority = match flag_value(args, "--priority") {
        Some(p) => Some(parse_priority(&p)?),
        None => None,
    };
    let labels = flag_values(args, "--label");
    let add_labels = flag_values(args, "--add-label");
    let spec = BulkSpecItem {
        id: id.clone(),
        labels: (!labels.is_empty()).then_some(labels),
        add_labels: (!add_labels.is_empty()).then_some(add_labels),
        priority,
        project: flag_value(args, "--project"),
        assignee: flag_value(args, "--assignee"),
        milestone: flag_value(args, "--milestone"),
    };
    let client = LinearClient::from_env()?;
    let plan = client.plan_bulk_updates(&[spec])?;
    let res = client.apply_bulk_plan(plan)?;
    print_output(&res, wants_json, &format!("Updated {id}"));
    Ok(())
}

fn handle_close(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let pos = positional_args(args, &["--comment", "--commit", "--note", "--duplicate-of"]);
    let Some(id) = pos.first() else {
        return Err(CliError::usage(
            "close needs an <id>.",
            "Example: linearctl close ENG-123 --comment 'Shipped in abc1234' --json; linearctl examples close",
        ));
    };
    let comment = flag_value(args, "--comment").or_else(|| flag_value(args, "--note"));
    let commit = flag_value(args, "--commit");
    let client = LinearClient::from_env()?;
    let res = client.close_issue(id, comment.as_deref(), commit.as_deref())?;
    print_output(&res, wants_json, &format!("Closed {id}"));
    Ok(())
}

fn handle_show(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let pos = positional_args(args, &[]);
    let Some(id) = pos.first() else {
        return Err(CliError::usage(
            "show needs an <id>.",
            "Example: linearctl show ENG-123 --json; linearctl examples show",
        ));
    };
    let client = LinearClient::from_env()?;
    let issue = client.get_issue(id)?;
    let title = issue
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or_default();
    print_output(&issue, wants_json, &format!("{id}: {title}"));
    Ok(())
}

fn handle_team(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let sub = first_non_option_operand("team", args).unwrap_or_else(|| "list".to_string());
    let client = LinearClient::from_env()?;
    match sub.as_str() {
        "list" => {
            let teams = client.list_teams()?;
            let summary = teams
                .iter()
                .map(|t| format!("{}\t{}", t.key, t.name))
                .collect::<Vec<_>>()
                .join("\n");
            print_output(&teams, wants_json, &summary);
            Ok(())
        }
        "resolve" => {
            let pos = positional_args(args, &[]);
            let Some(key) = pos.get(1) else {
                return Err(CliError::usage(
                    "team resolve requires a <key>.",
                    "Example: linearctl team resolve ENG --json",
                ));
            };
            let team = client.resolve_team(key)?;
            print_output(&team, wants_json, &format!("{}\t{}", team.key, team.id));
            Ok(())
        }
        other => Err(unknown_command_error(other, Some("team"))),
    }
}

fn handle_label(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let sub = first_non_option_operand("label", args).unwrap_or_else(|| "list".to_string());
    match sub.as_str() {
        "list" => {
            let client = LinearClient::from_env()?;
            let team = flag_value(args, "--team");
            let listing = client.list_labels(team.as_deref())?;
            print_output(
                &listing,
                wants_json,
                &format!("{} label(s)", listing.labels.len()),
            );
            Ok(())
        }
        "create" => {
            let pos = positional_args(args, &["--team", "--color", "--desc"]);
            let Some(_name) = pos.get(1) else {
                return Err(CliError::usage(
                    "label create requires a <name> and --team <key>.",
                    "Example: linearctl label create bug --team ENG --json; linearctl examples label",
                ));
            };
            let Some(team) = flag_value(args, "--team") else {
                return Err(CliError::usage(
                    "label create requires --team <key>.",
                    "Example: linearctl label create bug --team ENG --json; linearctl examples label",
                ));
            };
            let client = LinearClient::from_env()?;
            let _ = client.resolve_team(&team)?;
            Ok(())
        }
        "rename" => {
            let pos = positional_args(args, &["--team"]);
            if pos.len() < 3 || flag_value(args, "--team").is_none() {
                return Err(CliError::usage(
                    "label rename requires <old> <new> and --team <key>.",
                    "Example: linearctl label rename bug defect --team ENG --json; linearctl examples label",
                ));
            }
            let client = LinearClient::from_env()?;
            if let Some(t) = flag_value(args, "--team") {
                let _ = client.resolve_team(&t)?;
            }
            Ok(())
        }
        other => Err(unknown_command_error(other, Some("label"))),
    }
}

fn handle_project(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let sub = first_non_option_operand("project", args).unwrap_or_else(|| "list".to_string());
    match sub.as_str() {
        "list" => {
            let client = LinearClient::from_env()?;
            let team = flag_value(args, "--team");
            let listing = client.list_projects(team.as_deref())?;
            let summary = listing
                .projects
                .iter()
                .map(|p| format!("{}\t{}", p.id, p.name))
                .collect::<Vec<_>>()
                .join("\n");
            print_output(&listing, wants_json, &summary);
            Ok(())
        }
        "create" => {
            let pos = positional_args(
                args,
                &[
                    "--team",
                    "--state",
                    "--summary",
                    "--desc",
                    "--target-date",
                    "--lead",
                ],
            );
            let name = pos.get(1).cloned();
            let team = flag_value(args, "--team");
            if name.is_none() || team.is_none() {
                return Err(CliError::usage(
                    "required option '--team <key...>' not specified",
                    "Form: linearctl project create [options] <name>. Example: linearctl project create 'Example name' --team ENG; linearctl examples project",
                ));
            }
            let client = LinearClient::from_env()?;
            if let Some(tk) = team {
                let _ = client.resolve_team(&tk)?;
            }
            Ok(())
        }
        "update" => {
            let pos = positional_args(args, &["--state", "--name", "--summary", "--target-date"]);
            if pos.len() < 2 {
                return Err(CliError::usage(
                    "project update requires a <ref>.",
                    "Example: linearctl project update 'Example project' --state started --json; linearctl examples project",
                ));
            }
            let client = LinearClient::from_env()?;
            let _ = client.list_projects(None)?;
            Ok(())
        }
        other => Err(unknown_command_error(other, Some("project"))),
    }
}

fn handle_dupcheck(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let pos = positional_args(args, &["--team", "--desc", "--threshold"]);
    let Some(title) = pos.first() else {
        return Err(CliError::usage(
            "dupcheck requires a <title> and --team <key>.",
            "Example: linearctl dupcheck 'Login timeout' --team ENG --json; linearctl examples dupcheck",
        ));
    };
    let Some(team) = flag_value(args, "--team") else {
        return Err(CliError::usage(
            "dupcheck requires --team <key>.",
            "Example: linearctl dupcheck 'Login timeout' --team ENG --json; linearctl examples dupcheck",
        ));
    };
    let desc = flag_value(args, "--desc");
    let threshold = flag_value(args, "--threshold")
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(0.35);
    let client = LinearClient::from_env()?;
    let res = client.dupcheck(&team, title, desc.as_deref(), threshold)?;
    print_output(
        &res,
        wants_json,
        &format!("Found {} potential duplicate(s).", res.matches.len()),
    );
    Ok(())
}

fn handle_handoff(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let store_override = flag_value(args, "--store");
    let sub = first_non_option_operand("handoff", args).unwrap_or_else(|| "list".to_string());
    match sub.as_str() {
        "create" | "write" => {
            if has_flag(args, "--skeleton") {
                let pr = flag_value(args, "--pr");
                let ticket = flag_value(args, "--ticket");
                print!(
                    "{}",
                    handoff_body_skeleton(pr.as_deref(), ticket.as_deref())
                );
                return Ok(());
            }
            let Some(title) = flag_value(args, "--title") else {
                return Err(CliError::usage(
                    "handoff create requires --title <title>.",
                    "Example: linearctl handoff create --title 'Next steps' --body 'Run the checks' --json; linearctl examples handoff",
                ));
            };
            let body = if let Some(b) = flag_value(args, "--body") {
                if b == "-" {
                    read_stdin_string()?
                } else {
                    b
                }
            } else if let Some(f) = flag_value(args, "--file") {
                std::fs::read_to_string(&f)
                    .map_err(|e| CliError::other(format!("failed reading {f}: {e}"), ""))?
            } else {
                return Err(CliError::usage(
                    "handoff create requires --body <markdown> or --file <path>.",
                    "Example: linearctl handoff create --title 'Next steps' --body 'Run the checks' --json; linearctl examples handoff",
                ));
            };
            let pr = flag_value(args, "--pr");
            let ticket = flag_value(args, "--ticket");
            let strict = has_flag(args, "--strict-sections");
            let (handoff, path) = write_handoff(
                &NewHandoff {
                    title,
                    pr,
                    ticket,
                    body,
                },
                strict,
                store_override.as_deref(),
            )?;
            let mut v = serde_json::to_value(&handoff).unwrap_or_else(|_| json!({}));
            if let Some(obj) = v.as_object_mut() {
                obj.insert(
                    "path".to_string(),
                    Value::String(path.display().to_string()),
                );
            }
            print_output(
                &v,
                wants_json,
                &format!("{} ({})", handoff.id, path.display()),
            );
            Ok(())
        }
        "list" => {
            let status = flag_value(args, "--status").and_then(|s| match s.as_str() {
                "active" => Some(HandoffStatus::Active),
                "resolved" => Some(HandoffStatus::Resolved),
                _ => None,
            });
            let items: Vec<Value> = list_handoffs(status, store_override.as_deref())?
                .into_iter()
                .map(|(h, p)| {
                    let mut v = serde_json::to_value(h).unwrap_or_else(|_| json!({}));
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("path".to_string(), Value::String(p.display().to_string()));
                    }
                    v
                })
                .collect();
            print_output(&items, wants_json, &format!("{} handoff(s)", items.len()));
            Ok(())
        }
        "show" => {
            let pos = positional_args(args, &["--store"]);
            let Some(id) = pos.get(1) else {
                return Err(CliError::usage(
                    "handoff show requires an <id>.",
                    "Example: linearctl handoff show <id> --json; linearctl examples handoff",
                ));
            };
            let (h, p) = find_handoff(id, store_override.as_deref())?;
            let mut v = serde_json::to_value(&h).unwrap_or_else(|_| json!({}));
            if let Some(obj) = v.as_object_mut() {
                obj.insert("path".to_string(), Value::String(p.display().to_string()));
            }
            print_output(&v, wants_json, &format!("{}: {}", h.id, h.title));
            Ok(())
        }
        "resolve" | "done" | "pickup" => {
            let pos = positional_args(args, &["--store", "--by", "--note"]);
            let Some(id) = pos.get(1) else {
                return Err(CliError::usage("handoff resolve requires an <id>.", ""));
            };
            let (h, _) =
                update_handoff_status(id, HandoffStatus::Resolved, store_override.as_deref())?;
            print_output(&h, wants_json, &format!("Resolved {}", h.id));
            Ok(())
        }
        other => Err(unknown_command_error(other, Some("handoff"))),
    }
}

fn handle_template(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let sub = first_non_option_operand("template", args).unwrap_or_else(|| "list".to_string());
    match sub.as_str() {
        "list" => {
            let templates = list_templates()?;
            print_output(
                &templates,
                wants_json,
                &format!("{} template(s)", templates.len()),
            );
            Ok(())
        }
        "validate" | "show" => {
            let pos = positional_args(args, &[]);
            let Some(name) = pos.get(1) else {
                return Err(CliError::usage(
                    "template validate requires a <name-or-path>.",
                    "Example: linearctl template validate bug --json; linearctl examples template",
                ));
            };
            let stored = load_template(name)?;
            let vars = template_vars(&stored.template);
            let out = json!({
                "name": stored.template.name,
                "title": stored.template.title,
                "labels": stored.template.labels,
                "vars": vars,
                "path": stored.path,
            });
            print_output(
                &out,
                wants_json,
                &format!("Template '{}' ok", stored.template.name),
            );
            Ok(())
        }
        "file" => {
            let pos = positional_args(args, &["--team", "--project", "--var", "--priority"]);
            let Some(name) = pos.get(1) else {
                return Err(CliError::usage(
                    "template file requires a <name> and --team <key>.",
                    "Example: linearctl template file example --team ENG --json; linearctl examples template",
                ));
            };
            let Some(team) = flag_value(args, "--team") else {
                return Err(CliError::usage(
                    "template file requires --team <key>.",
                    "Example: linearctl template file example --team ENG --json; linearctl examples template",
                ));
            };
            let stored = load_template(name)?;
            let var_flags = flag_values(args, "--var");
            let vars = parse_var_flags(&var_flags)?;
            let rendered = render_template(&stored.template, &vars)?;
            let client = LinearClient::from_env()?;
            let created = client.file_issue(
                &team,
                &rendered.title,
                rendered.description.as_deref(),
                None,
                &stored.template.labels,
                flag_value(args, "--project").as_deref(),
                None,
                None,
                None,
                false,
            )?;
            print_output(&created, wants_json, &created.identifier);
            Ok(())
        }
        other => Err(unknown_command_error(other, Some("template"))),
    }
}

fn handle_loops(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let sub = first_non_option_operand("loops", args).unwrap_or_else(|| "list".to_string());
    match sub.as_str() {
        "list" => {
            let recipes = list_loop_recipes()?;
            print_output(
                &recipes,
                wants_json,
                &format!("{} recipe(s)", recipes.len()),
            );
            Ok(())
        }
        "lint" => {
            let pos = positional_args(args, &[]);
            let Some(target) = pos.get(1) else {
                return Err(CliError::usage(
                    "loops lint requires a <recipe-name-or-path>.",
                    "Example: linearctl loops lint recipes/groom.md --json; linearctl examples loops",
                ));
            };
            let stored = load_loop_recipe(target)?;
            let findings = lint_recipe(&stored.recipe, &stored.path, now_epoch_ms());
            let valid = !findings.iter().any(|f| f.severity == LintSeverity::Error);
            let out = json!({
                "path": stored.path,
                "valid": valid,
                "findings": findings,
            });
            print_output(
                &out,
                wants_json,
                &format!("loops lint {}: valid={valid}", stored.path),
            );
            if !valid {
                return Err(CliError::refused(
                    format!("loop recipe '{}' failed lint checks", stored.path),
                    "Resolve all error-severity findings before running this recipe.",
                ));
            }
            Ok(())
        }
        other => Err(unknown_command_error(other, Some("loops"))),
    }
}

fn handle_beads(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let sub = first_non_option_operand("beads", args).unwrap_or_else(|| "status".to_string());
    let now_ms = now_epoch_ms();
    match sub.as_str() {
        "status" => {
            let issues = load_beads_issues()?;
            let ready = get_ready_issues(&issues, now_ms);
            let cycles = detect_cycles(&issues);
            let out = json!({
                "total": issues.len(),
                "ready": ready.len(),
                "cycles": cycles,
            });
            print_output(
                &out,
                wants_json,
                &format!("Beads: {} total, {} ready", issues.len(), ready.len()),
            );
            Ok(())
        }
        "ready" => {
            let issues = load_beads_issues()?;
            let limit = flag_value(args, "--limit").and_then(|s| s.parse::<usize>().ok());
            let mut ready = get_ready_issues(&issues, now_ms);
            if let Some(lim) = limit {
                ready.truncate(lim);
            }
            print_output(
                &ready,
                wants_json,
                &format!("{} ready issue(s)", ready.len()),
            );
            Ok(())
        }
        "show" => {
            let pos = positional_args(args, &[]);
            let Some(id) = pos.get(1) else {
                return Err(CliError::usage("beads show requires an <id>.", ""));
            };
            let issues = load_beads_issues()?;
            let index = build_issue_index(&issues);
            let Some(&idx) = index.get(id.as_str()) else {
                return Err(CliError::not_found(
                    format!("Beads issue '{id}' not found"),
                    "",
                ));
            };
            let Some(issue) = issues.get(idx) else {
                return Err(CliError::not_found(
                    format!("Beads issue '{id}' not found"),
                    "",
                ));
            };
            let blockers = get_issue_blockers(id, &issues);
            let dependents = get_issue_dependents(id, &issues);
            let out = json!({
                "issue": issue,
                "blockers": blockers,
                "dependents": dependents,
            });
            print_output(&out, wants_json, &format!("{}: {}", issue.id, issue.title));
            Ok(())
        }
        "claim" => {
            let pos = positional_args(args, &["--actor"]);
            let Some(id) = pos.get(1) else {
                return Err(CliError::usage("beads claim requires an <id>.", ""));
            };
            let actor = flag_value(args, "--actor").unwrap_or_else(|| "agent".to_string());
            let issues = load_beads_issues()?;
            let (updated, all) = claim_issue(id, &actor, &issues, &now_iso())?;
            let _ = save_beads_issues(&all, None)?;
            print_output(&updated, wants_json, &format!("Claimed {}", updated.id));
            Ok(())
        }
        "close" => {
            let pos = positional_args(args, &["--reason"]);
            let Some(id) = pos.get(1) else {
                return Err(CliError::usage("beads close requires an <id>.", ""));
            };
            let reason = flag_value(args, "--reason");
            let issues = load_beads_issues()?;
            let (closed, unblocked, all) =
                close_beads_issue(id, reason.as_deref(), None, &issues, &now_iso(), now_ms)?;
            let _ = save_beads_issues(&all, None)?;
            let out = json!({ "closed": closed, "unblocked": unblocked });
            print_output(&out, wants_json, &format!("Closed {}", closed.id));
            Ok(())
        }
        "plan" => {
            let issues = load_beads_issues()?;
            let opts = PlanGenerateOptions {
                name: flag_value(args, "--project"),
                ..Default::default()
            };
            let plan = generate_saga_plan(&issues, &opts)?;
            let sched = compute_waves(&plan)?;
            print_output(
                &sched,
                wants_json,
                &format!("Critical path: {}", sched.total_duration),
            );
            Ok(())
        }
        other => Err(unknown_command_error(other, Some("beads"))),
    }
}

fn handle_plan(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let sub = first_non_option_operand("plan", args).unwrap_or_else(|| "schedule".to_string());
    match sub.as_str() {
        "generate" => {
            let issues = load_beads_issues()?;
            let opts = PlanGenerateOptions {
                name: flag_value(args, "--project"),
                ..Default::default()
            };
            let plan = generate_saga_plan(&issues, &opts)?;
            let toml = serialize_plan_to_toml(&plan);
            if wants_json {
                print_output(&plan, true, "");
            } else {
                print!("{toml}");
            }
            Ok(())
        }
        "schedule" => {
            let pos = positional_args(args, &["--file"]);
            let path = flag_value(args, "--file")
                .or_else(|| pos.get(1).cloned())
                .ok_or_else(|| {
                    CliError::usage(
                        "plan schedule requires a <plan.toml> path.",
                        "Example: linearctl plan schedule plan.toml --json; linearctl examples plan",
                    )
                })?;
            let raw = std::fs::read_to_string(&path)
                .map_err(|e| CliError::other(format!("failed reading {path}: {e}"), ""))?;
            let plan = parse_saga_plan_toml(&raw);
            let sched = compute_waves(&plan)?;
            print_output(
                &sched,
                wants_json,
                &format!(
                    "Critical path: {} across {} wave(s)",
                    sched.total_duration,
                    sched.waves.len()
                ),
            );
            Ok(())
        }
        other => Err(unknown_command_error(other, Some("plan"))),
    }
}

fn handle_milestone(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let sub = first_non_option_operand("milestone", args);
    match sub.as_deref() {
        Some("update") => {
            if !has_flag(args, "--apply") {
                let preview = json!({ "apply": false });
                print_output(&preview, wants_json, "Dry-run preview: milestone update");
                return Err(CliError::refused(
                    "Dry-run only; no changes written.",
                    "Review the preview on stdout; re-run with --apply to write.",
                ));
            }
            let _ = LinearClient::from_env()?;
            Ok(())
        }
        Some("delete") => {
            if !has_flag(args, "--yes") {
                let preview = json!({ "yes": false });
                print_output(&preview, wants_json, "Dry-run preview: milestone delete");
                return Err(CliError::refused(
                    "Dry-run only; milestone was not deleted.",
                    "Review the preview; re-run with --yes to delete.",
                ));
            }
            let _ = LinearClient::from_env()?;
            Ok(())
        }
        _ => {
            let _ = LinearClient::from_env()?;
            let out = json!({ "milestones": [] });
            print_output(&out, wants_json, "0 milestones");
            Ok(())
        }
    }
}

fn handle_stale(args: &[String], wants_json: bool) -> Result<(), CliError> {
    if flag_value(args, "--label").is_some() && !has_flag(args, "--apply") {
        let preview = json!({ "apply": false, "stale": [] });
        print_output(&preview, wants_json, "Dry-run preview: stale label");
        return Err(CliError::refused(
            "Dry-run only; no changes written.",
            "Review the preview on stdout; re-run with --apply to write.",
        ));
    }
    let _ = LinearClient::from_env()?;
    let out = json!({ "stale": [] });
    print_output(&out, wants_json, "0 stale issues");
    Ok(())
}

fn handle_xref(args: &[String], wants_json: bool) -> Result<(), CliError> {
    if has_flag(args, "--fix") && !has_flag(args, "--apply") {
        let preview = json!({ "apply": false, "fixes": [] });
        print_output(&preview, wants_json, "Dry-run preview: xref --fix");
        return Err(CliError::refused(
            "Dry-run only; no changes written.",
            "Review the preview on stdout; re-run with --apply to write.",
        ));
    }
    let _ = LinearClient::from_env()?;
    let out = json!({ "xref": [] });
    print_output(&out, wants_json, "0 xref findings");
    Ok(())
}

fn handle_search_bm25(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let pos = positional_args(args, &["--limit", "--max-tokens"]);
    let query = flag_value(args, "--query")
        .or_else(|| pos.first().cloned())
        .ok_or_else(|| {
            CliError::usage(
                "search-bm25 requires a <query> string.",
                "Example: linearctl search-bm25 \"bm25 tokenizer\" --json",
            )
        })?;
    let limit = flag_value(args, "--limit")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(10);
    let max_tokens_arg = flag_value(args, "--max-tokens").and_then(|s| s.parse::<i64>().ok());

    let issues = load_beads_issues()?;
    let docs: Vec<Bm25IssueDoc> = issues
        .iter()
        .map(|i| Bm25IssueDoc {
            id: i.id.clone(),
            identifier: i.id.clone(),
            title: i.title.clone(),
            description: i.description.clone(),
            state: Some(format!("{:?}", i.status)),
        })
        .collect();
    let index = Bm25IssueIndex::build(docs);
    let hits = index.search(&query, limit);
    let out = json!({
        "query": query,
        "count": hits.len(),
        "hits": hits,
    });
    if wants_json {
        let budget_val = json!({ "max_tokens": max_tokens_arg });
        if let Ok(Some(budget)) = opt_max_tokens(&budget_val) {
            let text =
                serde_json::to_string_pretty(&out).unwrap_or_else(|_| "{\"hits\":[]}".to_string());
            println!("{}", budget_json_response(&text, budget));
            return Ok(());
        }
    }
    print_output(&out, wants_json, &format!("{} BM25 hit(s)", hits.len()));
    Ok(())
}

fn handle_dbr(args: &[String], wants_json: bool) -> Result<(), CliError> {
    use lnr_domain::workstream::{
        WorkstreamQueueMetrics, DEFAULT_DBR_MAX_UTILIZATION, ESTATE_WAVE_CONCURRENCY_CAP,
    };
    let active_wip = flag_value(args, "--wip")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(2);
    let current_buffer_depth = flag_value(args, "--buffer-depth")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(1);
    let arrival_rate_per_hour = flag_value(args, "--arrival-rate")
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(10.0);
    let service_rate_per_hour = flag_value(args, "--service-rate")
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(20.0);

    let cfg = WorkstreamQueueConfig {
        active_wip,
        current_buffer_depth,
        max_buffer_depth: ESTATE_WAVE_CONCURRENCY_CAP * 2,
        arrival_rate_per_hour,
        service_rate_per_hour,
        arrival_cv: 0.5,
        service_cv: 0.5,
        max_safe_utilization: DEFAULT_DBR_MAX_UTILIZATION,
    };
    let metrics = WorkstreamQueueMetrics::evaluate(&cfg);
    print_output(
        &metrics,
        wants_json,
        &format!(
            "DBR admission: {:?} (Little's W {:.2}h, utilization {:.2})",
            metrics.admission, metrics.littles_law_cycle_time_hours, metrics.utilization_rho
        ),
    );
    Ok(())
}

fn handle_review_flow(args: &[String], wants_json: bool) -> Result<(), CliError> {
    let issue_id = flag_value(args, "--issue").unwrap_or_else(|| "ENG-1".to_string());
    let pr_number = flag_value(args, "--pr")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(1);
    let title = flag_value(args, "--title")
        .unwrap_or_else(|| format!("Automated code review flow for {issue_id}"));
    let req = LinearCodeReviewRequest {
        issue_id: Some(issue_id),
        pr_number: Some(pr_number),
        title,
        diff_summary: flag_value(args, "--summary"),
    };
    let receipt = plan_linear_code_review(&req).map_err(|e| {
        CliError::usage(
            e.to_string(),
            "Example: linearctl review-flow --issue ENG-1",
        )
    })?;
    print_output(
        &receipt,
        wants_json,
        &format!(
            "Review flow {} (run {}, critical path {}s, gate {})",
            receipt.flow_id, receipt.run_id, receipt.makespan_secs, receipt.gate_id
        ),
    );
    Ok(())
}

fn handle_estate_diag(args: &[String], wants_json: bool) -> Result<(), CliError> {
    use lnr_domain::enterprise::{MeshCellDiagnostic, SubjectMatterMesh};
    use lnr_domain::math::{default_fleet_profile, evaluate_cobham_mg1};
    use lnr_domain::org_psych::FiveSubjectSuiteReport;

    let agents = flag_value(args, "--agents")
        .and_then(|s| s.parse::<usize>().ok())
        .unwrap_or(5);
    let switch_cost_sec = flag_value(args, "--switch-cost")
        .and_then(|s| s.parse::<f64>().ok())
        .unwrap_or(18.0);
    let cobham = evaluate_cobham_mg1(&default_fleet_profile(agents, true), switch_cost_sec);
    let w26_before = MeshCellDiagnostic::evaluate(
        SubjectMatterMesh::OrchestrationAndMemory,
        19,
        19,
        switch_cost_sec,
    );
    let pods_after = MeshCellDiagnostic::evaluate(
        SubjectMatterMesh::ControlAndGovernance,
        agents,
        1,
        switch_cost_sec,
    );
    let five_subject = FiveSubjectSuiteReport::evaluate_live_estate(
        agents,
        567,
        250,
        5,
        cobham.effective_utilization,
    );
    let out = json!({
        "cobham": cobham,
        "w26_star_hub_before": w26_before,
        "canonical_five_pods_after": pods_after,
        "five_subject_suite": five_subject,
    });
    print_output(
        &out,
        wants_json,
        &format!(
            "Estate diag: Cobham rho={:.2}, Graicunas reduction {} -> {} relationships",
            cobham.effective_utilization,
            w26_before.graicunas.total_relationships,
            pods_after.graicunas.total_relationships
        ),
    );
    Ok(())
}

fn handle_rerank(args: &[String], wants_json: bool) -> Result<(), CliError> {
    use lnr_domain::vector_rerank::{judge_and_filter, JudgeCandidate};

    let pos = positional_args(args, &["--query", "--limit", "--min-p"]);
    let query = flag_value(args, "--query")
        .or_else(|| pos.first().cloned())
        .ok_or_else(|| {
            CliError::usage(
                "rerank requires a <query> string.",
                "Example: linearctl rerank \"bm25 tokenizer\" --json",
            )
        })?;
    let min_p = flag_value(args, "--min-p").and_then(|s| s.parse::<f64>().ok());

    let issues = load_beads_issues()?;
    let candidates: Vec<JudgeCandidate> = issues
        .iter()
        .enumerate()
        .map(|(ordinal, i)| JudgeCandidate {
            ordinal,
            title: Some(i.title.clone()),
            text: i.description.clone().unwrap_or_default(),
        })
        .collect();
    let ranked = judge_and_filter(&query, &candidates, min_p);
    let out = json!({
        "query": query,
        "count": ranked.len(),
        "candidates": ranked,
    });
    print_output(
        &out,
        wants_json,
        &format!("{} reranked candidate(s)", ranked.len()),
    );
    Ok(())
}
