//! Linear GraphQL HTTP adapter and `LINEARCTL_TEST_SCENARIO` offline test harness.

use std::collections::{BTreeMap, HashMap};
use std::io::Write;
use std::process::{Command, Stdio};

use lnr_domain::closest::closest_names;
use lnr_domain::error::{
    assert_batch_succeeded, classify_api_error, ApiErrorInput, BatchFailure, CliError,
};
use lnr_domain::intake::IntakeCandidate;
use lnr_domain::labels::{pick_label_ids, NamedLabel};
use lnr_domain::models::{
    build_batch_mutation, build_resolve_query, is_exhausted, is_uuid, parse_rate_limit_headers,
    triage_reasons, BatchFileItem, BatchFileOutcome, BatchResult, BatchRowFailure, BulkPlan,
    BulkPlanRow, BulkSpecItem, CreatedIssue, DupMatch, DupcheckResult, LabelInfo, LabelListing,
    OrganizationSummary, ProjectListing, ProjectSummary, PullIssue, RateLimitInfo, SearchItem,
    TeamSummary, TriageItem, WhoamiResult,
};
use lnr_domain::similarity::score_candidates;
use serde_json::{json, Value};

const DEFAULT_API_URL: &str = "https://api.linear.app/graphql";

/// Raw HTTP + GraphQL response from Linear.
#[derive(Debug, Clone)]
pub struct RawGraphqlResponse {
    /// Response headers (lowercased keys).
    pub headers: HashMap<String, String>,
    /// Parsed `data` object from the GraphQL response payload.
    pub data: Value,
}

/// Linear GraphQL client backed by `curl --config -` (passing secrets over stdin, never argv).
#[derive(Debug, Clone)]
pub struct LinearClient {
    api_key: String,
    api_url: String,
    scenario: Option<String>,
}

