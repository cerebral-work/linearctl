//! Falsifiable empirical claims, primary source citation validation, agent step receipts,
//! event journaling, and reverse-order Saga compensation planning.

use serde::{Deserialize, Serialize};

use crate::crypto::sha256_hex;
use crate::error::DomainError;
use crate::saga::{CompensationReceipt, FlowGraph};

/// A falsifiable empirical research or engineering claim.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Claim {
    /// Proposition statement.
    pub statement: String,
    /// Quantitative metric name or boundary indicator.
    pub metric: String,
    /// Measured bound or threshold value.
    pub bound: String,
    /// Mechanical verification command or falsification procedure.
    pub test_procedure: String,
    /// Evidence citation or primary source locator.
    pub evidence_ref: String,
    /// Positive or negative control description.
    pub control: String,
}

impl Claim {
    /// Create and validate a new claim.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::MissingClaimField`] if any field is empty, or [`DomainError::NonAscii`]
    /// if `statement` contains non-ASCII bytes.
    pub fn new(
        statement: impl Into<String>,
        metric: impl Into<String>,
        bound: impl Into<String>,
        test_procedure: impl Into<String>,
        evidence_ref: impl Into<String>,
        control: impl Into<String>,
    ) -> Result<Self, DomainError> {
        let claim = Self {
            statement: statement.into(),
            metric: metric.into(),
            bound: bound.into(),
            test_procedure: test_procedure.into(),
            evidence_ref: evidence_ref.into(),
            control: control.into(),
        };
        claim.validate()?;
        Ok(claim)
    }

    /// Verify that all required fields are non-empty and ASCII.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::MissingClaimField`] or [`DomainError::NonAscii`].
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.statement.trim().is_empty() {
            return Err(DomainError::MissingClaimField("statement"));
        }
        if self.metric.trim().is_empty() {
            return Err(DomainError::MissingClaimField("metric"));
        }
        if self.bound.trim().is_empty() {
            return Err(DomainError::MissingClaimField("bound"));
        }
        if self.test_procedure.trim().is_empty() {
            return Err(DomainError::MissingClaimField("test_procedure"));
        }
        if self.evidence_ref.trim().is_empty() {
            return Err(DomainError::MissingClaimField("evidence_ref"));
        }
        if self.control.trim().is_empty() {
            return Err(DomainError::MissingClaimField("control"));
        }
        if let Some((idx, _)) = self.statement.bytes().enumerate().find(|(_, b)| *b > 127) {
            return Err(DomainError::NonAscii(idx));
        }
        Ok(())
    }
}

/// Frontmatter for a research finding or technical RFC markdown document.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindingFrontmatter {
    /// Document type (must be `"finding"`).
    pub r#type: String,
    /// Lifecycle status (`"draft"`, `"reviewed"`, `"approved"`, `"superseded"`).
    pub status: String,
    /// Owner identifier (e.g. `"w19:p1"`).
    pub owner: String,
    /// Approver identifier (required if status is `"approved"`).
    pub approved_by: String,
    /// Review date (`YYYY-MM-DD`).
    pub last_reviewed: String,
    /// Primary source citations (`owner/repo@sha:path`, `arxiv:`, `doi:`, or `https://`).
    pub sources: Vec<String>,
}

impl FindingFrontmatter {
    /// Validate all invariant constraints on finding frontmatter.
    ///
    /// # Errors
    ///
    /// Returns a [`DomainError`] if any frontmatter field is invalid.
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.r#type != "finding" {
            return Err(DomainError::InvalidType(self.r#type.clone()));
        }
        match self.status.as_str() {
            "draft" | "reviewed" | "approved" | "superseded" => {}
            _ => return Err(DomainError::InvalidStatus(self.status.clone())),
        }
        if self.owner.trim().is_empty() {
            return Err(DomainError::MissingClaimField("owner"));
        }
        if !is_valid_date(&self.last_reviewed) {
            return Err(DomainError::InvalidDate(self.last_reviewed.clone()));
        }
        if self.sources.is_empty() {
            return Err(DomainError::MissingClaimField("sources"));
        }
        for s in &self.sources {
            if !is_valid_source_ref(s) {
                return Err(DomainError::InvalidSource(s.clone()));
            }
        }
        Ok(())
    }
}

