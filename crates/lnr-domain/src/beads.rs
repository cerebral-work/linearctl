//! Pure Beads (`gastownhall/beads`) issue models, field mappings, and dependency graph evaluation.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::CliError;
use crate::time::iso_to_epoch_ms;

/// Lifecycle status of a Beads issue.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BeadsStatus {
    /// Open and eligible if unblocked.
    Open,
    /// Claimed and actively worked on.
    InProgress,
    /// Completed or canceled.
    Closed,
    /// Explicitly blocked.
    Blocked,
    /// Deferred until a future date.
    Deferred,
}

impl BeadsStatus {
    /// Return the snake_case string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::InProgress => "in_progress",
            Self::Closed => "closed",
            Self::Blocked => "blocked",
            Self::Deferred => "deferred",
        }
    }
}

/// Issue classification in a Beads graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BeadsIssueType {
    /// General task.
    Task,
    /// Bug or defect.
    Bug,
    /// Feature or enhancement.
    Feature,
    /// Epic or parent container.
    Epic,
    /// Chore, refactor, or maintenance item.
    Chore,
}

impl BeadsIssueType {
    /// Return the lowercase string representation.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Task => "task",
            Self::Bug => "bug",
            Self::Feature => "feature",
            Self::Epic => "epic",
            Self::Chore => "chore",
        }
    }
}

/// Directed dependency relation type in a Beads graph.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum BeadsDependencyType {
    /// `depends_on_id` blocks `issue_id`.
    #[serde(rename = "blocks")]
    Blocks,
    /// Non-blocking cross-reference.
    #[serde(rename = "related")]
    Related,
    /// Duplicate issue link.
    #[serde(rename = "duplicates")]
    Duplicates,
    /// Parent-child hierarchy link.
    #[serde(rename = "parent-child")]
    ParentChild,
    /// Provenance link.
    #[serde(rename = "discovered-from")]
    DiscoveredFrom,
}

/// Directed dependency edge attached to a [`BeadsIssue`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BeadsDependency {
    /// Optional relation UUID.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    /// The issue that holds the dependency.
    pub issue_id: String,
    /// The issue depended upon (e.g. the blocker).
    pub depends_on_id: String,
    /// Dependency relation kind.
    #[serde(rename = "type")]
    pub dep_type: BeadsDependencyType,
    /// Optional creation timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<String>,
    /// Optional creator identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    /// Optional metadata string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<String>,
}

/// A single issue record in `.beads/issues.jsonl`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BeadsIssue {
    /// Issue identifier (e.g. `"CER-101"` or `"bd-a1b2"`).
    pub id: String,
    /// Issue title.
    pub title: String,
    /// Optional markdown description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Optional design notes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub design: Option<String>,
    /// Optional acceptance criteria text.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub acceptance_criteria: Option<String>,
    /// Optional operator notes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    /// Optional specification identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spec_id: Option<String>,
    /// Issue status.
    pub status: BeadsStatus,
    /// Beads priority (`0`=critical/P0, `1`=high/P1, `2`=medium/P2, `3`=low/P3, `4`=backlog/P4).
    pub priority: u8,
    /// Optional issue category.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issue_type: Option<BeadsIssueType>,
    /// Optional cached blocked flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_blocked: Option<bool>,
    /// Optional assignee name or email.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    /// Optional owner identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    /// Optional effort estimate in minutes.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_minutes: Option<u32>,
    /// ISO-8601 creation timestamp.
    pub created_at: String,
    /// Optional creator identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_by: Option<String>,
    /// ISO-8601 last-update timestamp.
    pub updated_at: String,
    /// Optional start timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    /// Optional completion timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_at: Option<String>,
    /// Optional completion reason.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub close_reason: Option<String>,
    /// Optional closing session identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub closed_by_session: Option<String>,
    /// Optional due date.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub due_at: Option<String>,
    /// Optional deferral timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub defer_until: Option<String>,
    /// Canonical external reference (e.g. Linear identifier or URL).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub external_ref: Option<String>,
    /// Source system identifier (e.g. `"linear"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_system: Option<String>,
    /// Source repository identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_repo: Option<String>,
    /// Attached label names.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub labels: Option<Vec<String>>,
    /// Directed dependency edges.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dependencies: Option<Vec<BeadsDependency>>,
    /// Arbitrary extension metadata.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
}

