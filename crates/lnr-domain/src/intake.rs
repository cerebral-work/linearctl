//! Pure `lnr → escapement` intake mapping (`PlanSubmission` synthesis and eligibility policy).

use serde::{Deserialize, Serialize};

use crate::models::TriageItem;

/// Schema identifier for escapement `PlanSubmission` v1 payloads.
pub const PLAN_SUBMISSION_SCHEMA_VERSION: &str = "escapement.plan-submission.v1";

/// Default token budget per story point when translating Linear estimates.
pub const DEFAULT_TOKENS_PER_POINT: u64 = 32_000;

/// Default token ceiling when an issue has no point estimate.
pub const DEFAULT_MAX_TOKENS: u64 = 64_000;

/// Minimum clamped token ceiling for a generated `PlanSubmission`.
pub const MIN_MAX_TOKENS: u64 = 16_000;

/// Maximum clamped token ceiling for a generated `PlanSubmission`.
pub const MAX_TOKENS_CAP: u64 = 512_000;

/// Escapement execution tier derived from Linear issue priority.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExecutionTier {
    /// Priority 4 (Low) — lightweight/fast execution lane.
    Fast,
    /// Priority 3 (Medium) — standard balanced execution lane.
    Balanced,
    /// Priority 1 (Urgent) or 2 (High) — deep reasoning capable lane.
    Capable,
    /// Priority 0 (Unprioritized) — requires triage/operator review before execution.
    Review,
}

impl ExecutionTier {
    /// Map a Linear numeric priority (`0..=4`) to an [`ExecutionTier`].
    #[must_use]
    pub const fn from_linear_priority(priority: u8) -> Self {
        match priority {
            1 | 2 => Self::Capable,
            3 => Self::Balanced,
            4 => Self::Fast,
            _ => Self::Review,
        }
    }

    /// Canonical lowercase tier name.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Fast => "fast",
            Self::Balanced => "balanced",
            Self::Capable => "capable",
            Self::Review => "review",
        }
    }
}

/// Token and turn budget attached to an escapement [`PlanSubmission`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanBudget {
    /// Maximum tokens allocated to the plan run.
    pub max_tokens: u64,
    /// Tokens allocated per Linear estimate point.
    pub tokens_per_point: u64,
    /// Whether `max_tokens` was derived from an explicit story-point estimate.
    pub estimated: bool,
}

/// Provenance and tracker context preserved on a [`PlanSubmission`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanMetadata {
    /// Linear team key (e.g. `"CER"`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// Linear project name if assigned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Workflow state name.
    pub state: String,
    /// Workflow state category (`triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`).
    pub state_type: String,
    /// Optional point estimate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate: Option<f64>,
    /// Optional assignee display name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
    /// Canonical Linear issue URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
}

/// Escapement `PlanSubmission` payload produced by the `lnr → escapement` intake edge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanSubmission {
    /// Schema version (`"escapement.plan-submission.v1"`).
    pub schema_version: String,
    /// Canonical Linear issue identifier (e.g. `"ENG-123"`) preserved for round-trip updates.
    #[serde(rename = "linear_issue_id")]
    pub linear_issue_id: String,
    /// Issue identifier alias matching `linear_issue_id`.
    pub identifier: String,
    /// Issue title.
    pub title: String,
    /// Combined goal statement synthesized from title and description.
    pub goal: String,
    /// Target escapement workflow name (`feature`, `bugfix`, `security-fix`, `docs`, `chore`).
    pub workflow: String,
    /// Target model/execution tier derived from priority.
    pub tier: ExecutionTier,
    /// Linear numeric priority (`0..=4`).
    pub priority: u8,
    /// Sorted issue label names.
    pub labels: Vec<String>,
    /// Computed token budget.
    pub budget: PlanBudget,
    /// Tracker metadata preserved for audit and round-trip correlation.
    pub metadata: PlanMetadata,
}

