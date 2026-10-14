//! Integration tests verifying the `lnr` binary against the full agent CLI contract and MCP protocol.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};

use lnr_domain::examples::EXAMPLES;
use serde_json::Value;

struct CliRun {
    code: i32,
    out: String,
    err: String,
}

fn run_lnr(args: &[&str], stdin_data: &str, scenario: Option<&str>) -> CliRun {
    let bin = env!("CARGO_BIN_EXE_lnr");
    let mut cmd = Command::new(bin);
    cmd.args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1");

    if scenario.is_some() || !stdin_data.is_empty() {
        cmd.env("LINEAR_API_KEY", "test-key");
    } else {
        cmd.env("LINEAR_API_KEY", "");
    }
    cmd.env("LINEARCTL_TEST_SCENARIO", scenario.unwrap_or(""));

    let mut child = cmd.spawn().expect("spawn lnr");
    if !stdin_data.is_empty() {
        if let Some(mut stdin) = child.stdin.take() {
            stdin.write_all(stdin_data.as_bytes()).expect("write stdin");
        }
    }
    let output = child.wait_with_output().expect("wait lnr");
    CliRun {
        code: output.status.code().unwrap_or(-1),
        out: String::from_utf8_lossy(&output.stdout).to_string(),
        err: String::from_utf8_lossy(&output.stderr).to_string(),
    }
}

fn assert_envelope(res: &CliRun, expected_code: i32, expected_kind: &str) -> Value {
    assert_eq!(
        res.code, expected_code,
        "unexpected exit code (out={:?}, err={:?})",
        res.out, res.err
    );
    let lines: Vec<&str> = res.err.trim().lines().collect();
    assert_eq!(
        lines.len(),
        1,
        "expected 1-line JSON error envelope, got: {:?}",
        res.err
    );
    let parsed: Value = serde_json::from_str(lines[0]).expect("valid JSON error envelope");
    let err = parsed.get("error").expect("error field").clone();
    assert_eq!(err["code"].as_i64(), Some(i64::from(expected_code)));
    assert_eq!(err["kind"].as_str(), Some(expected_kind));
    assert!(err["message"].is_string());
    assert!(err["hint"].is_string());
    err
}

#[test]
fn examples_and_help_work_without_authentication() {
    let res = run_lnr(&["examples", "comment"], "", None);
    assert_eq!(res.code, 0);
    assert_eq!(res.err, "");
    let (_, comment_script) = EXAMPLES
        .iter()
        .find(|(k, _)| *k == "comment")
        .expect("comment example");
    assert!(res.out.contains(comment_script));

    let help = run_lnr(&["--help"], "", None);
    assert_eq!(help.code, 0);
    assert!(help
        .out
        .contains("0 ok · 2 usage · 3 auth · 4 not found · 5 rate limited · 6 refused · 1 other"));
}

#[test]
fn positional_comment_body_explains_stdin_and_correct_command() {
    let res = run_lnr(&["comment", "ENG-123", "text", "--json"], "", None);
    let e = assert_envelope(&res, 2, "usage");
    assert!(e["message"].as_str().unwrap().contains("--body"));
    assert!(e["hint"].as_str().unwrap().contains("--body -"));
    assert!(e["hint"]
        .as_str()
        .unwrap()
        .contains("linearctl examples comment"));
    assert_eq!(res.out, "");

    let plain = run_lnr(&["comment", "X-1", "hello"], "", None);
    assert_eq!(plain.code, 2);
    assert!(plain.err.contains("Comment text is not positional"));
    assert!(plain.err.contains("--body -"));
    assert!(plain.err.contains("linearctl examples comment"));
}