/// Workspace metadata stored in `.beads/metadata.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BeadsMetadata {
    /// Storage backend (`"linearctl"`, `"http"`, or `"dolt"`).
    pub backend: String,
    /// Metadata schema version (`"1.0.0"`).
    pub version: String,
    /// Optional ISO-8601 timestamp of last Linear sync.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_sync: Option<String>,
    /// Optional primary team key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_id: Option<String>,
    /// Optional scoped team keys.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team_ids: Option<Vec<String>>,
    /// Optional scoped project identifier.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    /// Identifier generation mode (`"linear"` or `"hash"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_mode: Option<String>,
    /// Whether issue relations are synchronized.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sync_relations: Option<bool>,
}

/// Summary of an unresolved blocker in [`ReadyEvaluationResult`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockerInfo {
    /// Blocker issue identifier.
    pub id: String,
    /// Blocker issue title.
    pub title: String,
    /// Blocker issue status.
    pub status: BeadsStatus,
    /// Blocker issue priority.
    pub priority: u8,
}

/// Blocked issue paired with its active blockers.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockedIssueEntry {
    /// The blocked issue.
    pub issue: BeadsIssue,
    /// Unresolved blockers preventing readiness.
    pub blockers: Vec<BlockerInfo>,
}

/// Partition of open issues into ready (unblocked) and blocked sets.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReadyEvaluationResult {
    /// Unblocked open issues sorted by priority ascending then creation time.
    pub ready: Vec<BeadsIssue>,
    /// Open issues that still have unresolved blockers.
    pub blocked: Vec<BlockedIssueEntry>,
}

/// Convert a Linear priority (`1..=4` or `0`/unset) into a Beads priority (`0..=4`).
#[must_use]
pub const fn linear_priority_to_beads(linear_priority: Option<u8>) -> u8 {
    match linear_priority {
        Some(1) => 0,
        Some(2) => 1,
        Some(3) => 2,
        Some(4) => 3,
        _ => 4,
    }
}

/// Convert a Beads priority (`0..=4`) into a Linear priority (`0..=4`).
#[must_use]
pub const fn beads_priority_to_linear(beads_priority: u8) -> u8 {
    match beads_priority {
        0 => 1,
        1 => 2,
        2 => 3,
        3 => 4,
        _ => 0,
    }
}

/// Convert a Linear workflow state type (`started`, `completed`, `canceled`, `backlog`, `unstarted`) to [`BeadsStatus`].
#[must_use]
pub fn linear_state_type_to_beads(state_type: Option<&str>) -> BeadsStatus {
    match state_type.map(str::to_ascii_lowercase).as_deref() {
        Some("started") => BeadsStatus::InProgress,
        Some("completed" | "canceled") => BeadsStatus::Closed,
        _ => BeadsStatus::Open,
    }
}

/// Convert a [`BeadsStatus`] to its corresponding Linear workflow state type (`"unstarted"`, `"started"`, `"completed"`).
#[must_use]
pub const fn beads_status_to_linear_state_type(status: BeadsStatus) -> &'static str {
    match status {
        BeadsStatus::InProgress => "started",
        BeadsStatus::Closed => "completed",
        BeadsStatus::Open | BeadsStatus::Blocked | BeadsStatus::Deferred => "unstarted",
    }
}

/// Infer a [`BeadsIssueType`] from Linear label names and child-issue presence.
#[must_use]
pub fn infer_issue_type<S: AsRef<str>>(labels: &[S], has_children: bool) -> BeadsIssueType {
    if has_children {
        return BeadsIssueType::Epic;
    }
    let normalized: Vec<String> = labels.iter().map(|l| l.as_ref().to_lowercase()).collect();
    if normalized
        .iter()
        .any(|l| l.contains("bug") || l.contains("defect") || l.contains("fix"))
    {
        return BeadsIssueType::Bug;
    }
    if normalized
        .iter()
        .any(|l| l.contains("feat") || l.contains("feature") || l.contains("enhancement"))
    {
        return BeadsIssueType::Feature;
    }
    if normalized
        .iter()
        .any(|l| l.contains("epic") || l.contains("initiative"))
    {
        return BeadsIssueType::Epic;
    }
    if normalized
        .iter()
        .any(|l| l.contains("chore") || l.contains("maintenance") || l.contains("refactor"))
    {
        return BeadsIssueType::Chore;
    }
    BeadsIssueType::Task
}

