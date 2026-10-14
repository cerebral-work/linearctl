//! Linear Code Review workflow contracts, mesh gate cards, and content-addressed
//! handoff verification borrowed from `researchd` (`crates/researchd/src/autumn/reviews.rs`
//! and `crates/science/src/mesh.rs`).

use serde::{Deserialize, Serialize};

use crate::crypto::sha256_hex;
use crate::error::DomainError;
use crate::saga::{ActivityKind, FlowGraph, SagaStep};

/// Canonical flow identifier for Linear Code Review (`linear-code-review`).
pub const LINEAR_CODE_REVIEW_FLOW_ID: &str = "linear-code-review";

/// Canonical gate identifier for Linear Code Review sign-off (`linear:code-review`).
pub const LINEAR_CODE_REVIEW_GATE_ID: &str = "linear:code-review";

/// Default Cloudflare R2 bucket for secure document and checkpoint handoffs.
pub const DEFAULT_HANDOFF_R2_BUCKET: &str = "cerebral-secure-handoff";

/// Lifecycle state of a workflow run (`science::journal::RunState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewRunState {
    /// Workflow is queued or actively executing steps.
    Running,
    /// Workflow is paused awaiting a gate signal (`linear:code-review`).
    AwaitingGate,
    /// Workflow completed all steps with verified evidence.
    Succeeded,
    /// Workflow failed or was rejected at a gate.
    Failed,
}

/// Request payload to start a Linear Code Review workflow run.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinearCodeReviewRequest {
    /// Linear issue identifier (e.g. `"CER-104"`).
    #[serde(default)]
    pub issue_id: Option<String>,
    /// Pull request number associated with the review.
    #[serde(default)]
    pub pr_number: Option<u64>,
    /// Pull request or review title.
    pub title: String,
    /// Optional diff or change summary.
    #[serde(default)]
    pub diff_summary: Option<String>,
}

/// Receipt returned when a Linear Code Review run is evaluated or launched.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LinearCodeReviewReceipt {
    /// Unique workflow run identifier.
    pub run_id: String,
    /// Executed Saga flow identifier (`"linear-code-review"`).
    pub flow_id: String,
    /// Active orchestration engine (`"lnr-saga"`).
    pub orchestrator: String,
    /// Linked Linear issue identifier.
    pub issue_id: Option<String>,
    /// Linked pull request number.
    pub pr_number: Option<u64>,
    /// Review title.
    pub title: String,
    /// Optional diff summary attached to the review request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff_summary: Option<String>,
    /// Gate identifier guarding verdict synchronization (`"linear:code-review"`).
    pub gate_id: String,
    /// Critical path makespan in seconds.
    pub makespan_secs: u64,
    /// Ordered step IDs on the critical path.
    pub critical_path: Vec<String>,
    /// Initial run lifecycle state.
    pub state: ReviewRunState,
}

/// Construct the canonical `linear-code-review` [`FlowGraph`] from `researchd`.
///
/// # Errors
///
/// Returns [`DomainError`] if the static flow graph fails validation.
pub fn default_linear_code_review_flow() -> Result<FlowGraph, DomainError> {
    let steps = vec![
        SagaStep::new(
            "ingest-diff",
            "Ingest PR diff and linked Linear issue acceptance criteria",
            ActivityKind::Ingest,
            vec![],
        )
        .with_duration_secs(2)
        .with_agent("probe"),
        SagaStep::new(
            "xerj-ground",
            "Ground touched symbols and callers against XERJ code index",
            ActivityKind::Ground,
            vec!["ingest-diff".to_string()],
        )
        .with_duration_secs(3)
        .with_agent("probe"),
        SagaStep::new(
            "verify-gates",
            "Run cargo fmt, clippy (-j 2), and nextest verification suite",
            ActivityKind::Verify,
            vec!["ingest-diff".to_string()],
        )
        .with_duration_secs(5)
        .with_verify_cmd(vec![
            "cargo".to_string(),
            "test".to_string(),
            "-j".to_string(),
            "2".to_string(),
        ]),
        SagaStep::new(
            "critic-review",
            "Adversarial critic review of diff against Linear ticket spec",
            ActivityKind::Verify,
            vec!["xerj-ground".to_string(), "verify-gates".to_string()],
        )
        .with_duration_secs(4)
        .with_agent("critic"),
        SagaStep::new(
            "linear-sync-gate",
            "Gate approval before posting review verdict to Linear issue",
            ActivityKind::Gate,
            vec!["critic-review".to_string()],
        )
        .with_duration_secs(1)
        .with_gate(LINEAR_CODE_REVIEW_GATE_ID),
    ];

    FlowGraph::new(
        LINEAR_CODE_REVIEW_FLOW_ID,
        Some("Durable Linear Code Review Saga workflow (diff ingest, XERJ grounding, critic review, Linear gate)".to_string()),
        steps,
    )
}

