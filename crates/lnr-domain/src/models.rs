//! Linear domain entities, rate-limit headers, batch specs, and pure GraphQL document builders.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{CliError, ErrorKind};
use crate::time::epoch_ms_to_iso;

/// Return `true` if `s` is a canonical 36-character UUID (`8-4-4-4-12` hex).
#[must_use]
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    if b.len() != 36 {
        return false;
    }
    for (i, &ch) in b.iter().enumerate() {
        if matches!(i, 8 | 13 | 18 | 23) {
            if ch != b'-' {
                return false;
            }
        } else if !ch.is_ascii_hexdigit() {
            return false;
        }
    }
    true
}

/// Organization metadata inside [`WhoamiResult`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrganizationSummary {
    /// Organization UUID.
    pub id: String,
    /// Organization name.
    pub name: String,
    /// Workspace URL slug key.
    pub url_key: String,
}

/// Authenticated viewer + organization returned by `lnr whoami`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WhoamiResult {
    /// Viewer UUID.
    pub id: String,
    /// Full name.
    pub name: String,
    /// Display handle.
    pub display_name: String,
    /// Email address.
    pub email: String,
    /// Whether the viewer is an organization administrator.
    pub admin: bool,
    /// Organization summary.
    pub organization: OrganizationSummary,
}

/// Single quota axis (`requests` or `complexity`) from Linear's `X-RateLimit-*` headers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitAxis {
    /// Total window budget (`X-RateLimit-*-Limit`).
    pub limit: Option<i64>,
    /// Remaining budget (`X-RateLimit-*-Remaining`).
    pub remaining: Option<i64>,
    /// Window reset timestamp in ISO-8601 (`X-RateLimit-*-Reset`).
    pub reset_at: Option<String>,
}

/// Combined request and complexity quota state returned by `lnr ratelimit`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RateLimitInfo {
    /// HTTP request count quota.
    pub requests: RateLimitAxis,
    /// GraphQL complexity point quota.
    pub complexity: RateLimitAxis,
}

fn parse_header_num(raw: Option<&str>) -> Option<i64> {
    let trimmed = raw?.trim();
    if trimmed.is_empty() {
        return None;
    }
    trimmed.parse::<i64>().ok()
}

/// Parse Linear's `X-RateLimit-*` response headers via a case-insensitive lookup closure.
#[must_use]
pub fn parse_rate_limit_headers<'a, F>(get: F) -> RateLimitInfo
where
    F: Fn(&str) -> Option<&'a str>,
{
    let axis = |kind: &str| -> RateLimitAxis {
        let limit = parse_header_num(get(&format!("X-RateLimit-{kind}-Limit")));
        let remaining = parse_header_num(get(&format!("X-RateLimit-{kind}-Remaining")));
        let reset_at =
            parse_header_num(get(&format!("X-RateLimit-{kind}-Reset"))).map(epoch_ms_to_iso);
        RateLimitAxis {
            limit,
            remaining,
            reset_at,
        }
    };
    RateLimitInfo {
        requests: axis("Requests"),
        complexity: axis("Complexity"),
    }
}

/// Return `true` when either the request or complexity quota has reached `0`.
#[must_use]
pub const fn is_exhausted(info: &RateLimitInfo) -> bool {
    matches!(info.requests.remaining, Some(0)) || matches!(info.complexity.remaining, Some(0))
}

/// Summary of a Linear team returned by `lnr team list` / `lnr team resolve`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamSummary {
    /// Team UUID.
    pub id: String,
    /// Short uppercase team key (e.g. `"CER"`).
    pub key: String,
    /// Team name.
    pub name: String,
    /// Optional display name.
    pub display_name: Option<String>,
    /// Optional team description.
    pub description: Option<String>,
}

/// Label record returned by `lnr label list|create|rename`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelInfo {
    /// Label UUID.
    pub id: String,
    /// Label name.
    pub name: String,
    /// Optional hex color.
    pub color: Option<String>,
    /// Owning team key (`None` for workspace-level labels).
    pub team: Option<String>,
    /// Optional issue usage count (`--counts`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issues: Option<usize>,
}