/// Build a lookup map from both `id` and `external_ref` to issue index in `issues`.
#[must_use]
pub fn build_issue_index(issues: &[BeadsIssue]) -> HashMap<String, usize> {
    let mut index = HashMap::with_capacity(issues.len() * 2);
    for (i, issue) in issues.iter().enumerate() {
        index.insert(issue.id.clone(), i);
        if let Some(ext) = &issue.external_ref {
            index.insert(ext.clone(), i);
        }
    }
    index
}

/// Evaluate all issues in `issues` and partition open issues into `ready` and `blocked`.
#[must_use]
pub fn evaluate_readiness(issues: &[BeadsIssue], now_ms: i64) -> ReadyEvaluationResult {
    let index = build_issue_index(issues);
    let mut ready = Vec::new();
    let mut blocked = Vec::new();

    for issue in issues {
        if issue.status != BeadsStatus::Open {
            continue;
        }
        if let Some(defer_str) = &issue.defer_until {
            if let Some(defer_ms) = iso_to_epoch_ms(defer_str) {
                if defer_ms > now_ms {
                    continue;
                }
            }
        }

        let mut blockers = Vec::new();
        for dep in issue.dependencies.as_deref().unwrap_or(&[]) {
            if dep.dep_type == BeadsDependencyType::Blocks && dep.issue_id == issue.id {
                if let Some(&idx) = index.get(&dep.depends_on_id) {
                    if let Some(blocker) = issues.get(idx) {
                        if blocker.status != BeadsStatus::Closed {
                            blockers.push(BlockerInfo {
                                id: blocker.id.clone(),
                                title: blocker.title.clone(),
                                status: blocker.status,
                                priority: blocker.priority,
                            });
                        }
                    }
                } else {
                    blockers.push(BlockerInfo {
                        id: dep.depends_on_id.clone(),
                        title: "(external issue)".to_string(),
                        status: BeadsStatus::Open,
                        priority: 4,
                    });
                }
            }
        }

        if blockers.is_empty() {
            ready.push(issue.clone());
        } else {
            blocked.push(BlockedIssueEntry {
                issue: issue.clone(),
                blockers,
            });
        }
    }

    ready.sort_by(|a, b| {
        a.priority.cmp(&b.priority).then_with(|| {
            let ta = iso_to_epoch_ms(&a.created_at).unwrap_or(0);
            let tb = iso_to_epoch_ms(&b.created_at).unwrap_or(0);
            ta.cmp(&tb)
        })
    });

    ReadyEvaluationResult { ready, blocked }
}

/// Return all unblocked open issues sorted by priority then creation timestamp.
#[must_use]
pub fn get_ready_issues(issues: &[BeadsIssue], now_ms: i64) -> Vec<BeadsIssue> {
    evaluate_readiness(issues, now_ms).ready
}

/// Return active (non-closed) blockers for `issue_id`.
#[must_use]
pub fn get_issue_blockers(issue_id: &str, issues: &[BeadsIssue]) -> Vec<BlockerInfo> {
    let index = build_issue_index(issues);
    let Some(&target_idx) = index.get(issue_id) else {
        return Vec::new();
    };
    let Some(target) = issues.get(target_idx) else {
        return Vec::new();
    };

    let mut blockers = Vec::new();
    for dep in target.dependencies.as_deref().unwrap_or(&[]) {
        if dep.dep_type == BeadsDependencyType::Blocks && dep.issue_id == target.id {
            if let Some(&b_idx) = index.get(&dep.depends_on_id) {
                if let Some(blocker) = issues.get(b_idx) {
                    if blocker.status != BeadsStatus::Closed {
                        blockers.push(BlockerInfo {
                            id: blocker.id.clone(),
                            title: blocker.title.clone(),
                            status: blocker.status,
                            priority: blocker.priority,
                        });
                    }
                }
            } else {
                blockers.push(BlockerInfo {
                    id: dep.depends_on_id.clone(),
                    title: "(external issue)".to_string(),
                    status: BeadsStatus::Open,
                    priority: 4,
                });
            }
        }
    }
    blockers
}

