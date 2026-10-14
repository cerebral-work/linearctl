//! Native Rust stdio Model Context Protocol (MCP) server (`lnr mcp serve`).

use std::io::{self, BufRead, Write};

use lnr_domain::bm25::{Bm25IssueDoc, Bm25IssueIndex};
use lnr_domain::enterprise::MeshCellDiagnostic;
use lnr_domain::error::{error_envelope, CliError};
use lnr_domain::governance::{check_denylist_str, AuditChain};
use lnr_domain::links::{corpus_file, detect_all_edges, CorpusIndex};
use lnr_domain::math::{default_fleet_profile, evaluate_cobham_mg1};
use lnr_domain::org_psych::FiveSubjectSuiteReport;
use lnr_domain::priority::parse_priority;
use lnr_domain::reviews::{plan_linear_code_review, LinearCodeReviewRequest};
use lnr_domain::security::inspect_protocol_payload;
use lnr_domain::token_budget::{budget_json_response, opt_max_tokens};
use lnr_domain::vector_rerank::{judge_and_filter, JudgeCandidate};
use lnr_domain::workstream::{
    WorkstreamQueueConfig, WorkstreamQueueMetrics, DEFAULT_DBR_MAX_UTILIZATION,
    ESTATE_WAVE_CONCURRENCY_CAP,
};
use serde_json::{json, Value};

use crate::graphql::LinearClient;
use crate::store::{list_handoffs, list_templates};

/// Return the MCP tool catalog exposed by `lnr mcp serve`.
#[must_use]
pub fn mcp_tools_list() -> Value {
    json!({
        "tools": [
            {
                "name": "whoami",
                "description": "Verify Linear authentication and return viewer + organization metadata.",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "rate_limit",
                "description": "Return Linear API request and complexity rate-limit budgets.",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "team_list",
                "description": "List all Linear teams in the workspace.",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "project_list",
                "description": "List Linear projects, optionally filtered by team key.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "team": { "type": "string", "description": "Optional team key (e.g. ENG)" }
                    }
                }
            },
            {
                "name": "label_list",
                "description": "List team and workspace labels.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "team": { "type": "string", "description": "Optional team key (e.g. ENG)" }
                    }
                }
            },
            {
                "name": "dupcheck",
                "description": "Score open issues on a team for similarity against a candidate title/description.",
                "inputSchema": {
                    "type": "object",
                    "required": ["team", "title"],
                    "properties": {
                        "team": { "type": "string" },
                        "title": { "type": "string" },
                        "description": { "type": "string" },
                        "threshold": { "type": "number" }
                    }
                }
            },
            {
                "name": "file_issue",
                "description": "Create a new Linear issue with duplicate guard and label/project resolution.",
                "inputSchema": {
                    "type": "object",
                    "required": ["team", "title"],
                    "properties": {
                        "team": { "type": "string" },
                        "title": { "type": "string" },
                        "description": { "type": "string" },
                        "priority": { "type": ["string", "integer"] },
                        "labels": { "type": "array", "items": { "type": "string" } },
                        "project": { "type": "string" },
                        "state": { "type": "string" },
                        "parent": { "type": "string" },
                        "estimate": { "type": "number" },
                        "allow_duplicate": { "type": "boolean" }
                    }
                }
            },
            {
                "name": "issue_get",
                "description": "Fetch full details for a single Linear issue by identifier (e.g. ENG-123) or UUID.",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": { "type": "string" }
                    }
                }
            },
            {
                "name": "comment_issue",
                "description": "Post a markdown comment on a Linear issue.",
                "inputSchema": {
                    "type": "object",
                    "required": ["id", "body"],
                    "properties": {
                        "id": { "type": "string" },
                        "body": { "type": "string" }
                    }
                }
            },
            {
                "name": "issue_close",
                "description": "Transition a Linear issue to Done, optionally posting a shipping comment first.",
                "inputSchema": {
                    "type": "object",
                    "required": ["id"],
                    "properties": {
                        "id": { "type": "string" },
                        "comment": { "type": "string" },
                        "commit": { "type": "string" }
                    }
                }
            },
            {
                "name": "handoff_list",
                "description": "List local agent handoffs stored on disk.",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "template_list",
                "description": "List discovered local and user issue templates.",
                "inputSchema": { "type": "object", "properties": {} }
            },
            {
                "name": "bm25_search",
                "description": "Rank Linear issues or local documents using XERJ Lucene BM25 scoring with _explain breakdowns.",
                "inputSchema": {
                    "type": "object",
                    "required": ["query", "docs"],
                    "properties": {
                        "query": { "type": "string" },
                        "limit": { "type": "integer" },
                        "max_tokens": { "type": "integer" },
                        "docs": {
                            "type": "array",
                            "items": { "type": "object" }
                        }
                    }
                }
            },
            {
                "name": "queue_admission",
                "description": "Evaluate Little's Law, Kingman VUT queue wait, and Goldratt Drum-Buffer-Rope (DBR) admission.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "active_wip": { "type": "integer" },
                        "current_buffer_depth": { "type": "integer" },
                        "arrival_rate_per_hour": { "type": "number" },
                        "service_rate_per_hour": { "type": "number" }
                    }
                }
            },
            {
                "name": "review_flow",
                "description": "Plan a linear-code-review Saga flow with CPM critical path and gate receipt.",
                "inputSchema": {
                    "type": "object",
                    "required": ["title"],
                    "properties": {
                        "issue_id": { "type": "string" },
                        "pr_number": { "type": "integer" },
                        "title": { "type": "string" },
                        "diff_summary": { "type": "string" }
                    }
                }
            },
            {
                "name": "estate_diagnostic",
                "description": "Evaluate Cobham M/G/1 priority queue waiting times, Graicunas/Garicano/Baldwin-Clark modular pod diagnostics, and the 5-Subject Business School & I/O Psychology suite.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "mu_per_sec": { "type": "number" },
                        "service_cv_squared": { "type": "number" }
                    }
                }
            },
            {
                "name": "lexical_rerank",
                "description": "Re-rank and min-p filter candidate chunks using the zero-token deterministic second-stage lexical judge.",
                "inputSchema": {
                    "type": "object",
                    "required": ["query", "candidates"],
                    "properties": {
                        "query": { "type": "string" },
                        "alpha": { "type": "number" },
                        "min_p": { "type": "number" },
                        "candidates": {
                            "type": "array",
                            "items": { "type": "object" }
                        }
                    }
                }
            },
            {
                "name": "link_detect",
                "description": "Extract deterministic [[wikilink]], markdown link, repo path-citation, and Rust crate-citation cross-reference edges from markdown or source code.",
                "inputSchema": {
                    "type": "object",
                    "required": ["path", "text"],
                    "properties": {
                        "path": { "type": "string" },
                        "text": { "type": "string" },
                        "repo": { "type": "string" }
                    }
                }
            },
            {
                "name": "audit_verify",
                "description": "Verify tamper-evident SHA-256 WORM audit hash chain and 12-rule link-safety denylist.",
                "inputSchema": {
                    "type": "object",
                    "properties": {
                        "text": { "type": "string" },
                        "path": { "type": "string" }
                    }
                }
            }
        ]
    })
}