/// Paginated label listing with truncation flag.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LabelListing {
    /// Sorted label records.
    pub labels: Vec<LabelInfo>,
    /// True only when `--limit` truncated the complete listing.
    pub partial: bool,
}

/// Project summary row returned by `lnr project list`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectSummary {
    /// Project UUID.
    pub id: String,
    /// Project name.
    pub name: String,
    /// Canonical Linear URL.
    pub url: String,
    /// Project state string.
    pub state: String,
    /// Completion ratio (`0.0..=1.0`).
    pub progress: f64,
}

/// Paginated project listing with truncation flag.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectListing {
    /// Sorted project summaries.
    pub projects: Vec<ProjectSummary>,
    /// True only when `--limit` truncated the complete listing.
    pub partial: bool,
}

/// Created issue summary returned by `lnr file` and `lnr park`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CreatedIssue {
    /// Issue UUID.
    pub id: String,
    /// Human identifier (e.g. `"CER-123"`).
    pub identifier: String,
    /// Issue title.
    pub title: String,
    /// Canonical URL.
    pub url: String,
}

/// Updated issue summary returned by `lnr update` and `lnr close`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct UpdatedIssue {
    /// Issue UUID.
    pub id: String,
    /// Human identifier (e.g. `"CER-123"`).
    pub identifier: String,
    /// Issue title.
    pub title: String,
    /// Canonical URL.
    pub url: String,
    /// Current workflow state name.
    pub state: String,
    /// Optional assignee display name.
    pub assignee: Option<String>,
}

/// Duplicate match entry in [`DupcheckResult`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DupMatch {
    /// Issue identifier (e.g. `"ENG-123"`).
    pub identifier: String,
    /// Similarity score rounded to 2 decimal places.
    pub score: f64,
    /// Issue title.
    pub title: String,
    /// Canonical URL.
    pub url: String,
}

/// Result of `lnr dupcheck <title>`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DupcheckResult {
    /// Query title string.
    pub query: String,
    /// Similarity threshold used (`0.85` default).
    pub threshold: f64,
    /// Matching candidate issues.
    pub matches: Vec<DupMatch>,
}

/// One item in a `lnr file --stdin` JSON/NDJSON batch plan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchFileItem {
    /// Issue title.
    pub title: String,
    /// Optional team key override.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// Optional markdown description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc: Option<String>,
    /// Optional label names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    /// Optional project ref.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Optional assignee ref.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    /// Optional priority (`0..=4`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
    /// Optional milestone ref.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestone: Option<String>,
    /// Optional parent issue ref.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent: Option<String>,
}

/// Per-item outcome of `lnr file --stdin --apply`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchFileOutcome {
    /// Issue title.
    pub title: String,
    /// Target team key.
    pub team: String,
    /// Created issue metadata if successful.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<CreatedIssue>,
    /// Error message if creation failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Classified error kind if creation failed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ErrorKind>,
}

fn coerce_batch_file_item(val: Value, index: usize) -> Result<BatchFileItem, CliError> {
    let Some(obj) = val.as_object() else {
        return Err(CliError::usage(
            format!("batch item {index}: needs at least a string \"title\"."),
            "",
        ));
    };
    if !obj.get("title").is_some_and(Value::is_string) {
        return Err(CliError::usage(
            format!("batch item {index}: needs at least a string \"title\"."),
            "",
        ));
    }
    serde_json::from_value(val).map_err(|_| {
        CliError::usage(
            format!("batch item {index}: needs at least a string \"title\"."),
            "",
        )
    })
}