impl LinearClient {
    /// Construct a client from `LINEAR_API_KEY` (or `LINEARCTL_TEST_SCENARIO` in test mode).
    pub fn from_env() -> Result<Self, CliError> {
        let scenario = std::env::var("LINEARCTL_TEST_SCENARIO")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        let api_key = std::env::var("LINEAR_API_KEY")
            .ok()
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if api_key.is_empty() && scenario.is_none() {
            return Err(CliError::auth(
                "Missing LINEAR_API_KEY.",
                "Set LINEAR_API_KEY in the environment (or run `linearctl whoami` to test auth).",
            ));
        }
        let api_url = std::env::var("LINEAR_API_URL")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| DEFAULT_API_URL.to_string());
        Ok(Self {
            api_key,
            api_url,
            scenario,
        })
    }

    /// Execute a GraphQL query or mutation and return both response headers and `data`.
    pub fn execute_raw(
        &self,
        query: &str,
        variables: Value,
    ) -> Result<RawGraphqlResponse, CliError> {
        if let Some(scenario) = &self.scenario {
            return self.execute_scenario(scenario, query, &variables);
        }

        let payload = serde_json::to_string(&json!({
            "query": query,
            "variables": variables,
        }))
        .map_err(|e| CliError::other(format!("failed to serialize GraphQL payload: {e}"), ""))?;

        let escaped_body = payload.replace('\\', "\\\\").replace('"', "\\\"");
        let curl_config = format!(
            "url = \"{}\"\nrequest = \"POST\"\nheader = \"Content-Type: application/json\"\nheader = \"Authorization: {}\"\ndata = \"{}\"\nsilent\nshow-error\ndump-header = \"-\"\n",
            self.api_url, self.api_key, escaped_body
        );

        let mut child = Command::new("curl")
            .arg("--config")
            .arg("-")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| CliError::other(format!("failed to spawn curl: {e}"), ""))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(curl_config.as_bytes())
                .map_err(|e| CliError::other(format!("failed writing to curl stdin: {e}"), ""))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|e| CliError::other(format!("failed waiting on curl: {e}"), ""))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            return Err(CliError::other(
                format!("HTTP transport failed: {stderr}"),
                "Verify network connectivity and LINEAR_API_URL.",
            ));
        }

        let raw_stdout = String::from_utf8_lossy(&output.stdout);
        let (headers, status_code, body_str) = split_http_response(&raw_stdout);

        let parsed: Value = serde_json::from_str(body_str).unwrap_or_else(|_| json!({}));
        if let Some(errors) = parsed.get("errors").and_then(Value::as_array) {
            if let Some(first) = errors.first() {
                let msg = first
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("GraphQL error")
                    .to_string();
                let mut types = Vec::new();
                if let Some(ext) = first.get("extensions") {
                    if let Some(code) = ext.get("code").and_then(Value::as_str) {
                        types.push(code.to_string());
                    }
                    if let Some(tp) = ext.get("type").and_then(Value::as_str) {
                        types.push(tp.to_string());
                    }
                }
                let user_err = first
                    .get("extensions")
                    .and_then(|ext| ext.get("userError"))
                    .and_then(Value::as_bool);
                return Err(classify_api_error(&ApiErrorInput {
                    status: status_code,
                    types,
                    message: msg.clone(),
                    first_error_message: Some(msg),
                    user_error: user_err,
                    name: None,
                }));
            }
        }

        if let Some(code) = status_code {
            if code >= 400 {
                return Err(classify_api_error(&ApiErrorInput {
                    status: Some(code),
                    types: Vec::new(),
                    message: format!("HTTP {code} from Linear API"),
                    first_error_message: None,
                    user_error: None,
                    name: None,
                }));
            }
        }

        let data = parsed.get("data").cloned().unwrap_or_else(|| json!({}));
        Ok(RawGraphqlResponse { headers, data })
    }

    /// Execute a GraphQL query or mutation and return `data`.
    pub fn execute(&self, query: &str, variables: Value) -> Result<Value, CliError> {
        Ok(self.execute_raw(query, variables)?.data)
    }

    fn execute_scenario(
        &self,
        scenario: &str,
        query: &str,
        variables: &Value,
    ) -> Result<RawGraphqlResponse, CliError> {
        let mut headers = HashMap::new();
        headers.insert("x-ratelimit-requests-limit".to_string(), "1500".to_string());
        headers.insert(
            "x-ratelimit-requests-remaining".to_string(),
            "1490".to_string(),
        );
        headers.insert(
            "x-ratelimit-complexity-limit".to_string(),
            "250000".to_string(),
        );
        headers.insert(
            "x-ratelimit-complexity-remaining".to_string(),
            "249500".to_string(),
        );

        match scenario {
            "auth" => Err(classify_api_error(&ApiErrorInput {
                status: Some(401),
                types: vec![
                    "AUTHENTICATION_ERROR".to_string(),
                    "authentication error".to_string(),
                ],
                message: "Invalid API key".to_string(),
                first_error_message: Some("Invalid API key".to_string()),
                user_error: None,
                name: None,
            })),
            "rate_limit" => Err(classify_api_error(&ApiErrorInput {
                status: Some(429),
                types: vec!["RATELIMITED".to_string()],
                message: "Rate limited".to_string(),
                first_error_message: Some("Rate limited".to_string()),
                user_error: None,
                name: None,
            })),
            "userinput" => Err(classify_api_error(&ApiErrorInput {
                status: Some(400),
                types: vec!["userinput".to_string()],
                message: "Duplicate label name - Label \"example-label\" already exists in team Example Team".to_string(),
                first_error_message: Some("Duplicate label name - Label \"example-label\" already exists in team Example Team".to_string()),
                user_error: Some(true),
                name: None,
            })),
            "other" => Err(CliError::other(
                "fixture transport failure",
                "Re-run with network access; check LINEAR_API_KEY and Linear status if it persists.",
            )),
            "team" => {
                if query.contains("teams") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "teams": {
                                "nodes": [
                                    { "id": "t1", "key": "ENG", "name": "Engineering" },
                                    { "id": "t2", "key": "OPS", "name": "Operations" }
                                ]
                            }
                        }),
                    })
                } else {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({}),
                    })
                }
            }
            "label" => {
                if query.contains("teams") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "teams": {
                                "nodes": [
                                    { "id": "t1", "key": "ENG", "name": "Engineering" }
                                ]
                            }
                        }),
                    })
                } else {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "team": {
                                "labels": {
                                    "nodes": [
                                        { "id": "skill", "name": "skill", "color": "#eb5757" },
                                        { "id": "skills-ui", "name": "skills-ui", "color": "#6fcf97" },
                                        { "id": "skies", "name": "skies", "color": "#f2c94c" },
                                        { "id": "unrelated", "name": "unrelated", "color": "#bb6bd9" }
                                    ]
                                }
                            },
                            "organization": {
                                "labels": {
                                    "nodes": []
                                }
                            }
                        }),
                    })
                }
            }
            "bulk" => {
                let _ = variables;
                if query.contains("query Resolve") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "r0": {
                                "id": "issue-uuid",
                                "identifier": "ENG-123"
                            }
                        }),
                    })
                } else {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "m0": { "success": true }
                        }),
                    })
                }
            }
            "dup" => {
                if query.contains("teams") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "teams": {
                                "nodes": [
                                    { "id": "t1", "key": "ENG", "name": "Engineering" }
                                ]
                            }
                        }),
                    })
                } else {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "issues": {
                                "nodes": [
                                    {
                                        "id": "i1",
                                        "identifier": "ENG-123",
                                        "title": "Fix timeout",
                                        "description": "",
                                        "url": "https://example.com/ENG-123",
                                        "state": { "name": "Todo", "type": "unstarted" }
                                    }
                                ]
                            }
                        }),
                    })
                }
            }
            "mock" => {
                let _ = variables;
                if query.contains("teams") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "teams": {
                                "nodes": [
                                    { "id": "t1", "key": "ENG", "name": "Engineering" },
                                    { "id": "t2", "key": "OPS", "name": "Operations" }
                                ]
                            }
                        }),
                    })
                } else if query.contains("viewer") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "viewer": {
                                "id": "u1",
                                "name": "Alice",
                                "displayName": "Alice",
                                "email": "alice@example.com",
                                "admin": true
                            },
                            "organization": {
                                "id": "o1",
                                "name": "Example Org",
                                "urlKey": "example"
                            }
                        }),
                    })
                } else if query.contains("IssueHistory") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "issue": {
                                "id": "i1",
                                "identifier": "ENG-123",
                                "title": "Fix timeout",
                                "history": {
                                    "nodes": [
                                        {
                                            "id": "h1",
                                            "createdAt": "2026-10-14T00:00:00.000Z",
                                            "actor": { "name": "Alice", "displayName": "Alice" },
                                            "fromState": { "name": "Todo" },
                                            "toState": { "name": "In Progress" }
                                        }
                                    ]
                                }
                            }
                        }),
                    })
                } else if query.contains("TeamCycles") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "team": {
                                "activeCycle": {
                                    "id": "c1",
                                    "number": 12,
                                    "name": "Sprint 12",
                                    "startsAt": "2026-10-01T00:00:00.000Z",
                                    "endsAt": "2026-10-15T00:00:00.000Z",
                                    "issues": {
                                        "nodes": [
                                            { "identifier": "ENG-123", "state": { "type": "started" }, "estimate": 3 }
                                        ]
                                    }
                                },
                                "cycles": { "nodes": [] }
                            }
                        }),
                    })
                } else if query.contains("Initiatives") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "initiatives": {
                                "nodes": [
                                    { "id": "init-1", "name": "Rust Cutover", "status": "Active" }
                                ]
                            }
                        }),
                    })
                } else if query.contains("Documents") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "documents": {
                                "nodes": [
                                    {
                                        "id": "d1",
                                        "slugId": "doc-1",
                                        "title": "Architecture",
                                        "url": "https://example.com/doc-1",
                                        "updatedAt": "2026-10-14T00:00:00.000Z"
                                    }
                                ]
                            }
                        }),
                    })
                } else if query.contains("ProjectOverview") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "projects": {
                                "nodes": [
                                    {
                                        "id": "p1",
                                        "name": "linearctl",
                                        "url": "https://example.com/p1",
                                        "content": "# Overview"
                                    }
                                ]
                            }
                        }),
                    })
                } else if query.contains("CommentsByAuthor") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "comments": {
                                "nodes": [
                                    {
                                        "id": "cm1",
                                        "body": "Verified live",
                                        "createdAt": "2026-10-14T00:00:00.000Z",
                                        "url": "https://example.com/cm1",
                                        "user": { "id": "u1", "name": "Alice", "displayName": "Alice", "email": "alice@example.com" },
                                        "issue": { "identifier": "ENG-123", "title": "Fix timeout" }
                                    }
                                ]
                            }
                        }),
                    })
                } else if query.contains("issue(id:") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "issue": {
                                "id": "00000000-0000-4000-8000-000000000123",
                                "identifier": "ENG-123",
                                "title": "Fix timeout",
                                "priority": 2,
                                "estimate": 3.0,
                                "state": { "name": "Todo", "type": "unstarted" },
                                "assignee": null,
                                "project": { "name": "Core Platform" },
                                "labels": { "nodes": [{ "name": "agent-eligible" }, { "name": "bug" }] }
                            }
                        }),
                    })
                } else if query.contains("TriageIssues") {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "issues": {
                                "nodes": [
                                    {
                                        "id": "00000000-0000-4000-8000-000000000123",
                                        "identifier": "ENG-123",
                                        "title": "Fix timeout",
                                        "description": "Investigate timeout in transport",
                                        "url": "https://example.com/ENG-123",
                                        "priority": 2,
                                        "estimate": 3.0,
                                        "updatedAt": "2026-10-14T00:00:00.000Z",
                                        "state": { "name": "Todo", "type": "unstarted" },
                                        "assignee": null,
                                        "project": { "name": "Core Platform" },
                                        "labels": { "nodes": [{ "name": "agent-eligible" }, { "name": "bug" }] }
                                    }
                                ]
                            }
                        }),
                    })
                } else {
                    Ok(RawGraphqlResponse {
                        headers,
                        data: json!({
                            "issues": {
                                "nodes": [
                                    {
                                        "id": "00000000-0000-4000-8000-000000000123",
                                        "identifier": "ENG-123",
                                        "title": "Fix timeout",
                                        "description": "Investigate timeout in transport",
                                        "url": "https://example.com/ENG-123",
                                        "priority": 2,
                                        "estimate": 3.0,
                                        "updatedAt": "2026-10-14T00:00:00.000Z",
                                        "state": { "name": "In Progress", "type": "started" },
                                        "assignee": { "displayName": "Alice", "name": "Alice" },
                                        "project": { "name": "Core Platform" },
                                        "labels": { "nodes": [{ "name": "bug" }] }
                                    }
                                ]
                            },
                            "issueRelationCreate": { "success": true },
                            "attachmentLinkURL": { "success": true }
                        }),
                    })
                }
            }
            _ => Err(CliError::other(
                "fixture transport failure",
                "Re-run with network access; check LINEAR_API_KEY and Linear status if it persists.",
            )),
        }
    }

    /// Return the authenticated user (`lnr whoami`).
    pub fn whoami(&self) -> Result<WhoamiResult, CliError> {
        let data = self.execute(
            "query Whoami { viewer { id name email displayName admin } organization { id name urlKey } }",
            json!({}),
        )?;
        let viewer = data.get("viewer").ok_or_else(|| {
            CliError::auth(
                "Linear authentication failed.",
                "Set a valid LINEAR_API_KEY in the environment.",
            )
        })?;
        let org = data
            .get("organization")
            .cloned()
            .unwrap_or_else(|| json!({}));
        Ok(WhoamiResult {
            id: str_field(viewer, "id"),
            name: str_field(viewer, "name"),
            display_name: str_field(viewer, "displayName"),
            email: str_field(viewer, "email"),
            admin: viewer
                .get("admin")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            organization: OrganizationSummary {
                id: str_field(&org, "id"),
                name: str_field(&org, "name"),
                url_key: str_field(&org, "urlKey"),
            },
        })
    }

    /// Probe Linear API rate-limit headers (`lnr ratelimit`).
    pub fn rate_limit(&self) -> Result<(RateLimitInfo, bool), CliError> {
        let raw = self.execute_raw("query RateLimitProbe { viewer { id } }", json!({}))?;
        let info = parse_rate_limit_headers(|name| {
            raw.headers
                .get(&name.to_ascii_lowercase())
                .map(String::as_str)
        });
        let exhausted = is_exhausted(&info);
        Ok((info, exhausted))
    }

    /// List workspace teams (`lnr team list`).
    pub fn list_teams(&self) -> Result<Vec<TeamSummary>, CliError> {
        let data = self.execute(
            "query Teams { teams(first: 250) { nodes { id key name displayName description } } }",
            json!({}),
        )?;
        let mut teams: Vec<TeamSummary> = nodes_at(&data, &["teams", "nodes"])
            .into_iter()
            .map(|n| TeamSummary {
                id: str_field(&n, "id"),
                key: str_field(&n, "key"),
                name: str_field(&n, "name"),
                display_name: opt_str_field(&n, "displayName"),
                description: opt_str_field(&n, "description"),
            })
            .collect();
        teams.sort_by(|a, b| a.key.cmp(&b.key));
        Ok(teams)
    }

    /// Resolve a team by key or name (case-insensitive), returning a helpful `not_found` error with available keys on miss.
    pub fn resolve_team(&self, key_or_name: &str) -> Result<TeamSummary, CliError> {
        let teams = self.list_teams()?;
        let needle = key_or_name.trim().to_ascii_lowercase();
        if let Some(found) = teams
            .iter()
            .find(|t| t.key.to_ascii_lowercase() == needle || t.name.to_ascii_lowercase() == needle)
        {
            return Ok(found.clone());
        }
        let keys: Vec<String> = teams.iter().map(|t| t.key.clone()).collect();
        let avail = if keys.is_empty() {
            "none".to_string()
        } else {
            keys.join(", ")
        };
        Err(CliError::not_found(
            format!("team '{key_or_name}' not found (available: {avail})"),
            "Run: linearctl team list",
        ))
    }

    /// List labels for a team and the workspace (`lnr label list`).
    pub fn list_labels(&self, team_key: Option<&str>) -> Result<LabelListing, CliError> {
        let mut labels = Vec::new();
        if let Some(tk) = team_key {
            let team = self.resolve_team(tk)?;
            let data = self.execute(
                "query Labels($teamId: String!) {
                    team(id: $teamId) { labels(first: 250) { nodes { id name color } } }
                    organization { labels(first: 250) { nodes { id name color } } }
                }",
                json!({ "teamId": team.id }),
            )?;
            for n in nodes_at(&data, &["team", "labels", "nodes"]) {
                labels.push(LabelInfo {
                    id: str_field(&n, "id"),
                    name: str_field(&n, "name"),
                    color: opt_str_field(&n, "color"),
                    team: Some(team.key.clone()),
                    issues: None,
                });
            }
            for n in nodes_at(&data, &["organization", "labels", "nodes"]) {
                labels.push(LabelInfo {
                    id: str_field(&n, "id"),
                    name: str_field(&n, "name"),
                    color: opt_str_field(&n, "color"),
                    team: None,
                    issues: None,
                });
            }
        } else {
            let data = self.execute(
                "query OrgLabels { organization { labels(first: 250) { nodes { id name color } } } }",
                json!({}),
            )?;
            for n in nodes_at(&data, &["organization", "labels", "nodes"]) {
                labels.push(LabelInfo {
                    id: str_field(&n, "id"),
                    name: str_field(&n, "name"),
                    color: opt_str_field(&n, "color"),
                    team: None,
                    issues: None,
                });
            }
        }
        labels.sort_by(|a, b| {
            a.name
                .to_ascii_lowercase()
                .cmp(&b.name.to_ascii_lowercase())
        });
        Ok(LabelListing {
            labels,
            partial: false,
        })
    }

    /// Resolve label names into label IDs for a given team, failing with closest-name suggestions if any are missing.
    pub fn resolve_label_ids(
        &self,
        team_key: &str,
        wanted_names: &[String],
    ) -> Result<Vec<String>, CliError> {
        if wanted_names.is_empty() {
            return Ok(Vec::new());
        }
        let listing = self.list_labels(Some(team_key))?;
        let pool: Vec<NamedLabel> = listing
            .labels
            .into_iter()
            .map(|l| NamedLabel {
                id: l.id,
                name: l.name,
            })
            .collect();
        pick_label_ids(&pool, wanted_names, Some(team_key))
    }

    /// List projects (`lnr project list`).
    pub fn list_projects(&self, team_key: Option<&str>) -> Result<ProjectListing, CliError> {
        let nodes = if let Some(tk) = team_key {
            let team = self.resolve_team(tk)?;
            let data = self.execute(
                "query TeamProjects($teamId: String!) {
                    team(id: $teamId) {
                        projects(first: 100) {
                            nodes { id name state url progress }
                        }
                    }
                }",
                json!({ "teamId": team.id }),
            )?;
            nodes_at(&data, &["team", "projects", "nodes"])
        } else {
            let data = self.execute(
                "query AllProjects {
                    projects(first: 100) {
                        nodes { id name state url progress }
                    }
                }",
                json!({}),
            )?;
            nodes_at(&data, &["projects", "nodes"])
        };

        let projects = nodes
            .into_iter()
            .map(|n| ProjectSummary {
                id: str_field(&n, "id"),
                name: str_field(&n, "name"),
                url: str_field(&n, "url"),
                state: str_field(&n, "state"),
                progress: n.get("progress").and_then(Value::as_f64).unwrap_or(0.0),
            })
            .collect();
        Ok(ProjectListing {
            projects,
            partial: false,
        })
    }

    /// Resolve a project by UUID or name (case-insensitive).
    pub fn resolve_project(
        &self,
        name_or_id: &str,
        team_key: Option<&str>,
    ) -> Result<ProjectSummary, CliError> {
        let listing = self.list_projects(team_key)?;
        let needle = name_or_id.trim();
        let lower = needle.to_ascii_lowercase();
        if let Some(found) = listing
            .projects
            .iter()
            .find(|p| p.id == needle || p.name.to_ascii_lowercase() == lower)
        {
            return Ok(found.clone());
        }
        let candidates: Vec<String> = listing.projects.iter().map(|p| p.name.clone()).collect();
        let near = closest_names(&[needle], &candidates);
        let near_note = if near.is_empty() {
            String::new()
        } else {
            format!(" (closest: {})", near.join(", "))
        };
        Err(CliError::not_found(
            format!("project '{needle}' not found{near_note}"),
            "Run: linearctl project list",
        ))
    }

    /// Check for potential duplicate issues on a team (`lnr dupcheck` / `lnr file` pre-create check).
    pub fn dupcheck(
        &self,
        team_key: &str,
        title: &str,
        description: Option<&str>,
        threshold: f64,
    ) -> Result<DupcheckResult, CliError> {
        let team = self.resolve_team(team_key)?;
        let data = self.execute(
            "query RecentTeamIssues($teamId: ID!) {
                issues(
                    filter: {
                        team: { id: { eq: $teamId } }
                        state: { type: { nin: [\"completed\", \"canceled\"] } }
                    }
                    first: 100
                ) {
                    nodes {
                        id
                        identifier
                        title
                        description
                        url
                        state { name type }
                    }
                }
            }",
            json!({ "teamId": team.id }),
        )?;

        let nodes = nodes_at(&data, &["issues", "nodes"]);
        let query_text = match description {
            Some(d) if !d.trim().is_empty() => format!("{title} {d}"),
            _ => title.to_string(),
        };
        let scored = score_candidates(
            &query_text,
            nodes,
            |n| n.get("title").and_then(Value::as_str).unwrap_or(""),
            threshold,
            5,
        );
        let matches = scored
            .into_iter()
            .map(|s| DupMatch {
                identifier: str_field(&s.item, "identifier"),
                score: (s.score * 100.0).round() / 100.0,
                title: str_field(&s.item, "title"),
                url: str_field(&s.item, "url"),
            })
            .collect();

        Ok(DupcheckResult {
            query: title.to_string(),
            threshold,
            matches,
        })
    }

    /// Create a single Linear issue (`lnr file`).
    #[allow(clippy::too_many_arguments)]
    pub fn file_issue(
        &self,
        team_key: &str,
        title: &str,
        description: Option<&str>,
        priority: Option<u8>,
        labels: &[String],
        project: Option<&str>,
        state: Option<&str>,
        parent: Option<&str>,
        estimate: Option<f64>,
        allow_duplicate: bool,
    ) -> Result<CreatedIssue, CliError> {
        let team = self.resolve_team(team_key)?;
        if !allow_duplicate {
            let dup = self.dupcheck(&team.key, title, description, 0.5)?;
            if let Some(top) = dup.matches.first() {
                let norm_new = title.trim().to_ascii_lowercase();
                let norm_old = top.title.trim().to_ascii_lowercase();
                if norm_new == norm_old || top.score >= 0.65 {
                    return Err(CliError::refused(
                        format!(
                            "refusing to file likely duplicate of {} \"{}\"",
                            top.identifier,
                            top.title.trim()
                        ),
                        format!(
                            "Existing issue: {}. Re-run with --force to file anyway.",
                            top.url
                        ),
                    ));
                }
            }
        }

        let label_ids = self.resolve_label_ids(&team.key, labels)?;
        let mut input = serde_json::Map::new();
        input.insert("teamId".to_string(), Value::String(team.id.clone()));
        input.insert("title".to_string(), Value::String(title.to_string()));
        if let Some(desc) = description.filter(|s| !s.trim().is_empty()) {
            input.insert("description".to_string(), Value::String(desc.to_string()));
        }
        if let Some(p) = priority {
            input.insert("priority".to_string(), Value::Number(p.into()));
        }
        if !label_ids.is_empty() {
            input.insert(
                "labelIds".to_string(),
                Value::Array(label_ids.into_iter().map(Value::String).collect()),
            );
        }
        if let Some(proj) = project {
            let p = self.resolve_project(proj, Some(&team.key))?;
            input.insert("projectId".to_string(), Value::String(p.id));
        }
        if let Some(est) = estimate {
            if let Some(num) = serde_json::Number::from_f64(est) {
                input.insert("estimate".to_string(), Value::Number(num));
            }
        }
        if let Some(st_name) = state {
            let st_id = self.resolve_team_state_id(&team.id, &team.key, st_name)?;
            input.insert("stateId".to_string(), Value::String(st_id));
        }
        if let Some(parent_ref) = parent {
            let parent_uuid = self.resolve_issue_uuid(parent_ref)?;
            input.insert("parentId".to_string(), Value::String(parent_uuid));
        }

        let data = self.execute(
            "mutation IssueCreate($input: IssueCreateInput!) {
                issueCreate(input: $input) {
                    success
                    issue { id identifier title url }
                }
            }",
            json!({ "input": Value::Object(input) }),
        )?;

        let issue = data
            .get("issueCreate")
            .and_then(|ic| ic.get("issue"))
            .ok_or_else(|| CliError::other("issueCreate returned no issue", ""))?;

        Ok(CreatedIssue {
            id: str_field(issue, "id"),
            identifier: str_field(issue, "identifier"),
            title: str_field(issue, "title"),
            url: str_field(issue, "url"),
        })
    }

    /// Execute a batch of `file` specs (`lnr file --stdin --apply`).
    pub fn file_issues_batch(
        &self,
        items: &[BatchFileItem],
        default_team: Option<&str>,
    ) -> Result<Vec<BatchFileOutcome>, CliError> {
        let mut outcomes = Vec::with_capacity(items.len());
        let mut failures = Vec::new();
        for item in items {
            let team = item
                .team
                .as_deref()
                .or(default_team)
                .unwrap_or("ENG")
                .to_string();
            let labels = item.labels.clone().unwrap_or_default();
            match self.file_issue(
                &team,
                &item.title,
                item.desc.as_deref(),
                item.priority,
                &labels,
                item.project.as_deref(),
                None,
                item.parent.as_deref(),
                None,
                true,
            ) {
                Ok(created) => outcomes.push(BatchFileOutcome {
                    title: item.title.clone(),
                    team,
                    created: Some(created),
                    error: None,
                    kind: None,
                }),
                Err(err) => {
                    failures.push(BatchFailure {
                        error: Some(err.message.clone()),
                        kind: Some(err.kind),
                    });
                    outcomes.push(BatchFileOutcome {
                        title: item.title.clone(),
                        team,
                        created: None,
                        error: Some(err.message),
                        kind: Some(err.kind),
                    });
                }
            }
        }
        assert_batch_succeeded(&failures, &[])?;
        Ok(outcomes)
    }

    /// Plan a bulk update from `BulkSpecItem` entries (`lnr update --stdin`).
    pub fn plan_bulk_updates(&self, specs: &[BulkSpecItem]) -> Result<BulkPlan, CliError> {
        if specs.is_empty() {
            return Err(CliError::usage(
                "update --stdin received an empty plan.",
                "Example: cat plan.json | linearctl update --stdin --apply --json; linearctl examples update",
            ));
        }
        let resolve_q = build_resolve_query(specs.len());
        let mut vars = serde_json::Map::new();
        for (i, s) in specs.iter().enumerate() {
            vars.insert(format!("r{i}"), Value::String(s.id.clone()));
        }
        let data = self.execute(&resolve_q, Value::Object(vars))?;

        let mut rows = Vec::with_capacity(specs.len());
        let mut unresolved = Vec::new();

        for (i, spec) in specs.iter().enumerate() {
            let alias = format!("r{i}");
            let resolved = data.get(&alias).filter(|v| !v.is_null());
            let uuid = resolved
                .map(|r| str_field(r, "id"))
                .filter(|s| !s.is_empty());
            if uuid.is_none() {
                unresolved.push(spec.id.clone());
            }

            let mut input = BTreeMap::new();
            if let Some(p) = spec.priority {
                input.insert("priority".to_string(), Value::Number(p.into()));
            }
            if let Some(proj) = &spec.project {
                input.insert("projectId".to_string(), Value::String(proj.clone()));
            }
            if let Some(ass) = &spec.assignee {
                input.insert("assigneeId".to_string(), Value::String(ass.clone()));
            }
            if let Some(ms) = &spec.milestone {
                input.insert("projectMilestoneId".to_string(), Value::String(ms.clone()));
            }
            if let Some(lbls) = &spec.labels {
                input.insert(
                    "labelIds".to_string(),
                    Value::Array(lbls.iter().cloned().map(Value::String).collect()),
                );
            }

            rows.push(BulkPlanRow {
                issue_ref: spec.id.clone(),
                uuid,
                input,
                skipped: None,
            });
        }

        Ok(BulkPlan {
            apply: false,
            rows,
            unresolved,
            result: None,
        })
    }

    /// Execute a planned bulk update (`lnr update --stdin --apply`).
    pub fn apply_bulk_plan(&self, mut plan: BulkPlan) -> Result<BulkPlan, CliError> {
        plan.apply = true;
        let actionable: Vec<&BulkPlanRow> = plan
            .rows
            .iter()
            .filter(|r| r.uuid.is_some() && !r.input.is_empty())
            .collect();

        if actionable.is_empty() {
            assert_batch_succeeded(&[], &plan.unresolved)?;
            plan.result = Some(BatchResult {
                total: 0,
                succeeded: 0,
                failed: Vec::new(),
            });
            return Ok(plan);
        }

        let mutation = build_batch_mutation(actionable.len());
        let mut vars = serde_json::Map::new();
        for (i, row) in actionable.iter().enumerate() {
            vars.insert(
                format!("id{i}"),
                Value::String(row.uuid.clone().unwrap_or_default()),
            );
            let input_val = serde_json::to_value(&row.input).unwrap_or_else(|_| json!({}));
            vars.insert(format!("in{i}"), input_val);
        }

        let data = self.execute(&mutation, Value::Object(vars))?;
        let mut succeeded = 0usize;
        let mut failed = Vec::new();
        let mut batch_failures = Vec::new();

        for (i, row) in actionable.iter().enumerate() {
            let alias = format!("m{i}");
            let ok = data
                .get(&alias)
                .and_then(|e| e.get("success"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if ok {
                succeeded += 1;
            } else {
                let err_msg = "issueUpdate returned success=false".to_string();
                failed.push(BatchRowFailure {
                    issue_ref: row.issue_ref.clone(),
                    error: err_msg.clone(),
                    kind: None,
                });
                batch_failures.push(BatchFailure {
                    error: Some(err_msg),
                    kind: None,
                });
            }
        }

        plan.result = Some(BatchResult {
            total: actionable.len(),
            succeeded,
            failed,
        });
        assert_batch_succeeded(&batch_failures, &plan.unresolved)?;
        Ok(plan)
    }

    /// Resolve a workflow state name on a team to its UUID.
    pub fn resolve_team_state_id(
        &self,
        team_id: &str,
        team_key: &str,
        state_name: &str,
    ) -> Result<String, CliError> {
        let data = self.execute(
            "query TeamStates($teamId: String!) {
                team(id: $teamId) { states { nodes { id name type } } }
            }",
            json!({ "teamId": team_id }),
        )?;
        let states = nodes_at(&data, &["team", "states", "nodes"]);
        let needle = state_name.trim().to_ascii_lowercase();
        if let Some(found) = states.iter().find(|s| {
            str_field(s, "name").to_ascii_lowercase() == needle
                || str_field(s, "type").to_ascii_lowercase() == needle
        }) {
            return Ok(str_field(found, "id"));
        }
        let avail: Vec<String> = states.iter().map(|s| str_field(s, "name")).collect();
        Err(CliError::not_found(
            format!(
                "state '{state_name}' not found on team {team_key} (available: {})",
                avail.join(", ")
            ),
            "",
        ))
    }

    /// Resolve an issue identifier (`ENG-123`) or UUID to its internal UUID.
    pub fn resolve_issue_uuid(&self, id_or_identifier: &str) -> Result<String, CliError> {
        if is_uuid(id_or_identifier) {
            return Ok(id_or_identifier.trim().to_string());
        }
        let data = self.execute(
            "query IssueById($id: String!) { issue(id: $id) { id identifier } }",
            json!({ "id": id_or_identifier.trim() }),
        )?;
        let issue = data.get("issue").filter(|v| !v.is_null()).ok_or_else(|| {
            CliError::not_found(
                format!("issue '{id_or_identifier}' not found"),
                "Verify the issue identifier with `linearctl search`.",
            )
        })?;
        Ok(str_field(issue, "id"))
    }

    /// Fetch full details of a single issue (`lnr show <ID>`).
    pub fn get_issue(&self, id_or_identifier: &str) -> Result<Value, CliError> {
        let data = self.execute(
            "query IssueDetail($id: String!) {
                issue(id: $id) {
                    id
                    identifier
                    title
                    description
                    priority
                    estimate
                    url
                    branchName
                    createdAt
                    updatedAt
                    state { id name type }
                    team { id key name }
                    assignee { id name email }
                    project { id name }
                    projectMilestone { id name }
                    parent { id identifier title }
                    labels { nodes { id name color } }
                }
            }",
            json!({ "id": id_or_identifier.trim() }),
        )?;
        data.get("issue")
            .filter(|v| !v.is_null())
            .cloned()
            .ok_or_else(|| {
                CliError::not_found(
                    format!("issue '{id_or_identifier}' not found"),
                    "Verify the issue identifier with `linearctl search`.",
                )
            })
    }

    /// Post a markdown comment on an issue (`lnr comment <ID> --body ...`).
    pub fn comment_issue(&self, id_or_identifier: &str, body: &str) -> Result<Value, CliError> {
        let issue_id = self.resolve_issue_uuid(id_or_identifier)?;
        let data = self.execute(
            "mutation CommentCreate($input: CommentCreateInput!) {
                commentCreate(input: $input) {
                    success
                    comment { id url createdAt body }
                }
            }",
            json!({ "input": { "issueId": issue_id, "body": body } }),
        )?;
        data.get("commentCreate")
            .and_then(|c| c.get("comment"))
            .cloned()
            .ok_or_else(|| CliError::other("commentCreate returned no comment", ""))
    }

    /// Close an issue (`lnr close <ID>`), optionally posting a shipping comment first.
    pub fn close_issue(
        &self,
        id_or_identifier: &str,
        comment: Option<&str>,
        commit: Option<&str>,
    ) -> Result<Value, CliError> {
        let issue = self.get_issue(id_or_identifier)?;
        let issue_uuid = str_field(&issue, "id");
        let team_id = issue
            .get("team")
            .map(|t| str_field(t, "id"))
            .unwrap_or_default();
        let team_key = issue
            .get("team")
            .map(|t| str_field(t, "key"))
            .unwrap_or_default();

        if comment.is_some() || commit.is_some() {
            let mut body_parts = Vec::new();
            if let Some(sha) = commit.filter(|s| !s.trim().is_empty()) {
                body_parts.push(format!("Shipped in `{}`.", sha.trim()));
            }
            if let Some(note) = comment.filter(|s| !s.trim().is_empty()) {
                body_parts.push(note.trim().to_string());
            }
            if !body_parts.is_empty() {
                let _ = self.comment_issue(&issue_uuid, &body_parts.join("\n\n"))?;
            }
        }

        let done_state_id = self.resolve_team_state_id(&team_id, &team_key, "completed")?;
        let data = self.execute(
            "mutation CloseIssue($id: String!, $stateId: String!) {
                issueUpdate(id: $id, input: { stateId: $stateId }) {
                    success
                    issue { id identifier title url state { name type } }
                }
            }",
            json!({ "id": issue_uuid, "stateId": done_state_id }),
        )?;
        data.get("issueUpdate")
            .and_then(|u| u.get("issue"))
            .cloned()
            .ok_or_else(|| CliError::other("issueUpdate returned no issue", ""))
    }

    /// Query issues matching a GraphQL `IssueFilter` (`lnr search`, `lnr digest`, `lnr standup`, `lnr mine`, `lnr release-notes`).
    pub fn search_issues(
        &self,
        filter: Value,
        limit: Option<usize>,
    ) -> Result<Vec<SearchItem>, CliError> {
        let first = limit.unwrap_or(100).clamp(1, 250);
        let data = self.execute(
            "query SearchIssues($filter: IssueFilter, $first: Int!) {
                issues(filter: $filter, first: $first) {
                    nodes {
                        id
                        identifier
                        title
                        url
                        priority
                        state { name type }
                        assignee { displayName name }
                    }
                }
            }",
            json!({ "filter": filter, "first": first }),
        )?;
        let nodes = nodes_at(&data, &["issues", "nodes"]);
        let mut items: Vec<SearchItem> = nodes
            .iter()
            .map(|n| {
                let state = n
                    .get("state")
                    .map(|s| str_field(s, "name"))
                    .unwrap_or_default();
                let state_type = n
                    .get("state")
                    .map(|s| str_field(s, "type"))
                    .unwrap_or_default();
                let assignee = n.get("assignee").and_then(|a| {
                    opt_str_field(a, "displayName").or_else(|| opt_str_field(a, "name"))
                });
                let priority = n
                    .get("priority")
                    .and_then(Value::as_u64)
                    .and_then(|p| u8::try_from(p).ok())
                    .unwrap_or(0);
                SearchItem {
                    identifier: str_field(n, "identifier"),
                    title: str_field(n, "title"),
                    state,
                    state_type,
                    assignee,
                    priority,
                    url: str_field(n, "url"),
                }
            })
            .collect();
        if let Some(lim) = limit {
            items.truncate(lim);
        }
        Ok(items)
    }

    /// Pull machine-consumable [`PullIssue`] rows (`lnr pull` and `lnr cache sync`).
    pub fn pull_issues(
        &self,
        filter: Value,
        limit: Option<usize>,
    ) -> Result<Vec<PullIssue>, CliError> {
        let first = limit.unwrap_or(100).clamp(1, 250);
        let data = self.execute(
            "query PullIssues($filter: IssueFilter, $first: Int!) {
                issues(filter: $filter, first: $first) {
                    nodes {
                        id
                        identifier
                        title
                        url
                        priority
                        description
                        updatedAt
                        state { name type }
                        labels { nodes { name } }
                    }
                }
            }",
            json!({ "filter": filter, "first": first }),
        )?;
        let nodes = nodes_at(&data, &["issues", "nodes"]);
        let mut out: Vec<PullIssue> = nodes
            .iter()
            .map(|n| {
                let mut labels: Vec<String> = nodes_at(n, &["labels", "nodes"])
                    .iter()
                    .map(|l| str_field(l, "name"))
                    .filter(|s| !s.is_empty())
                    .collect();
                labels.sort();
                let priority = n
                    .get("priority")
                    .and_then(Value::as_u64)
                    .and_then(|p| u8::try_from(p).ok())
                    .unwrap_or(0);
                PullIssue {
                    id: str_field(n, "id"),
                    identifier: str_field(n, "identifier"),
                    title: str_field(n, "title"),
                    state: n
                        .get("state")
                        .map(|s| str_field(s, "name"))
                        .unwrap_or_default(),
                    state_type: n
                        .get("state")
                        .map(|s| str_field(s, "type"))
                        .unwrap_or_default(),
                    priority,
                    labels,
                    description: opt_str_field(n, "description").unwrap_or_default(),
                    url: str_field(n, "url"),
                    updated_at: str_field(n, "updatedAt"),
                }
            })
            .collect();
        if let Some(lim) = limit {
            out.truncate(lim);
        }
        Ok(out)
    }

    /// Surface issues needing triage (`lnr triage`).
    pub fn triage_issues(&self, filter: Value) -> Result<Vec<TriageItem>, CliError> {
        let data = self.execute(
            "query TriageIssues($filter: IssueFilter) {
                issues(filter: $filter, first: 100) {
                    nodes {
                        identifier
                        title
                        url
                        priority
                        estimate
                        state { name type }
                        assignee { displayName name }
                        project { name }
                        labels { nodes { name } }
                    }
                }
            }",
            json!({ "filter": filter }),
        )?;
        let nodes = nodes_at(&data, &["issues", "nodes"]);
        let mut out = Vec::new();
        for n in &nodes {
            let state = n
                .get("state")
                .map(|s| str_field(s, "name"))
                .unwrap_or_default();
            let state_type = n
                .get("state")
                .map(|s| str_field(s, "type"))
                .unwrap_or_default();
            let assignee = n
                .get("assignee")
                .and_then(|a| opt_str_field(a, "displayName").or_else(|| opt_str_field(a, "name")));
            let priority = n
                .get("priority")
                .and_then(Value::as_u64)
                .and_then(|p| u8::try_from(p).ok())
                .unwrap_or(0);
            let estimate = n.get("estimate").and_then(Value::as_f64);
            let project = n.get("project").and_then(|p| opt_str_field(p, "name"));
            let mut labels: Vec<String> = nodes_at(n, &["labels", "nodes"])
                .iter()
                .map(|l| str_field(l, "name"))
                .filter(|s| !s.is_empty())
                .collect();
            labels.sort();
            let reasons = triage_reasons(&state_type, assignee.as_deref(), priority, estimate);
            if !reasons.is_empty() {
                out.push(TriageItem {
                    identifier: str_field(n, "identifier"),
                    title: str_field(n, "title"),
                    state,
                    state_type,
                    assignee,
                    priority,
                    estimate,
                    reasons,
                    url: str_field(n, "url"),
                    labels,
                    project,
                });
            }
        }
        Ok(out)
    }

    /// Fetch a single issue as an `IntakeCandidate` (`lnr intake <id>`).
    pub fn intake_issue(&self, id_or_identifier: &str) -> Result<IntakeCandidate, CliError> {
        let data = self.execute(
            "query IntakeIssue($id: String!) { issue(id: $id) { identifier title description url priority estimate state { name type } assignee { name displayName } team { key } project { name } labels { nodes { name } } } }",
            json!({ "id": id_or_identifier }),
        )?;
        let n = data.get("issue").filter(|v| !v.is_null()).ok_or_else(|| {
            CliError::not_found(
                format!("issue \"{id_or_identifier}\" not found"),
                "Try: linearctl search --text \"...\"",
            )
        })?;
        let identifier = str_field(n, "identifier");
        let state = n
            .get("state")
            .map(|s| str_field(s, "name"))
            .unwrap_or_default();
        let state_type = n
            .get("state")
            .map(|s| str_field(s, "type"))
            .unwrap_or_default();
        let assignee = n
            .get("assignee")
            .and_then(|a| opt_str_field(a, "displayName").or_else(|| opt_str_field(a, "name")));
        let priority = n
            .get("priority")
            .and_then(Value::as_u64)
            .and_then(|p| u8::try_from(p).ok())
            .unwrap_or(0);
        let estimate = n.get("estimate").and_then(Value::as_f64);
        let team = n
            .get("team")
            .and_then(|t| opt_str_field(t, "key"))
            .or_else(|| {
                identifier
                    .split_once('-')
                    .map(|(prefix, _)| prefix.to_string())
            });
        let project = n.get("project").and_then(|p| opt_str_field(p, "name"));
        let mut labels: Vec<String> = nodes_at(n, &["labels", "nodes"])
            .iter()
            .map(|l| str_field(l, "name"))
            .filter(|s| !s.is_empty())
            .collect();
        labels.sort();
        Ok(IntakeCandidate {
            identifier,
            title: str_field(n, "title"),
            description: opt_str_field(n, "description"),
            url: opt_str_field(n, "url"),
            team,
            project,
            priority,
            estimate,
            state,
            state_type,
            labels,
            assignee,
        })
    }

    /// Wire issue relations (`lnr relate <id> --blocked-by ... --blocking ... --related-to ... --duplicate-of ...`).
    pub fn relate_issue(
        &self,
        id_or_identifier: &str,
        blocked_by: &[String],
        blocking: &[String],
        related_to: &[String],
        duplicate_of: Option<&str>,
    ) -> Result<Value, CliError> {
        let issue_uuid = self.resolve_issue_uuid(id_or_identifier)?;
        let mut created_blocked_by = Vec::new();
        let mut created_blocking = Vec::new();
        let mut created_related = Vec::new();

        for blocker in blocked_by {
            let blocker_uuid = self.resolve_issue_uuid(blocker)?;
            let _ = self.execute(
                "mutation CreateRelation($input: IssueRelationCreateInput!) {
                    issueRelationCreate(input: $input) { success }
                }",
                json!({
                    "input": {
                        "issueId": blocker_uuid,
                        "relatedIssueId": issue_uuid,
                        "type": "blocks"
                    }
                }),
            )?;
            created_blocked_by.push(blocker.clone());
        }

        for target in blocking {
            let target_uuid = self.resolve_issue_uuid(target)?;
            let _ = self.execute(
                "mutation CreateRelation($input: IssueRelationCreateInput!) {
                    issueRelationCreate(input: $input) { success }
                }",
                json!({
                    "input": {
                        "issueId": issue_uuid,
                        "relatedIssueId": target_uuid,
                        "type": "blocks"
                    }
                }),
            )?;
            created_blocking.push(target.clone());
        }

        for rel in related_to {
            let rel_uuid = self.resolve_issue_uuid(rel)?;
            let _ = self.execute(
                "mutation CreateRelation($input: IssueRelationCreateInput!) {
                    issueRelationCreate(input: $input) { success }
                }",
                json!({
                    "input": {
                        "issueId": issue_uuid,
                        "relatedIssueId": rel_uuid,
                        "type": "related"
                    }
                }),
            )?;
            created_related.push(rel.clone());
        }

        let mut dup_val = None;
        if let Some(dup_ref) = duplicate_of {
            let dup_uuid = self.resolve_issue_uuid(dup_ref)?;
            let _ = self.execute(
                "mutation CreateDuplicate($input: IssueRelationCreateInput!) {
                    issueRelationCreate(input: $input) { success }
                }",
                json!({
                    "input": {
                        "issueId": issue_uuid,
                        "relatedIssueId": dup_uuid,
                        "type": "duplicate"
                    }
                }),
            )?;
            dup_val = Some(json!({ "id": dup_uuid, "identifier": dup_ref }));
        }

        let mut out = json!({
            "identifier": id_or_identifier,
            "relations": {
                "blockedBy": created_blocked_by,
                "blocking": created_blocking,
                "relatedTo": created_related,
            }
        });
        if let Some(d) = dup_val {
            if let Some(obj) = out.as_object_mut() {
                obj.insert("duplicateOf".to_string(), d);
            }
        }
        Ok(out)
    }

    /// Attach an external URL to an issue (`lnr link <id> <url> [--title ...]`).
    pub fn attach_link(
        &self,
        id_or_identifier: &str,
        url: &str,
        title: Option<&str>,
    ) -> Result<Value, CliError> {
        let issue_uuid = self.resolve_issue_uuid(id_or_identifier)?;
        let _ = self.execute(
            "mutation AttachLink($issueId: String!, $url: String!, $title: String) {
                attachmentLinkURL(issueId: $issueId, url: $url, title: $title) {
                    success
                }
            }",
            json!({ "issueId": issue_uuid, "url": url, "title": title }),
        )?;
        Ok(json!({
            "id": issue_uuid,
            "identifier": id_or_identifier,
            "url": url,
            "title": title,
        }))
    }

    /// Query comments authored since `since_iso` (`lnr comments --author <who>`).
    pub fn comments_by_author(
        &self,
        author: &str,
        since_iso: &str,
        limit: usize,
    ) -> Result<Vec<Value>, CliError> {
        let first = limit.clamp(1, 200);
        let data = self.execute(
            "query CommentsByAuthor($since: DateTimeOrDuration!, $first: Int!) {
                comments(filter: { createdAt: { gte: $since } }, first: $first) {
                    nodes {
                        id
                        body
                        createdAt
                        url
                        user { id name displayName email }
                        issue { identifier title }
                    }
                }
            }",
            json!({ "since": since_iso, "first": first }),
        )?;
        let needle = author.trim().to_ascii_lowercase();
        let nodes = nodes_at(&data, &["comments", "nodes"]);
        let mut rows = Vec::new();
        for n in &nodes {
            let user_match = if needle == "me" {
                true
            } else if let Some(u) = n.get("user") {
                str_field(u, "name").to_ascii_lowercase().contains(&needle)
                    || str_field(u, "displayName")
                        .to_ascii_lowercase()
                        .contains(&needle)
                    || str_field(u, "email").to_ascii_lowercase().contains(&needle)
            } else {
                false
            };
            if user_match {
                rows.push(json!({
                    "id": str_field(n, "id"),
                    "at": str_field(n, "createdAt"),
                    "issue": n.get("issue").map(|i| str_field(i, "identifier")).unwrap_or_default(),
                    "body": str_field(n, "body"),
                    "url": str_field(n, "url"),
                }));
            }
        }
        Ok(rows)
    }

    /// Fetch chronological history events for an issue (`lnr history <id>`).
    pub fn issue_history(&self, id_or_identifier: &str, limit: usize) -> Result<Value, CliError> {
        let first = limit.clamp(1, 200);
        let data = self.execute(
            "query IssueHistory($id: String!, $first: Int!) {
                issue(id: $id) {
                    id
                    identifier
                    title
                    history(first: $first) {
                        nodes {
                            id
                            createdAt
                            actor { name displayName }
                            fromState { name }
                            toState { name }
                            fromPriority
                            toPriority
                        }
                    }
                }
            }",
            json!({ "id": id_or_identifier.trim(), "first": first }),
        )?;
        let issue = data.get("issue").filter(|v| !v.is_null()).ok_or_else(|| {
            CliError::not_found(format!("issue '{id_or_identifier}' not found"), "")
        })?;
        let nodes = nodes_at(issue, &["history", "nodes"]);
        let events: Vec<Value> = nodes
            .iter()
            .map(|e| {
                let actor = e
                    .get("actor")
                    .and_then(|a| {
                        opt_str_field(a, "displayName").or_else(|| opt_str_field(a, "name"))
                    })
                    .unwrap_or_else(|| "system".to_string());
                let from_st = e.get("fromState").and_then(|s| opt_str_field(s, "name"));
                let to_st = e.get("toState").and_then(|s| opt_str_field(s, "name"));
                let detail = match (from_st, to_st) {
                    (Some(f), Some(t)) => format!("state: {f} -> {t}"),
                    (None, Some(t)) => format!("state: -> {t}"),
                    _ => "updated".to_string(),
                };
                json!({
                    "at": str_field(e, "createdAt"),
                    "actor": actor,
                    "detail": detail,
                })
            })
            .collect();
        Ok(json!({
            "identifier": str_field(issue, "identifier"),
            "title": str_field(issue, "title"),
            "events": events,
        }))
    }

    /// Fetch active/previous cycle summary for a team (`lnr cycle --team <KEY>`).
    pub fn cycle_review(&self, team_key: &str, previous: bool) -> Result<Value, CliError> {
        let team = self.resolve_team(team_key)?;
        let data = self.execute(
            "query TeamCycles($teamId: String!) {
                team(id: $teamId) {
                    activeCycle {
                        id number name startsAt endsAt
                        issues { nodes { identifier state { type } estimate } }
                    }
                    cycles(first: 5) {
                        nodes {
                            id number name startsAt endsAt
                            issues { nodes { identifier state { type } estimate } }
                        }
                    }
                }
            }",
            json!({ "teamId": team.id }),
        )?;
        let cycle_node = if previous {
            nodes_at(&data, &["team", "cycles", "nodes"])
                .into_iter()
                .nth(1)
        } else {
            data.get("team")
                .and_then(|t| t.get("activeCycle"))
                .filter(|v| !v.is_null())
                .cloned()
                .or_else(|| {
                    nodes_at(&data, &["team", "cycles", "nodes"])
                        .into_iter()
                        .next()
                })
        };
        let Some(c) = cycle_node else {
            return Ok(json!({
                "team": team.key,
                "cycle": { "number": 0, "startsAt": "", "endsAt": "" },
                "daysRemaining": 0,
                "scope": { "issues": 0, "points": 0 },
                "done": { "issues": 0, "points": 0 },
                "inProgress": { "issues": 0, "points": 0 },
                "unstarted": { "issues": 0, "points": 0 },
                "atRisk": [],
            }));
        };
        let issues = nodes_at(&c, &["issues", "nodes"]);
        let total_issues = issues.len();
        let done_issues = issues
            .iter()
            .filter(|i| {
                i.get("state")
                    .map(|s| str_field(s, "type"))
                    .unwrap_or_default()
                    == "completed"
            })
            .count();
        let started_issues = issues
            .iter()
            .filter(|i| {
                i.get("state")
                    .map(|s| str_field(s, "type"))
                    .unwrap_or_default()
                    == "started"
            })
            .count();
        let unstarted_issues = total_issues.saturating_sub(done_issues + started_issues);
        Ok(json!({
            "team": team.key,
            "cycle": {
                "id": str_field(&c, "id"),
                "number": c.get("number").and_then(Value::as_u64).unwrap_or(0),
                "startsAt": str_field(&c, "startsAt"),
                "endsAt": str_field(&c, "endsAt"),
            },
            "daysRemaining": 0,
            "scope": { "issues": total_issues, "points": 0 },
            "done": { "issues": done_issues, "points": 0 },
            "inProgress": { "issues": started_issues, "points": 0 },
            "unstarted": { "issues": unstarted_issues, "points": 0 },
            "atRisk": [],
        }))
    }

    /// List workspace initiatives (`lnr initiative`).
    pub fn list_initiatives(&self) -> Result<Vec<Value>, CliError> {
        let data = self.execute(
            "query Initiatives {
                initiatives(first: 100) {
                    nodes { id name status targetDate description }
                }
            }",
            json!({}),
        )?;
        Ok(nodes_at(&data, &["initiatives", "nodes"]))
    }

    /// List Linear documents (`lnr doc list`).
    pub fn doc_list(&self, project: Option<&str>) -> Result<Vec<Value>, CliError> {
        let filter = match project.map(str::trim).filter(|s| !s.is_empty()) {
            Some(p) if is_uuid(p) => json!({ "project": { "id": { "eq": p } } }),
            Some(p) => json!({ "project": { "name": { "eqIgnoreCase": p } } }),
            None => json!({}),
        };
        let data = self.execute(
            "query Documents($filter: DocumentFilter) {
                documents(filter: $filter, first: 100) {
                    nodes {
                        id slugId title url updatedAt
                        project { id name }
                    }
                }
            }",
            json!({ "filter": filter }),
        )?;
        Ok(nodes_at(&data, &["documents", "nodes"]))
    }

    /// Fetch a project's overview markdown (`lnr doc get-overview --project <ref>`).
    pub fn doc_get_overview(&self, project_ref: &str) -> Result<Value, CliError> {
        let data = self.execute(
            "query ProjectOverview {
                projects(first: 100) {
                    nodes { id name url content description }
                }
            }",
            json!({}),
        )?;
        let needle = project_ref.trim().to_ascii_lowercase();
        let nodes = nodes_at(&data, &["projects", "nodes"]);
        let found = nodes
            .into_iter()
            .find(|p| {
                str_field(p, "id").to_ascii_lowercase() == needle
                    || str_field(p, "name").to_ascii_lowercase() == needle
            })
            .ok_or_else(|| {
                CliError::not_found(
                    format!("project '{project_ref}' not found"),
                    "Run `linearctl project list` to inspect project names.",
                )
            })?;
        let content =
            opt_str_field(&found, "content").or_else(|| opt_str_field(&found, "description"));
        Ok(json!({
            "project": {
                "id": str_field(&found, "id"),
                "name": str_field(&found, "name"),
                "url": str_field(&found, "url"),
            },
            "content": content,
        }))
    }
}