/// Evaluate a [`LinearCodeReviewRequest`] against the canonical `linear-code-review` flow and produce a [`LinearCodeReviewReceipt`].
///
/// # Errors
///
/// Returns [`DomainError::InvalidFlow`] if `req.title` is empty.
pub fn plan_linear_code_review(
    req: &LinearCodeReviewRequest,
) -> Result<LinearCodeReviewReceipt, DomainError> {
    if req.title.trim().is_empty() {
        return Err(DomainError::InvalidFlow(
            "Linear Code Review title cannot be empty".to_string(),
        ));
    }
    let flow = default_linear_code_review_flow()?;
    let cpm = flow.compute_cpm()?;
    let seed = format!(
        "{}:{}:{}",
        req.issue_id.as_deref().unwrap_or("none"),
        req.pr_number.unwrap_or(0),
        req.title.trim()
    );
    let digest = &sha256_hex(seed.as_bytes())[..12];

    Ok(LinearCodeReviewReceipt {
        run_id: format!("lcr-{digest}"),
        flow_id: LINEAR_CODE_REVIEW_FLOW_ID.to_string(),
        orchestrator: "lnr-saga".to_string(),
        issue_id: req.issue_id.clone(),
        pr_number: req.pr_number,
        title: req.title.trim().to_string(),
        diff_summary: req.diff_summary.clone(),
        gate_id: LINEAR_CODE_REVIEW_GATE_ID.to_string(),
        makespan_secs: cpm.makespan,
        critical_path: cpm.critical_path,
        state: ReviewRunState::AwaitingGate,
    })
}

/// Deterministic 64-bit FNV-1a digest for worktree and payload fingerprinting.
#[must_use]
pub fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

/// Sanitize a filename for content-addressed R2 object keys (`science::mesh::sanitize_filename`).
#[must_use]
pub fn sanitize_cas_filename(filename: &str) -> String {
    let base = filename
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or("artifact.json")
        .trim();
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') {
                c
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() {
        "artifact.json".to_string()
    } else {
        cleaned
    }
}

/// Build a canonical R2 Content-Addressed Store (CAS) object key (`mesh-handoffs/<date>/<sha256>-<filename>`).
#[must_use]
pub fn build_cas_r2_key(date_partition: &str, digest_hex: &str, filename: &str) -> String {
    let safe_name = sanitize_cas_filename(filename);
    format!("mesh-handoffs/{date_partition}/{digest_hex}-{safe_name}")
}

/// Verify payload bytes against an expected 64-character lowercase hex SHA-256 digest and byte size.
///
/// # Errors
///
/// Returns an error string if the byte size or SHA-256 digest does not match.
pub fn verify_handoff_bytes(
    bytes: &[u8],
    expected_digest_hex: &str,
    expected_size_bytes: u64,
) -> Result<(), String> {
    let actual_size = bytes.len() as u64;
    if actual_size != expected_size_bytes {
        return Err(format!(
            "payload size mismatch: expected {expected_size_bytes} bytes, got {actual_size}"
        ));
    }
    let actual_digest = sha256_hex(bytes);
    if !actual_digest.eq_ignore_ascii_case(expected_digest_hex.trim()) {
        return Err(format!(
            "payload digest mismatch: expected {}, got {actual_digest}",
            expected_digest_hex.trim()
        ));
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
mod tests {
    use super::*;

    #[test]
    fn linear_code_review_flow_and_cas_verification() {
        let req = LinearCodeReviewRequest {
            issue_id: Some("CER-104".to_string()),
            pr_number: Some(222),
            title: "Port lnr to Rust".to_string(),
            diff_summary: Some("15 domain modules + CLI + MCP".to_string()),
        };
        let receipt = plan_linear_code_review(&req).unwrap();
        assert_eq!(receipt.flow_id, LINEAR_CODE_REVIEW_FLOW_ID);
        assert_eq!(receipt.gate_id, LINEAR_CODE_REVIEW_GATE_ID);
        assert_eq!(receipt.makespan_secs, 12);
        assert_eq!(
            receipt.critical_path,
            vec![
                "ingest-diff",
                "verify-gates",
                "critic-review",
                "linear-sync-gate"
            ]
        );

        let payload = b"checkpoint-payload";
        let digest = sha256_hex(payload);
        verify_handoff_bytes(payload, &digest, payload.len() as u64).unwrap();
        assert!(
            verify_handoff_bytes(b"tampered-payload!!", &digest, payload.len() as u64).is_err()
        );
    }
}