/// Parse a JSON array or NDJSON stream into [`BatchFileItem`] entries.
///
/// # Errors
///
/// Returns a [`CliError`] (`usage`, exit code 2) on malformed JSON or missing `"title"`.
pub fn parse_file_batch_spec(raw: &str) -> Result<Vec<BatchFileItem>, CliError> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    if text.starts_with('[') {
        let parsed: Value = serde_json::from_str(text).map_err(|_| {
            CliError::usage("--stdin must contain a JSON array or NDJSON objects.", "")
        })?;
        let Some(arr) = parsed.as_array() else {
            return Err(CliError::usage(
                "batch spec must be a JSON array or NDJSON of objects.",
                "",
            ));
        };
        return arr
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, v)| coerce_batch_file_item(v, i))
            .collect();
    }

    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .enumerate()
        .map(|(i, line)| {
            let val: Value = serde_json::from_str(line).map_err(|_| {
                CliError::usage("--stdin must contain a JSON array or NDJSON objects.", "")
            })?;
            coerce_batch_file_item(val, i)
        })
        .collect()
}

/// One item in a `lnr update --stdin` bulk update specification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BulkSpecItem {
    /// Issue identifier or UUID (e.g. `"ENG-123"`).
    pub id: String,
    /// Replacement label names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    /// Additive label names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub add_labels: Option<Vec<String>>,
    /// Priority number (`0..=4`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub priority: Option<u8>,
    /// Project reference.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Assignee reference.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    /// Milestone reference.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub milestone: Option<String>,
}

/// One resolved row in a [`BulkPlan`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkPlanRow {
    /// Issue identifier (`"ENG-123"`).
    #[serde(rename = "ref")]
    pub issue_ref: String,
    /// Resolved issue UUID (`None` if unresolved).
    pub uuid: Option<String>,
    /// GraphQL `IssueUpdateInput` fields.
    pub input: BTreeMap<String, Value>,
    /// Optional reason why the row was skipped.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub skipped: Option<String>,
}

/// Failure entry inside [`BatchResult`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchRowFailure {
    /// Issue identifier.
    #[serde(rename = "ref")]
    pub issue_ref: String,
    /// Error message.
    pub error: String,
    /// Optional classified error kind.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<ErrorKind>,
}

/// Summary of batched GraphQL mutations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BatchResult {
    /// Total actionable items.
    pub total: usize,
    /// Number of items that succeeded.
    pub succeeded: usize,
    /// Items that failed.
    pub failed: Vec<BatchRowFailure>,
}

/// Resolved bulk update plan emitted by `lnr update --stdin`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BulkPlan {
    /// Whether `--apply` was set.
    pub apply: bool,
    /// Per-issue update rows.
    pub rows: Vec<BulkPlanRow>,
    /// Identifiers that did not resolve in Linear.
    pub unresolved: Vec<String>,
    /// Execution result when `apply == true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<BatchResult>,
}

fn coerce_bulk_item(val: Value, index: usize) -> Result<BulkSpecItem, CliError> {
    let Some(obj) = val.as_object() else {
        return Err(CliError::usage(
            format!("bulk spec item {index} needs a string \"id\"."),
            "",
        ));
    };
    if !obj.get("id").is_some_and(Value::is_string) {
        return Err(CliError::usage(
            format!("bulk spec item {index} needs a string \"id\"."),
            "",
        ));
    }
    serde_json::from_value(val)
        .map_err(|_| CliError::usage(format!("bulk spec item {index} needs a string \"id\"."), ""))
}

/// Parse a JSON array or NDJSON stream into [`BulkSpecItem`] entries.
///
/// # Errors
///
/// Returns a [`CliError`] (`usage`, exit code 2) on malformed JSON or missing `"id"`.
pub fn parse_bulk_spec(raw: &str) -> Result<Vec<BulkSpecItem>, CliError> {
    let text = raw.trim();
    if text.is_empty() {
        return Ok(Vec::new());
    }
    if text.starts_with('[') {
        let parsed: Value = serde_json::from_str(text).map_err(|_| {
            CliError::usage("--stdin must contain a JSON array or NDJSON objects.", "")
        })?;
        let Some(arr) = parsed.as_array() else {
            return Err(CliError::usage(
                "bulk spec must be a JSON array or NDJSON of objects.",
                "",
            ));
        };
        return arr
            .iter()
            .cloned()
            .enumerate()
            .map(|(i, v)| coerce_bulk_item(v, i))
            .collect();
    }

    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .enumerate()
        .map(|(i, line)| {
            let val: Value = serde_json::from_str(line).map_err(|_| {
                CliError::usage("--stdin must contain a JSON array or NDJSON objects.", "")
            })?;
            coerce_bulk_item(val, i)
        })
        .collect()
}

