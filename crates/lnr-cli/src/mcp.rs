//! Native Rust stdio Model Context Protocol (MCP) server (`lnr mcp serve`).

use std::io::{self, BufRead, Write};

use lnr_domain::error::{error_envelope, CliError};
use lnr_domain::priority::parse_priority;
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
            }
        ]
    })
}

/// Dispatch one MCP `tools/call` invocation and return its JSON payload.
pub fn dispatch_mcp_tool(name: &str, args: &Value) -> Result<Value, CliError> {
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
                match dispatch_mcp_tool(tool_name, &arguments) {
                    Ok(val) => {
                        let text =
                            serde_json::to_string_pretty(&val).unwrap_or_else(|_| val.to_string());
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
                        let text = serde_json::to_string_pretty(&error_envelope(&err, "", None))
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