/// Check if string matches `YYYY-MM-DD`.
#[must_use]
pub fn is_valid_date(date: &str) -> bool {
    if date.len() != 10 {
        return false;
    }
    let b = date.as_bytes();
    b[0..4].iter().all(u8::is_ascii_digit)
        && b[4] == b'-'
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[7] == b'-'
        && b[8..10].iter().all(u8::is_ascii_digit)
}

/// Check if string matches an accepted primary source locator.
///
/// Accepted formats:
/// - HTTP or HTTPS URL
/// - arXiv identifier (`arxiv:YYMM.NNNNN` or `arxiv:YYMM.NNNNNvN`)
/// - DOI identifier (`doi:10.NNNN.../suffix`)
/// - Git source locator (`owner/repo@sha:path` with non-zero commit hash)
#[must_use]
pub fn is_valid_source_ref(source: &str) -> bool {
    let s = source.trim();
    if s.is_empty() || s.contains(char::is_whitespace) {
        return false;
    }

    if s.starts_with("https://") || s.starts_with("http://") {
        return s.len() > 8;
    }

    if s.len() > 6 && s[..6].eq_ignore_ascii_case("arxiv:") {
        return is_valid_arxiv(&s[6..]);
    }

    if s.len() > 4 && s[..4].eq_ignore_ascii_case("doi:") {
        return is_valid_doi(&s[4..]);
    }

    let Some((repo_part, path_part)) = s.split_once(':') else {
        return false;
    };
    if path_part.is_empty() {
        return false;
    }
    let Some((owner_repo, sha)) = repo_part.split_once('@') else {
        return false;
    };
    if sha.len() < 7 || sha.len() > 40 || !sha.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    if sha.chars().all(|c| c == '0') {
        return false;
    }
    let Some((owner, repo)) = owner_repo.split_once('/') else {
        return false;
    };
    is_valid_ident(owner) && is_valid_ident(repo)
}

fn is_valid_arxiv(rest: &str) -> bool {
    let bytes = rest.as_bytes();
    if bytes.len() < 9 {
        return false;
    }
    if !bytes[..4].iter().all(u8::is_ascii_digit) || bytes[4] != b'.' {
        return false;
    }
    let after_dot = &rest[5..];
    let digit_count = after_dot.chars().take_while(char::is_ascii_digit).count();
    if digit_count != 4 && digit_count != 5 {
        return false;
    }
    let remainder = &after_dot[digit_count..];
    if remainder.is_empty() {
        return true;
    }
    if let Some(v_part) = remainder.strip_prefix(['v', 'V']) {
        return !v_part.is_empty() && v_part.chars().all(|c| c.is_ascii_digit());
    }
    false
}

fn is_valid_doi(rest: &str) -> bool {
    let Some(after_10) = rest.strip_prefix("10.") else {
        return false;
    };
    let digit_count = after_10.chars().take_while(char::is_ascii_digit).count();
    if !(4..=9).contains(&digit_count) {
        return false;
    }
    let remainder = &after_10[digit_count..];
    let Some(suffix) = remainder.strip_prefix('/') else {
        return false;
    };
    !suffix.is_empty() && !suffix.contains(char::is_whitespace)
}

fn is_valid_ident(s: &str) -> bool {
    !s.is_empty()
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
}

/// Validated research paper entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Paper {
    /// Canonical identifier (slug).
    pub id: String,
    /// Paper title.
    pub title: String,
    /// Publication date (`YYYY-MM-DD` or standard date string).
    pub publication_date: String,
    /// Author list.
    pub authors: Vec<String>,
    /// Web URL on primary source site.
    pub web_url: String,
    /// Abstract summary text.
    pub abstract_text: String,
    /// Classification topics.
    pub tags: Vec<String>,
}

impl Paper {
    /// Create a new paper entry.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::MissingClaimField`] or [`DomainError::NonAscii`].
    pub fn new(
        id: impl Into<String>,
        title: impl Into<String>,
        publication_date: impl Into<String>,
        authors: Vec<String>,
        web_url: impl Into<String>,
        abstract_text: impl Into<String>,
        tags: Vec<String>,
    ) -> Result<Self, DomainError> {
        let paper = Self {
            id: id.into(),
            title: title.into(),
            publication_date: publication_date.into(),
            authors,
            web_url: web_url.into(),
            abstract_text: abstract_text.into(),
            tags,
        };
        paper.validate()?;
        Ok(paper)
    }