/// Normalized issue / triage item candidate evaluated by the intake edge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeCandidate {
    /// Canonical Linear issue identifier (e.g. `"ENG-123"`).
    pub identifier: String,
    /// Issue title.
    pub title: String,
    /// Optional markdown description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Optional canonical issue URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Optional Linear team key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    /// Optional Linear project name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    /// Linear numeric priority (`0..=4`).
    pub priority: u8,
    /// Optional point estimate.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimate: Option<f64>,
    /// Workflow state name.
    pub state: String,
    /// Workflow state type.
    pub state_type: String,
    /// Attached label names.
    #[serde(default)]
    pub labels: Vec<String>,
    /// Optional assignee name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee: Option<String>,
}

impl From<&TriageItem> for IntakeCandidate {
    fn from(item: &TriageItem) -> Self {
        Self {
            identifier: item.identifier.clone(),
            title: item.title.clone(),
            description: None,
            url: Some(item.url.clone()).filter(|u| !u.is_empty()),
            team: item
                .identifier
                .split_once('-')
                .map(|(prefix, _)| prefix.to_string()),
            project: item.project.clone(),
            priority: item.priority,
            estimate: item.estimate,
            state: item.state.clone(),
            state_type: item.state_type.clone(),
            labels: item.labels.clone(),
            assignee: item.assignee.clone(),
        }
    }
}

/// Configurable policy governing intake eligibility and `PlanSubmission` synthesis.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakePolicy {
    /// Labels that must all be present on the candidate.
    pub required_labels: Vec<String>,
    /// Labels that disqualify the candidate if any are present.
    pub blocked_labels: Vec<String>,
    /// Allowed Linear workflow state types (`triage`, `backlog`, `unstarted`).
    pub allowed_state_types: Vec<String>,
    /// Fallback workflow when no label matches a specialized workflow.
    pub default_workflow: String,
    /// Token budget multiplier per story point.
    pub tokens_per_point: u64,
    /// Default token budget when an issue is unestimated.
    pub default_max_tokens: u64,
}

impl Default for IntakePolicy {
    fn default() -> Self {
        Self {
            required_labels: Vec::new(),
            blocked_labels: vec![
                "blocked".to_string(),
                "do-not-automate".to_string(),
                "needs-human".to_string(),
                "wontfix".to_string(),
            ],
            allowed_state_types: vec![
                "triage".to_string(),
                "backlog".to_string(),
                "unstarted".to_string(),
            ],
            default_workflow: "feature".to_string(),
            tokens_per_point: DEFAULT_TOKENS_PER_POINT,
            default_max_tokens: DEFAULT_MAX_TOKENS,
        }
    }
}

/// Result of evaluating an [`IntakeCandidate`] against an [`IntakePolicy`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntakeEvaluation {
    /// Canonical Linear issue identifier preserved for round-trip updates.
    #[serde(rename = "linear_issue_id")]
    pub linear_issue_id: String,
    /// Issue identifier alias matching `linear_issue_id`.
    pub identifier: String,
    /// Whether the candidate passed all policy checks.
    pub eligible: bool,
    /// Rejection reasons when `eligible` is `false`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub reasons: Vec<String>,
    /// Synthesized `PlanSubmission` when `eligible` is `true`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub submission: Option<PlanSubmission>,
}

/// Derive the escapement workflow name from issue labels and the policy fallback.
#[must_use]
pub fn resolve_workflow(labels: &[String], default_workflow: &str) -> String {
    let normalized: Vec<String> = labels
        .iter()
        .map(|l| l.trim().to_ascii_lowercase())
        .collect();

    if normalized
        .iter()
        .any(|l| matches!(l.as_str(), "security" | "cve" | "vulnerability"))
    {
        return "security-fix".to_string();
    }
    if normalized
        .iter()
        .any(|l| matches!(l.as_str(), "bug" | "incident" | "regression" | "defect"))
    {
        return "bugfix".to_string();
    }
    if normalized
        .iter()
        .any(|l| matches!(l.as_str(), "docs" | "documentation" | "runbook"))
    {
        return "docs".to_string();
    }
    if normalized
        .iter()
        .any(|l| matches!(l.as_str(), "chore" | "maintenance" | "refactor" | "deps"))
    {
        return "chore".to_string();
    }

    default_workflow.to_string()
}