/// Return issues that directly depend on (are blocked by) `issue_id`.
#[must_use]
pub fn get_issue_dependents(issue_id: &str, issues: &[BeadsIssue]) -> Vec<BeadsIssue> {
    let index = build_issue_index(issues);
    let Some(&target_idx) = index.get(issue_id) else {
        return Vec::new();
    };
    let Some(target) = issues.get(target_idx) else {
        return Vec::new();
    };

    let mut dependents = Vec::new();
    for issue in issues {
        for dep in issue.dependencies.as_deref().unwrap_or(&[]) {
            if dep.dep_type == BeadsDependencyType::Blocks
                && dep.depends_on_id == target.id
                && dep.issue_id == issue.id
            {
                dependents.push(issue.clone());
            }
        }
    }
    dependents
}

/// Claim an issue in the local graph (`status = in_progress`, sets `assignee` and `started_at`).
///
/// # Errors
///
/// Returns a [`CliError`] if the issue does not exist (`not_found`) or is already closed (`refused`).
pub fn claim_issue(
    issue_id: &str,
    actor: &str,
    issues: &[BeadsIssue],
    now_iso: &str,
) -> Result<(BeadsIssue, Vec<BeadsIssue>), CliError> {
    let index = build_issue_index(issues);
    let Some(&target_idx) = index.get(issue_id) else {
        return Err(CliError::not_found(
            format!("Issue not found: {issue_id}"),
            "",
        ));
    };
    let Some(target) = issues.get(target_idx) else {
        return Err(CliError::not_found(
            format!("Issue not found: {issue_id}"),
            "",
        ));
    };
    if target.status == BeadsStatus::Closed {
        return Err(CliError::refused(
            format!("Cannot claim closed issue: {issue_id}"),
            "",
        ));
    }

    let mut updated = target.clone();
    updated.status = BeadsStatus::InProgress;
    updated.assignee = Some(actor.to_string());
    if updated.started_at.is_none() {
        updated.started_at = Some(now_iso.to_string());
    }
    updated.updated_at = now_iso.to_string();

    let all: Vec<BeadsIssue> = issues
        .iter()
        .map(|i| {
            if i.id == target.id {
                updated.clone()
            } else {
                i.clone()
            }
        })
        .collect();
    Ok((updated, all))
}

/// Close an issue in the local graph and compute newly unblocked ready issues.
///
/// # Errors
///
/// Returns a [`CliError`] (`not_found`) if `issue_id` is absent.
pub fn close_beads_issue(
    issue_id: &str,
    reason: Option<&str>,
    session: Option<&str>,
    issues: &[BeadsIssue],
    now_iso: &str,
    now_ms: i64,
) -> Result<(BeadsIssue, Vec<BeadsIssue>, Vec<BeadsIssue>), CliError> {
    let index = build_issue_index(issues);
    let Some(&target_idx) = index.get(issue_id) else {
        return Err(CliError::not_found(
            format!("Issue not found: {issue_id}"),
            "",
        ));
    };
    let Some(target) = issues.get(target_idx) else {
        return Err(CliError::not_found(
            format!("Issue not found: {issue_id}"),
            "",
        ));
    };

    let before_ready: BTreeSet<String> = get_ready_issues(issues, now_ms)
        .into_iter()
        .map(|i| i.id)
        .collect();

    let mut closed = target.clone();
    closed.status = BeadsStatus::Closed;
    closed.closed_at = Some(now_iso.to_string());
    closed.close_reason = Some(reason.unwrap_or("Completed").to_string());
    closed.closed_by_session = session.map(str::to_string);
    closed.updated_at = now_iso.to_string();

    let all: Vec<BeadsIssue> = issues
        .iter()
        .map(|i| {
            if i.id == target.id {
                closed.clone()
            } else {
                i.clone()
            }
        })
        .collect();

    let newly_ready: Vec<BeadsIssue> = get_ready_issues(&all, now_ms)
        .into_iter()
        .filter(|i| !before_ready.contains(&i.id) && i.id != closed.id)
        .collect();

    Ok((closed, newly_ready, all))
}