fn split_http_response(raw: &str) -> (HashMap<String, String>, Option<u16>, &str) {
    let mut headers = HashMap::new();
    let mut status_code = None;
    let mut rest = raw;

    loop {
        if let Some((header_block, after)) = rest
            .split_once("\r\n\r\n")
            .or_else(|| rest.split_once("\n\n"))
        {
            if header_block.starts_with("HTTP/") {
                headers.clear();
                for (idx, line) in header_block.lines().enumerate() {
                    let trimmed = line.trim();
                    if idx == 0 {
                        let parts: Vec<&str> = trimmed.split_whitespace().collect();
                        if parts.len() >= 2 {
                            status_code = parts[1].parse::<u16>().ok();
                        }
                    } else if let Some((k, v)) = trimmed.split_once(':') {
                        headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
                    }
                }
                rest = after;
                continue;
            }
        }
        break;
    }

    (headers, status_code, rest.trim())
}

pub fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

pub fn opt_str_field(v: &Value, key: &str) -> Option<String> {
    v.get(key)
        .and_then(Value::as_str)
        .map(str::to_string)
        .filter(|s| !s.is_empty())
}

pub fn nodes_at(v: &Value, path: &[&str]) -> Vec<Value> {
    let mut cur = v;
    for segment in path {
        let Some(next) = cur.get(*segment) else {
            return Vec::new();
        };
        cur = next;
    }
    cur.as_array().cloned().unwrap_or_default()
}