/// Dispatch one MCP `tools/call` invocation and return its JSON payload.
pub fn dispatch_mcp_tool(name: &str, args: &Value) -> Result<Value, CliError> {
    let raw_args = serde_json::to_string(args).unwrap_or_default();
    let inspection = inspect_protocol_payload("tools/call", &raw_args);
    if !inspection.clean {
        return Err(CliError::refused(
            format!(
                "MCP payload rejected by security inspection: {:?}",
                inspection.flags
            ),
            "",
        ));
    }

    match name {
        "whoami" => {
            let client = LinearClient::from_env()?;
            let res = client.whoami()?;
            Ok(serde_json::to_value(res).unwrap_or_else(|_| json!({})))
        }
        "rate_limit" => {
            let client = LinearClient::from_env()?;
            let (info, _) = client.rate_limit()?;
            Ok(serde_json::to_value(info).unwrap_or_else(|_| json!({})))
        }
        "team_list" => {
            let client = LinearClient::from_env()?;
            let teams = client.list_teams()?;
            Ok(serde_json::to_value(teams).unwrap_or_else(|_| json!([])))
        }
        "project_list" => {
            let client = LinearClient::from_env()?;
            let team = args.get("team").and_then(Value::as_str);
            let projects = client.list_projects(team)?;
            Ok(serde_json::to_value(projects).unwrap_or_else(|_| json!({})))
        }
        "label_list" => {
            let client = LinearClient::from_env()?;
            let team = args.get("team").and_then(Value::as_str);
            let labels = client.list_labels(team)?;
            Ok(serde_json::to_value(labels).unwrap_or_else(|_| json!({})))
        }
        "dupcheck" => {
            let client = LinearClient::from_env()?;
            let team = args
                .get("team")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("dupcheck requires 'team'", ""))?;
            let title = args
                .get("title")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("dupcheck requires 'title'", ""))?;
            let desc = args.get("description").and_then(Value::as_str);
            let threshold = args
                .get("threshold")
                .and_then(Value::as_f64)
                .unwrap_or(0.35);
            let res = client.dupcheck(team, title, desc, threshold)?;
            Ok(serde_json::to_value(res).unwrap_or_else(|_| json!({})))
        }
        "file_issue" => {
            let client = LinearClient::from_env()?;
            let team = args
                .get("team")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("file_issue requires 'team'", ""))?;
            let title = args
                .get("title")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("file_issue requires 'title'", ""))?;
            let description = args.get("description").and_then(Value::as_str);
            let priority = match args.get("priority") {
                Some(Value::String(s)) => Some(parse_priority(s)?),
                Some(Value::Number(n)) => Some(parse_priority(&n.to_string())?),
                _ => None,
            };
            let labels: Vec<String> = args
                .get("labels")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let project = args.get("project").and_then(Value::as_str);
            let state = args.get("state").and_then(Value::as_str);
            let parent = args.get("parent").and_then(Value::as_str);
            let estimate = args.get("estimate").and_then(Value::as_f64);
            let allow_duplicate = args
                .get("allow_duplicate")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let created = client.file_issue(
                team,
                title,
                description,
                priority,
                &labels,
                project,
                state,
                parent,
                estimate,
                allow_duplicate,
            )?;
            Ok(serde_json::to_value(created).unwrap_or_else(|_| json!({})))
        }
        "issue_get" => {
            let client = LinearClient::from_env()?;
            let id = args
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("issue_get requires 'id'", ""))?;
            client.get_issue(id)
        }
        "comment_issue" => {
            let client = LinearClient::from_env()?;
            let id = args
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("comment_issue requires 'id'", ""))?;
            let body = args
                .get("body")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("comment_issue requires 'body'", ""))?;
            client.comment_issue(id, body)
        }
        "issue_close" => {
            let client = LinearClient::from_env()?;
            let id = args
                .get("id")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("issue_close requires 'id'", ""))?;
            let comment = args.get("comment").and_then(Value::as_str);
            let commit = args.get("commit").and_then(Value::as_str);
            client.close_issue(id, comment, commit)
        }
        "handoff_list" => {
            let items: Vec<Value> = list_handoffs(None, None)?
                .into_iter()
                .map(|(h, p)| {
                    let mut v = serde_json::to_value(h).unwrap_or_else(|_| json!({}));
                    if let Some(obj) = v.as_object_mut() {
                        obj.insert("path".to_string(), Value::String(p.display().to_string()));
                    }
                    v
                })
                .collect();
            Ok(Value::Array(items))
        }
        "template_list" => {
            let items = list_templates()?;
            Ok(serde_json::to_value(items).unwrap_or_else(|_| json!([])))
        }
        "bm25_search" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("bm25_search requires 'query'", ""))?;
            let limit = args
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .unwrap_or(10);
            let docs_val = args
                .get("docs")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            let docs: Vec<Bm25IssueDoc> = serde_json::from_value(docs_val)
                .map_err(|e| CliError::usage(format!("invalid 'docs' array: {e}"), ""))?;
            let index = Bm25IssueIndex::build(docs);
            let hits = index.search(query, limit);
            Ok(json!({ "issues": hits }))
        }
        "queue_admission" => {
            let active_wip = args
                .get("active_wip")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .unwrap_or(2);
            let current_buffer_depth = args
                .get("current_buffer_depth")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .unwrap_or(1);
            let arrival_rate_per_hour = args
                .get("arrival_rate_per_hour")
                .and_then(Value::as_f64)
                .unwrap_or(10.0);
            let service_rate_per_hour = args
                .get("service_rate_per_hour")
                .and_then(Value::as_f64)
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
            Ok(serde_json::to_value(metrics).unwrap_or_else(|_| json!({})))
        }
        "review_flow" => {
            let title = args
                .get("title")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("review_flow requires 'title'", ""))?;
            let req = LinearCodeReviewRequest {
                issue_id: args
                    .get("issue_id")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                pr_number: args.get("pr_number").and_then(Value::as_u64),
                title: title.to_string(),
                diff_summary: args
                    .get("diff_summary")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            };
            let receipt =
                plan_linear_code_review(&req).map_err(|e| CliError::usage(e.to_string(), ""))?;
            Ok(serde_json::to_value(receipt).unwrap_or_else(|_| json!({})))
        }
        "estate_diagnostic" => {
            let agents = args
                .get("agents")
                .and_then(Value::as_u64)
                .and_then(|n| usize::try_from(n).ok())
                .unwrap_or(5);
            let switch_cost_sec = args
                .get("switch_cost_sec")
                .and_then(Value::as_f64)
                .unwrap_or(18.0);
            let cobham = evaluate_cobham_mg1(&default_fleet_profile(agents, true), switch_cost_sec);
            let w26_before = MeshCellDiagnostic::evaluate(
                lnr_domain::enterprise::SubjectMatterMesh::OrchestrationAndMemory,
                19,
                19,
                switch_cost_sec,
            );
            let pods_after = MeshCellDiagnostic::evaluate(
                lnr_domain::enterprise::SubjectMatterMesh::ControlAndGovernance,
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
            Ok(json!({
                "cobham": cobham,
                "w26_star_hub_before": w26_before,
                "canonical_five_pods_after": pods_after,
                "five_subject_suite": five_subject,
            }))
        }
        "lexical_rerank" => {
            let query = args
                .get("query")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("lexical_rerank requires 'query'", ""))?;
            let cands_val = args
                .get("candidates")
                .cloned()
                .unwrap_or_else(|| Value::Array(Vec::new()));
            let candidates: Vec<JudgeCandidate> = serde_json::from_value(cands_val)
                .map_err(|e| CliError::usage(format!("invalid 'candidates': {e}"), ""))?;
            let min_p = args.get("min_p").and_then(Value::as_f64);
            let ranked = judge_and_filter(query, &candidates, min_p);
            Ok(json!({ "candidates": ranked }))
        }
        "link_detect" => {
            let path = args
                .get("path")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("link_detect requires 'path'", ""))?;
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .ok_or_else(|| CliError::usage("link_detect requires 'text'", ""))?;
            let repo = args.get("repo").and_then(Value::as_str).unwrap_or("lnr");
            let file = corpus_file(path, path, repo, "docs", 0);
            let index = CorpusIndex::build(vec![file.clone()]);
            let (edges, counters) = detect_all_edges(&index, &file, &file.anchor_doc_id, text);
            Ok(json!({
                "edges": edges,
                "counters": counters,
            }))
        }
        "audit_verify" => {
            let text = args.get("text").and_then(Value::as_str).unwrap_or("");
            let path = args.get("path").and_then(Value::as_str).unwrap_or("doc.md");
            let denylist_errors = check_denylist_str(text, path);
            let mut chain = AuditChain::new(8);
            let entry = chain
                .append(0, "audit_verify", "mcp", path, "ok", "")
                .clone();
            let chain_valid = chain.verify().is_ok();
            Ok(json!({
                "denylist_clean": denylist_errors.is_empty(),
                "denylist_errors": denylist_errors,
                "audit_entry": entry,
                "chain_valid": chain_valid,
            }))
        }
        other => Err(CliError::not_found(
            format!("unknown MCP tool '{other}'"),
            "",
        )),
    }
}