/// Build an aliased `query Resolve(...)` GraphQL document for `n` issue references.
#[must_use]
pub fn build_resolve_query(n: usize) -> String {
    let mut decls = Vec::with_capacity(n);
    let mut fields = Vec::with_capacity(n);
    for i in 0..n {
        decls.push(format!("$r{i}: String!"));
        fields.push(format!("r{i}: issue(id: $r{i}) {{ id identifier }}"));
    }
    format!(
        "query Resolve({}) {{\n  {}\n}}",
        decls.join(", "),
        fields.join("\n  ")
    )
}

/// Build an aliased `mutation Batch(...)` GraphQL document for `n` issue updates.
#[must_use]
pub fn build_batch_mutation(n: usize) -> String {
    let mut decls = Vec::with_capacity(n * 2);
    let mut fields = Vec::with_capacity(n);
    for i in 0..n {
        decls.push(format!("$id{i}: String!"));
        decls.push(format!("$in{i}: IssueUpdateInput!"));
        fields.push(format!(
            "m{i}: issueUpdate(id: $id{i}, input: $in{i}) {{ success }}"
        ));
    }
    format!(
        "mutation Batch({}) {{\n  {}\n}}",
        decls.join(", "),
        fields.join("\n  ")
    )
}

/// Terminal Linear workflow state types excluded by default in `search`, `pull`, `triage`, and `mine`.
pub const TERMINAL_STATE_TYPES: &[&str] = &["completed", "canceled"];

/// Map friendly `--state` alias strings to canonical Linear workflow state types.
#[must_use]
pub fn state_type_alias(raw: &str) -> Option<&'static str> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "triage" => Some("triage"),
        "backlog" => Some("backlog"),
        "todo" | "unstarted" => Some("unstarted"),
        "started" | "in-progress" => Some("started"),
        "done" | "completed" => Some("completed"),
        "canceled" | "cancelled" => Some("canceled"),
        "duplicate" => Some("duplicate"),
        _ => None,
    }
}

/// Input options for composing a Linear GraphQL `IssueFilter` (`search` and `pull`).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SearchFilterInput {
    /// Team keys (e.g. `["ENG", "OPS"]`). `"all"` lifts team filtering.
    pub team_keys: Vec<String>,
    /// Single state name or type alias (`"done"`, `"todo"`, `"all"`, etc.).
    pub state: Option<String>,
    /// Multiple state names/types combined with `or`.
    pub state_set: Vec<String>,
    /// Label names (`some.name.eqIgnoreCase`).
    pub labels: Vec<String>,
    /// Assignee filter (`"none"` or resolved user UUID).
    pub assignee: Option<String>,
    /// Project UUID or exact name.
    pub project: Option<String>,
    /// Milestone UUID or exact name.
    pub milestone: Option<String>,
    /// Priority number (`0..=4`).
    pub priority: Option<u8>,
    /// Substring match across `title` and `description`.
    pub text: Option<String>,
    /// ISO-8601 lower bound for `updatedAt`.
    pub updated_since_iso: Option<String>,
    /// ISO-8601 lower bound for `createdAt`.
    pub created_since_iso: Option<String>,
}