#[test]
fn unknown_commands_suggest_spelling_and_fail_even_with_help() {
    let r = run_lnr(&["commnt"], "", None);
    assert_eq!(r.code, 2);
    assert!(r.err.contains("Did you mean comment?"));

    for name in ["nosuchcmd", "bogus"] {
        let res = run_lnr(&[name, "--help"], "", None);
        assert_eq!(res.code, 2);
        assert_eq!(res.out, "");
        assert!(res.err.contains(&format!("unknown command '{name}'")));
        assert!(res.err.contains("linearctl examples;"));
        assert!(!res.err.contains("examples comment"));
    }

    let typo = run_lnr(&["commnt", "--help"], "", None);
    assert_eq!(typo.code, 2);
    assert!(typo.err.contains("Did you mean comment?"));
    assert!(typo.err.contains("linearctl examples comment"));

    let nested = run_lnr(&["project", "bogus", "--help", "--json"], "", None);
    assert_envelope(&nested, 2, "usage");
    assert_eq!(nested.out, "");

    for args in [
        &["comment", "--help"][..],
        &["project", "list", "--help"][..],
        &["milestone", "--project", "Example", "--help"][..],
        &["help", "comment"][..],
    ] {
        assert_eq!(run_lnr(args, "", None).code, 0);
    }
}

#[test]
fn root_json_placement_and_usage_precedence() {
    let e = assert_envelope(&run_lnr(&["--json", "nosuchcmd"], "", None), 2, "usage");
    assert!(e["hint"]
        .as_str()
        .unwrap()
        .contains("Place --json after the subcommand"));
    assert!(e["hint"]
        .as_str()
        .unwrap()
        .contains("linearctl whoami --json"));

    let typo = run_lnr(&["ratelimitt"], "", None);
    assert!(typo.err.contains("linearctl examples ratelimit"));

    let file_err = assert_envelope(&run_lnr(&["file", "--json"], "", None), 2, "usage");
    assert!(file_err["hint"].as_str().unwrap().contains("--desc -"));
    assert!(file_err["hint"].as_str().unwrap().contains("examples file"));

    let proj_err = assert_envelope(
        &run_lnr(&["project", "create", "Example", "--json"], "", None),
        2,
        "usage",
    );
    assert!(proj_err["hint"]
        .as_str()
        .unwrap()
        .contains("linearctl project create"));
    assert!(proj_err["hint"].as_str().unwrap().contains("--team ENG"));

    // `project list` does not require `--team` and reaches auth check (exit 3).
    assert_envelope(
        &run_lnr(&["project", "list", "--json"], "", None),
        3,
        "auth",
    );
}