/// Compute a [`PlanBudget`] from an optional story-point estimate and policy settings.
#[must_use]
pub fn compute_budget(estimate: Option<f64>, policy: &IntakePolicy) -> PlanBudget {
    let tokens_per_point = if policy.tokens_per_point == 0 {
        DEFAULT_TOKENS_PER_POINT
    } else {
        policy.tokens_per_point
    };
    let default_max = if policy.default_max_tokens == 0 {
        DEFAULT_MAX_TOKENS
    } else {
        policy.default_max_tokens
    };

    if let Some(points) = estimate {
        if points.is_finite() && points > 0.0 {
            #[allow(
                clippy::cast_possible_truncation,
                clippy::cast_sign_loss,
                clippy::cast_precision_loss
            )]
            let raw = (points * (tokens_per_point as f64)).round() as u64;
            let clamped = raw.clamp(MIN_MAX_TOKENS, MAX_TOKENS_CAP);
            return PlanBudget {
                max_tokens: clamped,
                tokens_per_point,
                estimated: true,
            };
        }
    }

    PlanBudget {
        max_tokens: default_max.clamp(MIN_MAX_TOKENS, MAX_TOKENS_CAP),
        tokens_per_point,
        estimated: false,
    }
}

/// Convert an [`IntakeCandidate`] into an escapement [`PlanSubmission`].
#[must_use]
pub fn to_plan_submission(candidate: &IntakeCandidate, policy: &IntakePolicy) -> PlanSubmission {
    let mut sorted_labels: Vec<String> = candidate
        .labels
        .iter()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    sorted_labels.sort();
    sorted_labels.dedup();

    let goal = match candidate
        .description
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        Some(desc) => format!("{}\n\n{}", candidate.title.trim(), desc),
        None => candidate.title.trim().to_string(),
    };

    let team = candidate.team.clone().or_else(|| {
        candidate
            .identifier
            .split_once('-')
            .map(|(prefix, _)| prefix.to_string())
    });

    PlanSubmission {
        schema_version: PLAN_SUBMISSION_SCHEMA_VERSION.to_string(),
        linear_issue_id: candidate.identifier.clone(),
        identifier: candidate.identifier.clone(),
        title: candidate.title.clone(),
        goal,
        workflow: resolve_workflow(&sorted_labels, &policy.default_workflow),
        tier: ExecutionTier::from_linear_priority(candidate.priority),
        priority: candidate.priority,
        labels: sorted_labels,
        budget: compute_budget(candidate.estimate, policy),
        metadata: PlanMetadata {
            team,
            project: candidate.project.clone(),
            state: candidate.state.clone(),
            state_type: candidate.state_type.clone(),
            estimate: candidate.estimate,
            assignee: candidate.assignee.clone(),
            source_url: candidate.url.clone(),
        },
    }
}

/// Evaluate whether an [`IntakeCandidate`] satisfies [`IntakePolicy`] and build its [`PlanSubmission`].
#[must_use]
pub fn evaluate_intake(candidate: &IntakeCandidate, policy: &IntakePolicy) -> IntakeEvaluation {
    let mut reasons = Vec::new();

    let state_type_lower = candidate.state_type.trim().to_ascii_lowercase();
    if !policy.allowed_state_types.is_empty()
        && !policy
            .allowed_state_types
            .iter()
            .any(|allowed| allowed.trim().eq_ignore_ascii_case(&state_type_lower))
    {
        reasons.push(format!(
            "stateType '{}' is not in allowedStateTypes [{}]",
            candidate.state_type,
            policy.allowed_state_types.join(", ")
        ));
    }

    let candidate_labels_lower: Vec<String> = candidate
        .labels
        .iter()
        .map(|l| l.trim().to_ascii_lowercase())
        .collect();

    for blocked in &policy.blocked_labels {
        let b = blocked.trim().to_ascii_lowercase();
        if !b.is_empty() && candidate_labels_lower.iter().any(|l| l == &b) {
            reasons.push(format!("blocked by label '{blocked}'"));
        }
    }

    for required in &policy.required_labels {
        let r = required.trim().to_ascii_lowercase();
        if !r.is_empty() && !candidate_labels_lower.iter().any(|l| l == &r) {
            reasons.push(format!("missing required label '{required}'"));
        }
    }

    let eligible = reasons.is_empty();
    let submission = if eligible {
        Some(to_plan_submission(candidate, policy))
    } else {
        None
    };

    IntakeEvaluation {
        linear_issue_id: candidate.identifier.clone(),
        identifier: candidate.identifier.clone(),
        eligible,
        reasons,
        submission,
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used)]
mod tests {
    use super::*;