/// Compose a Linear GraphQL `IssueFilter` JSON object from [`SearchFilterInput`].
#[must_use]
pub fn build_issue_filter(opts: &SearchFilterInput) -> Value {
    use serde_json::json;

    let mut and_clauses: Vec<Value> = Vec::new();

    if !opts.state_set.is_empty() {
        let clauses: Vec<Value> = opts
            .state_set
            .iter()
            .map(|s| match state_type_alias(s) {
                Some(tp) => json!({ "state": { "type": { "eq": tp } } }),
                None => json!({ "state": { "name": { "eqIgnoreCase": s } } }),
            })
            .collect();
        if clauses.len() == 1 {
            if let Some(first) = clauses.into_iter().next() {
                and_clauses.push(first);
            }
        } else {
            and_clauses.push(json!({ "or": clauses }));
        }
    } else {
        match opts.state.as_deref().map(str::trim) {
            None | Some("") => {
                and_clauses.push(json!({ "state": { "type": { "nin": TERMINAL_STATE_TYPES } } }));
            }
            Some(s) if s.eq_ignore_ascii_case("all") => {}
            Some(s) => match state_type_alias(s) {
                Some(tp) => and_clauses.push(json!({ "state": { "type": { "eq": tp } } })),
                None => and_clauses.push(json!({ "state": { "name": { "eqIgnoreCase": s } } })),
            },
        }
    }

    for label in &opts.labels {
        and_clauses.push(json!({ "labels": { "some": { "name": { "eqIgnoreCase": label } } } }));
    }

    if let Some(ass) = opts.assignee.as_deref().map(str::trim) {
        if ass.eq_ignore_ascii_case("none") {
            and_clauses.push(json!({ "assignee": { "null": true } }));
        } else if is_uuid(ass) {
            and_clauses.push(json!({ "assignee": { "id": { "eq": ass } } }));
        } else if !ass.is_empty() {
            and_clauses.push(json!({ "assignee": { "displayName": { "eqIgnoreCase": ass } } }));
        }
    }

    if let Some(proj) = opts
        .project
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if is_uuid(proj) {
            and_clauses.push(json!({ "project": { "id": { "eq": proj } } }));
        } else {
            and_clauses.push(json!({ "project": { "name": { "eqIgnoreCase": proj } } }));
        }
    }

    if let Some(ms) = opts
        .milestone
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if is_uuid(ms) {
            and_clauses.push(json!({ "projectMilestone": { "id": { "eq": ms } } }));
        } else {
            and_clauses.push(json!({ "projectMilestone": { "name": { "eqIgnoreCase": ms } } }));
        }
    }

    if let Some(p) = opts.priority {
        and_clauses.push(json!({ "priority": { "eq": p } }));
    }

    if let Some(txt) = opts
        .text
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        and_clauses.push(json!({
            "or": [
                { "title": { "containsIgnoreCase": txt } },
                { "description": { "containsIgnoreCase": txt } }
            ]
        }));
    }

    if let Some(up) = opts
        .updated_since_iso
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        and_clauses.push(json!({ "updatedAt": { "gte": up } }));
    }

    if let Some(cr) = opts
        .created_since_iso
        .as_deref()
        .filter(|s| !s.trim().is_empty())
    {
        and_clauses.push(json!({ "createdAt": { "gte": cr } }));
    }

    let mut root = serde_json::Map::new();
    let scoped_teams: Vec<String> = opts
        .team_keys
        .iter()
        .flat_map(|t| t.split(','))
        .map(|s| s.trim().to_ascii_uppercase())
        .filter(|s| !s.is_empty() && s != "ALL")
        .collect();
    if !scoped_teams.is_empty() {
        root.insert("team".to_string(), json!({ "key": { "in": scoped_teams } }));
    }
    if !and_clauses.is_empty() {
        root.insert("and".to_string(), Value::Array(and_clauses));
    }
    Value::Object(root)
}

/// Issue summary row returned by `lnr search`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    /// Issue identifier (e.g. `"CER-101"`).
    pub identifier: String,
    /// Issue title.
    pub title: String,
    /// Workflow state name.
    pub state: String,
    /// Workflow state type (`"triage"`, `"unstarted"`, `"started"`, `"completed"`, etc.).
    pub state_type: String,
    /// Optional assignee display name.
    pub assignee: Option<String>,
    /// Priority number (`0..=4`).
    pub priority: u8,
    /// Canonical issue URL.
    pub url: String,
}