    /// Check ASCII and required fields.
    ///
    /// # Errors
    ///
    /// Returns [`DomainError::MissingClaimField`] or [`DomainError::NonAscii`].
    pub fn validate(&self) -> Result<(), DomainError> {
        if self.id.trim().is_empty() {
            return Err(DomainError::MissingClaimField("id"));
        }
        if self.title.trim().is_empty() {
            return Err(DomainError::MissingClaimField("title"));
        }
        if self.web_url.trim().is_empty() {
            return Err(DomainError::MissingClaimField("web_url"));
        }
        for (i, b) in self.title.bytes().enumerate() {
            if b > 127 {
                return Err(DomainError::NonAscii(i));
            }
        }
        Ok(())
    }
}

/// Persona archetype driving an autonomous agent reasoning loop.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AgentPersona {
    /// Autonomous scientist formulating hypotheses and validating propositions.
    Scientist,
    /// Empirical evaluator validating claims against test suites and benchmarks.
    Evaluator,
    /// Knowledge synthesizer collating literature and building research graphs.
    Synthesizer,
    /// Editorial and formal reviewer verifying spec standards and invariants.
    Reviewer,
    /// Custom persona identifier.
    #[serde(untagged)]
    Custom(String),
}

impl AgentPersona {
    /// Parse persona from string identifier.
    #[must_use]
    pub fn from_str_or_custom(s: &str) -> Self {
        match s.trim().to_lowercase().as_str() {
            "scientist" | "research-scientist" => Self::Scientist,
            "evaluator" | "research-evaluator" => Self::Evaluator,
            "synthesizer" | "research-synthesizer" => Self::Synthesizer,
            "reviewer" | "research-reviewer" => Self::Reviewer,
            other => Self::Custom(other.to_string()),
        }
    }

    /// String tag representing the persona.
    #[must_use]
    pub fn as_str(&self) -> &str {
        match self {
            Self::Scientist => "scientist",
            Self::Evaluator => "evaluator",
            Self::Synthesizer => "synthesizer",
            Self::Reviewer => "reviewer",
            Self::Custom(s) => s.as_str(),
        }
    }

    /// System directive instructions tailored to the persona.
    #[must_use]
    pub const fn system_prompt(&self) -> &'static str {
        match self {
            Self::Scientist => {
                "You are an autonomous research scientist. Separate hypothesis generation from \
                 deterministic evaluation. Demand falsification criteria for every claim. Formulate \
                 structured EARS specifications and verify findings empirically."
            }
            Self::Evaluator => {
                "You are an empirical evaluator. Inspect test results, benchmark telemetry, and \
                 deterministic verification gates. Never guess or extrapolate beyond measured evidence."
            }
            Self::Synthesizer => {
                "You are a research knowledge synthesizer. Collate citations, map dependency \
                 trees, detect contradictions across literature, and distill clean executive summaries."
            }
            Self::Reviewer => {
                "You are a formal reviewer. Check ASD-STE100 controlled language rules, verify \
                 strict 7-bit ASCII encoding, validate EARS requirement modals, and audit claims."
            }
            Self::Custom(_) => {
                "You are an autonomous research assistant. Formulate precise, verifiable conclusions \
                 conforming to repository editorial standards and domain invariants."
            }
        }
    }
}

impl std::fmt::Display for AgentPersona {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Configuration options for an in-process agent execution turn.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentExecutionOptions {
    /// Target model identifier (e.g. `glm-5.2`).
    pub model: String,
    /// Sampling temperature between 0.0 and 1.0.
    pub temperature: f32,
    /// Maximum allowed agent reasoning turns before aborting.
    pub max_turns: usize,
    /// Execution timeout in seconds.
    pub timeout_secs: u64,
    /// Workspace root boundary for sandboxed tool operations.
    pub workspace_root: Option<String>,
    /// Whether to fall back to synthetic responses when gateway is offline.
    pub fallback_synthetic: bool,
}

impl Default for AgentExecutionOptions {
    fn default() -> Self {
        Self {
            model: "glm-5.2".to_string(),
            temperature: 0.2,
            max_turns: 10,
            timeout_secs: 60,
            workspace_root: None,
            fallback_synthetic: false,
        }
    }
}

/// Record of an individual tool call executed by an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ToolCallRecord {
    /// Name of the invoked tool.
    pub tool_name: String,
    /// Arguments passed to the tool.
    pub arguments: serde_json::Value,
    /// Whether the tool returned successfully.
    pub success: bool,
    /// Summary or truncated output of the tool result.
    pub output_summary: String,
}