    fn sample_candidate() -> IntakeCandidate {
        IntakeCandidate {
            identifier: "CER-2130".to_string(),
            title: "Wire lnr to escapement intake edge".to_string(),
            description: Some("Translate triage items into PlanSubmission.".to_string()),
            url: Some("https://linear.app/cerebral/issue/CER-2130".to_string()),
            team: Some("CER".to_string()),
            project: Some("Estates".to_string()),
            priority: 2,
            estimate: Some(3.0),
            state: "Todo".to_string(),
            state_type: "unstarted".to_string(),
            labels: vec!["agent-eligible".to_string(), "bug".to_string()],
            assignee: None,
        }
    }

    #[test]
    fn priority_maps_to_expected_execution_tier() {
        assert_eq!(
            ExecutionTier::from_linear_priority(1),
            ExecutionTier::Capable
        );
        assert_eq!(
            ExecutionTier::from_linear_priority(2),
            ExecutionTier::Capable
        );
        assert_eq!(
            ExecutionTier::from_linear_priority(3),
            ExecutionTier::Balanced
        );
        assert_eq!(ExecutionTier::from_linear_priority(4), ExecutionTier::Fast);
        assert_eq!(
            ExecutionTier::from_linear_priority(0),
            ExecutionTier::Review
        );
    }

    #[test]
    fn labels_map_to_expected_workflow() {
        assert_eq!(resolve_workflow(&["bug".to_string()], "feature"), "bugfix");
        assert_eq!(
            resolve_workflow(&["security".to_string(), "bug".to_string()], "feature"),
            "security-fix"
        );
        assert_eq!(
            resolve_workflow(&["runbook".to_string()], "feature"),
            "docs"
        );
        assert_eq!(
            resolve_workflow(&["refactor".to_string()], "feature"),
            "chore"
        );
        assert_eq!(
            resolve_workflow(&["agent-eligible".to_string()], "feature"),
            "feature"
        );
    }

    #[test]
    fn estimate_maps_to_clamped_token_budget() {
        let policy = IntakePolicy::default();
        let estimated = compute_budget(Some(3.0), &policy);
        assert!(estimated.estimated);
        assert_eq!(estimated.max_tokens, 96_000);

        let unestimated = compute_budget(None, &policy);
        assert!(!unestimated.estimated);
        assert_eq!(unestimated.max_tokens, DEFAULT_MAX_TOKENS);
    }

    #[test]
    fn evaluate_intake_preserves_linear_issue_id_and_filters_ineligible() {
        let candidate = sample_candidate();
        let policy = IntakePolicy {
            required_labels: vec!["agent-eligible".to_string()],
            ..IntakePolicy::default()
        };

        let eval = evaluate_intake(&candidate, &policy);
        assert!(eval.eligible);
        let sub = eval
            .submission
            .expect("eligible candidate yields submission");
        assert_eq!(sub.linear_issue_id, "CER-2130");
        assert_eq!(sub.tier, ExecutionTier::Capable);
        assert_eq!(sub.workflow, "bugfix");
        assert_eq!(sub.budget.max_tokens, 96_000);
        assert_eq!(sub.metadata.project.as_deref(), Some("Estates"));

        let mut blocked_candidate = candidate;
        blocked_candidate.labels.push("blocked".to_string());
        let rejected = evaluate_intake(&blocked_candidate, &policy);
        assert!(!rejected.eligible);
        assert!(rejected.submission.is_none());
        assert_eq!(rejected.linear_issue_id, "CER-2130");
        assert!(rejected.reasons.iter().any(|r| r.contains("blocked")));
    }
}