/// Machine-consumable issue record emitted by `lnr pull` (`docs/funnel-contract.md`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullIssue {
    /// Linear issue UUID.
    pub id: String,
    /// Issue identifier (e.g. `"CER-101"`).
    pub identifier: String,
    /// Issue title.
    pub title: String,
    /// Workflow state name.
    pub state: String,
    /// Workflow state type.
    pub state_type: String,
    /// Priority (`0..=4`).
    pub priority: u8,
    /// Sorted label names.
    pub labels: Vec<String>,
    /// Issue description markdown (`""` when empty).
    pub description: String,
    /// Canonical issue URL.
    pub url: String,
    /// Last updated timestamp (ISO-8601).
    pub updated_at: String,
}

/// Issue surfaced by `lnr triage` with classification reasons.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriageItem {
    /// Issue identifier.
    pub identifier: String,
    /// Issue title.
    pub title: String,
    /// Workflow state name.
    pub state: String,
    /// Workflow state type.
    pub state_type: String,
    /// Assignee display name if present.
    pub assignee: Option<String>,
    /// Priority (`0..=4`).
    pub priority: u8,
    /// Reasons this issue needs triage (`"triage"`, `"unassigned"`, `"no-priority"`, `"unestimated"`).
    pub reasons: Vec<String>,
    /// Canonical URL.
    pub url: String,
}

/// Compute triage reasons for an active issue.
#[must_use]
pub fn triage_reasons(
    state_type: &str,
    assignee: Option<&str>,
    priority: u8,
    estimate: Option<f64>,
) -> Vec<String> {
    let mut reasons = Vec::new();
    if state_type.eq_ignore_ascii_case("triage") {
        reasons.push("triage".to_string());
    }
    if assignee.is_none_or(|a| a.trim().is_empty()) {
        reasons.push("unassigned".to_string());
    }
    if priority == 0 {
        reasons.push("no-priority".to_string());
    }
    if estimate.is_none() {
        reasons.push("unestimated".to_string());
    }
    reasons
}

/// Group of issues sharing a workflow state type in `lnr digest` / `lnr mine` / `lnr standup`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DigestGroup {
    /// Workflow state type (`"started"`, `"completed"`, `"unstarted"`, `"triage"`, `"backlog"`, `"canceled"`).
    #[serde(rename = "type")]
    pub state_type: String,
    /// Number of issues in this group.
    pub count: usize,
    /// Issues in this group.
    pub items: Vec<SearchItem>,
}

/// Output of `lnr digest`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DigestResult {
    /// ISO-8601 lower bound timestamp.
    pub since: String,
    /// Total issues across all groups.
    pub total: usize,
    /// Issues grouped by workflow state type.
    pub groups: Vec<DigestGroup>,
}

/// Group flat [`SearchItem`] entries into canonical workflow state type buckets.
#[must_use]
pub fn build_digest_groups(since: &str, items: Vec<SearchItem>) -> DigestResult {
    const ORDER: &[&str] = &[
        "started",
        "triage",
        "unstarted",
        "backlog",
        "completed",
        "canceled",
    ];
    let total = items.len();
    let mut buckets: BTreeMap<String, Vec<SearchItem>> = BTreeMap::new();
    for item in items {
        let key = if item.state_type.is_empty() {
            "unstarted".to_string()
        } else {
            item.state_type.to_ascii_lowercase()
        };
        buckets.entry(key).or_default().push(item);
    }
    let mut groups = Vec::new();
    for &canonical in ORDER {
        if let Some(list) = buckets.remove(canonical) {
            groups.push(DigestGroup {
                state_type: canonical.to_string(),
                count: list.len(),
                items: list,
            });
        }
    }
    for (other, list) in buckets {
        groups.push(DigestGroup {
            state_type: other,
            count: list.len(),
            items: list,
        });
    }
    DigestResult {
        since: since.to_string(),
        total,
        groups,
    }
}