/// Verifiable receipt produced upon completing an agent reasoning step.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentStepReceipt {
    /// Flow run identifier.
    pub run_id: String,
    /// Step identifier within the flow.
    pub step_id: String,
    /// Active persona that executed the step.
    pub persona: AgentPersona,
    /// Model name utilized for reasoning.
    pub model: String,
    /// Number of reasoning turns executed.
    pub turns: usize,
    /// Prompt tokens consumed.
    pub prompt_tokens: u32,
    /// Completion tokens consumed.
    pub completion_tokens: u32,
    /// Total tokens consumed.
    pub total_tokens: u32,
    /// Chronological list of tool invocations.
    pub tool_calls: Vec<ToolCallRecord>,
    /// Artifact file paths generated or updated during the step.
    pub artifacts_produced: Vec<String>,
    /// Execution duration in milliseconds.
    pub duration_ms: u64,
    /// Overall success status of the agent step.
    pub success: bool,
    /// Concise synthesis or terminal conclusion.
    pub summary: String,
}

impl AgentStepReceipt {
    /// Create a new successful receipt.
    #[must_use]
    pub fn success(
        run_id: impl Into<String>,
        step_id: impl Into<String>,
        persona: AgentPersona,
        model: impl Into<String>,
        turns: usize,
        summary: impl Into<String>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            step_id: step_id.into(),
            persona,
            model: model.into(),
            turns,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            tool_calls: Vec::new(),
            artifacts_produced: Vec::new(),
            duration_ms: 0,
            success: true,
            summary: summary.into(),
        }
    }

    /// Create a failed step receipt.
    #[must_use]
    pub fn failure(
        run_id: impl Into<String>,
        step_id: impl Into<String>,
        persona: AgentPersona,
        model: impl Into<String>,
        error: impl Into<String>,
    ) -> Self {
        Self {
            run_id: run_id.into(),
            step_id: step_id.into(),
            persona,
            model: model.into(),
            turns: 0,
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
            tool_calls: Vec::new(),
            artifacts_produced: Vec::new(),
            duration_ms: 0,
            success: false,
            summary: error.into(),
        }
    }
}

/// Overall lifecycle state of a Saga flow execution.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum RunState {
    /// Initial state before any step begins execution.
    #[default]
    Pending,
    /// Actively executing steps in the flow graph.
    Running,
    /// Paused awaiting an external gate signal (e.g. operator sign-off).
    BlockedOnGate,
    /// Step failure occurred; executing reverse-order compensating actions.
    Compensating,
    /// All compensating actions finished after a failure.
    RolledBack,
    /// Execution failed and rollback could not be completed cleanly.
    Failed,
    /// All steps in the flow completed successfully.
    Passed,
}

/// Categorical kinds of journal events recorded during execution.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunEventKind {
    /// Flow execution initialized and registered.
    FlowStarted,
    /// Execution wave initialized with scheduled steps.
    WaveStarted,
    /// Execution wave completed all assigned steps successfully.
    WaveCompleted,
    /// A single step began execution.
    StepStarted,
    /// A single step completed with zero exit status.
    StepCompleted,
    /// A single step failed or encountered a non-zero exit.
    StepFailed,
    /// Flow paused on an approval gate.
    GateBlocked,
    /// An approval gate received an external resolution signal.
    GateResolved,
    /// Failure initiated reverse-order compensation execution.
    CompensationStarted,
    /// An individual compensating action completed.
    CompensationStepCompleted,
    /// The entire flow reached a terminal state (Passed or RolledBack).
    FlowFinished,
}

/// An immutable event recorded in the append-only journal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunEvent {
    /// Monotonically increasing sequence number within the run.
    pub seq: u64,
    /// Identifier of the run.
    pub run_id: String,
    /// RFC 3339 timestamp string when the event occurred.
    pub timestamp: String,
    /// Kind of event.
    pub kind: RunEventKind,
    /// Optional step ID associated with the event.
    #[serde(default)]
    pub step_id: Option<String>,
    /// Serialized payload describing event details.
    #[serde(default)]
    pub payload: String,
    /// Cryptographic hash (e.g. SHA-256) of this event chained from prior event.
    #[serde(default)]
    pub hash: Option<String>,
}