/// Run the JSON-RPC 2.0 MCP server loop over `stdin` / `stdout`.
pub fn serve_mcp_stdio(version: &str) -> Result<(), CliError> {
    let stdin = io::stdin();
    let mut stdout = io::stdout();

    for line_res in stdin.lock().lines() {
        let Ok(line) = line_res else {
            break;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(req) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let id = req.get("id").cloned();
        let method = req
            .get("method")
            .and_then(Value::as_str)
            .unwrap_or_default();

        // Notifications have no `id` and expect no response.
        let Some(req_id) = id else {
            continue;
        };

        let response = match method {
            "initialize" => json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": { "tools": {} },
                    "serverInfo": {
                        "name": "lnr",
                        "version": version
                    }
                }
            }),
            "ping" => json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {}
            }),
            "tools/list" => json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "result": mcp_tools_list()
            }),
            "tools/call" => {
                let params = req.get("params").cloned().unwrap_or_else(|| json!({}));
                let tool_name = params
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let max_tokens_res = opt_max_tokens(&arguments);
                match max_tokens_res {
                    Err(msg) => json!({
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "result": {
                            "content": [{ "type": "text", "text": msg }],
                            "isError": true
                        }
                    }),
                    Ok(max_tokens) => match dispatch_mcp_tool(tool_name, &arguments) {
                        Ok(val) => {
                            let raw_text = serde_json::to_string_pretty(&val)
                                .unwrap_or_else(|_| val.to_string());
                            let text = match max_tokens {
                                Some(budget) => budget_json_response(&raw_text, budget),
                                None => raw_text,
                            };
                            json!({
                                "jsonrpc": "2.0",
                                "id": req_id,
                                "result": {
                                    "content": [{ "type": "text", "text": text }],
                                    "isError": false
                                }
                            })
                        }
                        Err(err) => {
                            let text =
                                serde_json::to_string_pretty(&error_envelope(&err, "", None))
                                    .unwrap_or_else(|_| err.message.clone());
                            json!({
                                "jsonrpc": "2.0",
                                "id": req_id,
                                "result": {
                                    "content": [{ "type": "text", "text": text }],
                                    "isError": true
                                }
                            })
                        }
                    },
                }
            }
            _ => json!({
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32601,
                    "message": format!("Method not found: {method}")
                }
            }),
        };

        if let Ok(serialized) = serde_json::to_string(&response) {
            let _ = writeln!(stdout, "{serialized}");
            let _ = stdout.flush();
        }
    }
    Ok(())
}