/// Detect directed cycles in the blocking dependency graph.
#[must_use]
pub fn detect_cycles(issues: &[BeadsIssue]) -> Vec<Vec<String>> {
    let mut adj: HashMap<String, Vec<String>> = HashMap::with_capacity(issues.len());
    for issue in issues {
        let mut blockers = Vec::new();
        for dep in issue.dependencies.as_deref().unwrap_or(&[]) {
            if dep.dep_type == BeadsDependencyType::Blocks && dep.issue_id == issue.id {
                blockers.push(dep.depends_on_id.clone());
            }
        }
        adj.insert(issue.id.clone(), blockers);
    }

    let mut visited = HashSet::new();
    let mut rec_stack = HashSet::new();
    let mut cycles = Vec::new();
    let mut path = Vec::new();

    fn dfs(
        node: &str,
        adj: &HashMap<String, Vec<String>>,
        visited: &mut HashSet<String>,
        rec_stack: &mut HashSet<String>,
        path: &mut Vec<String>,
        cycles: &mut Vec<Vec<String>>,
    ) {
        visited.insert(node.to_string());
        rec_stack.insert(node.to_string());
        path.push(node.to_string());

        if let Some(neighbors) = adj.get(node) {
            for neighbor in neighbors {
                if !visited.contains(neighbor) {
                    dfs(neighbor, adj, visited, rec_stack, path, cycles);
                } else if rec_stack.contains(neighbor) {
                    if let Some(start_idx) = path.iter().position(|n| n == neighbor) {
                        let mut cycle = path[start_idx..].to_vec();
                        cycle.push(neighbor.clone());
                        cycles.push(cycle);
                    }
                }
            }
        }

        rec_stack.remove(node);
        path.pop();
    }

    for issue in issues {
        if !visited.contains(&issue.id) {
            dfs(
                &issue.id,
                &adj,
                &mut visited,
                &mut rec_stack,
                &mut path,
                &mut cycles,
            );
        }
    }

    cycles
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    fn sample_issue(id: &str, priority: u8, blocked_by: Option<&str>) -> BeadsIssue {
        let dependencies = blocked_by.map(|b| {
            vec![BeadsDependency {
                id: None,
                issue_id: id.to_string(),
                depends_on_id: b.to_string(),
                dep_type: BeadsDependencyType::Blocks,
                created_at: None,
                created_by: None,
                metadata: None,
            }]
        });
        BeadsIssue {
            id: id.to_string(),
            title: format!("Task {id}"),
            description: None,
            design: None,
            acceptance_criteria: None,
            notes: None,
            spec_id: None,
            status: BeadsStatus::Open,
            priority,
            issue_type: Some(BeadsIssueType::Task),
            is_blocked: None,
            assignee: None,
            owner: None,
            estimated_minutes: None,
            created_at: "2026-10-01T00:00:00.000Z".to_string(),
            created_by: None,
            updated_at: "2026-10-01T00:00:00.000Z".to_string(),
            started_at: None,
            closed_at: None,
            close_reason: None,
            closed_by_session: None,
            due_at: None,
            defer_until: None,
            external_ref: None,
            source_system: Some("linear".to_string()),
            source_repo: None,
            labels: None,
            dependencies,
            metadata: None,
        }
    }

    #[test]
    fn evaluates_readiness_and_unblocks_on_close() {
        let issues = vec![
            sample_issue("CER-1", 1, None),
            sample_issue("CER-2", 0, Some("CER-1")),
        ];
        let eval = evaluate_readiness(&issues, 1_800_000_000_000);
        assert_eq!(eval.ready.len(), 1);
        assert_eq!(eval.ready[0].id, "CER-1");
        assert_eq!(eval.blocked.len(), 1);
        assert_eq!(eval.blocked[0].issue.id, "CER-2");

        let (closed, newly_ready, _) = close_beads_issue(
            "CER-1",
            Some("Done"),
            None,
            &issues,
            "2026-10-14T00:00:00.000Z",
            1_800_000_000_000,
        )
        .unwrap();
        assert_eq!(closed.status, BeadsStatus::Closed);
        assert_eq!(newly_ready.len(), 1);
        assert_eq!(newly_ready[0].id, "CER-2");
    }
}