impl RunEvent {
    /// Create a new journal event.
    #[must_use]
    pub fn new(
        seq: u64,
        run_id: impl Into<String>,
        timestamp: impl Into<String>,
        kind: RunEventKind,
    ) -> Self {
        Self {
            seq,
            run_id: run_id.into(),
            timestamp: timestamp.into(),
            kind,
            step_id: None,
            payload: String::new(),
            hash: None,
        }
    }

    /// Builder method to attach a step identifier.
    #[must_use]
    pub fn with_step_id(mut self, step_id: impl Into<String>) -> Self {
        self.step_id = Some(step_id.into());
        self
    }

    /// Builder method to attach a serialized payload.
    #[must_use]
    pub fn with_payload(mut self, payload: impl Into<String>) -> Self {
        self.payload = payload.into();
        self
    }

    /// Builder method to attach a cryptographic hash.
    #[must_use]
    pub fn with_hash(mut self, hash: impl Into<String>) -> Self {
        self.hash = Some(hash.into());
        self
    }
}

/// Plan reverse-order Saga compensation receipts and append-only journal events for
/// `completed_steps` without performing I/O.
#[must_use]
pub fn plan_reverse_compensation(
    run_id: &str,
    completed_steps: &[String],
    flow_graph: &FlowGraph,
    timestamp: &str,
    mut current_seq: u64,
) -> (Vec<CompensationReceipt>, Vec<RunEvent>) {
    let mut receipts = Vec::with_capacity(completed_steps.len());
    let mut events = Vec::with_capacity(completed_steps.len());

    for step_id in completed_steps.iter().rev() {
        let title = flow_graph
            .step(step_id)
            .map_or_else(|| step_id.clone(), |s| s.title.clone());
        let action_desc = format!("Reverted side-effects and released resources for {step_id}");
        let preimage = format!("{run_id}:{step_id}:{action_desc}");
        let hash_hex = sha256_hex(preimage.as_bytes());

        let mut receipt = CompensationReceipt::new(step_id, title, action_desc, "succeeded");
        receipt.receipt_hash = Some(hash_hex.clone());

        current_seq += 1;
        let payload = serde_json::to_string(&receipt).unwrap_or_default();
        let event = RunEvent::new(
            current_seq,
            run_id,
            timestamp,
            RunEventKind::CompensationStepCompleted,
        )
        .with_step_id(step_id)
        .with_payload(payload)
        .with_hash(hash_hex);

        receipts.push(receipt);
        events.push(event);
    }

    (receipts, events)
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;
    use crate::saga::{ActivityKind, SagaStep};

    #[test]
    fn valid_claim_and_finding_pass() {
        let claim = Claim::new(
            "Agent achieves 50% task completion within 4 hours",
            "task_completion_rate",
            "0.50 @ 4h",
            "cargo test -p lnr-domain",
            "https://metr.org/blog/2025-02-19-evaluating-lms-realistic-autonomous-tasks/",
            "Zero-shot baseline achieves <5%",
        );
        assert!(claim.is_ok());

        let fm = FindingFrontmatter {
            r#type: "finding".into(),
            status: "draft".into(),
            owner: "w19:p1".into(),
            approved_by: String::new(),
            last_reviewed: "2026-10-08".into(),
            sources: vec![
                "METR/vivaria@20a6c29:README.md".into(),
                "arxiv:2505.21409v2".into(),
                "doi:10.1145/3318464.3389700".into(),
            ],
        };
        assert!(fm.validate().is_ok());
    }

    #[test]
    fn reverse_compensation_orders_last_completed_first() {
        let steps = vec![
            SagaStep::new("s1", "Step 1", ActivityKind::Ingest, vec![]),
            SagaStep::new("s2", "Step 2", ActivityKind::Impl, vec!["s1".into()]),
            SagaStep::new("s3", "Step 3", ActivityKind::Verify, vec!["s2".into()]),
        ];
        let graph = FlowGraph::new("flow-1", None, steps).unwrap();
        let completed = vec!["s1".to_string(), "s2".to_string(), "s3".to_string()];

        let (receipts, events) =
            plan_reverse_compensation("run-1", &completed, &graph, "2026-10-14T00:00:00Z", 10);
        assert_eq!(receipts.len(), 3);
        assert_eq!(receipts[0].step_id, "s3");
        assert_eq!(receipts[1].step_id, "s2");
        assert_eq!(receipts[2].step_id, "s1");
        assert_eq!(events[0].seq, 11);
        assert_eq!(events[2].seq, 13);
    }
}