/// Render a [`DigestResult`] as standup markdown (`Done`, `In progress`, `Up next`, `Needs triage`).
#[must_use]
pub fn render_standup_markdown(digest: &DigestResult, since_label: &str) -> String {
    let mut lines = vec![format!(
        "**Standup** · last {since_label} · {} issue(s) touched",
        digest.total
    )];
    for group in &digest.groups {
        let heading = match group.state_type.as_str() {
            "completed" => Some("Done"),
            "started" => Some("In progress"),
            "unstarted" => Some("Up next"),
            "triage" => Some("Needs triage"),
            _ => None,
        };
        let Some(h) = heading else {
            continue;
        };
        lines.push(String::new());
        lines.push(format!("**{h}** ({})", group.count));
        for item in &group.items {
            match &item.assignee {
                Some(a) if !a.is_empty() => {
                    lines.push(format!("- {} {} — {a}", item.identifier, item.title));
                }
                _ => lines.push(format!("- {} {}", item.identifier, item.title)),
            }
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

/// Render a [`DigestResult`] as the human `lnr mine` view.
#[must_use]
pub fn render_mine_text(result: &DigestResult) -> String {
    if result.total == 0 {
        return "No issues assigned to you.\n".to_string();
    }
    let mut lines = vec![format!("{} issue(s) assigned to you", result.total)];
    for group in &result.groups {
        let heading = match group.state_type.as_str() {
            "started" => "In progress",
            "triage" => "Needs triage",
            "unstarted" => "Up next",
            "backlog" => "Backlog",
            "completed" => "Done",
            "canceled" => "Canceled",
            other => other,
        };
        lines.push(String::new());
        lines.push(format!("{heading} ({})", group.count));
        for item in &group.items {
            let tag = match item.priority {
                1 => " [urgent]",
                2 => " [high]",
                _ => "",
            };
            lines.push(format!("  {}  {}{tag}", item.identifier, item.title));
        }
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn parses_rate_limit_headers_and_checks_exhaustion() {
        let info = parse_rate_limit_headers(|name| match name {
            "X-RateLimit-Requests-Limit" => Some("1500"),
            "X-RateLimit-Requests-Remaining" => Some("0"),
            "X-RateLimit-Requests-Reset" => Some("1785240000000"),
            _ => None,
        });
        assert_eq!(info.requests.limit, Some(1500));
        assert_eq!(info.requests.remaining, Some(0));
        assert_eq!(
            info.requests.reset_at.as_deref(),
            Some("2026-07-28T12:00:00.000Z")
        );
        assert!(is_exhausted(&info));
    }

    #[test]
    fn parses_bulk_and_batch_specs() {
        let bulk = parse_bulk_spec(r#"[{"id":"ENG-123","priority":3}]"#).unwrap();
        assert_eq!(bulk.len(), 1);
        assert_eq!(bulk[0].id, "ENG-123");
        assert_eq!(bulk[0].priority, Some(3));

        let batch = parse_file_batch_spec(r#"[{"title":"Example","team":"ENG"}]"#).unwrap();
        assert_eq!(batch.len(), 1);
        assert_eq!(batch[0].title, "Example");
    }

    #[test]
    fn builds_issue_filter_and_digest_standup_views() {
        let f = build_issue_filter(&SearchFilterInput {
            team_keys: vec!["eng".to_string()],
            state: Some("todo".to_string()),
            labels: vec!["bug".to_string()],
            priority: Some(1),
            ..Default::default()
        });
        assert_eq!(f["team"]["key"]["in"][0].as_str(), Some("ENG"));
        let items = vec![SearchItem {
            identifier: "ENG-1".to_string(),
            title: "Fix BM25".to_string(),
            state: "In Progress".to_string(),
            state_type: "started".to_string(),
            assignee: Some("Alice".to_string()),
            priority: 1,
            url: "https://linear.app/x/issue/ENG-1".to_string(),
        }];
        let digest = build_digest_groups("2026-10-14T00:00:00.000Z", items);
        assert_eq!(digest.total, 1);
        let standup = render_standup_markdown(&digest, "24h");
        assert!(standup.contains("**In progress** (1)"));
        assert!(standup.contains("- ENG-1 Fix BM25 — Alice"));
        let mine = render_mine_text(&digest);
        assert!(mine.contains("ENG-1  Fix BM25 [urgent]"));
    }
}
