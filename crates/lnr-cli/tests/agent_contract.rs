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
        "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/list\",\"params\":{}}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"queue_admission\",\"arguments\":{\"active_wip\":2}}}\n",
        "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"review_flow\",\"arguments\":{\"issue_id\":\"TOD-77\",\"pr_number\":42,\"title\":\"Review TOD-77\"}}}\n"
    );
    let res = run_lnr(&["mcp", "serve"], input, None);
    assert_eq!(res.code, 0);
    let lines: Vec<&str> = res.out.lines().collect();
    assert_eq!(lines.len(), 4);
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
    assert!(tools
        .iter()
        .any(|t| t["name"].as_str() == Some("bm25_search")));
    assert!(tools
        .iter()
        .any(|t| t["name"].as_str() == Some("queue_admission")));
    assert!(tools
        .iter()
        .any(|t| t["name"].as_str() == Some("review_flow")));
    assert!(tools
        .iter()
        .any(|t| t["name"].as_str() == Some("estate_diagnostic")));
    assert!(tools
        .iter()
        .any(|t| t["name"].as_str() == Some("lexical_rerank")));
    assert!(tools
        .iter()
        .any(|t| t["name"].as_str() == Some("link_detect")));
    assert!(tools
        .iter()
        .any(|t| t["name"].as_str() == Some("audit_verify")));

    let q_resp: Value = serde_json::from_str(lines[2]).unwrap();
    assert!(q_resp["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("admit"));

    let rev_resp: Value = serde_json::from_str(lines[3]).unwrap();
    assert!(rev_resp["result"]["content"][0]["text"]
        .as_str()
        .unwrap()
        .contains("linear-code-review"));
}

#[test]
fn borrowed_researchd_and_xerj_cli_commands_work() {
    let dbr = run_lnr(&["dbr", "--wip", "2", "--json"], "", None);
    assert_eq!(dbr.code, 0, "stderr={}", dbr.err);
    let dbr_json: Value = serde_json::from_str(&dbr.out).unwrap();
    assert_eq!(dbr_json["admission"].as_str(), Some("admit"));

    let rev = run_lnr(
        &["review-flow", "--issue", "TOD-99", "--pr", "12", "--json"],
        "",
        None,
    );
    assert_eq!(rev.code, 0, "stderr={}", rev.err);
    let rev_json: Value = serde_json::from_str(&rev.out).unwrap();
    assert_eq!(rev_json["flow_id"].as_str(), Some("linear-code-review"));
    assert_eq!(rev_json["gate_id"].as_str(), Some("linear:code-review"));

    let diag = run_lnr(&["estate-diag", "--agents", "5", "--json"], "", None);
    assert_eq!(diag.code, 0, "stderr={}", diag.err);
    let diag_json: Value = serde_json::from_str(&diag.out).unwrap();
    assert_eq!(
        diag_json["canonical_five_pods_after"]["graicunas"]["total_relationships"].as_u64(),
        Some(100)
    );
}

#[test]
fn ported_linear_and_cache_commands_work_end_to_end() {
    let search = run_lnr(
        &["search", "--team", "ENG", "--text", "timeout", "--json"],
        "",
        Some("mock"),
    );
    assert_eq!(search.code, 0, "stderr={}", search.err);
    let search_json: Value = serde_json::from_str(&search.out).unwrap();
    assert_eq!(search_json[0]["identifier"].as_str(), Some("ENG-123"));

    let pull = run_lnr(&["pull", "--team", "ENG", "--json"], "", Some("mock"));
    assert_eq!(pull.code, 0, "stderr={}", pull.err);
    let pull_json: Value = serde_json::from_str(&pull.out).unwrap();
    assert_eq!(pull_json[0]["labels"][0].as_str(), Some("bug"));

    let digest = run_lnr(&["digest", "--since", "24h", "--json"], "", Some("mock"));
    assert_eq!(digest.code, 0, "stderr={}", digest.err);
    let digest_json: Value = serde_json::from_str(&digest.out).unwrap();
    assert_eq!(digest_json["schema_version"].as_u64(), Some(1));
    assert_eq!(digest_json["total"].as_u64(), Some(1));

    let digest_bw = run_lnr(
        &["digest", "--since", "24h", "--format", "blackwall"],
        "",
        Some("mock"),
    );
    assert_eq!(digest_bw.code, 0, "stderr={}", digest_bw.err);
    assert!(digest_bw.out.contains("[[task]]"));
    assert!(digest_bw.out.contains("schema_version = 1"));
    assert!(digest_bw.out.contains("id = \"ENG-123\""));

    let digest_bad = run_lnr(
        &["digest", "--since", "24h", "--format", "bogus"],
        "",
        Some("mock"),
    );
    assert_eq!(digest_bad.code, 2);

    let standup = run_lnr(&["standup", "--since", "24h", "--json"], "", Some("mock"));
    assert_eq!(standup.code, 0, "stderr={}", standup.err);
    let standup_json: Value = serde_json::from_str(&standup.out).unwrap();
    assert!(standup_json["markdown"]
        .as_str()
        .unwrap()
        .contains("ENG-123"));

    let mine = run_lnr(&["mine", "--json"], "", Some("mock"));
    assert_eq!(mine.code, 0, "stderr={}", mine.err);

    let relate = run_lnr(
        &[
            "relate",
            "ENG-123",
            "--blocked-by",
            "ENG-100",
            "--related-to",
            "ENG-101",
            "--json",
        ],
        "",
        Some("mock"),
    );
    assert_eq!(relate.code, 0, "stderr={}", relate.err);
    let relate_json: Value = serde_json::from_str(&relate.out).unwrap();
    assert_eq!(
        relate_json["relations"]["blockedBy"][0].as_str(),
        Some("ENG-100")
    );

    let link = run_lnr(
        &[
            "link",
            "ENG-123",
            "https://github.com/cerebral-work/lnr/pull/226",
            "--title",
            "PR #226",
            "--json",
        ],
        "",
        Some("mock"),
    );
    assert_eq!(link.code, 0, "stderr={}", link.err);

    let hist = run_lnr(&["history", "ENG-123", "--json"], "", Some("mock"));
    assert_eq!(hist.code, 0, "stderr={}", hist.err);
    let hist_json: Value = serde_json::from_str(&hist.out).unwrap();
    assert_eq!(hist_json["events"].as_array().unwrap().len(), 1);

    let cycle = run_lnr(&["cycle", "--team", "ENG", "--json"], "", Some("mock"));
    assert_eq!(cycle.code, 0, "stderr={}", cycle.err);
    let cycle_json: Value = serde_json::from_str(&cycle.out).unwrap();
    assert_eq!(cycle_json["cycle"]["number"].as_u64(), Some(12));

    let op = run_lnr(&["operator", "--check", "--json"], "", None);
    assert_eq!(op.code, 0, "stderr={}", op.err);
    let op_json: Value = serde_json::from_str(&op.out).unwrap();
    assert_eq!(op_json["ok"].as_bool(), Some(true));
    assert_eq!(op_json["namespace"].as_str(), Some("linear-system"));

    let crds = run_lnr(&["operator", "--emit-crds", "--json"], "", None);
    assert_eq!(crds.code, 0, "stderr={}", crds.err);
    let crds_json: Value = serde_json::from_str(&crds.out).unwrap();
    assert_eq!(crds_json.as_array().unwrap().len(), 3);

    let reconcile = run_lnr(
        &["operator", "--reconcile", "-", "--json"],
        r#"{"kind":"LinearProject","metadata":{"name":"lnr-proj","namespace":"linear-system"},"spec":{"projectRef":"linearctl","team":"CER","syncInterval":"5m"}}"#,
        None,
    );
    assert_eq!(reconcile.code, 0, "stderr={}", reconcile.err);
    let rec_json: Value = serde_json::from_str(&reconcile.out).unwrap();
    assert_eq!(
        rec_json["status"]["conditions"][0]["type"].as_str(),
        Some("Ready")
    );
    assert_eq!(
        rec_json["status"]["conditions"][0]["status"].as_str(),
        Some("True")
    );

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let db_path = std::env::temp_dir().join(format!("lnr-cache-test-{nanos}.db"));
    let db_str = db_path.to_str().unwrap();

    let sync = run_lnr(
        &["cache", "sync", "--db", db_str, "--json"],
        "",
        Some("mock"),
    );
    assert_eq!(sync.code, 0, "stderr={}", sync.err);

    let query = run_lnr(
        &[
            "cache", "query", "--db", db_str, "--text", "timeout", "--json",
        ],
        "",
        None,
    );
    assert_eq!(query.code, 0, "stderr={}", query.err);
    let query_json: Value = serde_json::from_str(&query.out).unwrap();
    assert_eq!(query_json.as_array().unwrap().len(), 1);

    let clear = run_lnr(&["cache", "clear", "--db", db_str, "--json"], "", None);
    assert_eq!(clear.code, 0, "stderr={}", clear.err);
}