#[test]
fn update_stdin_and_dry_run_previews_and_scenarios() {
    let empty_update = assert_envelope(
        &run_lnr(&["update", "--stdin", "--json"], " \n", None),
        2,
        "usage",
    );
    assert!(empty_update["hint"]
        .as_str()
        .unwrap()
        .contains("cat plan.json | linearctl update --stdin"));
    assert!(empty_update["hint"].as_str().unwrap().contains("--apply"));

    assert_envelope(
        &run_lnr(&["update", "--stdin", "--json"], "{oops", None),
        2,
        "usage",
    );

    // 3: missing and invalid credentials
    assert_envelope(&run_lnr(&["whoami", "--json"], "", None), 3, "auth");
    assert_envelope(&run_lnr(&["whoami", "--json"], "", Some("auth")), 3, "auth");
    assert_envelope(
        &run_lnr(&["ratelimit", "--json"], "", Some("auth")),
        3,
        "auth",
    );

    // 2: GraphQL userinput scenario
    let msg = "Duplicate label name - Label \"example-label\" already exists in team Example Team (userError=true)";
    let json_ui = run_lnr(&["whoami", "--json"], "", Some("userinput"));
    assert_eq!(
        assert_envelope(&json_ui, 2, "usage")["message"].as_str(),
        Some(msg)
    );
    assert_eq!(json_ui.out, "");

    // 5: rate_limit scenario
    assert_envelope(
        &run_lnr(&["ratelimit", "--json"], "", Some("rate_limit")),
        5,
        "rate_limit",
    );

    // 6: dry-run previews do not masquerade as writes
    let file_dry = run_lnr(
        &["file", "--stdin", "--json"],
        "[{\"title\":\"Example\",\"team\":\"ENG\"}]",
        None,
    );
    let file_env = assert_envelope(&file_dry, 6, "refused");
    let preview_val: Value = serde_json::from_str(&file_dry.out).unwrap();
    assert_eq!(preview_val["apply"].as_bool(), Some(false));
    assert!(file_env["hint"].as_str().unwrap().contains("--apply"));

    let upd_dry = run_lnr(
        &["update", "--stdin", "--json"],
        "[{\"id\":\"ENG-123\",\"priority\":3}]",
        Some("bulk"),
    );
    assert_envelope(&upd_dry, 6, "refused");
    let upd_val: Value = serde_json::from_str(&upd_dry.out).unwrap();
    assert_eq!(
        upd_val["rows"][0]["input"],
        serde_json::json!({ "priority": 3 })
    );

    // 4: label and team lookup hints
    let label_err = assert_envelope(
        &run_lnr(
            &[
                "file", "Example", "--team", "ENG", "--label", "skills", "--json",
            ],
            "",
            Some("label"),
        ),
        4,
        "not_found",
    );
    assert!(label_err["hint"]
        .as_str()
        .unwrap()
        .contains("\"skill\", \"skies\", \"skills-ui\""));
    assert!(label_err["hint"]
        .as_str()
        .unwrap()
        .contains("linearctl label list --team"));

    let team_err = assert_envelope(
        &run_lnr(
            &["project", "list", "--team", "ENX", "--json"],
            "",
            Some("team"),
        ),
        4,
        "not_found",
    );
    assert!(team_err["message"].as_str().unwrap().contains("ENG, OPS"));

    // 6: duplicate guard exits 6 before create mutation
    let dup_err = assert_envelope(
        &run_lnr(
            &[
                "file",
                "Fix timeout",
                "--team",
                "ENG",
                "--check-dups",
                "--json",
            ],
            "",
            Some("dup"),
        ),
        6,
        "refused",
    );
    assert!(dup_err["message"]
        .as_str()
        .unwrap()
        .contains("likely duplicate"));

    // 1: transport error
    let other_err = assert_envelope(
        &run_lnr(&["ratelimit", "--json"], "", Some("other")),
        1,
        "other",
    );
    assert_eq!(
        other_err["message"].as_str(),
        Some("fixture transport failure")
    );
}

#[test]
fn handoff_create_show_and_missing_lookup_work_end_to_end() {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let store: PathBuf = std::env::temp_dir().join(format!("lnr-handoff-test-{nanos}"));
    fs::create_dir_all(&store).unwrap();
    let store_str = store.to_str().unwrap();

    let created = run_lnr(
        &[
            "handoff",
            "create",
            "--title",
            "Example",
            "--body",
            "Test body",
            "--store",
            store_str,
            "--json",
        ],
        "",
        None,
    );
    assert_eq!(created.code, 0, "stderr={}", created.err);
    let created_json: Value = serde_json::from_str(&created.out).unwrap();
    let id = created_json["id"].as_str().unwrap();

    let shown = run_lnr(
        &["handoff", "show", id, "--store", store_str, "--json"],
        "",
        None,
    );
    assert_eq!(shown.code, 0);

    let absent = run_lnr(
        &["handoff", "show", "absent", "--store", store_str, "--json"],
        "",
        None,
    );
    assert_envelope(&absent, 4, "not_found");

    let _ = fs::remove_dir_all(&store);
}

#[test]
fn mcp_serve_responds_to_initialize_and_tools_list() {
    let input = concat!(
        "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{}}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}\n"
    );
    let res = run_lnr(&["mcp", "serve"], input, None);
    assert_eq!(res.code, 0);
    let lines: Vec<&str> = res.out.lines().collect();
    assert_eq!(lines.len(), 2);
    let init_resp: Value = serde_json::from_str(lines[0]).unwrap();
    assert_eq!(
        init_resp["result"]["serverInfo"]["name"].as_str(),
        Some("lnr")
    );
    let tools_resp: Value = serde_json::from_str(lines[1]).unwrap();
    let tools = tools_resp["result"]["tools"].as_array().unwrap();
    assert!(tools.iter().any(|t| t["name"].as_str() == Some("whoami")));
    assert!(tools
        .iter()
        .any(|t| t["name"].as_str() == Some("file_issue")));
}
